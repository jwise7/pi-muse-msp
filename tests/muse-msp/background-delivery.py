#!/usr/bin/env python3
"""Idle background-completion delivery: a Muse run completing after its Pi
turn ends is posted to the thread exactly once; the turn's own run is never
re-posted and enabling the watcher never backfills old history."""
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rpc_harness as harness

SESSION_ID = "00000000-0000-7000-8000-000000000001"  # first session/start in a fresh HOME
TURN_RUN = "turn-run-baseline"
BG_RUN = "bg-run-marker"


def log_path(home):
    # uuid7 millis are 0, so the extension resolves the UTC fallback path
    # (same layout the fake host writes).
    path = home / ".local/share/muse/sessions/1970/01/01" / SESSION_ID / "session.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def write_completed_run(path, run_id, text, recorded_at=None):
    now = recorded_at if recorded_at is not None else time.time_ns() // 1000
    records = [
        {"recorded_at": now, "payload": {"run_id": run_id, "event": {
            "kind": "assistant_message_committed", "message_id": f"answer-{run_id}", "text": text}}},
        {"recorded_at": now + 1, "payload": {"run_id": run_id, "event": {
            "kind": "terminal", "terminal": "completed"}}},
    ]
    with open(path, "a") as handle:
        for record in records:
            handle.write(json.dumps(record) + "\n")


def background_entries(entries):
    return [e for e in entries if e.get("customType") == "muse-msp-background"]


root = harness.mkdtemp("pi-msp-bg.")
log = root / "msp.log"
# An old completed run, already durable before the turn ends: the turn-end
# snapshot must claim it so the idle watcher never backfills it. Stamped an
# hour back so turn salvage (which only looks at this turn's window) stays
# blind to it and the live path completes normally.
write_completed_run(log_path(root), TURN_RUN, "TURN-OWN-ANSWER",
                    recorded_at=time.time_ns() // 1000 - 3_600_000_000)
proc = harness.spawn(root, log, extra_env={"FAKE_REASONING": "1",
                                           "PI_MUSE_MSP_BACKGROUND_MS": "300"})
try:
    harness.send(proc, {"id": "p1", "type": "prompt", "message": "go"})
    harness.read_until(proc, lambda event, _: event.get("type") == "agent_end", timeout=20)
    # A background run completes while the chat is idle.
    write_completed_run(log_path(root), BG_RUN, "BACKGROUND-MARKER-ANSWER")
    deadline = time.time() + 15
    found = []
    while time.time() < deadline:
        found = background_entries(harness.get_entries(proc))
        if found:
            break
        time.sleep(0.5)
    assert len(found) == 1, harness.get_entries(proc)
    assert found[0].get("content") == "BACKGROUND-MARKER-ANSWER", found
    assert "TURN-OWN-ANSWER" not in json.dumps(harness.get_entries(proc)), \
        "turn's own run was re-posted"
    # Settle across several more poll ticks: exactly-once delivery.
    time.sleep(1.5)
    settled = background_entries(harness.get_entries(proc))
    assert len(settled) == 1, settled
finally:
    harness.stop(proc)
print("PASS: idle background completion posted once; turn's own run not re-posted")

# Scenario B: production ordering — the turn's own terminal plus a background
# run's terminal both land mid-turn (slow live flow). The turn completes live,
# its own run is claimed by text match, and the mid-turn background run is
# deferred, then posted at the next idle tick instead of suppressed.
rootB = harness.mkdtemp("pi-msp-bgmid.")
logB = rootB / "msp.log"
session_logB = log_path(rootB)
procB = harness.spawn(rootB, logB, extra_env={"FAKE_SLOW_DURABLE": "1",
                                             "PI_MUSE_MSP_BACKGROUND_MS": "300"})
try:
    harness.send(procB, {"id": "p1", "type": "prompt", "message": "go slow"})
    # Wait for the slow flow's mid-turn durable commits (3.5s live tail after).
    deadline = time.time() + 10
    turn_run = None
    while time.time() < deadline:
        if session_logB.exists():
            for line in session_logB.read_text().splitlines():
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                event = ((record.get("payload") or {}).get("event") or {})
                if event.get("text") == "SLOW-ANSWER":
                    turn_run = (record.get("payload") or {}).get("run_id")
                    break
        if turn_run:
            break
        time.sleep(0.05)
    assert turn_run, "slow flow never wrote durable commits"
    now = time.time_ns() // 1000
    with open(session_logB, "a") as handle:
        # The turn's own terminal (production ordering: terminal precedes live
        # completion) plus an unrelated background run completing mid-turn.
        handle.write(json.dumps({"recorded_at": now, "payload": {
            "run_id": turn_run,
            "event": {"kind": "terminal", "terminal": "completed"}}}) + "\n")
        handle.write(json.dumps({"recorded_at": now + 1, "payload": {
            "run_id": "mid-turn-bg",
            "event": {"kind": "assistant_message_committed", "message_id": "a-mid",
                      "text": "MID-TURN-BACKGROUND-ANSWER"}}}) + "\n")
        handle.write(json.dumps({"recorded_at": now + 2, "payload": {
            "run_id": "mid-turn-bg",
            "event": {"kind": "terminal", "terminal": "completed"}}}) + "\n")
    harness.read_until(procB, lambda event, _: event.get("type") == "agent_end", timeout=20)
    blob = json.dumps(harness.get_entries(procB))
    assert "SLOW-ANSWER" in blob, blob[-500:]
    deadline = time.time() + 15
    foundB = []
    while time.time() < deadline:
        foundB = background_entries(harness.get_entries(procB))
        if foundB:
            break
        time.sleep(0.5)
    assert len(foundB) == 1, harness.get_entries(procB)
    assert "MID-TURN-BACKGROUND-ANSWER" in json.dumps(foundB[0]), foundB
    assert "SLOW-ANSWER" not in json.dumps(foundB), "turn's own run was re-posted"
finally:
    harness.stop(procB)
print("PASS: mid-turn background completion deferred then posted; turn's own terminal claimed")

# Scenario C: event-driven delivery — a background wake completing while idle
# emits turn/completed + statusChanged on the wire (wiretap-verified). The
# idle poll is 60s here, so delivery within ~25s proves the event path.
rootC = harness.mkdtemp("pi-msp-bgevt.")
logC = rootC / "msp.log"
procC = harness.spawn(rootC, logC, extra_env={"FAKE_REASONING": "1",
                                             "FAKE_BG_EVENT": "1",
                                             "PI_MUSE_MSP_BACKGROUND_MS": "60000"})
try:
    harness.send(procC, {"id": "p1", "type": "prompt", "message": "go"})
    harness.read_until(procC, lambda event, _: event.get("type") == "agent_end", timeout=20)
    deadline = time.time() + 25
    foundC = []
    while time.time() < deadline:
        foundC = background_entries(harness.get_entries(procC))
        if foundC:
            break
        time.sleep(0.5)
    assert len(foundC) == 1, harness.get_entries(procC)
    assert foundC[0].get("content") == "BG-EVENT-ANSWER", foundC
finally:
    harness.stop(procC)
print("PASS: wire event (not the poll) delivered the background completion")
