const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { fixture, put } = require("./fixtures.cjs");
const { message, render } = require("../events.cjs");
const { createCommentWatch, wakeMessage } = require("../upstream.cjs");

// Ryugi's own watcher: its first look is the baseline, later looks return what changed.
function watcher(f, artifacts) {
  const native = createCommentWatch(f.project, "pi"),
    set = new Set(artifacts);
  native(set);
  return () => native(set);
}

test("a native submit becomes a message whose render inlines the brief", (t) => {
  const f = fixture(t),
    a = "artboard/pick",
    d = "document/ask";
  put(path.join(f.root, a, "comments.json"), { threads: [] });
  put(path.join(f.root, ".state", a, "rounds.json"), { rounds: [{ id: "r", state: "open" }] });
  put(path.join(f.root, d, "comments.json"), { threads: [] });
  const poll = watcher(f, [a, d]);
  put(path.join(f.root, ".state", a, "rounds.json"), { rounds: [{ id: "r", state: "submitted" }] });
  put(path.join(f.root, ".state", d, "asks.json"), { latest: { id: "s1" } });
  const events = poll();
  const ours = events.map((e) => message(e, {}, "pi"));
  assert.deepEqual(ours.map((m) => m.kind).sort(), ["answers", "choices"]);
  for (const [i, item] of ours.entries()) {
    assert.deepEqual(item.render.argv, events[i].argv);
    assert.equal(item.text, wakeMessage(events[i], 500));
  }
  const choice = ours.find((m) => m.kind === "choices").render;
  const inline = render({ ...choice, argv: ["-e", "console.log('BRIEF one\\nBRIEF two')"] });
  assert.match(inline, /^Ryugi choices artboard\/pick round r submitted/);
  assert.match(inline, /\nBRIEF one\nBRIEF two$/);
  assert.doesNotMatch(inline, /Run:/);
  // Without a running Ryugi server the list fails and the message keeps the Run command.
  assert.match(render(choice), /Run: node /);
});

test("withdrawals are not rendered, and comments alone send nothing", (t) => {
  const f = fixture(t),
    a = "artboard/back";
  const rounds = (state) => put(path.join(f.root, ".state", a, "rounds.json"), { rounds: [{ id: "r", state }] });
  put(path.join(f.root, a, "comments.json"), { threads: [] });
  rounds("submitted");
  const poll = watcher(f, [a]);
  rounds("open");
  put(path.join(f.root, a, "comments.json"), {
    threads: [{ id: "c", anchor: {}, status: "open", messages: [{ id: "m", author: "human", text: "x" }] }],
  });
  const events = poll();
  assert.deepEqual(events.map((e) => e.type).sort(), ["ryugi-choices", "ryugi-comments"]);
  const ours = events.map((e) => message(e, {}, "pi")).filter(Boolean);
  assert.deepEqual(ours.map((m) => m.kind), ["choices"]);
  assert.equal(ours[0].render, undefined);
});

test("Run lines use the launcher and session proof the agent started with", (t) => {
  const f = fixture(t);
  const d = "document/bound";
  put(path.join(f.root, d, "comments.json"), { threads: [] });
  put(path.join(f.root, ".state", d, "asks.json"), { latest: { id: "s", withdrawn: false } });
  const poll = watcher(f, [d]);
  put(path.join(f.root, ".state", d, "asks.json"), { latest: { id: "s", withdrawn: true } });
  const [event] = poll();
  const withdrawn = message(event, { launcher: "/codex/app/ryugi.cjs", proof: "x:y" }, "Codex");
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
