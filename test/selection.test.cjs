const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { fixture, put } = require("./fixtures.cjs");
const { app } = require("../upstream.cjs");
const { reviewStateKey, humanTokens } = app("comment-threads");
test("prompt context preserves upstream selections, inspector and named nodes, with per-host worktree reminders", (t) => {
  const f = fixture(t),
    state = path.join(f.root, ".state");
  assert.equal(f.run(["selection-context", "--cwd", f.project, "--host", "Codex"]), "");
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
  execFileSync("git", ["init", "-q", f.project]);
  execFileSync("git", [
    "-C",
    f.project,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@local",
    "commit",
    "--allow-empty",
    "-qm",
    "test",
  ]);
  const wt = path.join(f.dir, "linked");
  execFileSync("git", ["-C", f.project, "worktree", "add", "-q", "--detach", wt]);
  const evidence = {
    id: "item",
    status: "open",
    anchor: {},
    messages: [{ author: "human", id: "m", text: "hello", at: "2026-01-01" }],
  };
  const artifact = "slides/linked",
    otherRoot = path.join(wt, ".ryugi/artifacts");
  put(path.join(otherRoot, artifact, "comments.json"), { threads: [evidence] });
  f.json("subscribe", "--project", wt, "--artifact", artifact);
  put(
    path.join(
      otherRoot,
      ".state/agent-review",
      "agent-" + reviewStateKey(artifact, "Codex") + ".json",
    ),
    { consumed: humanTokens(evidence).map((x) => x.token) },
  );
  const ctx = (host) =>
    f.run(["selection-context", "--cwd", f.project, "--host", host, "--prompt", "edit board#7"]);
  const text = ctx("pi");
  for (const part of [
    "Selected nodes:",
    "Nodes named in this message:",
    "board#7",
    "color: red → blue",
    "> selected quote",
    'shape rect "rectangle"',
    "slides/linked (1)",
  ])
    assert.ok(text.includes(part), part);
  assert.doesNotMatch(ctx("Codex"), /Unread comment evidence/);
});
test("reminds the owning thread about an explicit project-dir outside its git worktree", (t) => {
  const f = fixture(t);
  put(path.join(f.root, ".state/server-info"), {});
  const other = path.join(f.dir, "external");
  const a = "slides/explicit";
  put(path.join(other, ".ryugi/artifacts", a, "comments.json"), {
    threads: [
      {
        id: "x",
        status: "open",
        anchor: {},
        messages: [{ id: "m", at: "2026-01-01", author: "human", text: "feedback" }],
      },
    ],
  });
  f.json("subscribe", "--project", other, "--artifact", a);
  assert.match(
    f.run(["selection-context", "--cwd", f.project, "--host", "pi", "--thread", "th"]),
    /slides\/explicit \(1\)/,
  );
  assert.doesNotMatch(
    f.run(["selection-context", "--cwd", f.project, "--host", "pi", "--thread", "other"]),
    /slides\/explicit/,
  );
});
test("selection-context without --host prints selections but no unread reminders", (t) => {
  const f = fixture(t),
    state = path.join(f.root, ".state");
  put(path.join(state, "server-info"), {});
  put(path.join(state, "whiteboard/w/selection.json"), {
    selected: [{ id: "shape", type: "rect", text: "rectangle" }],
  });
  put(path.join(f.root, "document/d/comments.json"), {
    threads: [
      {
        id: "x",
        status: "open",
        anchor: {},
        messages: [{ id: "m", at: "2026-01-01", author: "human", text: "already read" }],
      },
    ],
  });
  assert.match(f.run(["selection-context", "--host", "pi"]), /Unread comment evidence/);
  const text = f.run(["selection-context"]);
  assert.match(text, /shape rect "rectangle"/);
  assert.doesNotMatch(text, /Unread comment evidence/);
});
