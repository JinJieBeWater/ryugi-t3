const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fixture, put } = require("./fixtures.cjs");
const entry = require("../entry.cjs");

function launcher(f) {
  const file = path.join(f.dir, "plugin/skills/artifacts/app/ryugi.cjs");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "console.log(JSON.stringify({ok:true}))");
  return file;
}
const node = (f, env, args) =>
  spawnSync(process.execPath, args, {
    cwd: f.project,
    env: { ...f.env, ...env, NODE_OPTIONS: entry.nodeOptions(env) },
    encoding: "utf8",
    timeout: 15000,
  });

test("the installed stub loads the preload, so ryugi start subscribes", (t) => {
  const f = fixture(t),
    env = { XDG_DATA_HOME: path.join(f.dir, "data") };
  entry.install(env);
  const r = node(f, env, [launcher(f), "start", "--project-dir", f.project, "--artifact", "artboard/layout"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true });
  assert.match(r.stderr, /已订阅 artboard\/layout/);
  assert.deepEqual(f.json("list").map((s) => s.artifact), ["artboard/layout"]);
});

test("a missing or broken bridge leaves node working and only a ryugi start hears about it", (t) => {
  const f = fixture(t),
    env = { XDG_DATA_HOME: path.join(f.dir, "data") },
    broken = path.join(f.dir, "broken.cjs");
  for (const target of [path.join(f.dir, "gone.cjs"), broken]) {
    fs.writeFileSync(broken, "this is not javascript (");
    entry.install(env, target);
    const plain = node(f, env, ["-e", "console.log(1)"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, "1\n");
    assert.equal(plain.stderr, "");
    const r = node(f, env, [launcher(f), "start", "--artifact", "artboard/layout"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true });
    assert.match(r.stderr, /预加载失败，没有自动订阅/);
  }
  assert.deepEqual(f.json("list"), []);
});

test("doctor's entry check names providers on the stub and those still loading the checkout", (t) => {
  const f = fixture(t),
    env = { XDG_DATA_HOME: path.join(f.dir, "data"), T3CODE_HOME: path.join(f.dir, "t3home") },
    settings = path.join(env.T3CODE_HOME, "userdata/settings.json"),
    write = (pi) =>
      put(settings, {
        providerInstances: {
          codex: { driver: "codex", environment: [{ name: "NODE_OPTIONS", value: entry.nodeOptions(env) }] },
          pi: { driver: "pi", environment: [{ name: "NODE_OPTIONS", value: pi }] },
          claudeAgent: {
            driver: "claudeAgent",
            config: { launchArgs: "--settings " + path.join(__dirname, "..", "claude-settings.json") },
          },
        },
      });
  entry.install(env);
  write("--require " + entry.preload);
  assert.throws(() => entry.entries(env), /pi 仍直接加载/);
  write(entry.nodeOptions(env));
  assert.equal(entry.entries(env), "codex、pi、claudeAgent 会自动订阅");
  fs.rmSync(entry.stubPath(env));
  assert.throws(() => entry.entries(env), /缺少 .*preload\.cjs/);
});
