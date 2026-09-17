#!/usr/bin/env python3
"""Cross-process MSP session resume via the persisted session index.

run1: single-message -p turn in a named Pi session -> session/start x1,
      index file written.
run2: same Pi session continued in a NEW process (-p follow-up) -> the new
      Pi process must adopt the persisted session (session/resume x1,
      session/start x0) and send only the delta.
      (One pi process per turn: `pi -p A B` runs two turns in ONE process,
      which reuses the in-memory live session and never touches the index.)
run3: FAKE_RESUME_FAIL=1 -> stale entry dropped, fresh session/start x1.
run4: expired savedAt -> entry ignored without even attempting resume.
run5: FAKE_HANG_RESUME=1 -> resume ack never arrives, bounded wait then fresh start.
run6: FAKE_RESUME_PENDING=1 -> adopted session's pending approval is pulled
      and auto-decided.
"""
import json
import os
import pathlib
import subprocess
import sys

here = pathlib.Path(__file__).resolve().parent
extension = here.parents[1] / "extensions/muse-msp.ts"

sys.path.insert(0, str(here))
import rpc_harness as harness
first = "Persist probe alpha"
second = "follow-up beta"


def run(home, *messages, extra_env=None, expected="VISIBLE-ANSWER", reasoning=True):
    tmp = harness.mkdtemp("pi-msp-persist.")
    log = tmp / "msp.log"
    env = {k: v for k, v in os.environ.items() if not k.startswith("FAKE_")}
    env.update(
        HOME=str(home),
        PI_MUSE_BINARY=str(here / "fake-host.py"),
        FAKE_MSP_LOG=str(log),
        **({"FAKE_REASONING": "1"} if reasoning else {}),
        **(extra_env or {}),
    )
    input_log = tmp / "input.log"
    env["FAKE_MSP_INPUT_LOG"] = str(input_log)
    result = subprocess.run(
        ["pi", "--session-id", "msp-persist", "--no-extensions", "-e", str(extension),
         "--provider", "muse-msp", "--model", "muse-spark-1.3",
         "--no-tools", "-p", *messages],
        env=env, text=True, capture_output=True, timeout=60, cwd=str(home),
    )
    assert result.returncode == 0, (result.stdout, result.stderr)
    assert expected in result.stdout + result.stderr, (result.stdout, result.stderr)
    calls = log.read_text().splitlines()
    inputs = [json.loads(line) for line in input_log.read_text().splitlines()] if input_log.exists() else []
    return calls, inputs


home = harness.mkdtemp("pi-msp-home.")

# run1: fresh start, index written
calls1, _ = run(home, first)
assert calls1.count("session/start") == 1, calls1
assert calls1.count("turn/start") == 1, calls1
index = home / ".pi/agent/muse-msp-sessions.json"
assert index.exists(), "persisted session index was not written"
entries = json.loads(index.read_text())
assert len(entries) == 1, entries
assert entries[0][1]["messageCount"] == 1, entries
adopted_id = entries[0][1]["sessionId"]

# run2: same Pi session continued in a new process adopts the persisted session
calls2, inputs2 = run(home, second)
assert calls2.count("session/resume") == 1, calls2
assert calls2.count("session/start") == 0, calls2
assert calls2.count("turn/start") == 1, calls2
turns = [r for r in inputs2 if r["method"] == "turn/start"]
assert len(turns) == 1, inputs2
assert turns[0]["sessionId"] == adopted_id, (turns, adopted_id)
assert second in turns[0]["text"] and first not in turns[0]["text"], turns[0]["text"]

# run3: resume rejected -> stale entry dropped, fresh start
calls3, _ = run(home, second, extra_env={"FAKE_RESUME_FAIL": "1"})
assert calls3.count("session/resume") == 1, calls3
assert calls3.count("session/start") == 1, calls3
entries = json.loads(index.read_text())
assert all(e[1]["sessionId"] != adopted_id for e in entries), entries

# run4: expired entry is never even attempted
entries = json.loads(index.read_text())
for key, value in entries:
    value["savedAt"] = 0
index.write_text(json.dumps(entries))
calls4, _ = run(home, second)
assert "session/resume" not in calls4, calls4
assert calls4.count("session/start") == 1, calls4

# run5: resume ack never arrives -> bounded wait, then fresh start (run4 left
# a valid entry behind, so resume is attempted this time).
calls5, _ = run(home, "gamma follow-up", extra_env={"FAKE_HANG_RESUME": "1"})
assert calls5.count("session/resume") == 1, calls5
assert calls5.count("session/start") == 1, calls5

# run6: adopted session reports a pending approval -> pulled via listPending
# and auto-decided (run5 left a valid entry behind). The turn itself hangs,
# as a truly blocked turn would, so the approval settles it.
calls6, _ = run(home, "delta follow-up", extra_env={"FAKE_RESUME_PENDING": "1"},
                expected="AUTO-APPROVED", reasoning=False)
assert calls6.count("session/resume") == 1, calls6
assert calls6.count("session/start") == 0, calls6
assert calls6.count("approval/decide") == 1, calls6

print("PASS: persisted sessions resume across processes; stale/expired/hung entries fall back to fresh; resumed pending approvals decide")
