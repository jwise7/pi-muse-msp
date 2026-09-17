#!/usr/bin/env python3
import json, pathlib, sys, time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rpc_harness as harness

root = harness.mkdtemp("pi-msp-salvage.")
log = root / "msp.log"
sid = "00000000-0000-7000-8000-000000000001"
jsonl = root / ".local/share/muse/sessions/1970/01/01" / sid / "session.jsonl"
jsonl.parent.mkdir(parents=True)
proc = harness.spawn(root, log, extra_env={"FAKE_HANG": "1"})


def turn_start(event, _seen):
    return event.get("type") == "turn_start"


def assistant_end(event, _seen):
    return event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant"


try:
    harness.send(proc, {"type": "prompt", "message": "first"})
    harness.read_until(proc, turn_start, 8)
    now = int(time.time() * 1_000_000)
    jsonl.write_text("\n".join(json.dumps(row) for row in [
        {"recorded_at": now, "payload": {"kind": "run", "run_id": "run1", "event": {
            "kind": "assistant_message_committed", "message_id": "m1", "text": "RECOVERED"}}},
        {"recorded_at": now + 1, "payload": {"kind": "run", "run_id": "run1", "event": {
            "kind": "terminal", "terminal": "completed"}}},
    ]) + "\n")
    events = harness.read_until(proc, assistant_end, timeout=15)
    assert "fresh Muse session next turn" in json.dumps(events), events[-10:]

    harness.send(proc, {"type": "prompt", "message": "second"})
    harness.read_until(proc, turn_start, 8)
    deadline = time.time() + 3
    while time.time() < deadline and log.read_text().splitlines().count("turn/start") < 2:
        time.sleep(0.05)
    methods = log.read_text().splitlines()
    assert methods.count("session/start") == 2, methods
    assert methods.count("turn/start") == 2, methods

    harness.send(proc, {"type": "abort"})
    harness.wait_for_call(log, "turn/interrupt", timeout=3)
    methods = log.read_text().splitlines()
    assert "turn/interrupt" in methods and "turn/cancel" not in methods, methods
    print("PASS: salvaged sessions are discarded; abort uses turn/interrupt")
finally:
    harness.stop(proc)
