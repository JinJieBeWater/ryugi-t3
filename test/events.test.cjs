const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { fixture, put } = require("./fixtures.cjs");
const { scan, emptyBaseline, render } = require("../events.cjs");
const { app } = require("../upstream.cjs");
const { createCommentWatch, wakeMessage } = app("comment-watch");

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

test("withdrawals are bounded and not rendered, and comments alone send nothing", (t) => {
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
  assert.deepEqual(events.map((e) => e.kind), ["choices"]);
  assert.ok(events.every((e) => e.render === undefined));
});

test("Run lines use the launcher and session proof the agent started with", (t) => {
  const { scan, emptyBaseline } = require("../events.cjs");
  const f = fixture(t);
  const d = "document/bound";
  put(path.join(f.root, d, "comments.json"), { threads: [] });
  const b = emptyBaseline();
  scan(f.project, d, "Codex", b, true);
  put(path.join(f.root, ".state", d, "asks.json"), { latest: { id: "s", withdrawn: false } });
  scan(f.project, d, "Codex", b);
  put(path.join(f.root, ".state", d, "asks.json"), { latest: { id: "s", withdrawn: true } });
  const [withdrawn] = scan(f.project, d, "Codex", b, false, { launcher: "/codex/app/ryugi.cjs", proof: "x:y" });
  assert.match(withdrawn.text, /Run: node '\/codex\/app\/ryugi\.cjs' --ryugi-session x:y comment list/);
});

test("a rendered brief lists as the thread's host and names the agent's own launcher", () => {
  const { render } = require("../events.cjs");
  const before = process.env.AI_AGENT;
  const print = `console.log("Reply: node /x/ryugi.cjs comment reply; as " + process.env.AI_AGENT)`;
  const text = render({
    type: "ryugi-answers",
    artifact: "document/d",
    submit: "s",
    questions: 1,
    command: "x",
    argv: ["-e", print],
    followUp: { project: "/nowhere", host: "Codex", argv: [], command: "y" },
    rebind: { from: "/x/ryugi.cjs", to: "'/codex/ryugi.cjs' --ryugi-session a:b" },
  });
  assert.match(text, /\nReply: node '\/codex\/ryugi\.cjs' --ryugi-session a:b comment reply; as codex$/);
  assert.equal(process.env.AI_AGENT, before);
});
