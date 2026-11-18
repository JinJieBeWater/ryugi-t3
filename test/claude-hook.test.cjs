const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fixture } = require("./fixtures.cjs");
const { commands } = require("../claude-hook.cjs");
const hook = path.join(__dirname, "..", "claude-hook.cjs");

const run = (f, command, extra = {}, input = {}) =>
  spawnSync(process.execPath, [hook], {
    cwd: f.dir,
    env: { ...f.env, ...extra },
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: f.dir, ...input }),
    encoding: "utf8",
    timeout: 15000,
  });
const context = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "");

test("splits a Bash line into simple commands with quotes, escapes and $PWD", () => {
  assert.deepEqual(commands(`cd "/a b" && node 'x y'/ryugi.cjs start --project-dir "$PWD/p" a\\ b; ls|wc`, "/c"), [
    ["cd", "/a b"],
    ["node", "x y/ryugi.cjs", "start", "--project-dir", "/c/p", "a b"],
    ["ls"],
    ["wc"],
  ]);
  assert.deepEqual(commands(`echo '$PWD' "$HOME"`, "/c"), [["echo", "$PWD", "$HOME"]]);
});

test("a ryugi start in Claude's Bash subscribes and hands the agent the selection hint", (t) => {
  const f = fixture(t);
  const r = run(
    f,
    `cd ${JSON.stringify(f.project)} && node ~/.claude/plugins/x/skills/artifacts/app/ryugi.cjs --ryugi-session a:b start --background --project-dir . --artifact artboard/layout`,
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(context(r), /selection-context --cwd/);
  assert.deepEqual(
    f.json("list").map((s) => [s.artifact, s.project, s.thread]),
    [["artboard/layout", f.project, "th"]],
  );
});

test("other commands, other tools, help and shells outside T3 print nothing", (t) => {
  const f = fixture(t);
  const a = `node app/ryugi.cjs start --project-dir ${f.project} --artifact artboard/layout`;
  for (const r of [
    run(f, "ls -la"),
    run(f, `node app/ryugi.cjs comment list --project-dir ${f.project} --artifact artboard/layout`),
    run(f, a + " --help"),
    run(f, a, { T3CODE_THREAD_ID: "" }),
    run(f, a, {}, { tool_name: "Read" }),
    run(f, `node app/ryugi.cjs start --project-dir ${f.project} --artifact html/page`),
  ]) {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
  }
  assert.deepEqual(f.json("list"), []);
});

test("a project dir behind a variable is not guessed; the agent is told to subscribe by hand", (t) => {
  const f = fixture(t);
  const r = run(f, `node app/ryugi.cjs start --project-dir "$PROJ" --artifact document/notes`);
  assert.match(context(r), /ryugi-t3-watch subscribe --project <项目目录> --artifact document\/notes/);
  assert.deepEqual(f.json("list"), []);
});
