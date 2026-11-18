const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const stateRoot = path.resolve(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"),
  "ryugi-t3-watch",
);
const label =
  "local.ryugi-t3.watcher." + createHash("sha256").update(stateRoot).digest("hex").slice(0, 12);
const file = path.join(stateRoot, "subscriptions.json");
function atomic(file, value) {
  const tmp = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600, flush: true });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
function load() {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { subscriptions: [], sessions: {} };
    throw e;
  }
}
// shlock atomically links a PID lock and recovers it if the owner has died.
function locked(fn) {
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(stateRoot, "store.lock"),
    start = Date.now();
  while (spawnSync("/usr/bin/shlock", ["-p", String(process.pid), "-f", lock]).status !== 0) {
    if (Date.now() - start > 15000) throw new Error("Timed out acquiring subscription store lock");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  }
  try {
    const db = load();
    return fn(db, () => atomic(file, db));
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
module.exports = { atomic, load, locked, stateRoot, label };
