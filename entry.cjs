// The file T3 agent shells load into every node process (NODE_OPTIONS=--require <stub>). It lives in a
// fixed data directory, not in this checkout, and only tries to load preload.cjs: a moved, deleted or
// broken bridge then turns auto-subscribe off instead of stopping every node command in agent shells.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const preload = path.join(__dirname, "preload.cjs");

const stubPath = (env = process.env) =>
  path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"), "ryugi-t3-watch/preload.cjs");
// The NODE_OPTIONS value for T3's provider settings; Node reads double-quoted paths with spaces.
const nodeOptions = (env = process.env) => "--require " + JSON.stringify(stubPath(env));

function stubSource(target) {
  return `// Written by \`ryugi-t3-watch install\`; see entry.cjs there. Safe to leave behind: it only loads the
// bridge's preload while that exists, and says so only when a Ryugi start could not auto-subscribe.
try {
  require(${JSON.stringify(target)});
} catch (e) {
  if (/(?:^|[\\\\/])ryugi(?:-artifacts)?\\.cjs$/.test(process.argv[1] || "") && process.env.T3CODE_THREAD_ID)
    process.stderr.write("ryugi-t3-watch: 预加载失败，没有自动订阅（" + e.message.split("\\n")[0] + "）。运行 ryugi-t3-watch doctor 查看。\\n");
}
`;
}

function install(env = process.env, target = preload) {
  const file = stubPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".new", stubSource(target));
  fs.renameSync(file + ".new", file);
  return file;
}

// Read-only look at T3's provider settings: which providers load the stub, and Claude's launch argument.
function entries(env = process.env) {
  const problems = [];
  const file = stubPath(env);
  let source = "";
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {}
  if (source !== stubSource(preload)) problems.push(source ? `${file} 不是当前版本` : `缺少 ${file}`);
  const settings = path.join(env.T3CODE_HOME || path.join(os.homedir(), ".t3"), "userdata/settings.json");
  let providers;
  try {
    providers = JSON.parse(fs.readFileSync(settings, "utf8")).providerInstances || {};
  } catch {
    throw new Error("读不到 " + settings);
  }
  const loaded = [],
    stale = [];
  for (const [id, p] of Object.entries(providers)) {
    if (p.driver === "claudeAgent") {
      const args = String(p.config?.launchArgs ?? p.launchArgs ?? "");
      if (args.includes(path.join(__dirname, "claude-settings.json"))) loaded.push(id);
      continue;
    }
    const value = (p.environment || []).find((e) => e.name === "NODE_OPTIONS")?.value || "";
    if (value.includes(file)) loaded.push(id);
    else if (value.includes(preload)) stale.push(id);
  }
  if (stale.length) problems.push(`${stale.join("、")} 仍直接加载 ${preload}，改成 NODE_OPTIONS=${nodeOptions(env)}`);
  if (problems.length) throw new Error(problems.join("；"));
  return loaded.length ? loaded.join("、") + " 会自动订阅" : "没有 T3 provider 配置自动订阅";
}

module.exports = { stubPath, nodeOptions, install, entries, preload };
