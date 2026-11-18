"""CLI integration and unit tests. launchd runs the real worker; only the two product CLIs are fixtures."""
import concurrent.futures
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

CLI = Path(__file__).with_name("ryugi-t3-watch")
FAKE = '''#!/usr/bin/env python3
import json, sys
from pathlib import Path
root=Path(__file__).parent
args=sys.argv[1:]
def arg(name): return args[args.index(name)+1]
if Path(__file__).name == "ryugi":
    assert args[:2] == ["comment","list"]
    q=json.loads((root/"rounds").read_text())
    if "--cursor" not in args:
        print(json.dumps(dict(outcome="success",data=dict(items=[dict(id="other",state="submitted")]),page=dict(nextCursor="p2"))))
    else:
        assert arg("--cursor")=="p2"
        if q==["open"] and (root/"first-submit").exists():
            (root/"saw-withdrawal").touch()
        if q==["submitted","open"]:
            (root/"first-submit").touch()
            (root/"rounds").write_text('["open"]')
        print(json.dumps(dict(outcome="success",data=dict(items=[dict(id="layout",state=q[0])]),page=dict(nextCursor=None))))
elif args[:2]==["thread","list"]:
    items=json.loads((root/"threads").read_text()) if (root/"threads").exists() else []
    print(json.dumps(items))
elif args[:2]==["thread","show"]:
    tid=args[-1]
    archived=(root/"archived").exists()
    msgs=[]
    if (root/"echo-deliveries").exists() and (root/"deliveries").exists():
        for line in (root/"deliveries").read_text().splitlines():
            target, text = line.split(" ", 1)
            if target == tid:
                msgs.append(dict(role="user", text=text))
    print(json.dumps(dict(thread=dict(threadId=tid,archived=archived),messages=msgs)))
elif args[:2]==["thread","send"]:
    tid,msg=args[-2:]
    with (root/"deliveries").open("a") as f: f.write(tid+" "+msg.replace(chr(10)," ") + chr(10))
    if (root/"lose-ack").exists(): sys.exit(1)
    print(json.dumps(dict(threadId=tid,messageId="m-1",delivery="queued")))
else: sys.exit(9)
'''


class WatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.p = Path(self.tmp.name)
        (self.p / ".ryugi/artifacts").mkdir(parents=True)
        for tool in ["t3", "ryugi"]:
            path = self.p / tool
            path.write_text(FAKE)
            path.chmod(0o755)
        self.env = dict(
            os.environ,
            PATH=str(self.p) + ":" + os.environ["PATH"],
            XDG_STATE_HOME=str(self.p / "state"),
            T3CODE_CLI_PATH=str(self.p / "t3"),
            T3CODE_HOME=str(self.p / "t3-base"),
            T3CODE_THREAD_ID="thread:mcp:A",
        )
        self.env.pop("ANTIGRAVITY_AGENT", None)
        (self.p / "rounds").write_text('["open"]')
        self.assertTrue(CLI.is_file(), "the bridge executable is missing")
        self.addCleanup(lambda: self.call("cancel", check=False))

    def call(self, op, *extra, owner="thread:mcp:A", check=True, env_override=None):
        env = dict(self.env)
        if owner is None:
            env.pop("T3CODE_THREAD_ID", None)
        else:
            env["T3CODE_THREAD_ID"] = owner
        if env_override:
            env.update(env_override)
        return subprocess.run(
            [
                sys.executable,
                str(CLI),
                op,
                "--project",
                str(self.p),
                "--artifact",
                "artboard/test",
                "--round",
                "layout",
                *extra,
            ],
            env=env,
            text=True,
            capture_output=True,
            check=check,
        )

    def call_global(self, op, *extra, check=True):
        return subprocess.run(
            [sys.executable, str(CLI), op, *extra],
            env=self.env,
            text=True,
            capture_output=True,
            check=check,
        )

    def wait(self, state):
        for _ in range(60):
            r = self.call("status")
            if json.loads(r.stdout)["state"] == state:
                return json.loads(r.stdout)
            time.sleep(0.2)
        self.fail("last status: " + r.stdout)

    def test_route_and_dedup(self):
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            list(pool.map(lambda _: self.call("arm"), range(2)))
        self.assertNotEqual(self.call("arm", owner="thread:mcp:B", check=False).returncode, 0)
        self.assertNotEqual(self.call("cancel", owner="thread:mcp:B", check=False).returncode, 0)
        (self.p / "rounds").write_text('["submitted","open"]')
        for _ in range(60):
            if (self.p / "saw-withdrawal").exists():
                break
            time.sleep(0.2)
        self.assertTrue((self.p / "saw-withdrawal").exists(), "worker did not observe withdrawal")
        self.assertFalse((self.p / "deliveries").exists())
        (self.p / "rounds").write_text('["submitted"]')
        self.wait("delivered")
        self.call("arm")
        self.assertEqual(len((self.p / "deliveries").read_text().splitlines()), 1)
        self.assertTrue((self.p / "deliveries").read_text().startswith("thread:mcp:A "))
        (self.p / "rounds").write_text('["open"]')
        self.call("arm", "--again")
        self.call("cancel")
        self.wait("cancelled")

    def test_alias_inside_project_cannot_claim_second_binding(self):
        subdir = self.p / "src"
        subdir.mkdir()
        self.call("arm")
        result = self.call("arm", "--project", str(subdir), owner="thread:mcp:B", check=False)
        if result.returncode == 0:
            self.call("cancel", "--project", str(subdir), owner="thread:mcp:B", check=False)
        self.assertNotEqual(result.returncode, 0, "a subdirectory must not create a second owner")

    def test_exec_failure_before_send_retries(self):
        mod = runpy.run_path(str(CLI))
        record = dict(
            job="test",
            state="waiting",
            deadline=time.time() + 60,
            t3="t3",
            base="/base",
            project="/p",
            thread="A",
            artifact="artboard/test",
            round="layout",
        )
        (self.p / "binding.json").write_text(json.dumps(record))
        with patch.dict(
            mod["tick"].__globals__,
            round_state=lambda r: "submitted",
            show=lambda r: {"thread": {}},
            run_json=lambda a: missing(),
        ):
            def missing():
                raise FileNotFoundError("T3 executable temporarily unavailable")

            self.assertTrue(mod["tick"](self.p, "test"))
            data = json.loads((self.p / "binding.json").read_text())
            self.assertEqual(data["state"], "waiting")
            self.assertIn("temporarily unavailable", data["lastError"])

    def test_lost_receipt_and_status_reconciliation(self):
        (self.p / "lose-ack").touch()
        (self.p / "rounds").write_text('["submitted"]')
        self.call("arm")
        self.wait("uncertain")
        self.call("arm", check=False)
        self.assertEqual(len((self.p / "deliveries").read_text().splitlines()), 1)
        (self.p / "echo-deliveries").touch()
        reconciled = json.loads(self.call("status", owner=None).stdout)
        self.assertEqual(reconciled["state"], "delivered")
        self.assertIn("deliveredAt", reconciled)

    def test_list_prune_and_failed_arm_cleanup(self):
        (self.p / "archived").touch()
        failed = self.call("arm", check=False)
        self.assertNotEqual(failed.returncode, 0)
        watch_dir = self.p / "state/ryugi-t3-watch"
        self.assertFalse(watch_dir.exists() and any(watch_dir.iterdir()))

        (self.p / "archived").unlink()
        self.call("arm")
        listed_active = json.loads(self.call_global("list", "--active").stdout)
        self.assertEqual(len(listed_active["items"]), 1)
        self.assertEqual(listed_active["items"][0]["state"], "waiting")

        pruned_busy = json.loads(self.call_global("prune").stdout)
        self.assertEqual(pruned_busy["removed"], [])
        self.assertEqual(pruned_busy["kept"], 1)

        self.call("cancel")
        self.wait("cancelled")
        pruned_done = json.loads(self.call_global("prune").stdout)
        self.assertEqual(len(pruned_done["removed"]), 1)
        self.assertEqual(pruned_done["kept"], 0)
        self.assertEqual(json.loads(self.call_global("list").stdout)["items"], [])

    def test_thread_auto_resolution_without_env(self):
        (self.p / "threads").write_text(json.dumps([
            {"threadId": "t-idle", "status": "completed", "providerInstanceId": "antigravity"},
            {"threadId": "t-ag", "status": "running", "providerInstanceId": "antigravity"},
            {"threadId": "t-codex", "status": "running", "providerInstanceId": "codex"},
        ]))
        # Ambiguous (2 running threads) fails without ANTIGRAVITY_AGENT.
        ambig = self.call("arm", owner=None, check=False)
        self.assertNotEqual(ambig.returncode, 0)
        # ANTIGRAVITY_AGENT narrows to the single running antigravity thread.
        ok = self.call("arm", owner=None, env_override={"ANTIGRAVITY_AGENT": "1"})
        self.assertEqual(json.loads(ok.stdout)["thread"], "t-ag")
        self.call("cancel", "--thread", "t-ag", owner=None)

    def test_expired_and_archived_transitions(self):
        mod = runpy.run_path(str(CLI))
        expired_dir = self.p / "expired"
        expired_dir.mkdir()
        (expired_dir / "binding.json").write_text(json.dumps(dict(
            job="j-exp", state="waiting", deadline=time.time() - 1, t3="t3", base="/base",
            project="/p", thread="A", artifact="artboard/test", round="layout",
        )))
        self.assertFalse(mod["tick"](expired_dir, "j-exp"))
        self.assertEqual(json.loads((expired_dir / "binding.json").read_text())["state"], "expired")

        arch_dir = self.p / "arch"
        arch_dir.mkdir()
        (arch_dir / "binding.json").write_text(json.dumps(dict(
            job="j-arch", state="waiting", deadline=time.time() + 60, t3="t3", base="/base",
            project="/p", thread="A", artifact="artboard/test", round="layout",
        )))
        with patch.dict(mod["tick"].__globals__, round_state=lambda r: "submitted", show=lambda r: {"thread": {"archived": True}}):
            self.assertFalse(mod["tick"](arch_dir, "j-arch"))
        self.assertEqual(json.loads((arch_dir / "binding.json").read_text())["state"], "cancelled")


if __name__ == "__main__":
    unittest.main()
