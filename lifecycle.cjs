const fs = require("node:fs"),
  path = require("node:path");
const { spawn } = require("node:child_process");
const { projectRoot, app, plugin } = require("./upstream.cjs");
function lifecycle(op, opts) {
  const rawCwd = opts.cwd || process.cwd();
  let cwd = rawCwd;
  try {
    cwd = fs.realpathSync(rawCwd);
  } catch {}
  const project = projectRoot(cwd);
  if (op === "session-start") {
    const p = spawn(process.execPath, [path.join(plugin, "hooks/start-artifacts.cjs"), project], {
      stdio: "ignore",
      detached: true,
      cwd,
    });
    p.on("error", () => {});
    p.unref();
    return;
  }
  if (!fs.existsSync(path.join(project, ".ryugi/artifacts/.state/server-info"))) return;
  if (op === "turn-end") return app("agent-event").postToServer(project, "/api/cloud/flush");
  return require("./selection.cjs").selectionContext(
    project,
    cwd,
    opts.host,
    opts.prompt,
    opts["session-id"],
    Object.hasOwn(opts, "thread") ? opts.thread : process.env.T3CODE_THREAD_ID,
  );
}
module.exports = { lifecycle };
