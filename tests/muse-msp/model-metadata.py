#!/usr/bin/env python3
"""Live model/list metadata reaches the Pi model definitions.

The fake host answers model/list with Muse 1.4.6-shaped rows (camelCase
contextLimit/outputLimit, variant tier names, cost). The extension must
map those onto each Pi Model instead of stamping every model with the
static 1M/128k/full-thinking defaults: a small model must report its real
limits and only its supported thinking levels, a row with unusable
limits must fall back to the defaults, and priced rows must carry cost.
"""
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rpc_harness as harness

root = harness.mkdtemp("pi-msp-modelmeta.")
log = root / "msp.log"
proc = harness.spawn(root, log, extra_env={"FAKE_MODELLIST_META": "1"})

try:
    def available_models():
        response = harness.rpc_call(
            proc, {"id": f"m{time.time_ns()}", "type": "get_available_models"})
        assert response.get("success") is True, response
        return {m["id"]: m for m in (response.get("data") or {}).get("models", [])
                if m.get("provider") == "muse-msp"}

    # Startup refresh is asynchronous; poll until the live rows land.
    models = {}
    deadline = time.time() + 20
    while time.time() < deadline:
        models = available_models()
        if "test-small" in models:
            break
        time.sleep(0.25)
    assert "test-small" in models, f"live rows never registered: {sorted(models)}"

    alias = models["muse-spark"]
    assert alias["contextWindow"] == 1007997, alias
    assert alias["maxTokens"] == 128000, alias

    wonder = models["muse-wonder-1.0"]
    assert wonder["contextWindow"] == 1007997, wonder
    assert wonder["maxTokens"] == 128000, wonder
    assert wonder["thinkingLevelMap"].get("max") == "max", wonder

    small = models["test-small"]
    assert small["contextWindow"] == 200000, small
    assert small["maxTokens"] == 32000, small
    assert small["cost"] == {"input": 1.5, "output": 6, "cacheRead": 0.5,
                             "cacheWrite": 2, "total": 0} or \
        all(small["cost"].get(k) == v for k, v in
            {"input": 1.5, "output": 6, "cacheRead": 0.5, "cacheWrite": 2}.items()), small
    levels_map = small["thinkingLevelMap"]
    assert levels_map.get("low") == "low" and levels_map.get("high") == "high", small
    assert levels_map.get("max") is None and levels_map.get("xhigh") is None, small
    assert levels_map.get("minimal") is None, small

    nolimits = models["test-nolimits"]
    assert nolimits["contextWindow"] == 1000000, nolimits
    assert nolimits["maxTokens"] == 128000, nolimits

    switched = harness.rpc_call(proc, {"id": "s1", "type": "set_model",
                                       "provider": "muse-msp",
                                       "modelId": "test-small"})
    assert switched.get("success") is True, switched
    levels = harness.rpc_call(proc, {"id": "t1", "type": "get_available_thinking_levels"})
    assert levels.get("success") is True, levels
    got = (levels.get("data") or {}).get("levels", [])
    assert got == ["off", "low", "medium", "high"], got

    print("PASS: live model/list limits, cost, and thinking variants map onto Pi models")
finally:
    harness.stop(proc)
