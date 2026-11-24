const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once, EventEmitter } = require("node:events");
const assert = require("node:assert/strict");
const test = require("node:test");
const { serve } = require("../serve.cjs");

const T3 = "t3:thread-1";

// A stand-in for the Ryugi hub: answers hello, records every message, and replaces older connections as the real one does.
function fakeHub(socketPath) {
  const hub = new EventEmitter();
  hub.live = new Map();
  hub.hellos = [];
  hub.server = net.createServer((socket) => {
    let buffer = "";
    let key = null;
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (message.t === "hello") {
          key = `${message.host}:${message.session}`;
          hub.live.get(key)?.end(JSON.stringify({ t: "bye", reason: "replaced" }) + "\n");
          hub.live.set(key, socket);
          hub.hellos.push(key);
        }
        hub.emit(message.t, key, message, socket);
      }
    });
    socket.on("close", () => {
      if (hub.live.get(key) === socket) hub.live.delete(key);
      hub.emit("gone", key);
    });
  });
  hub.server.listen(socketPath);
  return hub;
}

// A stand-in for `ryugi-hook watch cmd`: says hello with what it read on stdin and exits once replaced, as the real one does.
const FAKE_WATCHER = `
const net = require("node:net");
const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const socket = net.connect(process.env.RYUGI_HUB_SOCKET);
socket.write(JSON.stringify({ t: "hello", ...input, args: process.argv.slice(2) }) + "\\n");
socket.on("data", (chunk) => String(chunk).includes("replaced") && process.exit(0));
`;

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt3-"));
  const home = path.join(dir, "server");
  fs.mkdirSync(home);
  const watcher = path.join(dir, "ryugi-hook");
  fs.writeFileSync(watcher, `#!${process.execPath}\n${FAKE_WATCHER}`, { mode: 0o755 });
  const config = path.join(dir, "config.json");
  const host = (command) => fs.writeFileSync(config, JSON.stringify({ hosts: { t3: { env: "T3CODE_THREAD_ID", command: [command] } } }));
  host("/bin/true");
  const subscribe = (keys) =>
    fs.writeFileSync(
      path.join(home, "agent-subscriptions.json"),
      JSON.stringify(Object.fromEntries(keys.map((key) => [key, { items: [{ project: dir, artifact: "document/plan" }], lastSeen: 0 }]))),
    );
  const socketPath = path.join(dir, "hub.sock");
  const hub = fakeHub(socketPath);
  const env = { ...process.env, RYUGI_HUB_SOCKET: socketPath, RYUGI_SERVER_HOME: home, RYUGI_HOSTS_CONFIG: config, RYUGI_HOOK_BIN: watcher };
  t.after(() => {
    hub.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, env, hub, host, subscribe };
}

const helloFrom = (hub, key) => new Promise((resolve) => hub.on("hello", (k, message) => k === key && resolve(message)));

test("runs Ryugi's cmd watcher for each custom-host subscription", async (t) => {
  const { dir, env, hub, subscribe } = setup(t);
  subscribe([T3, "claude:other-session"]);
  const hello = helloFrom(hub, T3);
  const server = serve({ env });
  t.after(() => server.close());
  const message = await hello;
  assert.deepEqual(message.args, ["watch", "cmd"]);
  assert.equal(message.project, dir);
  assert.deepEqual(hub.hellos, [T3]);
});

test("stops the watcher when the subscription goes away", async (t) => {
  const { env, hub, subscribe } = setup(t);
  subscribe([T3]);
  const hello = helloFrom(hub, T3);
  const server = serve({ env });
  t.after(() => server.close());
  await hello;
  const gone = once(hub, "gone");
  subscribe([]);
  assert.deepEqual(await gone, [T3]);
});

test("takes the session back after a Ryugi watcher replaces it", async (t) => {
  const { env, hub, subscribe } = setup(t);
  subscribe([T3]);
  const first = helloFrom(hub, T3);
  const server = serve({ env });
  t.after(() => server.close());
  await first;
  const ryugiWatcher = net.connect(env.RYUGI_HUB_SOCKET);
  t.after(() => ryugiWatcher.destroy());
  const replaced = new Promise((resolve) => ryugiWatcher.on("data", (chunk) => String(chunk).includes("replaced") && resolve()));
  ryugiWatcher.write(JSON.stringify({ t: "hello", host: "t3", session: "thread-1" }) + "\n");
  await replaced;
  assert.deepEqual(hub.hellos, [T3, T3, T3]);
});

test("restarts the watcher when the host config changes", async (t) => {
  const { env, hub, host, subscribe } = setup(t);
  subscribe([T3]);
  const first = helloFrom(hub, T3);
  const server = serve({ env });
  t.after(() => server.close());
  await first;
  const gone = once(hub, "gone");
  const second = helloFrom(hub, T3);
  host("/bin/echo");
  subscribe([T3]);
  await Promise.all([gone, second]);
});
