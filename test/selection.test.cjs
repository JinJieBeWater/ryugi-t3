const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixture, put } = require("./fixtures.cjs");

test("selection-context prints the viewer's selections in Ryugi's format and nothing else", (t) => {
  const f = fixture(t),
    state = path.join(f.root, ".state");
  // No running Ryugi server, no selection worth reading.
  assert.equal(f.run(["selection-context", "--cwd", f.project]), "");
  put(path.join(state, "server-info"), {});
  const node = {
    id: "board#7",
    board: "board",
    tag: "button",
    file: "x.html",
    path: "main > button",
    tweaks: [],
  };
  put(path.join(state, "artboard/a/selection.json"), {
    artifact: "artboard/a",
    selected: [node],
    nodes: [node],
    tweaks: [{ ...node, property: "color", from: "red", value: "blue" }],
  });
  fs.mkdirSync(path.join(f.root, "document/d"), { recursive: true });
  put(path.join(state, "document/d/selection.json"), { quote: "selected quote", blockIds: ["b"] });
  put(path.join(state, "whiteboard/w/selection.json"), {
    selected: [{ id: "shape", type: "rect", text: "rectangle" }],
  });
  put(path.join(f.root, "document/d/comments.json"), {
    threads: [
      {
        id: "x",
        status: "open",
        anchor: {},
        messages: [{ id: "m", at: "2026-01-01", author: "human", text: "unread" }],
      },
    ],
  });
  const text = f.run(["selection-context", "--cwd", f.project]);
  for (const part of [
    "Selected nodes:",
    "board#7",
    "color: red → blue",
    "> selected quote",
    'shape rect "rectangle"',
  ])
    assert.ok(text.includes(part), part);
  assert.doesNotMatch(text, /Unread comment evidence/);
});
