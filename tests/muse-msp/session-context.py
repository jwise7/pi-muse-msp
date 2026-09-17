#!/usr/bin/env python3
"""pi-session-context: origin.mjs reports Pi origin honestly, never fails hard."""
import json
import os
import pathlib
import subprocess
import tempfile

here = pathlib.Path(__file__).resolve().parent
helper = pathlib.Path.home() / ".config/muse/skills/pi-session-context/origin.mjs"
if not helper.is_file():
    print("SKIP: pi-session-context origin.mjs not installed")
    raise SystemExit(0)
agent_home = pathlib.Path(tempfile.mkdtemp(prefix="pi-origin-home.", dir="/tmp"))
agent_dir = agent_home / ".pi" / "agent"
agent_dir.mkdir(parents=True)
env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent_dir)}


def run(cwd=None):
    return subprocess.run(["node", str(helper)], env=env, text=True,
                          capture_output=True, timeout=30, cwd=cwd or str(agent_home))


# no origin file: standalone, exit 0
r = run()
assert r.returncode == 0, (r.stdout, r.stderr)
report = json.loads(r.stdout)
assert report["runningUnderPi"] is False and report["sessionId"] is None, report
assert report["cwd"] == str(agent_home.resolve()) and report["hermesStore"] is None, report

# fixture origin under matching cwd: all fields surface. The version is arbitrary
# test data (the helper only echoes it), deliberately not the repo release
# version, so bumps never require touching this fixture.
origin = {"provider": "muse-msp", "extensionVersion": "9.9.9-fixture",
          "sessionId": "s-123", "cwd": str(agent_home.resolve()),
          "model": "muse-spark-1.3", "sandboxed": False, "savedAt": 1757320000000}
(agent_dir / "muse-msp-origin.json").write_text(json.dumps(origin))
r = run()
report = json.loads(r.stdout)
assert report["runningUnderPi"] is True and report["cwdMatches"] is True, report
assert report["sessionId"] == "s-123" and report["model"] == "muse-spark-1.3", report
assert report["sandboxed"] is False, report

# stale origin (different cwd): reported, not trusted
r = run(cwd="/tmp")
report = json.loads(r.stdout)
assert report["runningUnderPi"] is True and report["cwdMatches"] is False, report

# corrupt origin file: still exit 0, standalone
(agent_dir / "muse-msp-origin.json").write_text("{broken")
r = run()
assert r.returncode == 0 and json.loads(r.stdout)["runningUnderPi"] is False, (r.stdout, r.stderr)

print("PASS: origin detection, stale and corrupt handling")
