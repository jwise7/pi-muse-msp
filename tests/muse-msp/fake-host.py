#!/usr/bin/env python3
import datetime, json, os, signal, sys, time


def delayed_sigterm(_signum, _frame):
    """Let a replacement host start before this generation reports close."""
    delay = float(os.environ.get("FAKE_DELAY_SIGTERM", "0") or 0)
    if delay:
        time.sleep(delay)
    print("received SIGTERM; flushed session logs", file=sys.stderr, flush=True)
    os._exit(143)


if os.environ.get("FAKE_DELAY_SIGTERM"):
    signal.signal(signal.SIGTERM, delayed_sigterm)

session_id = "00000000-0000-7000-8000-000000000001"
turn_id = None
session_count = 0
turn_count = 0
log_path = os.environ["FAKE_MSP_LOG"]
input_log_path = os.environ.get("FAKE_MSP_INPUT_LOG", "")


def dump_input(record):
    if not input_log_path:
        return
    with open(input_log_path, "a") as log:
        log.write(json.dumps(record) + "\n")


def send(message):
    print(json.dumps(message), flush=True)


def result(message, value):
    send({"jsonrpc": "2.0", "id": message["id"], "result": value})


def notify(method, params):
    send({"jsonrpc": "2.0", "method": method, "params": params})


def write_durable_completed(session_id, turn_id, text):
    millis = int(session_id.replace("-", "")[:12], 16)
    date = datetime.datetime.fromtimestamp(millis / 1000, datetime.timezone.utc)
    path = os.path.join(
        os.path.expanduser("~/.local/share/muse/sessions"),
        date.strftime("%Y/%m/%d"), session_id, "session.jsonl",
    )
    os.makedirs(os.path.dirname(path), exist_ok=True)
    now = time.time_ns() // 1000
    records = [
        {
            "recorded_at": now,
            "payload": {
                "run_id": turn_id,
                "event": {"kind": "reasoning_summary_committed", "message_id": "summary-1", "text": "Durable recovery summary"},
            },
        },
        {
            "recorded_at": now + 1,
            "payload": {
                "run_id": turn_id,
                "event": {"kind": "assistant_message_committed", "message_id": "answer-1", "text": text},
            },
        },
        {
            "recorded_at": now + 2,
            "payload": {
                "run_id": turn_id,
                "event": {"kind": "terminal", "terminal": "completed", "reason": None},
            },
        },
    ]
    with open(path, "a") as output:
        for record in records:
            output.write(json.dumps(record) + "\n")


