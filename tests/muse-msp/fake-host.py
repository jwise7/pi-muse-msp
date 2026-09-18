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


def next_session_id():
    # Cross-process counter (kept in HOME, which tests isolate per case)
    # so a fresh session/start in a NEW process mints a NEW id. Without
    # this every process restarts at ...000001 and stale-entry eviction
    # is unobservable.
    global session_count
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
    return f"00000000-0000-7000-8000-{session_count:012d}"


# Every spawned host records its argv once, so posture tests can prove which
# flags each generation ran with (method-count assertions ignore this line).
with open(log_path, "a") as _argv_log:
    _argv_log.write("argv:" + " ".join(sys.argv[1:]) + "\n")


def write_durable_records(session_id, turn_id, terminal):
    """Mid-turn durable state: summary + answer commits, terminal optional."""
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
                "event": {"kind": "assistant_message_committed", "message_id": "answer-1", "text": "SLOW-ANSWER"},
            },
        },
    ]
    if terminal:
        records.append(
            {
                "recorded_at": now + 2,
                "payload": {
                    "run_id": turn_id,
                    "event": {"kind": "terminal", "terminal": "completed", "reason": None},
                },
            }
        )
    with open(path, "a") as output:
        for record in records:
            output.write(json.dumps(record) + "\n")


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
        # Both postures pass --trust-workspace now; the sandboxed host is the
        # one WITHOUT --disable-sandbox.
        if "--disable-sandbox" not in sys.argv:
            delay = float(os.environ.get("FAKE_DELAY_TRUST_INITIALIZE", "0") or 0)
            if delay:
                time.sleep(delay)
        result(message, {"schema": {"fingerprint": "sha256:0000000000000000000000000000000000000000000000000000000000000000"}})
    elif method == "model/list":
        if os.environ.get("FAKE_HANG_MODELLIST") == "1":
            continue
        result(message, {"models": []})
    elif method == "skill/list":
        result(message, {"skills": [
            {"selector": "pi-session-context", "displayName": "Pi Session Context", "source": "user"},
            {"selector": "acme:deploy", "displayName": "Deploy", "source": "plugin", "pluginId": "acme"},
        ]})
    elif method == "session/list":
        sessions = [{"sessionId": session_id, "modelId": "muse-spark-1.3",
                     "updatedAt": "2026-09-17T00:00:00Z", "status": "idle"}]
        if os.environ.get("FAKE_LIST_EXTRA") == "1":
            sessions.append({"sessionId": "99999999-9999-7999-8999-999999999999",
                             "modelId": "muse-spark-1.2", "updatedAt": "2026-09-01T00:00:00Z",
                             "status": "notLoaded"})
        result(message, {"sessions": sessions, "nextCursor": None})
    elif method == "session/start":
        if os.environ.get("FAKE_HANG_START") == "1":
            continue
        session_id = next_session_id()
        provider = (message.get("params") or {}).get("providerId")
        with open(log_path, "a") as log:
            log.write(f"session/start provider={provider}\n")
        dump_input({"method": "session/start", "params": message.get("params") or {}})
        result(message, {"session": {"sessionId": session_id, "providerId": provider}})
    elif method == "session/resume":
        if os.environ.get("FAKE_HANG_RESUME") == "1":
            continue
        if os.environ.get("FAKE_RESUME_FAIL") == "1":
            send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": "unknown session"}})
            continue
        pending = [{"kind": "approval", "approvalId": "approval-9", "viewCursor": "v:9"}] \
            if os.environ.get("FAKE_RESUME_PENDING") == "1" else []
        result(message, {"session": {"sessionId": session_id}, "history": {"mode": "none"}, "pendingRequests": pending, "viewCursor": "v:1"})
    elif method == "session/setModel":
        model = ((message.get("params") or {}).get("model") or {}).get("modelId")
        with open(log_path, "a") as log:
            log.write(f"session/setModel model={model}\n")
        result(message, {"status": "accepted"})
    elif method == "session/fork":
        session_id = next_session_id()
        result(message, {"session": {"sessionId": session_id}, "history": {"mode": "none"}, "pendingRequests": [], "viewCursor": "v:9"})
    elif method == "turn/start":
        turn_count += 1
        turn_id = message["params"]["commandId"]
        if os.environ.get("FAKE_DURABLE_NO_ACK") == "1":
            write_durable_completed(session_id, turn_id, "DURABLE-ANSWER")
            continue
        result(message, {"commandId": turn_id, "status": "accepted", "turnId": turn_id, "startedNewTurn": True, "disposition": "started"})
        notify("turn/started", {"sessionId": session_id, "turnId": turn_id})
        # Independent top-ups, composable with any flow below.
        if os.environ.get("FAKE_NOTIFY_TODOS") == "1":
            notify("session/todoListChanged", {"sessionId": session_id, "items": [
                {"text": "Write code", "status": "completed"},
                {"text": "Write tests", "status": "completed"},
            ]})
        if os.environ.get("FAKE_NOTIFY_CONTEXT") == "1":
            notify("session/contextUsage", {"sessionId": session_id, "pressure": "warning", "usedTokens": 800000, "windowTokens": 1000000})
        if os.environ.get("FAKE_NOTIFY_VIEWHEALTH") == "1":
            notify("session/viewHealthChanged", {"sessionId": session_id, "health": "unavailable", "noneReason": "projectionUnavailable"})
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
        elif os.environ.get("FAKE_SLOW_DURABLE") == "1":
            # Durable commits land mid-turn (no terminal yet) while live deltas
            # keep flowing: salvage must hold durable progress, not duplicate it.
            write_durable_records(session_id, turn_id, terminal=False)
            notify("item/delta", {"sessionId": session_id, "itemId": "rs1", "field": "summary.0", "delta": "Durable recovery summary"})
            notify("item/delta", {"sessionId": session_id, "itemId": "answer", "field": "text", "delta": "SLOW-"})
            time.sleep(3.5)
            notify("item/delta", {"sessionId": session_id, "itemId": "answer", "field": "text", "delta": "ANSWER"})
            notify("item/completed", {"sessionId": session_id, "item": {"itemId": "answer", "turnId": turn_id, "kind": "agentMessage", "text": "SLOW-ANSWER"}})
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
        elif os.environ.get("FAKE_CANCELLED") == "1":
            notify("turn/completed", {"sessionId": session_id, "turnId": turn_id, "terminal": "cancelled", "reason": "server stopped it"})
        elif os.environ.get("FAKE_UNKNOWN_TERMINAL") == "1":
            notify("turn/completed", {"sessionId": session_id, "turnId": turn_id, "terminal": "evaporated", "reason": "melted"})
        elif os.environ.get("FAKE_RETRY_FLOW") == "1":
            notify("turn/retryScheduled", {"sessionId": session_id, "turnId": turn_id, "attempt": 1, "maxAttempts": 3, "nextAttempt": 2, "retryDelayMs": 2000, "reason": "model overloaded"})
            notify("item/completed", {"sessionId": session_id, "item": {"itemId": "answer", "turnId": turn_id, "kind": "agentMessage", "text": "RETRY-ANSWER"}})
            notify("turn/completed", {"sessionId": session_id, "turnId": turn_id, "terminal": "completed"})
        elif os.environ.get("FAKE_USAGE") == "1":
            notify("item/completed", {"sessionId": session_id, "item": {"itemId": "answer", "turnId": turn_id, "kind": "agentMessage", "text": "USAGE-ANSWER"}})
            notify("turn/completed", {"sessionId": session_id, "turnId": turn_id, "terminal": "completed", "usage": {"inputTokens": 101, "outputTokens": 202}})
        elif os.environ.get("FAKE_ODD_ITEM") == "1":
            notify("item/completed", {"sessionId": session_id, "item": {"itemId": "tp-1", "turnId": turn_id, "kind": "teleport", "fallbackText": "beamed up"}})
            notify("item/completed", {"sessionId": session_id, "item": {"itemId": "answer", "turnId": turn_id, "kind": "agentMessage", "text": "ODD-ANSWER"}})
            notify("turn/completed", {"sessionId": session_id, "turnId": turn_id, "terminal": "completed"})
        elif os.environ.get("FAKE_ITEMS") == "1":
            notify("item/completed", {"sessionId": session_id, "item": {"itemId": "sg-1", "turnId": turn_id, "kind": "subagent", "agentPath": "researcher", "objective": "find docs", "subagentId": "sub-9", "childSessionId": "cs-1", "status": "completed"}})
            notify("item/completed", {"sessionId": session_id, "item": {"itemId": "tc-1", "turnId": turn_id, "kind": "toolCall", "tool": "bash", "args": "{\"command\": \"ls\"}", "status": "completed", "outputRef": {"id": "out-7", "kind": "tool_output"}}})
            notify("item/completed", {"sessionId": session_id, "item": {"itemId": "wf-1", "turnId": turn_id, "kind": "workflow", "fallbackText": "deploy", "status": "completed", "children": [
                {"childId": "a", "terminal": "completed"}, {"childId": "b", "terminal": "completed"}, {"childId": "c", "terminal": "failed"},
            ]}})
            notify("item/updated", {"sessionId": session_id, "item": {"itemId": "tc-2", "turnId": turn_id, "kind": "toolCall", "tool": "bash", "args": "{\"command\": \"sleep 60\"}", "background": True}})
            notify("item/completed", {"sessionId": session_id, "item": {"itemId": "answer", "turnId": turn_id, "kind": "agentMessage", "text": "ITEMS-ANSWER"}})
            notify("turn/completed", {"sessionId": session_id, "turnId": turn_id, "terminal": "completed"})
    elif method == "approval/listPending":
        if os.environ.get("FAKE_RESUME_PENDING") == "1":
            result(message, {"approvals": [{
                "sessionId": session_id, "approvalId": "approval-9",
                "currentRequirementId": {"approvalId": "approval-9", "sourceIndex": 0},
                "toolName": "bash", "availableChoices": [
                    {"choiceId": "allow_once", "decision": "approved", "scope": "once", "label": "Allow once"},
                ],
            }], "userInputs": []})
        else:
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
    elif method == "subagent/readResult":
        assert message["params"]["subagentId"] == "sub-9", message["params"]
        result(message, {"summary": "Docs found", "text": "SUBAGENT-RESULT-TEXT"})
    elif method == "item/readOutput":
        assert message["params"]["outputRef"] == "out-7", message["params"]
        result(message, {"content": "TOOL-OUTPUT-BYTES", "eof": True, "byteLen": 17, "offsetBytes": 0, "mediaType": "text/plain"})
