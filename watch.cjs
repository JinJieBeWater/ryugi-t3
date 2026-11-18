const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const { setTimeout: sleep } = require("node:timers/promises");
const { randomUUID } = require("node:crypto");
const { projectRoot, aliveFile, beat, subscriptionFile, app } = require("./upstream.cjs");
const { unreadCount } = app("comment-watch");
const { postToServer } = app("agent-event");
const { atomic, stateRoot, locked, load, label } = require("./store.cjs");
const { scan, emptyBaseline } = require("./events.cjs");
const watchId = "ryugi-t3-watch";
const artifactPattern = /^(?:document|artboard|whiteboard|slides)\/[a-z0-9][a-z0-9-]*$/;
const keys = {
  antigravity: "Antigravity",
  codex: "Codex",
  claudeAgent: "Claude Code",
  pi: "pi",
  grok: "Grok",
};
// While T3 owns an artifact, Ryugi's per-session watchers must not wake their host too.
// Session ids are unreliable under T3 (Codex binds by app-server), so strip every host session.
function stripNative(project, owned, ours) {
  const state = path.join(project, ".ryugi/artifacts/.state");
  let dirs = [];
  try {
    dirs = fs.readdirSync(state).filter((d) => d.endsWith("-comment-watch"));
  } catch {}
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(state, dir)).filter((n) => n.endsWith(".json"));
    } catch {}
    for (const name of names) {
      const file = path.join(state, dir, name);
      if (file === ours) continue;
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!Array.isArray(data?.artifacts) || !data.artifacts.some((a) => owned.has(a))) continue;
        atomic(file, { ...data, artifacts: data.artifacts.filter((a) => !owned.has(a)) });
      } catch {
        // A partial write by Ryugi is retried on the next pass.
      }
    }
  }
}
function syncProjectHeartbeat(project, subscriptions, now = Date.now()) {
  const subFile = subscriptionFile(project, "codex", watchId);
  const alive = aliveFile(project, "codex", watchId);
  const artifacts = [
    ...new Set(
      subscriptions
        .filter((r) => r.project === project && r.deadline > now)
        .map((r) => r.artifact),
    ),
  ].sort();
  if (!artifacts.length || !fs.existsSync(path.join(project, ".ryugi/artifacts"))) {
    fs.rmSync(subFile, { force: true });
    fs.rmSync(alive, { force: true });
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(subFile), { recursive: true });
    let same = false;
    try {
      const prev = JSON.parse(fs.readFileSync(subFile, "utf8"))?.artifacts;
      same = Array.isArray(prev) && JSON.stringify(prev) === JSON.stringify(artifacts);
    } catch {}
    if (!same) atomic(subFile, { artifacts });
    beat(project, "codex", watchId, now);
    stripNative(project, new Set(artifacts), subFile);
    return true;
  } catch {
    return false;
  }
}
const transport = () => ({
  base: path.resolve(process.env.T3CODE_HOME || path.join(os.homedir(), ".t3")),
  t3: process.env.T3CODE_CLI_PATH || path.join(os.homedir(), ".t3/bin/t3"),
});
function call(record, op, ...args) {
  const out = execFileSync(
    record.t3,
    ["thread", op, "--base-dir", record.base, "--json", ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return JSON.parse(out);
}
function show(r, n) {
  const detail = call(r, "show", "--messages", String(n), r.thread);
  if (detail.thread?.threadId !== r.thread) throw new Error("T3 returned a different thread");
  return detail;
}
const launch = (...args) => spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 5000 });
function ensureJob() {
  if (launch("list", label).status === 0) return;
  const r = launch(
    "submit",
    "-l",
    label,
    "--",
    "/usr/bin/env",
    "HOME=" + os.homedir(),
    "PATH=" + (process.env.PATH || ""),
    "XDG_STATE_HOME=" + path.dirname(stateRoot),
    process.execPath,
    path.join(__dirname, "cli.cjs"),
    "worker",
  );
  if (r.status !== 0) throw new Error(r.stderr || "launchctl submit failed");
}
function identity(opts) {
  const project = projectRoot(opts.project || opts.cwd || process.cwd()),
    artifact = opts.artifact;
  if (!artifactPattern.test(artifact)) throw new Error("Expected --artifact <type>/<id>");
  return { project, artifact };
}
const find = (db, key) =>
  db.subscriptions.find((r) => r.project === key.project && r.artifact === key.artifact);
