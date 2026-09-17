#!/usr/bin/env python3
"""Origin file + (when available) pi-proposals inbox injection.

Always: a turn through muse-msp writes the origin file the
pi-session-context skill reads (provider, sessionId, cwd, model).

When the pi-proposals companion extension is available — either vendored at
extensions/pi-proposals.ts or installed in the agent extensions directory — a
second run proves inbox scoping: a seeded project proposal (cwd == run cwd)
and a global one reach the fake host's turn/start text, while an
unrelated-cwd project proposal does not. Without the companion extension that
half prints SKIP and exits 0.
"""
import json
import os
import pathlib
import subprocess
import tempfile

here = pathlib.Path(__file__).resolve().parent
msp_ext = here.parents[1] / "extensions/muse-msp.ts"


def find_inbox_ext():
    candidates = [here.parents[1] / "extensions/pi-proposals.ts"]
    configured = os.environ.get("PI_CODING_AGENT_DIR", "").strip()
    if configured:
        candidates.append(pathlib.Path(configured) / "extensions/pi-proposals.ts")
    candidates.append(pathlib.Path.home() / ".pi/agent/extensions/pi-proposals.ts")
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def run_turn(home, extra_exts=()):
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="pi-msp-inbox.", dir="/tmp"))
    log = tmp / "msp.log"
    input_log = tmp / "input.log"
    env = {k: v for k, v in os.environ.items() if not k.startswith("FAKE_")}
    env.update(HOME=str(home), PI_MUSE_BINARY=str(here / "fake-host.py"),
               FAKE_MSP_LOG=str(log), FAKE_MSP_INPUT_LOG=str(input_log), FAKE_REASONING="1")
    cmd = ["pi", "--no-session", "--no-extensions", "-e", str(msp_ext)]
    for ext in extra_exts:
        cmd += ["-e", str(ext)]
    cmd += ["--provider", "muse-msp", "--model", "muse-spark-1.3",
            "--no-tools", "-p", "Inbox probe"]
    result = subprocess.run(cmd, env=env, text=True, capture_output=True,
                            timeout=60, cwd=str(home))
    assert result.returncode == 0, (result.stdout, result.stderr)
    assert "VISIBLE-ANSWER" in result.stdout + result.stderr, (result.stdout, result.stderr)
    return input_log


home = pathlib.Path(tempfile.mkdtemp(prefix="pi-msp-inbox-home.", dir="/tmp"))
agent_dir = home / ".pi" / "agent"
agent_dir.mkdir(parents=True)

# Origin half: needs only muse-msp itself.
run_turn(home)
origin = json.loads((agent_dir / "muse-msp-origin.json").read_text())
assert origin["provider"] == "muse-msp", origin
assert origin["sessionId"] == "00000000-0000-7000-8000-000000000001", origin
assert origin["cwd"] == str(home.resolve()) and origin["model"] == "muse-spark-1.3", origin
print("PASS: origin file")

# Inbox half: needs the companion extension.
inbox_ext = find_inbox_ext()
if inbox_ext is None:
    print("SKIP: inbox injection (pi-proposals.ts neither vendored nor installed)")
    raise SystemExit(0)

seed = [
    {"id": "p-aaa111", "ts": 1, "cwd": str(home), "project": "home",
     "scope": "project", "target": "memory", "category": "convention",
     "fact": "INBOX-PROJECT-FACT"},
    {"id": "p-bbb222", "ts": 2, "cwd": "", "project": "other",
     "scope": "global", "target": "user", "category": "preference",
     "fact": "INBOX-GLOBAL-FACT"},
    {"id": "p-ccc333", "ts": 3, "cwd": "/elsewhere", "project": "else",
     "scope": "project", "target": "memory", "category": "insight",
     "fact": "INBOX-ELSEWHERE-FACT"},
]
(agent_dir / "muse-proposals.jsonl").write_text("\n".join(json.dumps(e) for e in seed) + "\n")
input_log = run_turn(home, (inbox_ext,))

turns = [json.loads(line) for line in input_log.read_text().splitlines()
         if json.loads(line)["method"] == "turn/start"]
assert len(turns) == 1, turns
text = turns[0]["text"]
assert "INBOX-PROJECT-FACT" in text, text
assert "INBOX-GLOBAL-FACT" in text, text
assert "INBOX-ELSEWHERE-FACT" not in text, text

print(f"PASS: inbox injection scoping (via {inbox_ext})")
