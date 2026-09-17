#!/usr/bin/env python3
"""Mid-turn steering reaches MSP turn/steer instead of queueing a follow-up.

RPC mode: prompt "first" with FAKE_HANG keeps the MSP turn in flight (no live
events, no durable log, so salvage never settles it). A second prompt with
streamingBehavior="steer" must fire the extension input handler, which steers
the running MSP turn; the fake host answers STEERED:<text> and completes the
turn. Asserts turn/steer x1, no second turn/start, and the steered text.
"""
import json
import os
import pathlib
import select
import subprocess
import tempfile
import time

here = pathlib.Path(__file__).resolve().parent
root = pathlib.Path(tempfile.mkdtemp(prefix="pi-msp-steer.", dir="/tmp"))
log = root / "msp.log"
env = {k: v for k, v in os.environ.items() if not k.startswith("FAKE_")}
env.update(
    HOME=str(root),
    PI_MUSE_BINARY=str(here / "fake-host.py"),
    FAKE_MSP_LOG=str(log),
    FAKE_HANG="1",
)
proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session", "--no-extensions", "-e",
     str(here.parents[1] / "extensions/muse-msp.ts"),
     "--provider", "muse-msp", "--model", "muse-spark-1.3", "--no-tools"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, env=env, cwd=str(root),
)


def send(value):
    proc.stdin.write(json.dumps(value) + "\n")
    proc.stdin.flush()


def read_until(predicate, timeout=20):
    deadline = time.time() + timeout
    seen = []
    while time.time() < deadline:
        ready, _, _ = select.select([proc.stdout], [], [], max(0, deadline - time.time()))
        if not ready:
            break
        line = proc.stdout.readline()
        if not line:
            break
        event = json.loads(line)
        seen.append(event)
        if predicate(event, seen):
            return seen
    err = proc.stderr.read() if proc.poll() is not None else ""
    raise AssertionError(f"timed out; events={seen[-12:]}; stderr={err}")


def wait_for_call(method, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if log.exists() and method in log.read_text().splitlines():
            return
        time.sleep(0.05)
    raise AssertionError(f"{method} never arrived; log={log.read_text() if log.exists() else '<missing>'}")


try:
    send({"type": "prompt", "message": "first"})
    read_until(lambda _, seen: any(item.get("type") == "turn_start" for item in seen), timeout=10)
    # The MSP turn must be registered as steerable before the steer lands:
    # turn_start fires before the turn/start ack roundtrip completes.
    wait_for_call("turn/start")
    time.sleep(1)
    send({"type": "prompt", "message": "go left", "streamingBehavior": "steer"})
    events = read_until(lambda event, _: event.get("type") == "agent_end", timeout=20)
    ame = [event.get("assistantMessageEvent") or {} for event in events]
    text = "".join(e.get("delta", "") for e in ame if e.get("type") == "text_delta")
    methods = [line.strip() for line in log.read_text().splitlines()]
    assert methods.count("turn/steer") == 1, methods
    assert methods.count("turn/start") == 1, methods
    assert methods.count("session/start") == 1, methods
    assert "STEERED:go left" in text, text
    print("PASS: mid-turn steer reaches MSP turn/steer; no queued follow-up")
finally:
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