// Antigravity runs commands inside agy, which does not inherit T3CODE_THREAD_ID.
// The caller is running, so a single running Antigravity thread in this project is it.
function antigravityThread(route, project) {
  let rows = [],
    failure = "";
  try {
    rows = call(route, "list", "--project", project);
  } catch (e) {
    failure = e.message;
  }
  const ids = rows
    .filter((r) => r.providerInstanceId === "antigravity" && r.status === "running" && !r.archived)
    .filter((r) => {
      try {
        const where =
          r.worktreePath === undefined
            ? show({ ...route, thread: r.threadId }, 0).thread.worktreePath
            : r.worktreePath;
        if (!where) return true;
        // The artifact project may be a subdirectory of the thread's checkout.
        const rel = path.relative(projectRoot(where), project);
        return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
      } catch {
        return false;
      }
    })
    .map((r) => r.threadId);
  return { thread: ids.length === 1 ? ids[0] : null, failure };
}
function subscribe(opts) {
  const key = identity(opts);
  const route = transport();
  route.base = path.resolve(opts["base-dir"] || route.base);
  let thread = opts.thread || process.env.T3CODE_THREAD_ID,
    failure = "";
  if (!thread) ({ thread, failure } = antigravityThread(route, key.project));
  if (!thread)
    throw new Error(
      "这个 shell 里没有 T3 线程 ID。在 T3 线程里（例如 Antigravity）时，先调用 T3 工具 orchestrator_capabilities，用返回的 parentThreadId 重试：ryugi-t3-watch subscribe --thread <parentThreadId> --artifact " +
        key.artifact +
        (failure ? "\n（查找 Antigravity 线程时 t3 thread list 失败：" + failure + "）" : ""),
    );
  const ttl = Number(opts.ttl ?? 7 * 86400);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("Expected positive TTL in seconds");
  return locked((db, save) => {
    const now = Date.now();
    let r = find(db, key);
    if (!r || r.thread !== thread || r.base !== route.base || r.deadline <= now) {
      const baseline = emptyBaseline();
      scan(key.project, key.artifact, opts.host, baseline, true);
      db.subscriptions = db.subscriptions.filter((other) => other !== r);
      r = { ...key, thread, createdAt: now, baseline, pending: [], generation: randomUUID() };
      db.subscriptions.push(r);
    }
    Object.assign(r, route, {
      hostReviewKey: opts.host || r.hostReviewKey || "Codex",
      updatedAt: now,
      deadline: now + ttl * 1000,
    });
    save();
    syncProjectHeartbeat(key.project, db.subscriptions, now);
    ensureJob();
    return r;
  });
}
function inspect(op, opts) {
  if (op === "list") return load().subscriptions;
  if (op === "status") return find(load(), identity(opts)) || null;
  return locked((db, save) => {
    const now = Date.now(),
      old = db.subscriptions.length,
      target = op === "unsubscribe" ? find(db, identity(opts)) : null,
      touched = new Set(db.subscriptions.map((r) => r.project));
    db.subscriptions = db.subscriptions.filter((r) =>
      op === "prune" ? r.deadline > now : r !== target,
    );
    save();
    for (const project of touched) syncProjectHeartbeat(project, db.subscriptions, now);
    return { removed: old - db.subscriptions.length };
  });
}
const matching = (messages, text) =>
  messages.filter((m) => m.role === "user" && m.text === text).map((m) => m.runId || "");
