// Loaded into every node process a T3 agent shell starts (NODE_OPTIONS=--require, set per provider in
// T3's settings), so agents need no instruction: a successful `ryugi.cjs start` subscribes its artifact.
// Anything else returns at once. Ryugi's stdout is left alone; the bridge speaks on stderr.
(() => {
  const script = process.argv[1] || "";
  if (!process.env.T3CODE_THREAD_ID) return;
  if (!/[\\/]skills[\\/]artifacts[\\/]app[\\/]ryugi(?:-artifacts)?\.cjs$/.test(script)) return;
  const autosub = require("./autosub.cjs");
  const cwd = process.cwd();
  const goal = autosub.target(process.argv.slice(2), cwd);
  if (!goal) return;
  let done = false;
  function subscribe() {
    if (done) return;
    done = true;
    process.stderr.write(autosub.subscribe(goal, cwd) + "\n");
  }
  // A start without --background may stay up; subscribe while it runs.
  setTimeout(subscribe, 3000).unref();
  process.on("exit", (code) => {
    if (code === 0) subscribe();
  });
})();
