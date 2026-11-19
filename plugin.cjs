const os = require("node:os");
const path = require("node:path");
// This stable plugin path is refreshed by `ryugi update`.
module.exports = path.resolve(
  process.env.RYUGI_T3_WATCH_PLUGIN ||
    path.join(os.homedir(), ".local/share/ryugi/install/plugins/pi/plugin"),
);
