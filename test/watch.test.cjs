const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { fixture, put, until } = require("./fixtures.cjs");
const { app } = require("../upstream.cjs");
const { humanTokens, reviewStateKey } = app("comment-threads");
const thread = (id, text, anchor = {}) => ({
  id,
  anchor,
  status: "open",
  messages: [{ id: "m" + id, at: "2026-01-01", text, author: "human" }],
});

test("durable launchd watcher delivers changes since subscribe, survives restart and reconciles lost output", async (t) => {
  const f = fixture(t),
    a = "artboard/layout",
    d = "document/doc";
  const stateFile = (id, name) => path.join(f.root, ".state", id, name + ".json");
  const rounds = (state) =>
    put(stateFile(a, "rounds"), { rounds: [{ id: "r", state, groups: ["g"] }] });
  const comments = (id, threads) => put(path.join(f.root, id, "comments.json"), { threads });
  const ask = (id, withdrawn) => put(stateFile(d, "asks"), { latest: { id, withdrawn } });
  const subscribe = (id) => f.json("subscribe", "--artifact", id, "--host", "pi");
  const status = (id) => f.json("status", "--artifact", id);
  const expectMessage = async (n, pattern) => {
    await until(() => f.sent().length >= n);
    assert.match(f.sent()[n - 1].text, pattern);
  };
  rounds("open");
  comments(a, [thread("old", "before")]);
  comments(d, []);
  ask("historic", false);
  subscribe(a);
  rounds("submitted"); // may happen before first worker tick
  subscribe(d);
  ask("answer", false);
  await until(() => f.sent().length === 2);
  assert.ok(f.sent().some((x) => /Ryugi choices.*submitted/.test(x.text)));
  assert.ok(f.sent().some((x) => /Ryugi answers.*answer/.test(x.text)));
  const old = status(a);
  const renewed = subscribe(a);
  assert.equal(renewed.createdAt, old.createdAt);
  assert.ok(renewed.deadline > old.deadline);
  rounds("open");
  ask("answer", true);
  await until(() => f.sent().length === 4);
  assert.ok(
    f
      .sent()
      .slice(2)
      .every((x) => x.text.includes("withdrawn")),
  );
  const draft = thread("draft", "draft comment", { group: "g" });
  comments(a, [thread("old", "before"), draft]);
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(f.sent().length, 4);
  rounds("submitted");
  await expectMessage(5, /Ryugi choices.*submitted/);
  const threads = [thread("old", "before"), draft];
  for (const [provider, key] of [
    ["codex", "Codex"],
    ["antigravity", "Antigravity"],
    ["claudeAgent", "Claude Code"],
    ["pi", "pi"],
  ]) {
    f.threads[0].providerInstanceId = provider;
    put(path.join(f.dir, "threads"), f.threads);
    // Each iteration starts with evidence read only by the current provider.
    const ack = thread("ack" + provider, "already consumed");
    const review = path.join(
      f.root,
      ".state/agent-review",
      "agent-" + reviewStateKey(a, key) + ".json",
    );
    threads.push(ack);
    put(review, { consumed: threads.flatMap(humanTokens).map((x) => x.token) });
    await new Promise((r) => setTimeout(r, 3300));
    comments(a, threads);
    const count = f.sent().length;
    await new Promise((r) => setTimeout(r, 3200));
    assert.equal(f.sent().length, count, "ack for " + key);
    threads.push(thread(provider, "new for " + key));
    comments(a, threads);
    await expectMessage(count + 1, new RegExp("new for " + key));
  }
  const count = f.sent().length;
  assert.equal(count, 9);
  f.launch("remove", f.label);
  await until(() => f.launch("list", f.label).status !== 0);
  threads.push(thread("offline", "while stopped"));
  comments(a, threads);
  fs.writeFileSync(path.join(f.dir, "lose"), "");
  subscribe(a);
  await expectMessage(count + 1, /while stopped/);
  await until(() => status(a).pending.length === 0);
  assert.equal(f.sent().length, count + 1);
  f.threads[0].archived = true;
  put(path.join(f.dir, "threads"), f.threads);
  await until(() => f.json("list").length === 0 && f.launch("list", f.label).status !== 0);
});

