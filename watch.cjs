const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { randomUUID } = require("node:crypto");
const { projectRoot, aliveFile, beat, subscriptionFile, app } = require("./upstream.cjs");
const { postToServer } = app("agent-event");
const { createCommentWatch } = app("comment-watch");
const { atomic, stateRoot, locked, load, label, launch } = require("./store.cjs");
const { message, render } = require("./events.cjs");
const { transport, call, show } = require("./t3.cjs");
const { fingerprint } = require("./doctor.cjs");
const watchId = "ryugi-t3-watch";
const idlePoll = 20000;
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
    ...(process.env.RYUGI_T3_WATCH_PLUGIN
      ? ["RYUGI_T3_WATCH_PLUGIN=" + process.env.RYUGI_T3_WATCH_PLUGIN]
      : []),
    process.execPath,
    path.join(__dirname, "cli.cjs"),
    "worker",
  );
  if (r.status !== 0) throw new Error(r.stderr || "launchctl submit failed");
}
function identity(opts) {
  const project = projectRoot(opts.project || opts.cwd || process.cwd()),
    artifact = opts.artifact;
  // Same types as Ryugi's own comment subscriptions; other artifacts send no feedback.
  if (!artifactPattern.test(artifact))
    throw new Error(
      /^[a-z]+\/[a-z0-9][a-z0-9-]*$/.test(artifact || "")
        ? `Ryugi 只回传 document、artboard、whiteboard、slides 的反馈，${artifact} 不需要订阅`
        : "Expected --artifact <type>/<id>",
    );
  return { project, artifact };
}
const find = (db, key) =>
  db.subscriptions.find((r) => r.project === key.project && r.artifact === key.artifact);
function subscribe(opts) {
  const key = identity(opts);
  const route = transport();
  route.base = path.resolve(opts["base-dir"] || route.base);
  const thread = opts.thread || process.env.T3CODE_THREAD_ID;
  if (!thread)
    throw new Error(
      "这个 shell 里没有 T3 线程 ID。在 T3 线程里（例如 Grok）时，先调用 T3 工具 orchestrator_capabilities，用返回的 parentThreadId 重试：ryugi-t3-watch subscribe --thread <parentThreadId> --artifact " +
        key.artifact,
    );
  const ttl = Number(opts.ttl ?? 7 * 86400);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("Expected positive TTL in seconds");
  return locked((db, save) => {
    const now = Date.now();
    let r = find(db, key);
    if (!r || r.thread !== thread || r.base !== route.base || r.deadline <= now) {
      db.subscriptions = db.subscriptions.filter((other) => other !== r);
      r = { ...key, thread, createdAt: now, pending: [], generation: randomUUID() };
      db.subscriptions.push(r);
    }
    // The launcher the agent ran start with (and Codex's session proof) goes into Run lines it is shown.
    if (opts.launcher) {
      r.launcher = path.resolve(opts.launcher);
      r.proof = opts["ryugi-session"] || undefined;
    }
    Object.assign(r, route, {
      updatedAt: now,
      ttl,
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
      target = find(db, identity(opts)),
      touched = new Set(db.subscriptions.map((r) => r.project));
    db.subscriptions = db.subscriptions.filter((r) => r !== target);
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
  // A submit still waiting for its brief keeps its place ahead of later feedback.
  if (r.pending.some((item) => item.render)) return;
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
// Fills in a submit brief outside the store lock, since Ryugi's list command can take 15 s.
function renderPending(entry) {
  for (const item of entry.pending) {
    if (!item.render) continue;
    const text = render(item.render);
    locked((db, save) => {
      const r = find(db, entry);
      const target = r?.generation === entry.generation && r.pending.find((x) => x.id === item.id);
      if (!target?.render) return;
      target.text = text;
      delete target.render;
      save();
    });
  }
}
// print is the plugin fingerprint doctor passed; any change restarts the worker under launchd.
async function worker(print) {
  let lastActive = Date.now();
  const cache = new Map(),
    statuses = new Map(),
    trackedProjects = new Set(),
    // Per subscription generation: Ryugi's watcher, whose first look is the baseline, and the
    // events it returned that are not yet in the store.
    watches = new Map(),
    inbox = new Map();
  while (true) {
    if (fingerprint() !== print) process.exit(75);
    const snapshot = load().subscriptions;
    for (const entry of snapshot) trackedProjects.add(entry.project);
    const live = new Set(snapshot.map((entry) => entry.generation));
    for (const map of [watches, inbox]) for (const id of map.keys()) if (!live.has(id)) map.delete(id);
    for (const entry of snapshot) {
      const cacheKey = JSON.stringify([entry.base, entry.thread]);
      let cached = cache.get(cacheKey);
      try {
        let poll = watches.get(entry.generation);
        if (!poll) watches.set(entry.generation, (poll = createCommentWatch(entry.project)));
        const found = poll(new Set([entry.artifact])).filter((e) => e.type !== "ryugi-comments");
        if (found.length) inbox.set(entry.generation, [...(inbox.get(entry.generation) ?? []), ...found]);
        if (!cached || cached.until < Date.now()) {
          const thread = show(entry, 0).thread;
          // Each T3 CLI call costs ~0.25 s CPU, so an idle thread with nothing to send is checked slowly.
          // Comments are still noticed every pass; only archive cleanup and turn-end flush wait.
          const busy = thread.status === "running" || entry.pending.length > 0;
          cached = { thread, until: Date.now() + (busy ? 2000 : idlePoll) };
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
        const queued = locked((db, save) => {
          const r = find(db, entry);
          if (r?.generation !== entry.generation) return false;
          if (cached.thread.archived) {
            db.subscriptions = db.subscriptions.filter(
              (s) => s.base !== r.base || s.thread !== r.thread,
            );
            save();
            return false;
          }
          if (r.deadline <= Date.now()) return false;
          // A thread still at work keeps its lease: the TTL counts from its last running turn.
          let renewed = false;
          const lease = (r.ttl ?? 7 * 86400) * 1000;
          if (cached.thread.status === "running" && r.deadline - Date.now() < lease - Math.min(60000, lease / 10)) {
            r.deadline = Date.now() + lease;
            renewed = true;
          }
          const host = keys[cached.thread.providerInstanceId] || "Codex";
          const changes = (inbox.get(r.generation) ?? []).map((event) => message(event, r, host)).filter(Boolean);
          for (const item of changes) r.pending.push({ ...item, id: randomUUID(), state: "ready" });
          if (changes.length) lastActive = Date.now();
          if (renewed || changes.length) save();
          inbox.delete(r.generation);
          deliver(r, db, save);
          return changes.length > 0;
        });
        // Sending new feedback starts a turn; watch it closely so its end still triggers the flush.
        if (queued) cache.delete(cacheKey);
        const latest = find(load(), entry);
        if (latest?.generation === entry.generation) renderPending(latest);
      } catch (e) {
        // Retried on the next pass; detected events wait in the inbox.
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
