const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fixture } = require("./fixtures.cjs");
const hook = path.join(__dirname, "..", "claude-hook.cjs");

// Runs the SessionStart hook, then a Bash command the way Claude does: env file sourced first.
function session(f, cwd, extra = {}, install = true) {
  const file = path.join(f.dir, "claude-env.sh");
  fs.rmSync(file, { force: true });
  const env = {
    ...f.env,
    CLAUDE_ENV_FILE: file,
    XDG_DATA_HOME: path.join(f.dir, "data"),
    RYUGI_T3_PLUGIN: require("../upstream.cjs").plugin,
    ...extra,
  };
  delete env.NODE_OPTIONS;
  if (install) require("../entry.cjs").install(env);
  const r = spawnSync(process.execPath, [hook], {
    env,
    input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const bash = (command) =>
    spawnSync("/bin/bash", ["-c", `[ -f "$CLAUDE_ENV_FILE" ] && . "$CLAUDE_ENV_FILE"; ${command}`], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 15000,
    });
  return { file, bash };
}
function launcher(f) {
  const file = path.join(f.dir, "plugin dir/skills/artifacts/app/ryugi.cjs");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "console.log(JSON.stringify({ok:true}))");
  return file;
}

test("a Claude session in T3 loads the preload, so ryugi start subscribes like under other providers", (t) => {
  const f = fixture(t),
    other = path.join(f.dir, "other");
  fs.mkdirSync(path.join(other, ".ryugi/artifacts"), { recursive: true });
  const s = session(f, f.project);
  const run = (project, artifact) =>
    s.bash(`node ${JSON.stringify(launcher(f))} --ryugi-session a:b start --project-dir ${JSON.stringify(project)} --artifact ${artifact}`);
  const own = run(f.project, "artboard/layout");
  assert.equal(own.status, 0, own.stderr);
  assert.deepEqual(JSON.parse(own.stdout), { ok: true });
  assert.match(own.stderr, /已订阅 artboard\/layout/);
  // Ryugi's own prompt hook already shows this project's selection to Claude.
  assert.doesNotMatch(own.stderr, /selection-context/);
  const away = run(other, "document/notes");
  assert.match(away.stderr, /已订阅 document\/notes[^]*selection-context/);
  const subs = f.json("list");
  assert.deepEqual(
    subs.map((x) => [x.artifact, x.project, x.thread, x.proof]),
    [
      ["artboard/layout", f.project, "th", "a:b"],
      ["document/notes", other, "th", "a:b"],
    ],
  );
  assert.equal(subs[0].launcher, launcher(f));
  // Other node commands are untouched.
  const plain = s.bash(`node -e "console.log(1)"`);
  assert.equal(plain.stdout, "1\n");
  assert.equal(plain.stderr, "");
});

test("outside T3, or before `ryugi-t3 install`, the hook writes nothing", (t) => {
  const f = fixture(t);
  assert.ok(!fs.existsSync(session(f, f.project, { T3CODE_THREAD_ID: "" }).file));
  fs.rmSync(path.join(f.dir, "data"), { recursive: true });
  assert.ok(!fs.existsSync(session(f, f.project, {}, false).file));
});
