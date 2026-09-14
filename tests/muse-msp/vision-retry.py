#!/usr/bin/env python3
import json, os, pathlib, select, subprocess, tempfile, time

root = pathlib.Path(tempfile.mkdtemp(prefix="pi-msp-vision.", dir="/tmp"))
log = root / "msp.log"
sid = "00000000-0000-7000-8000-000000000001"
jsonl = root / ".local/share/muse/sessions/1970/01/01" / sid / "session.jsonl"
jsonl.parent.mkdir(parents=True)
png = root / "shot.png"
png.write_bytes(
    bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
    )
)
env = os.environ | {
    "HOME": str(root),
    "PI_MUSE_BINARY": str(pathlib.Path(__file__).with_name("fake-host.py")),
    "FAKE_MSP_LOG": str(log),
    "FAKE_HANG": "1",
}
proc = subprocess.Popen(
    [
        "pi",
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "-e",
        str(pathlib.Path(__file__).parents[2] / "extensions" / "muse-msp.ts"),
        "--provider",
        "muse-msp",
        "--model",
        "muse-spark-1.3",
        "--no-tools",
    ],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    env=env,
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


try:
    send({"id": "start", "type": "prompt", "message": "look at the screenshot"})
    read_until(lambda _, seen: any(item.get("type") == "turn_start" for item in seen), timeout=8)
    now_us = int(time.time() * 1_000_000)
    jsonl.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "recorded_at": now_us,
                        "payload": {
                            "kind": "run",
                            "run_id": "vis1",
                            "event": {
                                "kind": "tool_result_model_visible_content",
                                "content": [
                                    {
                                        "kind": "image",
                                        "path": str(png),
                                        "media_type": "image/png",
                                    }
                                ],
                            },
                        },
                    }
                ),
                json.dumps(
                    {
                        "recorded_at": now_us + 1,
                        "payload": {
                            "kind": "run",
                            "run_id": "vis1",
                            "event": {
                                "kind": "terminal",
                                "terminal": "failed",
                                "reason": "provider-private history is incompatible with the active route: retained media history is unsupported by target provider `muse`",
                            },
                        },
                    }
                ),
            ]
        )
        + "\n"
    )
    events = read_until(lambda event, _: event.get("type") == "agent_end", timeout=16)
    ame = [event.get("assistantMessageEvent") or {} for event in events]
    text = "".join(e.get("delta", "") for e in ame if e.get("type") == "text_delta")
    thinking = "".join(e.get("delta", "") for e in ame if e.get("type") == "thinking_delta")
    methods = [line.strip() for line in log.read_text().splitlines()]
    assert methods.count("turn/start") == 2, methods
    assert methods.count("session/start") == 2, methods
    assert "SAW-IMAGES:1" in text, text
    assert "cannot retain tool-read images" in thinking, thinking
    print("PASS: retained-media failure retried with attached images")
finally:
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