for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method", "")
    with open(log_path, "a") as log:
        log.write(method + "\n")
    if method == "initialize":
        if "--trust-workspace" in sys.argv:
            delay = float(os.environ.get("FAKE_DELAY_TRUST_INITIALIZE", "0") or 0)
            if delay:
                time.sleep(delay)
        result(message, {"schema": {"fingerprint": "sha256:0000000000000000000000000000000000000000000000000000000000000000"}})
    elif method == "model/list":
        result(message, {"models": []})
    elif method == "session/start":
        # Cross-process counter (kept in HOME, which tests isolate per case)
        # so a fresh session/start in a NEW process mints a NEW id. Without
        # this every process restarts at ...000001 and stale-entry eviction
        # is unobservable.
        try:
            counter_path = os.path.join(os.path.expanduser("~"), ".fake-msp-session-counter")
            try:
                with open(counter_path) as f:
                    session_count = int(f.read().strip() or 0)
            except (OSError, ValueError):
                pass
            session_count += 1
            with open(counter_path, "w") as f:
                f.write(str(session_count))
        except OSError:
            session_count += 1
        session_id = f"00000000-0000-7000-8000-{session_count:012d}"
        provider = (message.get("params") or {}).get("providerId")
        with open(log_path, "a") as log:
            log.write(f"session/start provider={provider}\n")
        dump_input({"method": "session/start", "params": message.get("params") or {}})
        result(message, {"session": {"sessionId": session_id, "providerId": provider}})
    elif method == "session/resume":
        if os.environ.get("FAKE_RESUME_FAIL") == "1":
            send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": "unknown session"}})
            continue
        # The extension only reads session.sessionId from this response.
        result(message, {"session": {"sessionId": session_id}, "history": {"mode": "none"}, "pendingRequests": [], "viewCursor": "v:1"})
    elif method == "turn/start":
        turn_count += 1
        turn_id = message["params"]["commandId"]
        if os.environ.get("FAKE_DURABLE_NO_ACK") == "1":
            write_durable_completed(session_id, turn_id, "DURABLE-ANSWER")
            continue
        result(message, {"commandId": turn_id, "status": "accepted", "turnId": turn_id, "startedNewTurn": True, "disposition": "started"})
        notify("turn/started", {"sessionId": session_id, "turnId": turn_id})
        inputs = message.get("params", {}).get("input") or []
        dump_input({
            "method": "turn/start",
            "sessionId": message.get("params", {}).get("sessionId"),
            "text": "\n".join(
                str(part.get("text", "")) for part in inputs
                if isinstance(part, dict) and part.get("type") == "text"
            ),
            "images": sum(1 for part in inputs if isinstance(part, dict) and part.get("type") == "image"),
        })
        image_n = sum(1 for part in inputs if isinstance(part, dict) and part.get("type") == "image")
        if os.environ.get("FAKE_MEDIA_EVENT") == "1" and (turn_count == 1 or os.environ.get("FAKE_MEDIA_ALWAYS") == "1"):
            notify("turn/completed", {"sessionId": session_id, "turnId": turn_id, "terminal": "failed", "error": {"message": "retained media history is unsupported"}})
        elif image_n:
            notify("item/completed", {"sessionId": session_id, "item": {"itemId": "answer", "turnId": turn_id, "kind": "agentMessage", "text": f"SAW-IMAGES:{image_n}"}})
            notify("turn/completed", {"sessionId": session_id, "turnId": turn_id, "terminal": "completed"})
        elif os.environ.get("FAKE_REASONING") == "1":
            notify("item/delta", {"sessionId": session_id, "itemId": "rs1", "field": "summary.0", "delta": "First I consider X"})
            notify("item/delta", {"sessionId": session_id, "itemId": "rs1", "field": "summary.1", "delta": "Then Y"})
            notify("item/completed", {"sessionId": session_id, "item": {"itemId": "rs1", "turnId": turn_id, "kind": "reasoning", "summary": ["First I consider X", "Then Y"]}})
            notify("item/delta", {"sessionId": session_id, "itemId": "answer", "field": "text", "delta": "VISIBLE-ANSWER"})
            notify("item/completed", {"sessionId": session_id, "item": {"itemId": "answer", "turnId": turn_id, "kind": "agentMessage", "text": "VISIBLE-ANSWER"}})
            notify("turn/completed", {"sessionId": session_id, "turnId": turn_id, "terminal": "completed"})
        elif os.environ.get("FAKE_HANG") == "1":
            pass
        elif os.environ.get("FAKE_APPROVAL") == "1":
            approval = {
                "sessionId": session_id, "turnId": turn_id, "approvalId": "approval-1",
                "currentRequirementId": {"approvalId": "approval-1", "sourceIndex": 0},
                "toolName": "bash", "availableChoices": [
                    {"choiceId": "allow_once", "decision": "approved", "scope": "once", "label": "Allow once"},
                    {"choiceId": "abort", "decision": "abort", "scope": "once", "label": "Abort"},
                ],
            }
            notify("approval/requested", approval)
            updated = dict(approval)
            if os.environ.get("FAKE_APPROVAL_DRIFT") == "1":
                # Same approval, differently-shaped requirement (as real
                # approval/updated + salvage rows arrive): must not decide twice.
                updated = dict(approval, currentRequirementId={"approvalId": "approval-1", "sourceIndex": 1})
            notify("approval/updated", updated)
        elif os.environ.get("FAKE_USER_INPUT") == "1":
            notify("userInput/requested", {
                "sessionId": session_id, "turnId": turn_id, "userInputId": "input-1",
                "questions": [{
                    "id": "q1", "question": "Which region?",
                    "options": [{"label": "us-east"}, {"label": "eu-west"}],
                    "selection": {"mode": "single"},
                }],
            })
    elif method == "approval/listPending":
        result(message, {"approvals": [], "userInputs": []})
    elif method == "approval/decide":
        assert message["params"]["choiceId"] == "allow_once"
        if os.environ.get("FAKE_ALREADY_RESOLVED") == "1":
            send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": "Conflict", "data": {"kind": "approvalAlreadyResolved"}}})
        else:
            result(message, {"commandId": message["params"]["commandId"], "status": "accepted", "approvalId": "approval-1", "terminal": True})
        notify("item/completed", {"sessionId": session_id, "item": {"itemId": "answer", "turnId": turn_id, "kind": "agentMessage", "text": "AUTO-APPROVED"}})
        notify("turn/completed", {"sessionId": session_id, "turnId": turn_id, "terminal": "completed"})
    elif method == "turn/steer":
        text = message["params"]["input"][0]["text"]
        result(message, {"commandId": message["params"]["commandId"], "status": "accepted", "turnId": turn_id})
        notify("item/completed", {"sessionId": session_id, "item": {"itemId": "answer", "turnId": turn_id, "kind": "agentMessage", "text": "STEERED:" + text}})
        notify("turn/completed", {"sessionId": session_id, "turnId": turn_id, "terminal": "completed"})
    elif method in ("turn/cancel", "turn/interrupt"):
        result(message, {"status": "accepted"})
    elif method in ("userInput/cancel", "userInput/answer", "userInput/clarify"):
        result(message, {"status": "accepted"})
