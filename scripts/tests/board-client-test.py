"""Exercise the real shell client with a local curl stub; never call a service."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "pidgindocs.sh"


class BoardClientTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        curl = self.path / "curl"
        curl.write_text("#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\nPath(os.environ['CAPTURE']).write_text(json.dumps(sys.argv[1:]))\nprint(os.environ['RESPONSE'])\n")
        curl.chmod(0o755)
        self.env = {key: value for key, value in os.environ.items() if not key.startswith(("PIDGIN_", "PIDGINDOCS_", "CODEX_", "CLAUDE_"))}
        self.env.update(PATH=f"{self.path}:{os.environ['PATH']}", PIDGINDOCS_API_KEY="test-user-key", PIDGINDOCS_AGENT_KEY="test-agent-key", PIDGINDOCS_URL="https://test.invalid", CAPTURE=str(self.path / "args"), RESPONSE='[1,"entry",0]')

    def run_client(self, *args):
        return subprocess.run(["bash", str(SCRIPT), "board", *args], env=self.env, text=True, capture_output=True)

    def post(self, *args):
        return self.run_client("post", "--project-id", "a1", "--kind", "s", "--topic", "tests", "--body", "green", *args)

    def test_metadata_flags_override_environment_without_interpolation(self):
        self.env.update(PIDGINDOCS_SESSION_ID="environment-id", PIDGINDOCS_ORIGIN="environment-origin", PIDGINDOCS_MODEL="gpt-example")
        name = 'Review "quotes" $(touch not-a-command)'
        result = self.post("--session-id", "thread-1", "--session-name", name, "--origin", "codex-cli", "--model-version", "v1", "--origin-version", "1.2", "--client-id", "post-001")
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads((self.path / "args").read_text())
        payload = json.loads(args[args.index("-d") + 1])
        self.assertEqual(payload[4], dict(session_id="thread-1", session_name=name, model="gpt-example", model_version="v1", origin="codex-cli", origin_version="1.2"))
        self.assertIn("Authorization: Agent test-agent-key", args)
        self.assertNotIn("Bearer test-user-key", " ".join(args))

    def test_legacy_post_and_missing_origin(self):
        self.assertEqual(self.post().returncode, 0)
        args = json.loads((self.path / "args").read_text())
        self.assertEqual(json.loads(args[args.index("-d") + 1]), ["s", "tests", "green", 0])
        (self.path / "args").unlink()
        result = self.post("--session-id", "thread-1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.path / "args").exists())

    def test_codex_thread_is_used_without_guessing_model(self):
        self.env["CODEX_THREAD_ID"] = "native-thread"
        self.assertEqual(self.post().returncode, 0)
        args = json.loads((self.path / "args").read_text())
        session = json.loads(args[args.index("-d") + 1])[4]
        self.assertEqual(session["session_id"], "native-thread")
        self.assertEqual(session["origin"], "codex")
        self.assertEqual(session["model"], "")

    def test_both_wire_versions_decode(self):
        for version, actors in [("pb1", ["codex"]), ("pb2", [["agent1", "codex", "Codex", "user1", "thread1", "Review", "gpt-example", "v1", "codex-cli", "1.2"]])]:
            self.env["RESPONSE"] = json.dumps([version, 1, actors, [[1, 123, 0, "s", "tests", "green", 0]]])
            result = self.run_client("read", "--project-id", "a1", "--human")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("green", result.stdout)
            if version == "pb2":
                self.assertIn("thread1", result.stdout)
                self.assertIn("Key owner: user1", result.stdout)
            args = json.loads((self.path / "args").read_text())
            self.assertTrue(any("protocol=pb2" in arg for arg in args))

    def test_members_and_error_exit(self):
        self.env["RESPONSE"] = '{"ok":true,"data":{"members":[],"sessions":[],"sessions_truncated":false}}'
        self.assertEqual(self.run_client("members", "--project-id", "a1").returncode, 0)
        self.env["RESPONSE"] = '{"ok":false,"error":"forbidden"}'
        self.assertNotEqual(self.run_client("members", "--project-id", "a1").returncode, 0)


if __name__ == "__main__":
    unittest.main()
