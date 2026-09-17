#!/usr/bin/env python3
"""Mid-turn steering reaches MSP turn/steer instead of queueing a follow-up.

RPC mode: prompt "first" with FAKE_HANG keeps the MSP turn in flight (no live
events, no durable log, so salvage never settles it). A second prompt with
streamingBehavior="steer" must fire the extension input handler, which steers
the running MSP turn; the fake host answers STEERED:<text> and completes the
turn. Asserts turn/steer x1, no second turn/start, and the steered text.
"""
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rpc_harness as harness

root = harness.mkdtemp("pi-msp-steer.")
log = root / "msp.log"
proc = harness.spawn(root, log, extra_env={"FAKE_HANG": "1"}, cwd=root)

try:
    harness.send(proc, {"type": "prompt", "message": "first"})
    harness.read_until(proc, lambda _, seen: any(item.get("type") == "turn_start" for item in seen), timeout=10)
    # The MSP turn must be registered as steerable before the steer lands:
    # turn_start fires before the turn/start ack roundtrip completes.
    harness.wait_for_call(log, "turn/start")
    time.sleep(1)
    harness.send(proc, {"type": "prompt", "message": "go left", "streamingBehavior": "steer"})
    events = harness.read_until(proc, lambda event, _: event.get("type") == "agent_end", timeout=20)
    ame = [event.get("assistantMessageEvent") or {} for event in events]
    text = "".join(e.get("delta", "") for e in ame if e.get("type") == "text_delta")
    methods = [line.strip() for line in log.read_text().splitlines()]
    assert methods.count("turn/steer") == 1, methods
    assert methods.count("turn/start") == 1, methods
    assert methods.count("session/start") == 1, methods
    assert "STEERED:go left" in text, text
    print("PASS: mid-turn steer reaches MSP turn/steer; no queued follow-up")
finally:
    harness.stop(proc)
