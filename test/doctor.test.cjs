const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fixture, put, until, cli } = require("./fixtures.cjs");
const { plugin } = require("../upstream.cjs");
const exportsLine = "module.exports = { createCommentWatch, main, unreadCount, wakeMessage };";

// A private copy of the installed plugin that a test can "upgrade" in place.
function pluginCopy(f) {
  const copy = path.join(f.dir, "plugin");
  fs.mkdirSync(copy);
  fs.copyFileSync(path.join(plugin, "package.json"), path.join(copy, "package.json"));
  fs.cpSync(path.join(plugin, "skills/artifacts/app"), path.join(copy, "skills/artifacts/app"), {
    recursive: true,
  });
  f.env.RYUGI_T3_WATCH_PLUGIN = copy;
  const watch = path.join(copy, "skills/artifacts/app/comment-watch.cjs");
  const original = fs.readFileSync(watch, "utf8");
  assert.ok(original.includes(exportsLine), "fixture expects Ryugi's comment-watch export line");
  return {
    breakIt: () =>
      fs.writeFileSync(
        watch,
        original.replace(exportsLine, "module.exports = { createCommentWatch, main, unreadCount };"),
      ),
    fix: () => fs.writeFileSync(watch, original + "\n"),
  };
}
const raw = (f, ...args) =>
  spawnSync(cli, args, { cwd: f.project, env: f.env, encoding: "utf8", timeout: 15000 });

test("doctor passes against the installed Ryugi plugin and names its version", (t) => {
  const f = fixture(t);
  const r = raw(f, "doctor");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const version = JSON.parse(fs.readFileSync(path.join(plugin, "package.json"))).version;
  assert.match(r.stdout, new RegExp("Ryugi " + version.replaceAll(".", "\\.")));
  assert.doesNotMatch(r.stdout, /✖/);
  assert.match(r.stdout, /✔ 选区对照/);
});

test("doctor uses the managed Pi plugin by default even if a Gemini copy exists", (t) => {
  const f = fixture(t);
  f.env.HOME = f.dir;
  delete f.env.RYUGI_T3_WATCH_PLUGIN;
  put(path.join(f.dir, ".gemini/config/plugins/ryugi/package.json"), { version: "1.0.0" });
  const managed = path.join(f.dir, ".local/share/ryugi/install/plugins/pi/plugin");
  put(path.join(managed, "package.json"), { version: "2.0.0" });
  fs.cpSync(path.join(plugin, "skills/artifacts/app"), path.join(managed, "skills/artifacts/app"), {
    recursive: true,
  });
  const r = raw(f, "doctor");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Ryugi 2\.0\.0/);
});

test("a plugin that drops an export fails doctor and subscribe records nothing", (t) => {
  const f = fixture(t);
  pluginCopy(f).breakIt();
  const d = raw(f, "doctor");
  assert.equal(d.status, 1);
  assert.match(d.stdout, /✖ .*wakeMessage/);
  const s = raw(f, "subscribe", "--artifact", "artboard/broken");
  assert.notEqual(s.status, 0);
  assert.match(s.stderr, /自检/);
  assert.match(s.stderr, /wakeMessage/);
  assert.deepEqual(f.json("list"), []);
  assert.notEqual(f.launch("list", f.label).status, 0);
});

test("an upgrade that breaks the bridge pauses delivery with one notice and resumes after a fix", async (t) => {
  const f = fixture(t),
    a = "document/upgrade",
    file = path.join(f.root, a, "comments.json");
  const copy = pluginCopy(f);
  const ask = (id) => put(path.join(f.root, ".state", a, "asks.json"), { latest: { id } });
  put(file, { threads: [] });
  f.json("subscribe", "--artifact", a);
  await f.settled();
  ask("before-upgrade");
  await until(() => f.sent().length === 1);
  const flag = (name, on) =>
    on ? fs.writeFileSync(path.join(f.dir, name), "") : fs.rmSync(path.join(f.dir, name));
  flag("drop", true);
  copy.breakIt();
  // The worker notices the changed plugin, restarts under launchd and tries to report.
  await until(() => f.json("list")[0].noticeTry, 30000);
  assert.equal(f.sent().length, 1);
  // A failed send is retried; one that landed without a receipt is found and not repeated.
  flag("drop", false);
  flag("lose", true);
  await until(() => f.sent().length === 2, 15000);
  assert.match(f.sent()[1].text, /ryugi-t3-watch doctor/);
  assert.match(f.sent()[1].text, /wakeMessage/);
  assert.match(f.sent()[1].text, /不会补发/);
  flag("lose", false);
  await until(() => f.json("list")[0].notice, 15000);
  assert.equal(f.sent().length, 2);
  ask("while-broken");
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(f.sent().length, 2);
  copy.fix();
  // The resumed worker starts from what the files show now; a submit made while paused is not sent.
  await f.settled();
  ask("after-fix");
  await until(() => f.sent().length === 3, 30000);
  assert.match(f.sent()[2].text, /after-fix/);
});
