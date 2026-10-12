#!/usr/bin/env python3
"""Statically registered models survive an empty live model/list.

The fake host answers model/list with zero rows (like `muse serve` builds
whose listing omits ids the server still accepts), so the extension falls
back to its static list. All four EXTRA ids (muse-wonder-1.0,
muse-wonder-1.0-contributor, muse-spark-1.3-contributor,
muse-spark-1.2-contributor) must resolve via set_model, and a turn on
muse-wonder-1.0 must carry modelId muse-wonder-1.0 with no providerId
override (default routing, not meta).
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rpc_harness as harness

root = harness.mkdtemp("pi-msp-staticmodels.")
log = root / "msp.log"
input_log = root / "input.log"
proc = harness.spawn(root, log, extra_env={"FAKE_REASONING": "1"},
                     input_log=input_log)

try:
    # Every statically registered id must resolve, including the contributor
    # ids the live model/list omits (a refresh replaces the fallback with the
    # live rows, so these only survive via the EXTRA union).
    for seq, model_id in enumerate(["muse-wonder-1.0-contributor",
                                    "muse-spark-1.3-contributor",
                                    "muse-spark-1.2-contributor"]):
        switched = harness.rpc_call(proc, {"id": f"pre{seq}", "type": "set_model",
                                           "provider": "muse-msp",
                                           "modelId": model_id})
        assert switched.get("success") is True, (model_id, switched)

    switched = harness.rpc_call(proc, {"id": "s1", "type": "set_model",
                                       "provider": "muse-msp",
                                       "modelId": "muse-wonder-1.0"})
    assert switched.get("success") is True, switched

    harness.send(proc, {"id": "p1", "type": "prompt", "message": "hello"})
    events = harness.read_until(
        proc, lambda event, _: event.get("type") == "agent_end", timeout=20)

    def text_of(events):
        ame = [event.get("assistantMessageEvent") or {} for event in events]
        return "".join(e.get("delta", "") for e in ame if e.get("type") == "text_delta")

    assert "VISIBLE-ANSWER" in text_of(events), text_of(events)
    starts = [json.loads(line) for line in input_log.read_text().splitlines()
              if json.loads(line).get("method") == "session/start"]
    assert len(starts) == 1, [json.loads(line).get("method")
                              for line in input_log.read_text().splitlines()]
    params = starts[0]["params"]
    assert params.get("modelId") == "muse-wonder-1.0", params
    assert "providerId" not in params, params
    print("PASS: wonder model resolves from the static list with default routing")
finally:
    harness.stop(proc)
