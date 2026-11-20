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
  // Heredoc bodies and here-strings are data, not commands.
  assert.deepEqual(
    commands(`cat > t.js <<'EOF'\nnode app/ryugi.cjs start --artifact document/x\nEOF\nnode a.cjs; grep x <<< "ryugi.cjs start"`, "/c"),
    [["cat"], ["node", "a.cjs"], ["grep", "x"]],
  );
  assert.deepEqual(commands(`cat <<-END && ls\n\tbody\n\tEND\npwd`, "/c"), [["cat"], ["ls"], ["pwd"]]);
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

test("~ and redirections are read the way the shell would, and the launcher the agent ran is kept", (t) => {
  const f = fixture(t);
  const home = path.dirname(f.project);
  const r = run(
    f,
    `cd ~/project && node ./skills/artifacts/app/ryugi.cjs --ryugi-session a:b start --project-dir ~/project --artifact artboard/layout 2>&1 | tail -5`,
    { HOME: home, CLAUDE_PROJECT_DIR: f.dir, RYUGI_T3_WATCH_PLUGIN: require("../plugin.cjs") },
  );
  assert.equal(r.status, 0, r.stderr);
  // The project is outside the session's, so Ryugi's own prompt hook cannot show its selection.
  assert.match(context(r), /selection-context/);
  const [s] = f.json("list");
  assert.equal(s.project, f.project);
  assert.equal(s.launcher, path.join(f.project, "skills/artifacts/app/ryugi.cjs"));
  assert.equal(s.proof, "a:b");
});

test("the selection hint is left out when Ryugi's prompt hook already covers the project", (t) => {
  const f = fixture(t);
  const r = run(f, `node app/ryugi.cjs start --project-dir . --artifact document/notes`, { CLAUDE_PROJECT_DIR: f.project }, { cwd: f.project });
  assert.match(context(r), /已订阅 document\/notes/);
  assert.doesNotMatch(context(r), /selection-context/);
});

test("a failed subscribe in Claude says to retry, not to leave a sandbox", (t) => {
  const f = fixture(t);
  const r = run(f, `node app/ryugi.cjs start --project-dir ${f.dir}/missing --artifact document/notes`);
  assert.match(context(r), /未能订阅 document\/notes[^]*运行 ryugi-t3-watch subscribe .* 重试/);
  assert.doesNotMatch(context(r), /沙盒/);
});
