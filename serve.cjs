// Holds the hub connection for every custom-host subscription from one launchd-owned process.
// Ryugi starts each session's watcher from the agent's shell, and T3 SIGKILLs whatever a Claude CLI
// leaves behind when it exits, so those watchers die and feedback waits in the hub. The hub keeps the
// newest connection per session and Ryugi's watcher exits when replaced, so reconnecting wins.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SYNC_MS = 60000;
const RECONNECT_MS = 1000;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const log = (...parts) => process.stderr.write(`${new Date().toISOString()} ${parts.join(" ")}\n`);

// The newest installed Ryugi plugin, which `ryugi update` keeps current.
function installedApp(env = process.env) {
  if (env.RYUGI_T3_APP) return { app: env.RYUGI_T3_APP, version: "" };
  const plugins = path.join(env.RYUGI_INSTALL_ROOT || path.join(os.homedir(), ".local/share/ryugi/install"), "plugins");
  const parts = (version) => version.split(".").map(Number);
  const newer = (a, b) => {
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] || 0) > (y[i] || 0);
    return false;
  };
  let best = null;
  for (const name of fs.existsSync(plugins) ? fs.readdirSync(plugins) : []) {
    const dir = path.join(plugins, name, "plugin");
    const app = path.join(dir, "skills/artifacts/app");
    const version = readJson(path.join(dir, "package.json"))?.version || "0";
    if (fs.existsSync(path.join(app, "cmd-comment-watch.cjs")) && (!best || newer(version, best.version)))
      best = { app, version };
  }
  if (!best) throw Error(`No Ryugi plugin with custom hosts under ${plugins}`);
  return best;
}

function serve({ env = process.env, app = installedApp(env).app, startHub } = {}) {
  const { openHubChannel } = require(path.join(app, "hub-channel.cjs"));
  const { createDeliveryQueue } = require(path.join(app, "delivery-queue.cjs"));
  const { deliverComment } = require(path.join(app, "cmd-comment-watch.cjs"));
  const { loadCustomHosts, SESSION_ID } = require(path.join(app, "custom-hosts.cjs"));
  const serverHome = env.RYUGI_SERVER_HOME || path.join(os.homedir(), ".ryugi", "server");
  const subscriptionsFile = path.join(serverHome, "agent-subscriptions.json");

  // Several sessions notice a missing hub at once; one start is enough for all of them.
  let starting = null;
  const launchHub =
    startHub ||
    ((project) =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [path.join(app, "ryugi.cjs"), "start", "--background", "--no-open", "--project-dir", project],
          { env: { ...env, RYUGI_NO_UPDATE_CHECK: "1" }, stdio: "ignore" },
        );
        child.on("error", resolve).on("close", resolve);
      }));
  const sharedStart = (project) => (starting ??= Promise.resolve(launchHub(project)).finally(() => (starting = null)));

  const sessions = new Map();

  function open(key, host, session, project) {
    const ctx = { host: host.host, session, project, command: host.command, timeoutMs: host.timeoutMs };
    const controller = new AbortController();
    const entry = { commandKey: JSON.stringify(host), channel: null, closed: false };
    const queue = createDeliveryQueue({
      baseMs: 500,
      deliver: async (event) => {
        const result = await deliverComment(ctx, event, controller.signal);
        if (result.action === "unsubscribe") {
          log("unsubscribe", key);
          drop(key, { unsubscribe: true });
        }
        return result;
      },
      delivered: (id) => entry.channel.delivered(id),
      onFailure: (error) => log("retry", key, String(error.message).split("\n")[0]),
    });
    const connect = () => {
      if (entry.closed) return;
      entry.channel = openHubChannel({
        env,
        project,
        host: host.host,
        session,
        agent: host.agent,
        startHub: sharedStart,
        onEvent: (event, id) => queue.push(event, id),
        onRetract: (message) => queue.retract(message),
        onReplaced: () => setTimeout(connect, RECONNECT_MS),
      });
    };
    entry.stop = ({ unsubscribe }) => {
      entry.closed = true;
      queue.close();
      if (unsubscribe) return entry.channel.unsubscribe();
      controller.abort();
      entry.channel.close();
    };
    sessions.set(key, entry);
    connect();
  }

  function drop(key, { unsubscribe = false } = {}) {
    sessions.get(key)?.stop({ unsubscribe });
    sessions.delete(key);
  }

  function sync() {
    const hosts = new Map(loadCustomHosts(env).map((host) => [host.host, host]));
    const wanted = new Map();
    for (const [key, value] of Object.entries(readJson(subscriptionsFile) || {})) {
      const at = key.indexOf(":");
      const host = hosts.get(key.slice(0, at));
      const session = key.slice(at + 1);
      const project = value?.items?.[0]?.project;
      if (host && SESSION_ID.test(session) && typeof project === "string") wanted.set(key, { host, session, project });
    }
    for (const [key, entry] of sessions)
      if (JSON.stringify(wanted.get(key)?.host) !== entry.commandKey) drop(key);
    for (const [key, { host, session, project }] of wanted) if (!sessions.has(key)) open(key, host, session, project);
  }

  // The hub rewrites the file by rename, so watch its directory; the interval covers events macOS drops.
  let debounce = null;
  const later = () => {
    clearTimeout(debounce);
    debounce = setTimeout(sync, 200);
  };
  fs.mkdirSync(serverHome, { recursive: true });
  const watcher = fs.watch(serverHome, (_, name) => name === "agent-subscriptions.json" && later());
  const timer = setInterval(sync, SYNC_MS);
  sync();

  return {
    close() {
      clearTimeout(debounce);
      clearInterval(timer);
      watcher.close();
      for (const key of [...sessions.keys()]) drop(key);
    },
  };
}

module.exports = { serve };

if (require.main === module) {
  const loaded = installedApp();
  const server = serve({ app: loaded.app });
  log("serving", loaded.app, loaded.version);
  // `ryugi update` rewrites the plugin in place; exit so launchd restarts on the new modules.
  setInterval(() => {
    let current;
    try {
      current = installedApp();
    } catch {}
    if (current && (current.app !== loaded.app || current.version !== loaded.version)) {
      log("ryugi updated, restarting for", current.app, current.version);
      server.close();
      process.exit(0);
    }
  }, SYNC_MS).unref();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      server.close();
      process.exit(0);
    });
}
