#!/usr/bin/env python3
"""Mid-chat /model switch moves the live session via session/setModel instead
of starting fresh and replaying full history (same provider family only)."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rpc_harness as harness

root = harness.mkdtemp("pi-msp-modelswitch.")
log = root / "msp.log"
proc = harness.spawn(root, log, extra_env={"FAKE_REASONING": "1"})

try:
    harness.send(proc, {"id": "p1", "type": "prompt", "message": "first"})
    events1 = harness.read_until(proc, lambda event, _: event.get("type") == "agent_end", timeout=20)

    switched = harness.rpc_call(proc, {"id": "s1", "type": "set_model",
                                       "provider": "muse-msp", "modelId": "muse-spark-1.2"})
    assert switched.get("success") is True, switched

    harness.send(proc, {"id": "p2", "type": "prompt", "message": "second"})
    events2 = harness.read_until(proc, lambda event, _: event.get("type") == "agent_end", timeout=20)

    def text_of(events):
        ame = [event.get("assistantMessageEvent") or {} for event in events]
        return "".join(e.get("delta", "") for e in ame if e.get("type") == "text_delta")

    assert "VISIBLE-ANSWER" in text_of(events1), text_of(events1)
    assert "VISIBLE-ANSWER" in text_of(events2), text_of(events2)
    methods = [line.strip() for line in log.read_text().splitlines()]
    assert methods.count("session/start") == 1, methods
    assert methods.count("session/setModel") == 1, methods
    assert "session/setModel model=muse-spark-1.2" in methods, methods
    assert methods.count("turn/start") == 2, methods
    print("PASS: model switch reuses the session via session/setModel")
finally:
    harness.stop(proc)
