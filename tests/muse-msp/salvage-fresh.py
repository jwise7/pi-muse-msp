#!/usr/bin/env python3
import json, os, pathlib, select, subprocess, tempfile, time

root = pathlib.Path(tempfile.mkdtemp(prefix="pi-msp-salvage.", dir="/tmp"))
log = root / "msp.log"
sid = "00000000-0000-7000-8000-000000000001"
jsonl = root / ".local/share/muse/sessions/1970/01/01" / sid / "session.jsonl"
jsonl.parent.mkdir(parents=True)
env = os.environ | {
    "HOME": str(root),
    "PI_MUSE_BINARY": str(pathlib.Path(__file__).with_name("fake-host.py")),
    "FAKE_MSP_LOG": str(log),
    "FAKE_HANG": "1",
}
proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session", "--no-extensions", "-e",
     str(pathlib.Path(__file__).parents[2] / "extensions/muse-msp.ts"),
     "--provider", "muse-msp", "--model", "muse-spark-1.3", "--no-tools"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
)


def send(value):
    proc.stdin.write(json.dumps(value) + "\n")
    proc.stdin.flush()


def read_until(kind, timeout=15, role=None):
    deadline = time.time() + timeout
    seen = []
    while time.time() < deadline:
        ready, _, _ = select.select([proc.stdout], [], [], max(0, deadline - time.time()))
        if not ready:
            break
        event = json.loads(proc.stdout.readline())
        seen.append(event)
        if event.get("type") == kind and (role is None or event.get("message", {}).get("role") == role):
            return seen
    raise AssertionError(f"timed out waiting for {kind}: {seen[-10:]}")


try:
    send({"type": "prompt", "message": "first"})
    read_until("turn_start", 8)
    now = int(time.time() * 1_000_000)
    jsonl.write_text("\n".join(json.dumps(row) for row in [
        {"recorded_at": now, "payload": {"kind": "run", "run_id": "run1", "event": {
            "kind": "assistant_message_committed", "message_id": "m1", "text": "RECOVERED"}}},
        {"recorded_at": now + 1, "payload": {"kind": "run", "run_id": "run1", "event": {
            "kind": "terminal", "terminal": "completed"}}},
    ]) + "\n")
    events = read_until("message_end", role="assistant")
    assert "fresh Muse session next turn" in json.dumps(events), events[-10:]

    send({"type": "prompt", "message": "second"})
    read_until("turn_start", 8)
    deadline = time.time() + 3
    while time.time() < deadline and log.read_text().splitlines().count("turn/start") < 2:
        time.sleep(0.05)
    methods = log.read_text().splitlines()
    assert methods.count("session/start") == 2, methods
    assert methods.count("turn/start") == 2, methods

    send({"type": "abort"})
    deadline = time.time() + 3
    while time.time() < deadline and "turn/interrupt" not in log.read_text().splitlines():
        time.sleep(0.05)
    methods = log.read_text().splitlines()
    assert "turn/interrupt" in methods and "turn/cancel" not in methods, methods
    print("PASS: salvaged sessions are discarded; abort uses turn/interrupt")
finally:
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
