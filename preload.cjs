// Loaded into every node process a T3 agent shell starts (NODE_OPTIONS=--require: set per provider in
// T3's settings, for Claude by claude-hook.cjs), so agents need no instruction: a successful
// `ryugi.cjs start` subscribes its artifact.
// Anything else returns at once. Ryugi's stdout is left alone; the bridge speaks on stderr.
(() => {
  const script = process.argv[1] || "";
  if (!process.env.T3CODE_THREAD_ID) return;
  if (!/[\\/]ryugi(?:-artifacts)?\.cjs$/.test(script)) return;
  // Hosts link the skill under their own names (Antigravity: skills/ryugi-artifacts); match the real path.
  let real;
  try {
    real = require("node:fs").realpathSync(script);
  } catch {
    return;
  }
  if (!/[\\/]skills[\\/]artifacts[\\/]app[\\/]ryugi(?:-artifacts)?\.cjs$/.test(real)) return;
  const autosub = require("./autosub.cjs");
  const cwd = process.cwd();
  const goal = autosub.target(process.argv.slice(2), cwd);
  if (!goal) return;
  let done = false;
  function subscribe() {
    if (done) return;
    done = true;
    // Only Codex runs agent shells in a sandbox that can block the bridge's state directory.
    const sandboxed = Boolean(process.env.CODEX_THREAD_ID || process.env.CODEX_SANDBOX);
    // Under Claude, Ryugi's prompt hook already shows the session project's selection (claude-hook.cjs).
    let selection = true;
    const session = process.env.RYUGI_T3_SESSION_PROJECT;
    if (session)
      try {
        selection = require("./upstream.cjs").projectRoot(goal.project) !== session;
      } catch {}
    process.stderr.write(autosub.subscribe(goal, cwd, { launcher: script, selection, sandboxed }) + "\n");
  }
  // A start without --background may stay up; subscribe while it runs.
  setTimeout(subscribe, 3000).unref();
  process.on("exit", (code) => {
    if (code === 0) subscribe();
  });
})();
