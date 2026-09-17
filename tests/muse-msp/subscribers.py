#!/usr/bin/env python3
"""Session subscribers: todo completion notes, context-pressure warnings, and
view-health signals that accelerate salvage past the grace period."""
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rpc_harness as harness


def new_session(prefix, extra_env):
    root = harness.mkdtemp(prefix)
    log = root / "msp.log"
    proc = harness.spawn(root, log, extra_env=extra_env)
    return root, log, proc


def stream_thinking(events):
    ame = [event.get("assistantMessageEvent") or {} for event in events]
    return "".join(e.get("delta", "") for e in ame if e.get("type") == "thinking_delta")


# Completed todo lists get a thinking note (live counts ride the working message).
_, _, proc = new_session("pi-msp-todos.", {"FAKE_NOTIFY_TODOS": "1", "FAKE_REASONING": "1"})
try:
    harness.send(proc, {"id": "p1", "type": "prompt", "message": "go"})
    events = harness.read_until(proc, lambda event, _: event.get("type") == "agent_end", timeout=20)
    thinking = stream_thinking(events)
    assert "todos complete (2/2)" in thinking, thinking
finally:
    harness.stop(proc)
print("PASS: todo completion noted")

# Context pressure warnings surface once per level.
_, _, proc = new_session("pi-msp-context.", {"FAKE_NOTIFY_CONTEXT": "1", "FAKE_REASONING": "1"})
try:
    harness.send(proc, {"id": "p1", "type": "prompt", "message": "go"})
    events = harness.read_until(proc, lambda event, _: event.get("type") == "agent_end", timeout=20)
    thinking = stream_thinking(events)
    assert "context pressure warning: 800000/1000000 tokens" in thinking, thinking
finally:
    harness.stop(proc)
print("PASS: context pressure warned")

# A server-confirmed dead projector skips the 6s salvage grace.
root, log, proc = new_session("pi-msp-vhealth.", {"FAKE_NOTIFY_VIEWHEALTH": "1", "FAKE_HANG": "1"})
try:
    sid = "00000000-0000-7000-8000-000000000001"
    jsonl = root / ".local/share/muse/sessions/1970/01/01" / sid / "session.jsonl"
    jsonl.parent.mkdir(parents=True)
    harness.send(proc, {"id": "p1", "type": "prompt", "message": "go"})
    harness.read_until(proc, lambda _, seen: any(item.get("type") == "turn_start" for item in seen), timeout=10)
    harness.wait_for_call(log, "turn/start")
    now = int(time.time() * 1_000_000)
    jsonl.write_text("\n".join(json.dumps(row) for row in [
        {"recorded_at": now, "payload": {"kind": "run", "run_id": "run1", "event": {
            "kind": "assistant_message_committed", "message_id": "m1", "text": "VITAL-ANSWER"}}},
        {"recorded_at": now + 1, "payload": {"kind": "run", "run_id": "run1", "event": {
            "kind": "terminal", "terminal": "completed"}}},
    ]) + "\n")
    started = time.time()
    events = harness.read_until(
        proc, lambda event, _: event.get("type") == "message_end"
        and event.get("message", {}).get("role") == "assistant", timeout=20)
    elapsed = time.time() - started
    assert "VITAL-ANSWER" in json.dumps(events), events[-4:]
    assert elapsed < 6.0, f"grace was not bypassed: {elapsed:.1f}s"
finally:
    harness.stop(proc)
print("PASS: confirmed projector death skips salvage grace")
