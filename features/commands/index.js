const reposCommands = require('./repos');
const issuesCommands = require('./issues');
const pullRequestsCommands = require('./pullRequests');
const branchesCommands = require('./branches');
const profilesCommands = require('./profiles');
const notificationsCommands = require('./notifications');
const miscCommands = require('./misc');

function registerAllCommands(context, auth, deps) {
    reposCommands.registerCommands(context, auth, deps);
    issuesCommands.registerCommands(context, auth, deps);
    pullRequestsCommands.registerCommands(context, auth, deps);
    branchesCommands.registerCommands(context, auth, deps);
    profilesCommands.registerCommands(context, auth, deps);
    notificationsCommands.registerCommands(context, auth, deps);
    miscCommands.registerCommands(context, auth, deps);
}

module.exports = { registerAllCommands };
