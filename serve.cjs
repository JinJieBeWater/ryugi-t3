// Keeps Ryugi's own watcher running for every custom-host subscription, from one launchd-owned process.
// Ryugi starts each session's watcher from the agent's shell, and T3 SIGKILLs whatever a Claude CLI
// leaves behind when it exits, so those watchers die and feedback waits in the hub. Watchers started here
// sit outside T3's process tree. The hub keeps the newest connection per session and a replaced watcher
// exits, so a watcher started again here takes the session back.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SYNC_MS = 60000;
const RESPAWN_MS = 1000;
const MAX_RESPAWN_MS = 60000;
// A watcher exits at once when another live watcher already holds its session; back off instead of spinning.
const SETTLED_MS = 10000;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const log = (...parts) => process.stderr.write(`${new Date().toISOString()} ${parts.join(" ")}\n`);

const newer = (a, b) => {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] || 0) > (y[i] || 0);
  return false;
};

// Resolves the watcher binary the way Ryugi's hook-bin.sh does: the newest managed plugin names the version.
function hook(env) {
  if (env.RYUGI_HOOK_BIN) return { bin: env.RYUGI_HOOK_BIN, env };
  const home = env.HOME || os.homedir();
  const plugins = path.join(env.RYUGI_INSTALL_ROOT || path.join(home, ".local/share/ryugi/install"), "plugins");
  let best = null;
  for (const name of fs.existsSync(plugins) ? fs.readdirSync(plugins) : []) {
    const root = path.join(plugins, name, "plugin");
    const version = readJson(path.join(root, "package.json"))?.version;
    if (version && fs.existsSync(path.join(root, "skills/artifacts/app/ryugi.cjs")) && (!best || newer(version, best.version)))
      best = { root, version };
  }
  if (!best) throw Error(`No Ryugi plugin under ${plugins}`);
  const bin = path.join(home, ".ryugi/hook", best.version, "ryugi-hook");
  fs.accessSync(bin, fs.constants.X_OK);
  // The watcher finds Ryugi's launcher through RYUGI_PLUGIN_ROOT and runs it with `node` to start the hub.
  const PATH = [path.dirname(process.execPath), env.PATH].filter(Boolean).join(":");
  return { bin, env: { ...env, PATH, RYUGI_PLUGIN_ROOT: best.root } };
}

function serve({ env = process.env } = {}) {
  const home = env.HOME || os.homedir();
  const serverHome = env.RYUGI_SERVER_HOME || path.join(home, ".ryugi/server");
  const subscriptionsFile = path.join(serverHome, "agent-subscriptions.json");
  const hostsFile = env.RYUGI_HOSTS_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "ryugi/config.json");
  const watchers = new Map();
  let closed = false;

  function restart(key, watcher, settled) {
    watcher.delay = settled ? RESPAWN_MS : Math.min(watcher.delay * 2, MAX_RESPAWN_MS);
    watcher.timer = setTimeout(() => start(key, watcher), watcher.delay);
  }

  function start(key, watcher) {
    const at = key.indexOf(":");
    let child;
    try {
      const { bin, env: childEnv } = hook(env);
      child = spawn(bin, ["watch", "cmd"], { cwd: watcher.project, env: childEnv, stdio: ["pipe", "ignore", "inherit"] });
    } catch (error) {
      log("cannot start watcher for", key, error.message);
      return restart(key, watcher, false);
    }
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ host: key.slice(0, at), session: key.slice(at + 1), project: watcher.project }));
    const startedAt = Date.now();
    watcher.child = child;
    child.once("error", (error) => log("watcher", key, error.message));
    child.once("close", (code, signal) => {
      watcher.child = null;
      if (closed || watchers.get(key) !== watcher) return;
      restart(key, watcher, Date.now() - startedAt >= SETTLED_MS);
      log("watcher", key, "exited", signal || code, "restarting in", `${watcher.delay}ms`);
    });
  }

  function stop(key) {
    const watcher = watchers.get(key);
    watchers.delete(key);
    clearTimeout(watcher.timer);
    watcher.child?.kill();
  }

  function sync() {
    const hosts = readJson(hostsFile)?.hosts || {};
    const wanted = new Map();
    for (const [key, value] of Object.entries(readJson(subscriptionsFile) || {})) {
      const host = hosts[key.slice(0, key.indexOf(":"))];
      const project = value?.items?.[0]?.project;
      if (host && typeof project === "string") wanted.set(key, { project, config: JSON.stringify(host) });
    }
    // A changed host config restarts the watcher so it runs the new command.
    for (const [key, watcher] of watchers) if (wanted.get(key)?.config !== watcher.config) stop(key);
    for (const [key, { project, config }] of wanted) {
      if (watchers.has(key)) continue;
      const watcher = { project, config, child: null, timer: null, delay: RESPAWN_MS };
      watchers.set(key, watcher);
      start(key, watcher);
    }
  }

  // The hub rewrites the file by rename, so watch its directory; the interval also picks up host config edits.
  let debounce = null;
  fs.mkdirSync(serverHome, { recursive: true });
  const fileWatcher = fs.watch(serverHome, (_, name) => {
    if (name !== "agent-subscriptions.json") return;
    clearTimeout(debounce);
    debounce = setTimeout(sync, 200);
  });
  const timer = setInterval(sync, SYNC_MS);
  sync();

  return {
    close() {
      closed = true;
      clearTimeout(debounce);
      clearInterval(timer);
      fileWatcher.close();
      for (const key of [...watchers.keys()]) stop(key);
    },
  };
}

module.exports = { serve };

if (require.main === module) {
  const server = serve();
  log("serving");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      server.close();
      process.exit(0);
    });
}
