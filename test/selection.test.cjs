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

test("selection-context is the installed hook's own output, run as a plain shell without its unread reminder", (t) => {
  const f = fixture(t),
    { plugin } = require("../upstream.cjs");
  // A plugin copy whose hook marks its output, standing in for a Ryugi upgrade that changes the format.
  const copy = path.join(f.dir, "plugin");
  for (const part of ["package.json", "hooks", "skills/artifacts/app"])
    fs.cpSync(path.join(plugin, part), path.join(copy, part), { recursive: true });
  const hook = path.join(copy, "hooks/selection-context.cjs"),
    print = "  process.stdout.write(text);\n}";
  const source = fs.readFileSync(hook, "utf8");
  assert.equal(source.split(print).length, 2, "fixture expects the hook's plain-text write");
  fs.writeFileSync(hook, source.replace(print, '  process.stdout.write("FROM-HOOK\\n" + text);\n}'));
  const state = path.join(f.root, ".state");
  put(path.join(state, "server-info"), {});
  fs.mkdirSync(path.join(f.root, "document/d"), { recursive: true });
  put(path.join(state, "document/d/selection.json"), { quote: "selected quote", blockIds: ["b"] });
  put(path.join(f.root, "document/d/comments.json"), {
    threads: [{ id: "x", status: "open", anchor: {}, messages: [{ id: "m", at: "2026-01-01", author: "human", text: "unread" }] }],
  });
  const text = f.run(["selection-context", "--cwd", f.project], undefined, {
    RYUGI_T3_PLUGIN: copy,
    // An Antigravity agent shell: the hook would answer in JSON and start Antigravity's own watcher.
    ANTIGRAVITY_AGENT: "1",
    ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:1",
    ANTIGRAVITY_CONVERSATION_ID: "00000000-0000-4000-8000-000000000000",
  });
  assert.match(text, /^FROM-HOOK\n/);
  assert.match(text, /> selected quote/);
  assert.doesNotMatch(text, /Unread comment evidence|injectSteps/);
});
