const path = require("node:path");
const plugin = require("./plugin.cjs");
const app = (name) => require(path.join(plugin, "skills/artifacts/app", name + ".cjs"));
module.exports = { plugin, app, ...app("comment-subscriptions") };
