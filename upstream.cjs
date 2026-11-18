const path = require("node:path");
const os = require("node:os");

const plugin = path.join(os.homedir(), ".gemini/config/plugins/ryugi");
const app = (name) => require(path.join(plugin, "skills/artifacts/app", name + ".cjs"));
module.exports = { plugin, app, ...app("comment-subscriptions") };
