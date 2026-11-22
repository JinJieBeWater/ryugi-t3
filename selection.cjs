// The viewer's selections, as Ryugi's own prompt hook prints them. It runs as a plain shell would:
// agent markers would make it answer in Antigravity's JSON or start Antigravity's own watcher.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { projectRoot, hook, load, reminderHelpers } = require("./upstream.cjs");
const markers = /^(?:ANTIGRAVITY_|CLAUDE_|CURSOR_|PLUGIN_)|^NODE_OPTIONS$/;
function selectionContext({ cwd }) {
  const project = projectRoot(path.resolve(cwd || process.cwd()));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !markers.test(k)));
  // The hook's unread-comment reminder counts for the wrong host; T3 threads get unread comments with each submit.
  // It is pure, unlike the auto-publish notices that follow it, which are one-shot and pass through.
  // Computed before and after the hook runs, so a comment read or added meanwhile still matches one of them.
  const helpers = load("hooks/selection-context.cjs");
  const strip = reminderHelpers.every((n) => typeof helpers[n] === "function");
  const reminder = () =>
    strip ? helpers.commentReminders(project, path.join(project, ".ryugi/artifacts"), helpers.cursorKey(env)) : "";
  const before = reminder();
  const r = spawnSync(process.execPath, [hook, project, project], {
    cwd: project,
    env,
    input: "{}",
    encoding: "utf8",
    timeout: 10000,
  });
  if (r.status !== 0) throw new Error(`Ryugi 的 selection-context 失败（${r.status ?? r.error}）：${r.stderr.trim()}`);
  let text = r.stdout.trimEnd();
  for (const shown of new Set([before, reminder()].filter(Boolean)))
    for (const cut of ["\n\n" + shown, shown + "\n\n", shown]) {
      const at = text.lastIndexOf(cut);
      if (at < 0) continue;
      text = text.slice(0, at) + text.slice(at + cut.length);
      break;
    }
  return text;
}
module.exports = { selectionContext };
