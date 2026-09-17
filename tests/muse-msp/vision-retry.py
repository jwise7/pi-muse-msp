#!/usr/bin/env python3
import json, pathlib, sys, time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import rpc_harness as harness

root = harness.mkdtemp("pi-msp-vision.")
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
proc = harness.spawn(root, log, extra_env={"FAKE_HANG": "1"})

try:
    harness.send(proc, {"id": "start", "type": "prompt", "message": "look at the screenshot"})
    harness.read_until(proc, lambda _, seen: any(item.get("type") == "turn_start" for item in seen), timeout=8)
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
    events = harness.read_until(proc, lambda event, _: event.get("type") == "agent_end", timeout=16)
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
    harness.stop(proc)
