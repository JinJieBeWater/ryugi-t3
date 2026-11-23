const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const test = require("node:test");

const deliver = path.join(__dirname, "..", "ryugi-t3");
const THREAD = "thread-1";
const MESSAGE = "Ryugi choices artboard/layout round r1 submitted (1 group). Draw the next round.";

// A stand-in for the T3 CLI: threads and the send outcome come from state.json, every call lands in calls.jsonl.
const FAKE_T3 = `
const fs = require("node:fs"), path = require("node:path");
const dir = __dirname, args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const stdin = args.at(-1) === "-" ? fs.readFileSync(0, "utf8") : null;
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, stdin }) + "\\n");
const id = args.at(args[1] === "send" ? -2 : -1);
const thread = state.threads[id];
if (!thread) {
  process.stderr.write("Thread " + id + " is no longer available.\\n");
  process.exit(1);
}
if (args[1] === "show") {
  console.log(JSON.stringify({ thread: { threadId: id, archived: !!thread.archived }, messages: thread.messages || [] }));
} else if (state.send === "lost-receipt") {
  thread.messages = [...(thread.messages || []), { role: "user", text: stdin }];
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  process.exit(1);
} else if (state.send === "fail") {
  process.stderr.write("server unavailable\\n");
  process.exit(1);
} else {
  console.log(JSON.stringify({ threadId: id, messageId: "m1", delivery: state.delivery || "queued" }));
}
`;

function run(t, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ryugi-t3-deliver-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const t3 = path.join(dir, "t3");
  fs.writeFileSync(t3, "#!" + process.execPath + "\n" + FAKE_T3, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  const result = spawnSync(deliver, [], {
    input: JSON.stringify({ protocol: 1, host: "t3", session: THREAD, wakeMessage: MESSAGE, event: {} }),
    // Agent shells from the old bridge still carry this; delivery must not depend on the file existing.
    env: { ...process.env, T3CODE_CLI_PATH: t3, T3CODE_HOME: dir, NODE_OPTIONS: "--require /nonexistent/preload.cjs" },
    encoding: "utf8",
  });
  const calls = fs.existsSync(path.join(dir, "calls.jsonl"))
    ? fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
    : [];
  return { ...result, sends: calls.filter((c) => c.args[1] === "send"), dir };
}

// T3 answers started for an idle thread, queued behind a running turn, and steered or restarted when it folds the message into one.
for (const delivery of ["started", "queued", "steered", "restarted"])
  test(`sends the wake message to the session's thread and reports a ${delivery} delivery`, (t) => {
    const r = run(t, { threads: { [THREAD]: {} }, delivery });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { status: delivery });
    assert.equal(r.sends.length, 1);
    assert.deepEqual(r.sends[0].args, ["thread", "send", "--base-dir", r.dir, "--json", THREAD, "-"]);
    assert.equal(r.sends[0].stdin, MESSAGE);
  });

for (const [name, threads] of [
  ["an archived thread", { [THREAD]: { archived: true } }],
  ["a thread T3 no longer has", {}],
])
  test(`unsubscribes from ${name} without sending`, (t) => {
    const r = run(t, { threads });
    assert.equal(r.status, 10, r.stderr);
    assert.equal(r.sends.length, 0);
  });

test("a send whose receipt was lost counts as delivered once the message is in the thread", (t) => {
  const r = run(t, { threads: { [THREAD]: {} }, send: "lost-receipt" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.sends.length, 1);
});

test("a failed send exits non-zero so Ryugi retries it", (t) => {
  const r = run(t, { threads: { [THREAD]: {} }, send: "fail" });
  assert.notEqual(r.status, 0);
  assert.notEqual(r.status, 10);
  assert.match(r.stderr, /server unavailable/);
});
