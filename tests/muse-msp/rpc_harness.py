#!/usr/bin/env python3
"""Shared RPC-mode harness for fake-host suites (steer, salvage-fresh, vision-retry).

Spawns `pi --mode rpc` with the MSP extension on the fake host under an
isolated HOME. Suites import this module and keep only scenario logic.
"""
import atexit
import json
import os
import pathlib
import select
import shutil
import subprocess
import tempfile
import time

here = pathlib.Path(__file__).resolve().parent
extension = here.parents[1] / "extensions/muse-msp.ts"

# Per-process stdout reassembly. readline() on the buffered text wrapper
# read-aheads: select() then only sees NEW bytes, so lines already in the
# buffer look like a timeout whenever pi writes a burst (message_end plus
# its notify in one chunk). os.read() into our own buffer never hides data.
_readers = {}


def _readline(proc, timeout):
    """Next stdout line (sans newline), or None on timeout/EOF."""
    buf = _readers.setdefault(id(proc), bytearray())
    deadline = time.time() + timeout
    while True:
        nl = buf.find(b"\n")
        if nl >= 0:
            line = bytes(buf[:nl])
            del buf[:nl + 1]
            return line.decode()
        remaining = deadline - time.time()
        if remaining <= 0:
            return None
        try:
            ready, _, _ = select.select([proc.stdout], [], [], remaining)
        except (OSError, ValueError):
            return None
        if not ready:
            return None
        try:
            chunk = os.read(proc.stdout.fileno(), 65536)
        except OSError:
            return None
        if not chunk:
            return None
        buf += chunk


def mkdtemp(prefix):
    """Scratch dir under /tmp, removed at process exit.

    Suites need stable paths across spawned pi processes (HOME, log dirs),
    which TemporaryDirectory context managers cannot provide at module scope;
    the atexit hook gives the same no-residue guarantee instead.
    """
    path = pathlib.Path(tempfile.mkdtemp(prefix=prefix, dir="/tmp"))
    atexit.register(lambda: shutil.rmtree(path, ignore_errors=True))
    return path


def spawn(home, log, extra_env=None, cwd=None, input_log=None):
    """Start an RPC-mode pi against the fake host. Caller owns stop()."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("FAKE_")}
    env.update(HOME=str(home), PI_MUSE_BINARY=str(here / "fake-host.py"),
               FAKE_MSP_LOG=str(log), **(extra_env or {}))
    if input_log is not None:
        env["FAKE_MSP_INPUT_LOG"] = str(input_log)
    return subprocess.Popen(
        ["pi", "--mode", "rpc", "--no-session", "--no-extensions", "-e",
         str(extension), "--provider", "muse-msp", "--model", "muse-spark-1.3",
         "--no-tools"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, env=env, cwd=str(cwd) if cwd else None,
    )


def send(proc, value):
    proc.stdin.write(json.dumps(value) + "\n")
    proc.stdin.flush()


def read_until(proc, predicate, timeout=20):
    """Collect stdout events until predicate(event, seen); return all seen."""
    deadline = time.time() + timeout
    seen = []
    while True:
        line = _readline(proc, max(0, deadline - time.time()))
        if line is None:
            break
        event = json.loads(line)
        seen.append(event)
        if predicate(event, seen):
            return seen
    err = proc.stderr.read() if proc.poll() is not None else ""
    raise AssertionError(f"timed out; events={seen[-12:]}; stderr={err}")


def wait_for_call(log, method, timeout=10):
    """Poll the fake-host call log until method appears."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if log.exists() and method in log.read_text().splitlines():
            return
        time.sleep(0.05)
    raise AssertionError(f"{method} never arrived; log={log.read_text() if log.exists() else '<missing>'}")


def stop(proc):
    _readers.pop(id(proc), None)
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()


def rpc_call(proc, value, timeout=20):
    """Send an RPC request (must carry a unique id); return its response event."""
    if "id" not in value:
        raise AssertionError("rpc_call needs a request id")
    send(proc, value)
    events = read_until(proc, lambda event, _: event.get("id") == value["id"], timeout=timeout)
    return next(event for event in events if event.get("id") == value["id"])


def get_entries(proc, timeout=20):
    """Return all session entries in append order (custom rows included)."""
    response = rpc_call(proc, {"id": "entries", "type": "get_entries"}, timeout=timeout)
    assert response.get("success") is True, response
    return ((response.get("data") or {}).get("entries")) or []


def run_command(proc, text, timeout=20):
    """Run an extension slash-command prompt; return its notify texts.

    Extension-command prompts get no id-echoed response, so this returns on
    the first notify. Sound because every muse-msp command notifies exactly
    once, at handler end — a second notify would leak into the next call.
    """
    send(proc, {"type": "prompt", "message": text})
    deadline = time.time() + timeout
    seen = []
    notifies = []
    while True:
        line = _readline(proc, max(0, deadline - time.time()))
        if line is None:
            break
        event = json.loads(line)
        seen.append(event)
        if event.get("type") == "extension_ui_request" and event.get("method") == "notify":
            notifies.append(str(event.get("message") or ""))
            return notifies
    raise AssertionError(f"no notify for {text}; events={seen[-8:]}")
