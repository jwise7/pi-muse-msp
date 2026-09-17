#!/usr/bin/env python3
"""Turn-lifecycle depth: retry notices, cancelled/unknown terminals, terminal
usage, and generic rendering of unknown item kinds (all RPC-observable)."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rpc_harness as harness


def run_case(prefix, extra_env):
    root = harness.mkdtemp(prefix)
    log = root / "msp.log"
    proc = harness.spawn(root, log, extra_env=extra_env)
    try:
        harness.send(proc, {"id": "p1", "type": "prompt", "message": "go"})
        events = harness.read_until(proc, lambda event, _: event.get("type") == "agent_end", timeout=20)
        return proc, events
    except BaseException:
        harness.stop(proc)
        raise


def stream_text(events):
    ame = [event.get("assistantMessageEvent") or {} for event in events]
    text = "".join(e.get("delta", "") for e in ame if e.get("type") == "text_delta")
    thinking = "".join(e.get("delta", "") for e in ame if e.get("type") == "thinking_delta")
    return text, thinking


# retryScheduled renders "attempt N/M" instead of dead air; turn completes.
proc, events = run_case("pi-msp-retry.", {"FAKE_RETRY_FLOW": "1"})
try:
    text, thinking = stream_text(events)
    assert "RETRY-ANSWER" in text, text
    assert "attempt 1/3" in thinking and "model overloaded" in thinking, thinking
    assert "retrying in 2.0s" in thinking, thinking
finally:
    harness.stop(proc)
print("PASS: turn/retryScheduled renders attempt progress")

# server-cancelled turns finish aborted, with the server reason.
proc, events = run_case("pi-msp-cancel.", {"FAKE_CANCELLED": "1"})
try:
    blob = json.dumps(events)
    assert "aborted" in blob, blob[-600:]
    assert "server stopped it" in blob, blob[-600:]
finally:
    harness.stop(proc)
print("PASS: cancelled terminal finishes aborted")

# unknown terminals fail loudly, never pass silently.
proc, events = run_case("pi-msp-evapor.", {"FAKE_UNKNOWN_TERMINAL": "1"})
try:
    blob = json.dumps(events)
    assert "evaporated" in blob, blob[-600:]
finally:
    harness.stop(proc)
print("PASS: unknown terminal fails loudly")

# terminal usage lands on the assistant message even with no tokenUsage frames.
proc, events = run_case("pi-msp-usage.", {"FAKE_USAGE": "1"})
try:
    entries = harness.get_entries(proc)
    assistants = [e for e in entries if e.get("type") == "message"
                  and (e.get("message") or {}).get("role") == "assistant"]
    assert len(assistants) == 1, entries
    usage = assistants[0]["message"]["usage"]
    assert (usage["input"], usage["output"]) == (101, 202), usage
finally:
    harness.stop(proc)
print("PASS: terminal usage applied to the message")

# unknown item kinds render a generic activity row (schema MUST).
proc, events = run_case("pi-msp-oddkind.", {"FAKE_ODD_ITEM": "1"})
try:
    entries = harness.get_entries(proc)
    rows = [e for e in entries if e.get("customType") == "muse-msp-activity"]
    assert any("teleport" in (r.get("data") or {}).get("label", "") for r in rows), entries
    assert any("beamed up" in (r.get("data") or {}).get("label", "") for r in rows), entries
finally:
    harness.stop(proc)
print("PASS: unknown item kinds render generically")
