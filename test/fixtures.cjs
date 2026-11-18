const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const cli = path.join(__dirname, "..", "ryugi-t3-watch");
function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".new", JSON.stringify(value));
  fs.renameSync(file + ".new", file);
}
const read = (file) => JSON.parse(fs.readFileSync(file));
async function until(f, limit = 16000) {
  const end = Date.now() + limit;
  do {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < end);
  assert.fail("Timed out waiting for " + f);
}
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ryugi-t3-test-")));
  const project = path.join(dir, "project");
  const root = path.join(project, ".ryugi/artifacts");
  const state = path.join(dir, "state/ryugi-t3-watch");
  fs.mkdirSync(root, { recursive: true });
  const label =
    "local.ryugi-t3.watcher." + createHash("sha256").update(state).digest("hex").slice(0, 12);
  const launch = (...args) => spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  t.after(() => {
    launch("remove", label);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const mock = path.join(dir, "t3");
  fs.writeFileSync(
    mock,
    "#!" +
      process.execPath +
      "\n" +
      `
    const fs=require('node:fs'),p=require('node:path'),d=__dirname;
    const args=process.argv.slice(2), command=args[1];
    const config=JSON.parse(fs.readFileSync(p.join(d,'threads')));
    const log=p.join(d,'sent');
    const history=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];
    let result;
    if(command==='list') result=config.filter(t=>t.listed!==false);
    if(command==='show'){
      const thread=config.find(x=>x.threadId===args.at(-1)); if(!thread)process.exit(2);
      fs.appendFileSync(p.join(d,'shows'),args[args.indexOf('--messages')+1]+'\\n');
      if(args[args.indexOf('--messages')+1]==='50' && fs.existsSync(p.join(d,'uninstall-once'))){
        fs.unlinkSync(p.join(d,'uninstall-once'));fs.renameSync(__filename,__filename+'.offline');
      }
      result={thread,messages:[...(thread.messages||[]),...history.filter(x=>x.thread===thread.threadId)].slice(-Number(args[args.indexOf('--messages')+1]))};
    }
    if(command==='send'){
      const thread=args.at(-2);
      if(fs.existsSync(p.join(d,'drop')))process.exit(1);
      fs.appendFileSync(log,JSON.stringify({thread,text:args.at(-1),role:'user'})+'\\n');
      if(fs.existsSync(p.join(d,'lose')))process.exit(1);
      result={threadId:thread,messageId:'msg'+history.length,delivery:'queued'};
    }
    console.log(JSON.stringify(result));
  `,
    { mode: 0o755 },
  );
  const threads = [
    {
      threadId: "th",
      providerInstanceId: "codex",
      status: "running",
      worktreePath: project,
      archived: false,
    },
  ];
  put(path.join(dir, "threads"), threads);
  const env = {
    ...process.env,
    XDG_STATE_HOME: path.dirname(state),
    XDG_CONFIG_HOME: path.join(dir, "config"),
    RYUGI_SERVER_HOME: path.join(dir, "hub"),
    T3CODE_THREAD_ID: "th",
    T3CODE_HOME: path.join(dir, "base"),
    T3CODE_CLI_PATH: mock,
  };
  function run(args, input, extra = {}) {
    const result = spawnSync(cli, args, {
      cwd: project,
      env: { ...env, ...extra },
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout.trimEnd();
  }
  const json = (...args) => JSON.parse(run(args));
  const sent = () =>
    fs.existsSync(path.join(dir, "sent"))
      ? fs.readFileSync(path.join(dir, "sent"), "utf8").trim().split("\n").map(JSON.parse)
      : [];
  // How many times the worker asked T3 for a thread, by --messages count.
  const shows = (n) =>
    fs.existsSync(path.join(dir, "shows"))
      ? fs.readFileSync(path.join(dir, "shows"), "utf8").split("\n").filter((x) => x === String(n)).length
      : 0;
  return { dir, project, root, state, label, launch, env, threads, run, json, sent, mock, shows };
}
module.exports = { fixture, until, put, read, cli };
