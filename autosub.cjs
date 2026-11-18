// Auto-subscribe for a `ryugi.cjs start` an agent ran in a T3 thread. preload.cjs feeds it the real
// argv; claude-hook.cjs feeds it words split from Claude's Bash command, since Claude strips NODE_OPTIONS.
const path = require("node:path");
const { spawnSync } = require("node:child_process");
// Same types as Ryugi's comment subscriptions; the others send no feedback.
const artifactPattern = /^(?:document|artboard|whiteboard|slides)\/[a-z0-9][a-z0-9-]*$/;

// Returns { artifact, project } for a start worth subscribing, else null.
function target(argv, cwd) {
  const args = [...argv];
  const proof = args.indexOf("--ryugi-session");
  if (proof >= 0) args.splice(proof, 2);
  if (args[0] !== "start" || args.includes("--help") || args.includes("-h")) return null;
  const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(name + "="))?.slice(name.length + 1);
  };
  const artifact = option("--artifact");
  if (!artifactPattern.test(artifact || "")) return null;
  return { artifact, project: path.resolve(cwd, option("--project-dir") || ".") };
}

// Subscribes and returns what the agent should be told.
function subscribe({ artifact, project }, cwd) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, "cli.cjs"), "subscribe", "--artifact", artifact, "--project", project],
    { cwd, env, encoding: "utf8", timeout: 30000 },
  );
  if (r.status === 0)
    return (
      `ryugi-t3-watch: ${artifact} 的提交和评论会送回这个 T3 线程，不必再订阅。` +
      `用户说「这里」「这段」「选中的」却没给出位置时，运行 ryugi-t3-watch selection-context --cwd ${JSON.stringify(project)}；没有输出表示查看器里没有选区。`
    );
  // A sandboxed shell (Codex workspace-write) cannot write the bridge state or reach launchd.
  return (
    `ryugi-t3-watch: 没能自动订阅 ${artifact}，反馈不会送回这个线程。在沙盒外运行 ` +
    `ryugi-t3-watch subscribe --project ${JSON.stringify(project)} --artifact ${artifact} 重试，仍失败就把原因告诉用户：\n` +
    (r.stderr || String(r.error || "")).trim()
  );
}

module.exports = { target, subscribe };
