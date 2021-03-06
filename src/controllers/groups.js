'use strict';

const validator = require('validator');
const nconf = require('nconf');

const db = require('../database');
const meta = require('../meta');
const groups = require('../groups');
const user = require('../user');
const helpers = require('./helpers');
const pagination = require('../pagination');
const privileges = require('../privileges');

const groupsController = module.exports;

groupsController.list = async function (req, res) {
	const sort = req.query.sort || 'alpha';
	const page = parseInt(req.query.page, 10) || 1;
	const groupsPerPage = 14;
	const start = Math.max(0, (page - 1) * groupsPerPage);
	const stop = start + groupsPerPage - 1;

	const [groupData, allowGroupCreation] = await Promise.all([
		groups.getGroupsBySort(sort, start, stop),
		privileges.global.can('group:create', req.uid),
	]);

	groupData.forEach(async function (group) {
		if (group) {
			const [isMember, isOwner] = await Promise.all([
				groups.isMember(req.uid, group.name),
				groups.ownership.isOwner(req.uid, group.name),
			]);

			group.isMember = isMember;
			group.isOwner = isOwner;
		}
	});

	let groupNames = await getGroupNames();
	const pageCount = Math.ceil(groupNames.length / groupsPerPage);
	res.render('groups/list', {
		groups: groupData,
		allowGroupCreation: allowGroupCreation,
		nextStart: 15,
		title: '[[pages:groups]]',
		pagination: pagination.create(page, pageCount, req.query),
		breadcrumbs: helpers.buildBreadcrumbs([{ text: '[[pages:groups]]' }]),
	});
};

groupsController.details = async function (req, res, next) {
	const lowercaseSlug = req.params.slug.toLowerCase();
	if (req.params.slug !== lowercaseSlug) {
		if (res.locals.isAPI) {
			req.params.slug = lowercaseSlug;
		} else {
			return res.redirect(nconf.get('relative_path') + '/groups/' + lowercaseSlug);
		}
	}
	const groupName = await groups.getGroupNameByGroupSlug(req.params.slug);
	if (!groupName) {
		return next();
	}
	const [exists, isHidden, isAdmin, isGlobalMod] = await Promise.all([
		groups.exists(groupName),
		groups.isHidden(groupName),
		user.isAdministrator(req.uid),
		user.isGlobalModerator(req.uid),
	]);
	if (!exists) {
		return next();
	}
	if (isHidden && !isAdmin && !isGlobalMod) {
		const [isMember, isInvited] = await Promise.all([
			groups.isMember(req.uid, groupName),
			groups.isInvited(req.uid, groupName),
		]);
		if (!isMember && !isInvited) {
			return next();
		}
	}
	const [groupData, posts] = await Promise.all([
		groups.get(groupName, {
			uid: req.uid,
			truncateUserList: true,
			userListCount: 20,
		}),
		groups.getLatestMemberPosts(groupName, 10, req.uid),
	]);
	if (!groupData) {
		return next();
	}
	groupData.isOwner = groupData.isOwner || isAdmin || (isGlobalMod && !groupData.system);
	
	if (groupData.cid) {
		groupData.isModerator = await user.isModerator(req.uid, parseInt(groupData.cid));
	}

	res.render('groups/details', {
		title: '[[pages:group, ' + groupData.displayName + ']]',
		group: groupData,
		posts: posts,
		isAdmin: isAdmin,
		isGlobalMod: isGlobalMod,
		allowPrivateGroups: meta.config.allowPrivateGroups,
		breadcrumbs: helpers.buildBreadcrumbs([{ text: '[[pages:groups]]', url: '/groups' }, { text: groupData.displayName }]),
	});
};

groupsController.members = async function (req, res, next) {
	const page = parseInt(req.query.page, 10) || 1;
	const usersPerPage = 50;
	const start = Math.max(0, (page - 1) * usersPerPage);
	const stop = start + usersPerPage - 1;
	const groupName = await groups.getGroupNameByGroupSlug(req.params.slug);
	if (!groupName) {
		return next();
	}
	const [groupData, isAdminOrGlobalMod, isMember, isHidden] = await Promise.all([
		groups.getGroupData(groupName),
		user.isAdminOrGlobalMod(req.uid),
		groups.isMember(req.uid, groupName),
		groups.isHidden(groupName),
	]);

	if (isHidden && !isMember && !isAdminOrGlobalMod) {
		return next();
	}
	//const users = await user.getUsersFromSet('group:' + groupName + ':members', req.uid, start, stop);
	const users = await groups.getOwnersAndMembers(groupName, req.uid, start, stop);
	
	if (groupData.cid) {
		users.forEach(async function (u) {
			const isModerator = await user.isModerator(u.uid, parseInt(groupData.cid));

			u.isModerator = isModerator;
		});
	}

	const breadcrumbs = helpers.buildBreadcrumbs([
		{ text: '[[pages:groups]]', url: '/groups' },
		{ text: validator.escape(String(groupName)), url: '/groups/' + req.params.slug },
		{ text: '[[groups:details.members]]' },
	]);

	const pageCount = Math.max(1, Math.ceil(groupData.memberCount / usersPerPage));
	res.render('groups/members', {
		users: users,
		pagination: pagination.create(page, pageCount, req.query),
		breadcrumbs: breadcrumbs,
	});
};

groupsController.uploadCover = async function (req, res, next) {
	const params = JSON.parse(req.body.params);

	try {
		const isOwner = await groups.ownership.isOwner(req.uid, params.groupName);
		if (!isOwner) {
			throw new Error('[[error:no-privileges]]');
		}
		const image = await groups.updateCover(req.uid, {
			file: req.files.files[0],
			groupName: params.groupName,
		});
		res.json([{ url: image.url }]);
	} catch (err) {
		next(err);
	}
};

async function getGroupNames() {
	const groupNames = await db.getSortedSetRange('groups:createtime', 0, -1);
	return groupNames.filter(name => name !== 'registered-users' && !groups.isPrivilegeGroup(name));
}
