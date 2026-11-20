// Auto-subscribe for a `ryugi.cjs start` an agent ran in a T3 thread; preload.cjs feeds it the real argv.
const path = require("node:path");
const { spawnSync } = require("node:child_process");
// Same types as Ryugi's comment subscriptions; the others send no feedback.
const artifactPattern = /^(?:document|artboard|whiteboard|slides)\/[a-z0-9][a-z0-9-]*$/;

// Returns { artifact, project, proof } for a start worth subscribing, else null.
function target(argv, cwd) {
  const args = [...argv];
  let proof;
  const at = args.indexOf("--ryugi-session");
  if (at >= 0) proof = args.splice(at, 2)[1];
  if (args[0] !== "start" || args.includes("--help") || args.includes("-h")) return null;
  const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(name + "="))?.slice(name.length + 1);
  };
  const artifact = option("--artifact");
  if (!artifactPattern.test(artifact || "")) return null;
  return { artifact, project: path.resolve(cwd, option("--project-dir") || "."), proof };
}

// Subscribes and returns what the agent should be told. launcher is the script it ran;
// selection: false leaves out the selection hint (Ryugi's prompt hook already shows it to Claude);
// sandboxed: true adds the way out of Codex's sandbox to the failure message.
function subscribe({ artifact, project, proof }, cwd, { launcher, selection = true, sandboxed = false } = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const args = ["subscribe", "--artifact", artifact, "--project", project];
  if (launcher) args.push("--launcher", launcher, ...(proof ? ["--ryugi-session", proof] : []));
  const r = spawnSync(process.execPath, [path.join(__dirname, "cli.cjs"), ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  const manual = `ryugi-t3-watch subscribe --project ${JSON.stringify(project)} --artifact ${artifact}`;
  if (r.status === 0)
    return (
      `ryugi-t3-watch: 已订阅 ${artifact}，用户在查看器里点提交或撤回后会自动送回本线程，未读评论随提交一起送达。` +
      (selection
        ? `用户指代产物某处（如「这里」）却没说是哪时，先运行 ryugi-t3-watch selection-context --cwd ${JSON.stringify(project)}，无输出再问用户。`
        : "")
    );
  return (
    `ryugi-t3-watch: 未能订阅 ${artifact}，提交到不了本线程。` +
    (sandboxed ? `到沙盒外运行 ${manual}` : `运行 ${manual} 重试`) +
    "；仍失败就把下面的原因告诉用户：\n" +
    (r.stderr || String(r.error || "")).trim()
  );
}

module.exports = { target, subscribe };
