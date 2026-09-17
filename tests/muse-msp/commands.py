#!/usr/bin/env python3
"""Slash-command depth over RPC: doctor inventory, server-joined session
listing, list-based prune, and session forking."""
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rpc_harness as harness

root = harness.mkdtemp("pi-msp-commands.")
log = root / "msp.log"
input_log = root / "input.log"
proc = harness.spawn(root, log, extra_env={"FAKE_REASONING": "1", "FAKE_LIST_EXTRA": "1"},
                     input_log=input_log)

try:
    harness.send(proc, {"id": "p1", "type": "prompt", "message": "hello"})
    harness.read_until(proc, lambda event, _: event.get("type") == "agent_end", timeout=20)

    notifies = harness.run_command(proc, "/muse-msp-doctor")
    assert any("muse-msp ok" in text for text in notifies), notifies
    assert any("sandboxed=false" in text for text in notifies), notifies
    assert any("liveSessions=1" in text for text in notifies), notifies
    assert any("skills=2(pi-session-context,acme:deploy)" in text for text in notifies), notifies
    print("PASS: doctor reports host, sessions, and loaded skills")

    notifies = harness.run_command(proc, "/muse-msp-sessions")
    assert any("* 00000000" in text for text in notifies), notifies
    assert any("99999999" in text and "server only" in text for text in notifies), notifies
    print("PASS: sessions joins server inventory")

    index = root / ".pi/agent/muse-msp-sessions.json"
    entries = json.loads(index.read_text())
    entries.append(["deadkey", {"sessionId": "bogus000-0000-7000-8000-000000000000",
                                "cwd": str(root), "model": "muse-spark-1.3", "sandboxed": False,
                                "messageCount": 3, "prefixFp": "nope",
                                "savedAt": int(time.time() * 1000)}])
    index.write_text(json.dumps(entries))
    notifies = harness.run_command(proc, "/muse-msp-sessions prune")
    assert any("dropped=1 kept=1" in text for text in notifies), notifies
    assert "bogus000" not in index.read_text()
    print("PASS: prune drops server-unknown sessions via one list call")

    notifies = harness.run_command(proc, "/muse-msp-fork")
    assert any("continues on the fork" in text for text in notifies), notifies
    harness.send(proc, {"id": "p2", "type": "prompt", "message": "after fork"})
    harness.read_until(proc, lambda event, _: event.get("type") == "agent_end", timeout=20)
    methods = [line.strip() for line in log.read_text().splitlines()]
    assert methods.count("session/start") == 1, methods
    assert methods.count("session/fork") == 1, methods
    assert methods.count("turn/start") == 2, methods
    turns = [json.loads(line) for line in input_log.read_text().splitlines()
             if json.loads(line)["method"] == "turn/start"]
    assert len(turns) == 2, turns
    assert turns[0]["sessionId"] != turns[1]["sessionId"], turns
    print("PASS: fork rebinds the chat to the forked session")
finally:
    harness.stop(proc)