test("standing submit outlives stale open state, ownership transfer snapshots history", async (t) => {
  const f = fixture(t),
    a = "artboard/choice";
  const rs = path.join(f.root, ".state", a, "rounds.json"),
    cf = path.join(f.root, a, "comments.json");
  const rounds = (state) => put(rs, { rounds: [{ id: "r", state }] });
  rounds("open");
  put(cf, { threads: [] });
  f.json("subscribe", "--artifact", a);
  const record = thread("submit", "", { round: "r", submit: true });
  put(cf, { threads: [record] });
  rounds("submitted");
  await until(() => f.sent().length === 1);
  rounds("open");
  await new Promise((r) => setTimeout(r, 3200));
  rounds("submitted");
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(f.sent().length, 1);
  f.threads.push({ ...f.threads[0], threadId: "other" });
  put(path.join(f.dir, "threads"), f.threads);
  put(cf, { threads: [record, thread("prior", "prior owner")] });
  f.json("subscribe", "--thread", "other", "--artifact", a);
  put(cf, { threads: [record, thread("prior", "prior owner"), thread("new", "new owner")] });
  await until(() => f.sent().some((x) => x.thread === "other"));
  const newOwner = f.sent().filter((x) => x.thread === "other");
  assert.equal(newOwner.length, 1);
  assert.match(newOwner[0].text, /new owner/);
  assert.doesNotMatch(newOwner[0].text, /prior owner/);
  f.json("unsubscribe", "--artifact", a);
  await until(() => f.launch("list", f.label).status !== 0);
});

