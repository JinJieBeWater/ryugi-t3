const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once, EventEmitter } = require("node:events");
const assert = require("node:assert/strict");
const test = require("node:test");
const { serve } = require("../serve.cjs");

const T3 = "t3:thread-1";
const event = (project) => ({ project, artifact: "document/plan", type: "ryugi-comments", unread: 1, threads: [] });

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
          socket.write(JSON.stringify({ t: "welcome", version: "test" }) + "\n");
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

function setup(t, { exitCode = 0, hub = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt3-"));
  const home = path.join(dir, "server");
  fs.mkdirSync(home);
  const command = path.join(dir, "deliver");
  fs.writeFileSync(
    command,
    `#!${process.execPath}\nrequire("fs").appendFileSync(${JSON.stringify(path.join(dir, "got"))}, require("fs").readFileSync(0, "utf8") + "\\n");\nprocess.exit(${exitCode});\n`,
    { mode: 0o755 },
  );
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({ hosts: { t3: { env: "T3CODE_THREAD_ID", agent: "T3 Code", command: [command] } } }));
  const subscribe = (keys) =>
    fs.writeFileSync(
      path.join(home, "agent-subscriptions.json"),
      JSON.stringify(Object.fromEntries(keys.map((key) => [key, { items: [{ project: dir, artifact: "document/plan" }], lastSeen: 0 }]))),
    );
  const socketPath = path.join(dir, "hub.sock");
  const fake = hub ? fakeHub(socketPath) : null;
  const env = { ...process.env, RYUGI_HUB_SOCKET: socketPath, RYUGI_SERVER_HOME: home, RYUGI_HOSTS_CONFIG: config };
  const got = () => fs.readFileSync(path.join(dir, "got"), "utf8").trim().split("\n").map(JSON.parse);
  t.after(() => {
    fake?.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, env, fake, subscribe, got };
}

const helloFrom = (hub, key) => (hub.live.has(key) ? Promise.resolve() : new Promise((resolve) => hub.on("hello", (k) => k === key && resolve())));

test("connects each t3 subscription, delivers its feedback through the command and acks it", async (t) => {
  const { dir, env, fake, subscribe, got } = setup(t);
  subscribe([T3, "claude:other-session"]);
  const server = serve({ env });
  t.after(() => server.close());
  await helloFrom(fake, T3);
  const socket = fake.live.get(T3);
  socket.write(JSON.stringify({ t: "event", id: 7, event: event(dir) }) + "\n");
  const [, ack] = await once(fake, "delivered");
  assert.equal(ack.id, 7);
  assert.equal(got()[0].session, "thread-1");
  assert.deepEqual(fake.hellos, [T3]);
});

test("unsubscribes when the command reports the thread is gone", async (t) => {
  const { dir, env, fake, subscribe } = setup(t, { exitCode: 10 });
  subscribe([T3]);
  const server = serve({ env });
  t.after(() => server.close());
  await helloFrom(fake, T3);
  fake.live.get(T3).write(JSON.stringify({ t: "event", id: 1, event: event(dir) }) + "\n");
  const [key] = await once(fake, "unsubscribe");
  assert.equal(key, T3);
});

test("takes the session back after a Ryugi watcher replaces it", async (t) => {
  const { env, fake, subscribe } = setup(t);
  subscribe([T3]);
  const server = serve({ env });
  t.after(() => server.close());
  await helloFrom(fake, T3);
  const ryugiWatcher = net.connect(env.RYUGI_HUB_SOCKET);
  ryugiWatcher.write(JSON.stringify({ t: "hello", protocol: 1, host: "t3", session: "thread-1", agent: "T3 Code" }) + "\n");
  const replaced = new Promise((resolve) => ryugiWatcher.on("data", (chunk) => String(chunk).includes("replaced") && resolve()));
  await replaced;
  ryugiWatcher.destroy();
  assert.deepEqual(fake.hellos, [T3, T3, T3]);
});

test("drops the connection when the subscription goes away", async (t) => {
  const { env, fake, subscribe } = setup(t);
  subscribe([T3]);
  const server = serve({ env });
  t.after(() => server.close());
  await helloFrom(fake, T3);
  const gone = once(fake, "gone");
  subscribe([]);
  assert.deepEqual(await gone, [T3]);
});

test("starts a missing hub and connects every waiting session to it", async (t) => {
  const { dir, env, subscribe } = setup(t, { hub: false });
  fs.mkdirSync(path.join(dir, ".ryugi/artifacts"), { recursive: true });
  subscribe([T3, "t3:thread-2"]);
  let hub = null;
  let up;
  const started = new Promise((resolve) => (up = resolve));
  // Like `ryugi start --background`: reuse a running hub, and resolve once it accepts connections.
  const startHub = () => {
    if (!hub) up((hub = fakeHub(env.RYUGI_HUB_SOCKET)));
    return hub.server.listening ? undefined : once(hub.server, "listening");
  };
  const server = serve({ env, startHub });
  await started;
  t.after(() => (server.close(), hub.server.close()));
  await Promise.all([helloFrom(hub, T3), helloFrom(hub, "t3:thread-2")]);
});
