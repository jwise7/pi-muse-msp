#!/usr/bin/env python3
"""Local model-catalog rows join the Pi model list behind live rows.

The Muse catalog under ~/.local/share/muse/model-catalog carries
chat models the MSP `model/list` omits (tier-gated ids such as a future
wonder-full). The extension must register those with their snake_case
limits and reasoning tiers, exclude image-generation and non-chat rows,
ignore malformed catalog files, and let live `model/list` rows win by
id (the catalog fixture deliberately disagrees on wonder's context).
"""
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rpc_harness as harness

root = harness.mkdtemp("pi-msp-modelcat.")
catalog_dir = root / ".local/share/muse/model-catalog"
catalog_dir.mkdir(parents=True)
tiers = [{"tier": t} for t in ["minimal", "low", "medium", "high", "xhigh", "max"]]
(catalog_dir / "catalog.json").write_text(json.dumps({"rows": [
    {"model_id": "muse-wonder-full-1.0", "display_label": "muse-wonder-full-1.0",
     "visibility": "hidden", "context_limit": 1007997, "output_limit": 128000,
     "reasoning_effort_variants": tiers, "supports_image_generation": False},
    {"model_id": "muse-image-9.9", "display_label": "Muse Image",
     "visibility": "hidden", "context_limit": None, "output_limit": None,
     "reasoning_effort_variants": None, "supports_image_generation": True},
    {"model_id": "hidden-internal", "display_label": "hidden-internal",
     "visibility": "hidden", "context_limit": None, "output_limit": None,
     "reasoning_effort_variants": None, "supports_image_generation": False},
    {"model_id": "muse-wonder-1.0", "display_label": "muse-wonder-1.0",
     "visibility": "visible", "context_limit": 42, "output_limit": 42,
     "reasoning_effort_variants": tiers, "supports_image_generation": False},
]}))
(catalog_dir / "broken.json").write_text("{not json")

log = root / "msp.log"
proc = harness.spawn(root, log, extra_env={"FAKE_MODELLIST_META": "1"})

try:
    def available_models():
        response = harness.rpc_call(
            proc, {"id": f"m{time.time_ns()}", "type": "get_available_models"})
        assert response.get("success") is True, response
        return {m["id"]: m for m in (response.get("data") or {}).get("models", [])
                if m.get("provider") == "muse-msp"}

    # Poll until the live rows land (test-small only exists there); the
    # catalog rows are already in the initial registration, so stopping
    # at first sight of wonder-full would race the live replacement.
    models = {}
    deadline = time.time() + 20
    while time.time() < deadline:
        models = available_models()
        if "test-small" in models and "muse-wonder-full-1.0" in models:
            break
        time.sleep(0.25)
    assert "muse-wonder-full-1.0" in models, f"catalog rows never registered: {sorted(models)}"
    assert "test-small" in models, f"live rows never registered: {sorted(models)}"

    full = models["muse-wonder-full-1.0"]
    assert full["contextWindow"] == 1007997, full
    assert full["maxTokens"] == 128000, full
    assert full["thinkingLevelMap"].get("max") == "max", full

    assert "muse-image-9.9" not in models, models["muse-image-9.9"]
    assert "hidden-internal" not in models, models["hidden-internal"]

    # Live rows win by id over the catalog's conflicting wonder row.
    assert models["muse-wonder-1.0"]["contextWindow"] == 1007997, models["muse-wonder-1.0"]

    print("PASS: catalog chat models register with metadata; image/non-chat rows and malformed files ignored; live rows win")
finally:
    harness.stop(proc)
