"""CLI integration tests. launchd runs the real worker; only the two product CLIs are fixtures."""
import concurrent.futures
import json
import os
import runpy
from unittest.mock import patch
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

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
elif args[:2]==["thread","show"]:
    print(json.dumps(dict(thread=dict(threadId=args[-1],archived=False),messages=[])))
elif args[:2]==["thread","send"]:
    tid,msg=args[-2:]
    with (root/"deliveries").open("a") as f: f.write(tid+" "+msg.replace(chr(10)," ") + chr(10))
    if (root/"lose-ack").exists(): sys.exit(1)
    print(json.dumps(dict(threadId=tid,messageId="m-1",delivery="queued")))
else: sys.exit(9)
'''

class WatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.p=Path(self.tmp.name)
        (self.p/".ryugi/artifacts").mkdir(parents=True)
        for tool in ["t3","ryugi"]:
            path=self.p/tool
            path.write_text(FAKE)
            path.chmod(0o755)
        self.env=dict(os.environ, PATH=str(self.p)+":"+os.environ["PATH"],
                      XDG_STATE_HOME=str(self.p/"state"), T3CODE_CLI_PATH=str(self.p/"t3"),
                      T3CODE_HOME=str(self.p/"t3-base"), T3CODE_THREAD_ID="thread:mcp:A")
        (self.p/"rounds").write_text('["open"]')
        self.assertTrue(CLI.is_file(),"the bridge executable is missing")
        self.addCleanup(lambda:self.call("cancel",check=False))

    def call(self, op, *extra, owner="thread:mcp:A", check=True):
        return subprocess.run([sys.executable,str(CLI),op,"--project",str(self.p),
            "--artifact","artboard/test","--round","layout",*extra],
            env=dict(self.env,T3CODE_THREAD_ID=owner),text=True,capture_output=True,check=check)

    def wait(self,state):
        for _ in range(60):
            r=self.call("status")
            if json.loads(r.stdout)["state"]==state: return
            time.sleep(.2)
        self.fail("last status: "+r.stdout)

    def test_route_and_dedup(self):
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            list(pool.map(lambda _:self.call("arm"),range(2)))
        self.assertNotEqual(self.call("arm",owner="thread:mcp:B",check=False).returncode,0)
        self.assertNotEqual(self.call("cancel",owner="thread:mcp:B",check=False).returncode,0)
        (self.p/"rounds").write_text('["submitted","open"]')
        for _ in range(60):
            if (self.p/"saw-withdrawal").exists(): break
            time.sleep(.2)
        self.assertTrue((self.p/"saw-withdrawal").exists(),"worker did not observe withdrawal")
        self.assertFalse((self.p/"deliveries").exists())
        (self.p/"rounds").write_text('["submitted"]')
        self.wait("delivered")
        self.call("arm")
        self.assertEqual(len((self.p/"deliveries").read_text().splitlines()),1)
        self.assertTrue((self.p/"deliveries").read_text().startswith("thread:mcp:A "))
        (self.p/"rounds").write_text('["open"]')
        self.call("arm","--again")
        self.call("cancel")
        self.wait("cancelled")

    def test_alias_inside_project_cannot_claim_second_binding(self):
        subdir = self.p/"src"
        subdir.mkdir()
        self.call("arm")
        result = self.call("arm","--project",str(subdir),owner="thread:mcp:B",check=False)
        if result.returncode==0:
            self.call("cancel","--project",str(subdir),owner="thread:mcp:B",check=False)
        self.assertNotEqual(result.returncode,0,"a subdirectory must not create a second owner")

    def test_exec_failure_before_send_retries(self):
        mod=runpy.run_path(str(CLI))
        record=dict(job="test",state="waiting",deadline=time.time()+60,t3="t3",base="/base",
                    project="/p",thread="A",artifact="artboard/test",round="layout")
        (self.p/"binding.json").write_text(json.dumps(record))
        with patch.dict(mod["tick"].__globals__, round_state=lambda r:"submitted",
                        show=lambda r:{"thread":{}},run_json=lambda a:missing()):
            def missing():
                raise FileNotFoundError("T3 executable temporarily unavailable")
            self.assertTrue(mod["tick"](self.p,"test"))
            self.assertEqual(json.loads((self.p/"binding.json").read_text())["state"], "waiting")

    def test_lost_receipt(self):
        (self.p/"lose-ack").touch()
        (self.p/"rounds").write_text('["submitted"]')
        self.call("arm")
        self.wait("uncertain")
        self.call("arm",check=False)
        self.assertEqual(len((self.p/"deliveries").read_text().splitlines()),1)

if __name__=="__main__": unittest.main()
