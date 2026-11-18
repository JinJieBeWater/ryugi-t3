const os = require("node:os");
const path = require("node:path");
// RYUGI_T3_WATCH_PLUGIN points the bridge at another Ryugi checkout.
module.exports = path.resolve(
  process.env.RYUGI_T3_WATCH_PLUGIN || path.join(os.homedir(), ".gemini/config/plugins/ryugi"),
);
