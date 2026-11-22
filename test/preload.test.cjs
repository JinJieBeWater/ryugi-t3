const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fixture } = require("./fixtures.cjs");
const preload = path.join(__dirname, "..", "preload.cjs");

// A stand-in for Ryugi's launcher at the path shape the preload recognises.
function launcher(f, name, body) {
  const file = path.join(f.dir, "plugin/skills/artifacts/app", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}
const start = (f, file, args, extra = {}) =>
  spawnSync(process.execPath, [file, ...args], {
    cwd: f.project,
    env: { ...f.env, NODE_OPTIONS: `--require ${preload}`, ...extra },
    encoding: "utf8",
    timeout: 15000,
  });

test("a successful ryugi start in a T3 shell subscribes its artifact and says how to read a selection", (t) => {
  const f = fixture(t);
  const ok = launcher(f, "ryugi.cjs", "console.log(JSON.stringify({ok:true}))");
  const r = start(f, ok, ["--ryugi-session", "x", "start", "--background", "--project-dir", f.project, "--artifact", "artboard/layout"]);
  assert.equal(r.status, 0, r.stderr);
  // Ryugi's own stdout stays parseable JSON.
  assert.deepEqual(JSON.parse(r.stdout), { ok: true });
  assert.match(r.stderr, /ryugi-t3 selection-context --cwd/);
  const subs = f.json("list");
  assert.equal(subs.length, 1);
  assert.equal(subs[0].artifact, "artboard/layout");
  assert.equal(subs[0].project, f.project);
  assert.equal(subs[0].thread, "th");
});

test("the alias launcher with --artifact= and a relative project dir also subscribes", (t) => {
  const f = fixture(t);
  const ok = launcher(f, "ryugi-artifacts.cjs", "");
  const r = start(f, ok, ["start", "--artifact=document/notes", "--project-dir", "."]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    f.json("list").map((s) => [s.artifact, s.project]),
    [["document/notes", f.project]],
  );
});

test("a start run through a host's renamed skill link (Antigravity's ryugi-artifacts) subscribes", (t) => {
  const f = fixture(t);
  const real = launcher(f, "ryugi.cjs", "");
  const link = path.join(f.dir, "host/skills/ryugi-artifacts");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.dirname(path.dirname(real)), link);
  const r = start(f, path.join(link, "app/ryugi.cjs"), ["start", "--artifact", "artboard/layout"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.json("list").map((s) => s.artifact), ["artboard/layout"]);
});

test("failed starts, help, other commands, other scripts and non-T3 shells stay untouched", (t) => {
  const f = fixture(t);
  const ok = launcher(f, "ryugi.cjs", "");
  const fail = launcher(f, "ryugi-artifacts.cjs", "process.exitCode = 3");
  const other = path.join(f.dir, "other.cjs");
  fs.writeFileSync(other, "");
  const a = ["start", "--artifact", "artboard/layout"];
  const quiet = (r, status = 0) => {
    assert.equal(r.status, status, r.stderr);
    assert.equal(r.stderr, "");
  };
  quiet(start(f, fail, a), 3);
  quiet(start(f, ok, [...a, "--help"]));
  quiet(start(f, ok, ["comment", "list", "--artifact", "artboard/layout"]));
  quiet(start(f, other, a));
  quiet(start(f, ok, a, { T3CODE_THREAD_ID: "" }));
  // Types Ryugi sends no feedback for are skipped, not reported as errors.
  quiet(start(f, ok, ["start", "--artifact", "html/page"]));
  assert.deepEqual(f.json("list"), []);
});

test("a start that keeps running is subscribed before it exits", (t) => {
  const f = fixture(t);
  const slow = launcher(
    f,
    "ryugi.cjs",
    `const { execFileSync } = require("node:child_process");
     setTimeout(() => {
       const list = execFileSync(process.env.BRIDGE, ["list"], { encoding: "utf8" });
       process.stdout.write(list);
     }, 4500);`,
  );
  const r = start(f, slow, ["start", "--artifact", "artboard/live"], {
    BRIDGE: path.join(__dirname, "..", "ryugi-t3"),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout)[0]?.artifact, "artboard/live");
  assert.equal(f.json("list").length, 1);
});

test("a bridge that fails its self-check reports why on stderr without failing start", (t) => {
  const f = fixture(t);
  const ok = launcher(f, "ryugi.cjs", "");
  const r = start(f, ok, ["start", "--artifact", "artboard/layout"], {
    RYUGI_T3_PLUGIN: path.join(f.dir, "missing-plugin"),
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /ryugi-t3/);
  assert.match(r.stderr, /自检/);
  assert.deepEqual(f.json("list"), []);
});
