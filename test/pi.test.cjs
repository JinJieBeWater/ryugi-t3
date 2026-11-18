const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path"),
  fs = require("node:fs");
const { fixture, put, cli } = require("./fixtures.cjs");
test("Pi only registers in T3, injects a before_agent_start message and observes successful bash", async (t) => {
  const f = fixture(t);
  const handlers = {},
    pi = {
      on: (k, v) => {
        handlers[k] = v;
      },
    };
  const env = { ...f.env, AI_AGENT: "", RYUGI_T3_WATCH_BIN: cli, T3CODE_THREAD_ID: "" };
  for (const k of [
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "RYUGI_SERVER_HOME",
    "AI_AGENT",
    "RYUGI_T3_WATCH_BIN",
    "T3CODE_CLI_PATH",
    "T3CODE_HOME",
    "T3CODE_THREAD_ID",
  ]) {
    const before = process.env[k];
    t.after(() => {
      if (before === undefined) delete process.env[k];
      else process.env[k] = before;
    });
    process.env[k] = env[k];
  }
  const extension = (await import("../pi-extension.ts")).default;
  extension(pi);
  assert.deepEqual(handlers, {});
  process.env.T3CODE_THREAD_ID = "th";
  extension(pi);
  assert.equal(process.env.AI_AGENT, "pi");
  const ctx = { cwd: f.project, sessionManager: { getSessionId: () => "pi-session" } };
  assert.deepEqual(Object.keys(handlers).sort(), [
    "agent_end",
    "before_agent_start",
    "session_start",
    "tool_result",
  ]);
  await handlers.session_start({}, ctx);
  assert.equal(
    await handlers.before_agent_start({ messageType: "user", prompt: "/foo" }, ctx),
    undefined,
  );
  put(path.join(f.root, ".state/server-info"), {});
  put(path.join(f.root, ".state/whiteboard/w/selection.json"), {
    selected: [{ id: "x", type: "rect" }],
  });
  assert.equal(
    await handlers.before_agent_start({ messageType: "custom", message: {} }, ctx),
    undefined,
  );
  const event = { messageType: "user", prompt: "/foo" },
    result = await handlers.before_agent_start(event, ctx);
  assert.equal(event.prompt, "/foo");
  assert.match(result.message.content, /Selected elements/);
  const tool = {
    toolName: "bash",
    input: { command: "ryugi start --artifact whiteboard/w" },
    isError: true,
  };
  await handlers.tool_result(tool, ctx);
  assert.equal(f.json("list").length, 0);
  await handlers.tool_result({ ...tool, isError: false }, ctx);
  assert.equal(f.json("list")[0].hostReviewKey, "pi");
  const sub = path.join(f.project, "sub");
  fs.mkdirSync(sub, { recursive: true });
  await handlers.tool_result(
    {
      toolName: "exec_command",
      input: { cmd: "node ~/.gemini/config/plugins/ryugi/skills/artifacts/app/ryugi.cjs start --artifact artboard/pcc", workdir: "sub" },
      isError: false,
    },
    ctx,
  );
  assert.ok(f.json("list").some((r) => r.artifact === "artboard/pcc" && r.hostReviewKey === "pi"));
  await handlers.agent_end({}, ctx);
});
