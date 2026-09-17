#!/usr/bin/env python3
"""Item depth: workflow progress labels, backgrounded rows, and drill-down
commands for subagent results and stored tool output."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rpc_harness as harness

root = harness.mkdtemp("pi-msp-subagents.")
log = root / "msp.log"
proc = harness.spawn(root, log, extra_env={"FAKE_ITEMS": "1"})

try:
    harness.send(proc, {"id": "p1", "type": "prompt", "message": "go"})
    harness.read_until(proc, lambda event, _: event.get("type") == "agent_end", timeout=20)

    entries = harness.get_entries(proc)
    rows = [e.get("data") or {} for e in entries if e.get("customType") == "muse-msp-activity"]
    labels = [r.get("label", "") for r in rows]
    assert any("subagent researcher" in label for label in labels), labels
    assert any("2/3 children" in label and "deploy" in label for label in labels), labels
    assert any(label.startswith("backgrounded: bash") for label in labels), labels
    assert any(r.get("tool") == "bash" for r in rows), rows
    print("PASS: workflow progress, backgrounded rows, native tool rows")

    notifies = harness.run_command(proc, "/muse-msp-subagent sg-1")
    assert any("Docs found" in text for text in notifies), notifies
    entries = harness.get_entries(proc)
    assert any(e.get("customType") == "muse-msp-subagent"
               and "SUBAGENT-RESULT-TEXT" in json.dumps(e) for e in entries), entries
    print("PASS: subagent result drill-down")

    notifies = harness.run_command(proc, "/muse-msp-output tc-1")
    assert any("17 chars" in text for text in notifies), notifies
    entries = harness.get_entries(proc)
    assert any(e.get("customType") == "muse-msp-output"
               and "TOOL-OUTPUT-BYTES" in json.dumps(e) for e in entries), entries
    print("PASS: stored output drill-down")

    notifies = harness.run_command(proc, "/muse-msp-subagent tc-1")
    assert any("has no subagent result" in text for text in notifies), notifies
    notifies = harness.run_command(proc, "/muse-msp-output bogus")
    assert any("no recorded item" in text for text in notifies), notifies
    print("PASS: drill-down errors stay actionable")
finally:
    harness.stop(proc)
