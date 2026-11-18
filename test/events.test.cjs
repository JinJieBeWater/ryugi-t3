const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { fixture, put } = require("./fixtures.cjs");
const { scan, emptyBaseline } = require("../events.cjs");
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
