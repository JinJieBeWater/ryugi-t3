const path = require("node:path");
const plugin = require("./plugin.cjs");
const app = (name) => require(path.join(plugin, "skills/artifacts/app", name + ".cjs"));
const hook = path.join(plugin, "hooks/selection-context.cjs");
module.exports = { plugin, app, hook, ...app("comment-subscriptions") };
