const fs = require("node:fs");
const path = require("node:path");
const { projectRoot } = require("./upstream.cjs");
function selectionContext(opts) {
  let cwd = opts.cwd || process.cwd();
  try {
    cwd = fs.realpathSync(cwd);
  } catch {}
  const project = projectRoot(cwd);
  if (!fs.existsSync(path.join(project, ".ryugi/artifacts/.state/server-info"))) return "";
  return require("./selection.cjs").selectionContext(
    project,
    cwd,
    opts.host,
    opts.prompt,
    Object.hasOwn(opts, "thread") ? opts.thread : process.env.T3CODE_THREAD_ID,
  );
}
module.exports = { selectionContext };
