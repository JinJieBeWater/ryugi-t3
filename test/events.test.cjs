const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { fixture, put } = require("./fixtures.cjs");
const { scan, emptyBaseline, render } = require("../events.cjs");
const { app } = require("../upstream.cjs");
const { createCommentWatch, wakeMessage } = app("comment-watch");

for (const type of ["document", "artboard", "whiteboard", "slides"]) {
  test(type + " replies, edits and status match the Ryugi watcher, excluding ask records", (t) => {
    const f = fixture(t),
      artifact = type + "/design";
    const file = path.join(f.root, artifact, "comments.json");
    const baseline = emptyBaseline(),
      native = createCommentWatch(f.project, "pi");
    const human = { id: "thread", anchor: {}, status: "open", messages: [] };
    const threads = [human];
    put(file, { threads });
    native(new Set([artifact]));
    scan(f.project, artifact, "pi", baseline, true);
    function verify(count) {
      put(file, { threads });
      const expected = native(new Set([artifact])).map((event) => wakeMessage(event, 500));
      assert.equal(expected.length, count);
      assert.deepEqual(
        scan(f.project, artifact, "pi", baseline).map((event) => event.text),
        expected,
      );
    }
    human.messages.push({ id: "initial", at: "2026-01-01", author: "human", text: "first" });
    verify(1);
    threads.push({
      id: "ask",
      anchor: { ask: "q" },
      status: "open",
      messages: [{ id: "draft", author: "human", text: "unsubmitted answer" }],
    });
    verify(0);
    human.messages.push({ id: "reply", at: "2026-01-02", author: "human", text: "reply" });
    verify(1);
    Object.assign(human.messages[1], { text: "edited", editedAt: "2026-01-03" });
    verify(1);
    Object.assign(human, { status: "reopened", statusBy: "human", statusAt: "2026-01-04" });
    verify(1);
    Object.assign(human, { status: "resolved", statusBy: "agent" });
    verify(0);
  });
}

test("submit events carry the native watcher's list argv and render inlines the brief", (t) => {
  const f = fixture(t),
    a = "artboard/pick",
    d = "document/ask";
  put(path.join(f.root, a, "comments.json"), { threads: [] });
  put(path.join(f.root, ".state", a, "rounds.json"), { rounds: [{ id: "r", state: "open" }] });
  put(path.join(f.root, d, "comments.json"), { threads: [] });
  const native = createCommentWatch(f.project, "pi"),
    set = new Set([a, d]);
  const ba = emptyBaseline(),
    bd = emptyBaseline();
  native(set);
  scan(f.project, a, "pi", ba, true);
  scan(f.project, d, "pi", bd, true);
  put(path.join(f.root, ".state", a, "rounds.json"), { rounds: [{ id: "r", state: "submitted" }] });
  put(path.join(f.root, ".state", d, "asks.json"), { latest: { id: "s1" } });
  const expected = native(set);
  const ours = [...scan(f.project, a, "pi", ba), ...scan(f.project, d, "pi", bd)];
  assert.equal(ours.length, 2);
  for (const item of ours) {
    const twin = expected.find((e) => e.type === "ryugi-" + item.kind);
    assert.deepEqual(item.render.argv, twin.argv);
    assert.equal(item.text, wakeMessage(twin, 500));
  }
  const choice = ours[0].render;
  const inline = render({ ...choice, argv: ["-e", "console.log('BRIEF one\\nBRIEF two')"] });
  assert.match(inline, /^Ryugi choices artboard\/pick round r submitted/);
  assert.match(inline, /\nBRIEF one\nBRIEF two$/);
  assert.doesNotMatch(inline, /Run:/);
  // Without a running Ryugi server the list fails and the message keeps the Run command.
  assert.match(render(choice), /Run: node /);
});

test("withdrawals and comments stay bounded and are not rendered", (t) => {
  const f = fixture(t),
    a = "artboard/back";
  const rounds = (state) => put(path.join(f.root, ".state", a, "rounds.json"), { rounds: [{ id: "r", state }] });
  put(path.join(f.root, a, "comments.json"), { threads: [] });
  rounds("submitted");
  const b = emptyBaseline();
  scan(f.project, a, "pi", b, true);
  rounds("open");
  put(path.join(f.root, a, "comments.json"), {
    threads: [{ id: "c", anchor: {}, status: "open", messages: [{ id: "m", author: "human", text: "x" }] }],
  });
  const events = scan(f.project, a, "pi", b);
  assert.deepEqual(events.map((e) => e.kind).sort(), ["choices", "comments"]);
  assert.ok(events.every((e) => e.render === undefined));
});
