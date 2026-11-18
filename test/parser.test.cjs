const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

test("extracts only literal Ryugi start invocations with their own options and working directory", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ryugi-parser-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "other project"));
  fs.mkdirSync(path.join(root, "other project/.git"));
  fs.mkdirSync(path.join(root, "other project/nested"));
  const { extractStartArtifacts } = require("../parser.cjs");
  const command = [
    'ryugi start --artifact artboard/first && echo "ryugi start --artifact document/fake"',
    'node "/plugins with spaces/ryugi.cjs" start --project-dir="other project/nested" --artifact=document/doc; ryugi get --artifact document/no',
    "ryugi start --artifact=slides/no --help; ryugi start -h --artifact=document/no",
    'ryugi start --artifact=invalid/xx; ryugi start --artifact="document/../no"',
    'cd "other project" && /local/bin/ryugi start --artifact whiteboard/w --project-dir nested',
    "cat <<'EOF'\nryugi start --artifact document/no\nEOF",
  ].join("\n");
  assert.deepEqual(extractStartArtifacts(command, root), [
    { project: root, artifact: "artboard/first" },
    { project: path.join(root, "other project"), artifact: "document/doc" },
    { project: path.join(root, "other project"), artifact: "whiteboard/w" },
  ]);
});
test("resolves HOME launcher and PWD project flags without executing shell expansions", () => {
  const { extractStartArtifacts } = require("../parser.cjs");
  const project = fs.realpathSync(process.cwd());
  assert.deepEqual(
    extractStartArtifacts(
      'node "$HOME/tools/ryugi.cjs" start --project-dir="$PWD" --artifact=slides/d',
      project,
    ),
    [{ project, artifact: "slides/d" }],
  );
});
test("recognizes the bound launcher emitted by the native Codex hook", () => {
  const { extractStartArtifacts } = require("../parser.cjs");
  const project = fs.realpathSync(process.cwd());
  const proof = "01234567-0123-4567-8901-000000000000:01234567-0123-4567-8901-000000000001";
  const cmd =
    'node "/plugins/ryugi.cjs" --ryugi-session ' + proof + " start --artifact document/proof";
  assert.deepEqual(extractStartArtifacts(cmd, project), [{ project, artifact: "document/proof" }]);
});
test("handles pipelines, subshells with scoped cwd, and absolute --project-dir after dynamic cd", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ryugi-parser-pipe-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sub = path.join(root, "sub");
  fs.mkdirSync(path.join(sub, ".git"), { recursive: true });
  const { extractStartArtifacts } = require("../parser.cjs");
  const command = [
    "(cd sub && ryugi start --artifact document/in-sub --json | jq .)",
    "ryugi start --artifact artboard/root",
    'cd "$UNKNOWN_DIR" && ryugi start --project-dir ' + JSON.stringify(sub) + " --artifact whiteboard/abs",
  ].join("\n");
  assert.deepEqual(extractStartArtifacts(command, root), [
    { project: sub, artifact: "document/in-sub" },
    { project: root, artifact: "artboard/root" },
    { project: sub, artifact: "whiteboard/abs" },
  ]);
});
