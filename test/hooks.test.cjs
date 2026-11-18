const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
const { spawn } = require("node:child_process");
const { fixture, put, read, until, cli } = require("./fixtures.cjs");
const sid = "69e3e465-1102-49ed-8484-f620fa661ea4";
test("Claude Bash hook transfers only started artifact from native monitor to thread", (t) => {
  const f = fixture(t),
    session = path.join(f.root, ".state/claude-comment-watch", sid + ".json");
  put(session, { artifacts: ["artboard/a", "slides/b"], extra: 42 });
  const input = {
    cwd: f.project,
    session_id: sid,
    tool_input: { command: "ryugi start --artifact artboard/a" },
  };
  const hook = ["hook", "claude", "post-tool-use"];
  f.run(hook, input, { T3CODE_THREAD_ID: "" });
  assert.deepEqual(read(session).artifacts, ["artboard/a", "slides/b"]);
  f.run(hook, input);
  const [r] = f.json("list");
  assert.deepEqual([r.thread, r.hostReviewKey, r.artifact], ["th", "Claude Code", "artboard/a"]);
  assert.deepEqual(read(session), { artifacts: ["slides/b"], extra: 42 });
});
test("Codex gates outside T3, disambiguates running sessions by user message, caches binding and flushes", async (t) => {
  const f = fixture(t),
    requests = [];
  const srv = http.createServer((req, res) => {
    requests.push(req.url);
    res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const info = { url: "http://127.0.0.1:" + srv.address().port + "/?key=mock" };
  put(path.join(f.root, ".state/server-info"), info);
  put(path.join(f.env.RYUGI_SERVER_HOME, "server-info"), info);
  put(path.join(f.root, ".state/whiteboard/a/selection.json"), {
    selected: [{ id: "x", type: "rect" }],
  });
  f.threads[0].messages = [{ role: "user", text: "other prompt" }];
  f.threads.push({
    ...f.threads[0],
    threadId: "correct",
    messages: [{ role: "user", text: "my prompt" }],
  });
  put(path.join(f.dir, "threads"), f.threads);
  const input = { cwd: f.project, session_id: sid, prompt: "my prompt" };
  const hook = (event) => ["hook", "codex", event];
  assert.equal(
    f.run(hook("user-prompt-submit"), input, {
      T3CODE_CLI_PATH: "",
      T3CODE_DESKTOP_HOST_SCOPE: "",
    }),
    "",
  );
  assert.equal(fs.existsSync(f.state), false);
  f.run(hook("session-start"), input);
  await until(() => requests.some((p) => p.startsWith("/api/hub/projects")));
  const { hookSpecificOutput: h } = JSON.parse(f.run(hook("user-prompt-submit"), input));
  assert.equal(h.hookEventName, "UserPromptSubmit");
  assert.match(h.additionalContext, /Whiteboard whiteboard\/a/);
  f.run(hook("post-tool-use"), {
    ...input,
    prompt: undefined,
    tool_input: { command: 'node "/some/ryugi.cjs" start --artifact=slides/p' },
  });
  const [r] = f.json("list");
  assert.deepEqual([r.thread, r.hostReviewKey], ["correct", "Codex"]);
  const child = spawn(cli, hook("stop"), { env: f.env, stdio: ["pipe", "ignore", "inherit"] });
  child.stdin.end(JSON.stringify(input));
  await new Promise((r) => child.once("close", r));
  assert.ok(requests.some((p) => p.startsWith("/api/cloud/flush")));
});
test("Codex confirms an unlisted delegated thread by its T3 hint and checkout", (t) => {
  const f = fixture(t);
  f.threads[0].listed = false;
  put(path.join(f.dir, "threads"), f.threads);
  f.run(["hook", "codex", "post-tool-use"], {
    session_id: sid,
    cwd: f.project,
    tool_input: { command: "ryugi start --artifact document/delegated" },
  });
  assert.equal(f.json("list")[0]?.thread, "th");
});
test("a deleted worktree in T3 thread list leaves local viewer context available", (t) => {
  const f = fixture(t);
  f.threads[0].worktreePath = path.join(f.dir, "gone");
  put(path.join(f.dir, "threads"), f.threads);
  put(path.join(f.root, ".state/server-info"), {});
  put(path.join(f.root, ".state/whiteboard/w/selection.json"), {
    selected: [{ id: "x", type: "rect" }],
  });
  const result = f.run(["hook", "codex", "user-prompt-submit"], {
    session_id: sid,
    cwd: f.project,
    prompt: "hello",
  });
  assert.match(JSON.parse(result).hookSpecificOutput.additionalContext, /Selected elements/);
});
test("hook exits cleanly on empty or malformed stdin", (t) => {
  const f = fixture(t);
  const { spawnSync } = require("node:child_process");
  const res = spawnSync(cli, ["hook", "claude", "post-tool-use"], {
    cwd: f.project,
    env: f.env,
    input: "",
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
});
test("Codex stop hook syncs native codex-comment-watch subscriptions even when PostToolUse matcher did not fire", async (t) => {
  const f = fixture(t);
  put(path.join(f.root, ".state/codex-comment-watch", sid + ".json"), {
    artifacts: ["artboard/from-exec-cmd"],
  });
  f.run(["hook", "codex", "stop"], { cwd: f.project, session_id: sid });
  const [r] = f.json("list");
  assert.deepEqual([r.thread, r.hostReviewKey, r.artifact], ["th", "Codex", "artboard/from-exec-cmd"]);
});