test("an unresolved receipt survives restart without blocking later independent feedback", async (t) => {
  const f = fixture(t),
    a = "slides/deck",
    file = path.join(f.root, a, "comments.json");
  const sub = () => f.json("subscribe", "--artifact", a);
  const pending = () => f.json("status", "--artifact", a).pending;
  sub();
  fs.writeFileSync(path.join(f.dir, "drop"), "");
  const old = thread("first", "first event");
  put(file, { threads: [old] });
  await until(() => pending()[0]?.state === "uncertain");
  f.launch("remove", f.label);
  await until(() => f.launch("list", f.label).status !== 0);
  // A killed worker can leave the write-ahead record at "sending".
  const dbFile = path.join(f.state, "subscriptions.json"),
    db = JSON.parse(fs.readFileSync(dbFile));
  db.subscriptions[0].pending[0].state = "sending";
  delete db.subscriptions[0].pending[0].retryAt;
  put(dbFile, db);
  fs.unlinkSync(path.join(f.dir, "drop"));
  sub();
  const newer = thread("second", "later feedback");
  put(file, { threads: [old, newer] });
  await until(() => f.sent().length === 1, 5500);
  assert.match(f.sent()[0].text, /later feedback/);
  await until(() => pending().length === 1 && pending()[0].state === "uncertain");
  assert.equal(pending()[0].state, "uncertain");
  assert.match(pending()[0].text, /first event/);
});
test("a provable spawn failure backs off and a later retry sends once", async (t) => {
  const f = fixture(t),
    a = "whiteboard/shape";
  f.json("subscribe", "--artifact", a);
  fs.writeFileSync(path.join(f.dir, "uninstall-once"), "");
  put(path.join(f.root, a, "comments.json"), { threads: [thread("item", "deliver once")] });
  await until(
    () =>
      fs.existsSync(f.mock + ".offline") &&
      f.json("status", "--artifact", a).pending[0]?.state === "ready",
  );
  const item = f.json("status", "--artifact", a).pending[0];
  assert.ok(item.retryAt > Date.now());
  assert.equal(f.sent().length, 0);
  fs.renameSync(f.mock + ".offline", f.mock);
  await until(() => f.sent().length === 1);
  await until(() => f.json("status", "--artifact", a).pending.length === 0);
});
test("concurrent subscriptions survive atomic writes, prune only expires elapsed leases", async (t) => {
  const f = fixture(t),
    { execFile } = require("node:child_process"),
    { promisify } = require("node:util"),
    { cli } = require("./fixtures.cjs");
  await Promise.all(
    ["a", "b", "c", "d"].map((id) =>
      promisify(execFile)(cli, ["subscribe", "--artifact", "document/" + id], {
        cwd: f.project,
        env: f.env,
      }),
    ),
  );
  assert.equal(f.json("list").length, 4);
  f.json("subscribe", "--artifact", "document/short", "--ttl", "0.1");
  await new Promise((r) => setTimeout(r, 200));
  f.json("prune");
  assert.equal(f.json("list").length, 4);
});
test("a queued comment acknowledged on the new provider is silent when transport recovers", async (t) => {
  const f = fixture(t),
    a = "document/unread";
  f.json("subscribe", "--artifact", a);
  fs.writeFileSync(path.join(f.dir, "uninstall-once"), "");
  const evidence = thread("new", "already read by Antigravity");
  put(path.join(f.root, a, "comments.json"), { threads: [evidence] });
  await until(
    () =>
      fs.existsSync(f.mock + ".offline") &&
      f.json("status", "--artifact", a).pending[0]?.state === "ready",
  );
  f.threads[0].providerInstanceId = "antigravity";
  put(path.join(f.dir, "threads"), f.threads);
  put(
    path.join(f.root, ".state/agent-review", "agent-" + reviewStateKey(a, "Antigravity") + ".json"),
    { consumed: humanTokens(evidence).map((x) => x.token) },
  );
  fs.renameSync(f.mock + ".offline", f.mock);
  await until(() => f.json("status", "--artifact", a).pending.length === 0);
  assert.equal(f.sent().length, 0);
});
test("a standing submission predating subscription stays silent when rounds.json is rebuilt", async (t) => {
  const f = fixture(t),
    a = "artboard/rewrite";
  put(path.join(f.root, a, "comments.json"), {
    threads: [thread("historic", "historic choice", { round: "r", submit: true })],
  });
  const file = path.join(f.root, ".state", a, "rounds.json");
  put(file, { rounds: [] });
  f.json("subscribe", "--artifact", a);
  put(file, { rounds: [{ id: "r", state: "submitted" }] });
  await until(() => f.json("status", "--artifact", a).baseline.roundStates.r === "submitted");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(f.sent().length, 0);
});
test("worker publishes viewer listening heartbeat while subscribed and clears it on unsubscribe", async (t) => {
  const f = fixture(t),
    a = "artboard/live",
    dir = path.join(f.root, ".state/codex-comment-watch"),
    sub = path.join(dir, "ryugi-t3-watch.json"),
    alive = path.join(dir, "ryugi-t3-watch.alive");
  f.json("subscribe", "--artifact", a, "--host", "pi");
  await until(() => fs.existsSync(sub) && fs.existsSync(alive));
  assert.deepEqual(JSON.parse(fs.readFileSync(sub, "utf8")), { artifacts: [a] });
  const stamp = Number(fs.readFileSync(alive, "utf8"));
  assert.ok(Number.isFinite(stamp) && Date.now() - stamp < 10000);
  f.json("unsubscribe", "--artifact", a);
  await until(() => !fs.existsSync(sub) && !fs.existsSync(alive));
});
test("subscribe strips the artifact from every native host subscription and the worker strips it again after Ryugi re-registers", async (t) => {
  const f = fixture(t),
    a = "artboard/native",
    other = "document/keep",
    state = path.join(f.root, ".state");
  const native = (host, session) => path.join(state, host + "-comment-watch", session + ".json");
  const files = [native("claude", "c1"), native("pi", "p1"), native("codex", "x1")];
  for (const file of files) put(file, { artifacts: [a, other], updatedAt: "t" });
  const ours = native("codex", "ryugi-t3-watch");
  // A half-written Ryugi file and non-json siblings are left byte-identical.
  const partial = native("pi", "p2"),
    alive = path.join(state, "pi-comment-watch", "p1.alive");
  fs.writeFileSync(partial, '{"artifacts":["' + a);
  fs.writeFileSync(alive, a);
  f.json("subscribe", "--artifact", a);
  for (const file of files) assert.deepEqual(JSON.parse(fs.readFileSync(file)).artifacts, [other]);
  assert.deepEqual(JSON.parse(fs.readFileSync(ours)).artifacts, [a]);
  assert.equal(fs.readFileSync(partial, "utf8"), '{"artifacts":["' + a);
  assert.equal(fs.readFileSync(alive, "utf8"), a);
  // An expired subscription stops stripping.
  f.json("subscribe", "--artifact", "artboard/brief", "--ttl", "1");
  await new Promise((r) => setTimeout(r, 1200));
  put(files[0], { artifacts: ["artboard/brief"] });
  f.json("subscribe", "--artifact", a);
  assert.deepEqual(JSON.parse(fs.readFileSync(files[0])).artifacts, ["artboard/brief"]);
  put(files[1], { artifacts: [other, a] });
  await until(() => !JSON.parse(fs.readFileSync(files[1])).artifacts.includes(a));
  f.json("unsubscribe", "--artifact", a);
  put(files[2], { artifacts: [a] });
  await new Promise((r) => setTimeout(r, 3000));
  assert.deepEqual(JSON.parse(fs.readFileSync(files[2])).artifacts, [a]);
});
test("without a thread id subscribe fails with guidance and guesses no thread", (t) => {
  const f = fixture(t),
    { spawnSync } = require("node:child_process"),
    { cli } = require("./fixtures.cjs");
  f.threads.push({
    threadId: "ag",
    providerInstanceId: "antigravity",
    status: "running",
    worktreePath: f.project,
    archived: false,
  });
  put(path.join(f.dir, "threads"), f.threads);
  const r = spawnSync(cli, ["subscribe", "--artifact", "artboard/orphan"], {
    cwd: f.project,
    env: { ...f.env, T3CODE_THREAD_ID: "" },
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /orchestrator_capabilities/);
  assert.ok(!f.json("list").some((s) => s.artifact === "artboard/orphan"));
});

test("worker flushes the project once when its subscribed thread stops running", async (t) => {
  const f = fixture(t),
    http = require("node:http"),
    hits = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/cloud/flush")) hits.push(req.headers["x-ryugi-project"]);
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const info = { url: "http://127.0.0.1:" + server.address().port + "/?key=test" };
  put(path.join(f.env.RYUGI_SERVER_HOME, "server-info"), info);
  put(path.join(f.root, ".state/server-info"), info);
  f.json("subscribe", "--artifact", "artboard/flush");
  await new Promise((r) => setTimeout(r, 2600));
  assert.equal(hits.length, 0);
  f.threads[0].status = "completed";
  put(path.join(f.dir, "threads"), f.threads);
  await until(() => hits.length === 1);
  await new Promise((r) => setTimeout(r, 3000));
  assert.deepEqual(hits, [encodeURIComponent(f.project)]);
});
test("a store written by the hook era keeps working and drops its session bindings", (t) => {
  const f = fixture(t),
    store = path.join(f.state, "subscriptions.json");
  put(store, { subscriptions: [], sessions: { '["base","s"]': "th" } });
  assert.deepEqual(f.json("list"), []);
  f.json("subscribe", "--artifact", "artboard/legacy");
  const saved = JSON.parse(fs.readFileSync(store, "utf8"));
  assert.equal(saved.sessions, undefined);
  assert.deepEqual(
    saved.subscriptions.map((s) => s.artifact),
    ["artboard/legacy"],
  );
});
test("subscribe on an artifact type without feedback says no subscription is needed", (t) => {
  const f = fixture(t),
    { spawnSync } = require("node:child_process"),
    { cli } = require("./fixtures.cjs");
  const r = spawnSync(cli, ["subscribe", "--artifact", "verify/report"], {
    cwd: f.project,
    env: f.env,
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /document、artboard、whiteboard、slides/);
  assert.match(r.stderr, /verify\/report 不需要订阅/);
});
test("a submit brief renders outside the store lock and is sent inline, ahead of later feedback", async (t) => {
  const f = fixture(t),
    a = "artboard/inline",
    started = path.join(f.dir, "render-started");
  f.json("subscribe", "--artifact", a);
  f.launch("remove", f.label);
  await until(() => f.launch("list", f.label).status !== 0);
  // A killed worker can leave a submit that was detected but never rendered.
  const dbFile = path.join(f.state, "subscriptions.json"),
    db = JSON.parse(fs.readFileSync(dbFile));
  const slow = `require('fs').writeFileSync(${JSON.stringify(started)},'');setTimeout(()=>console.log('BRIEF a\\nBRIEF b'),4000)`;
  db.subscriptions[0].pending = [
    {
      id: "p1",
      kind: "choices",
      state: "ready",
      text: "bounded fallback",
      render: { type: "ryugi-choices", artifact: a, round: "r", groups: 1, command: "x", argv: ["-e", slow] },
    },
  ];
  put(dbFile, db);
  f.json("subscribe", "--artifact", a);
  await until(() => fs.existsSync(started));
  put(path.join(f.root, a, "comments.json"), { threads: [thread("later", "after submit")] });
  const t0 = Date.now();
  f.json("subscribe", "--artifact", "document/other");
  assert.ok(Date.now() - t0 < 2500, "subscribe waited on the render");
  await until(() => f.sent().length === 2);
  assert.match(f.sent()[0].text, /^Ryugi choices artboard\/inline round r submitted.*\nBRIEF a\nBRIEF b$/s);
  assert.match(f.sent()[1].text, /after submit/);
  await until(() => f.json("status", "--artifact", a).pending.length === 0);
});