function backoff(item) {
  item.attempts = (item.attempts || 0) + 1;
  item.retryAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(6, item.attempts - 1));
}
function deliver(r, db, save) {
  const preceding = new Set();
  const index = r.pending.findIndex((item) => {
    const duplicate = preceding.has(item.text);
    preceding.add(item.text);
    return !duplicate && !(item.retryAt > Date.now());
  });
  if (index < 0) return;
  const item = r.pending[index];
  // Only a new user message can confirm this delivery, even for identical re-submits.
  const detail = show(r, 50);
  if (detail.thread.archived) {
    db.subscriptions = db.subscriptions.filter((s) => s.base !== r.base || s.thread !== r.thread);
    save();
    return;
  }
  const evidence = matching(detail.messages, item.text);
  if (item.state === "sending" || item.state === "uncertain") {
    const previous = [...(item.before || [])];
    const found = evidence.some((run) => {
      const i = previous.indexOf(run);
      if (i < 0) return true;
      previous.splice(i, 1);
      return false;
    });
    if (found) r.pending.splice(index, 1);
    else {
      item.state = "uncertain";
      backoff(item);
    }
    save();
    return;
  }
  const host = keys[detail.thread.providerInstanceId] || r.hostReviewKey;
  if (item.kind === "comments" && unreadCount(r.project, r.artifact, host) === 0) {
    r.pending.splice(index, 1);
    save();
    return;
  }
  Object.assign(item, { state: "sending", before: evidence });
  save();
  try {
    const ack = call(r, "send", r.thread, item.text);
    if (
      ack.threadId !== r.thread ||
      !ack.messageId ||
      !["started", "queued"].includes(ack.delivery)
    )
      throw Error("Missing T3 receipt");
    r.pending.splice(index, 1);
  } catch (e) {
    item.state = ["ENOENT", "EACCES", "EAGAIN", "EMFILE", "ENFILE"].includes(e.code)
      ? "ready"
      : "uncertain";
    backoff(item);
  }
  save();
}
async function worker() {
  let lastActive = Date.now();
  const cache = new Map(),
    statuses = new Map(),
    trackedProjects = new Set();
  while (true) {
    const snapshot = load().subscriptions;
    for (const entry of snapshot) trackedProjects.add(entry.project);
    for (const entry of snapshot) {
      const cacheKey = JSON.stringify([entry.base, entry.thread]);
      let cached = cache.get(cacheKey);
      try {
        if (!cached || cached.until < Date.now()) {
          cached = { thread: show(entry, 0).thread, until: Date.now() + 2000 };
          cache.set(cacheKey, cached);
          // A finished turn publishes now instead of waiting for Ryugi's idle timer.
          const was = statuses.get(cacheKey);
          statuses.set(cacheKey, cached.thread.status);
          if (was === "running" && cached.thread.status !== "running") {
            const owned = snapshot.filter(
              (s) => s.base === entry.base && s.thread === entry.thread && s.deadline > Date.now(),
            );
            for (const project of new Set(owned.map((s) => s.project)))
              void postToServer(project, "/api/cloud/flush");
          }
        }
        locked((db, save) => {
          const r = find(db, entry);
          if (r?.generation !== entry.generation) return;
          if (cached.thread.archived) {
            db.subscriptions = db.subscriptions.filter(
              (s) => s.base !== r.base || s.thread !== r.thread,
            );
            save();
            return;
          }
          if (r.deadline <= Date.now()) return;
          const before = JSON.stringify(r.baseline);
          const host = keys[cached.thread.providerInstanceId] || r.hostReviewKey;
          const changes = scan(r.project, r.artifact, host, r.baseline);
          for (const event of changes) r.pending.push({ ...event, state: "ready" });
          if (changes.length || JSON.stringify(r.baseline) !== before) {
            lastActive = Date.now();
            save();
          }
          deliver(r, db, save);
        });
      } catch (e) {
        // Re-read on the next pass. Keep the last good baseline after a partial file write.
        cache.delete(cacheKey);
      }
    }
    if (
      locked((db, save) => {
        const now = Date.now(),
          active = db.subscriptions.filter((r) => r.deadline > now);
        if (active.length !== db.subscriptions.length) {
          db.subscriptions = active;
          save();
        }
        for (const r of active) trackedProjects.add(r.project);
        for (const project of [...trackedProjects]) {
          if (!syncProjectHeartbeat(project, active, now)) trackedProjects.delete(project);
        }
        if (active.length) return false;
        launch("remove", label);
        return true;
      })
    )
      return;
    await sleep(Date.now() - lastActive < 30000 ? 1000 : 2500);
  }
}
module.exports = { subscribe, inspect, transport, call, show, worker };
