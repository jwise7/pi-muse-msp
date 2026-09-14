#!/usr/bin/env python3
"""pi-memory-propose: propose.mjs appends validated entries, lists, rejects bad input, never touches Hermes."""
import json
import os
import pathlib
import subprocess
import tempfile

here = pathlib.Path(__file__).resolve().parent
helper = pathlib.Path.home() / ".config/muse/skills/pi-memory-propose/propose.mjs"
agent_home = pathlib.Path(tempfile.mkdtemp(prefix="pi-propose-home.", dir="/tmp"))
agent_dir = agent_home / ".pi" / "agent"
env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent_dir)}


def run(*args):
    return subprocess.run(["node", str(helper), *args], env=env,
                           text=True, capture_output=True, timeout=30)


# add: valid entry, id on stdout, JSONL row with expected fields
r = run("add", "--fact", "Retry flaky deploys with --no-cache first",
        "--project", "web", "--target", "failure", "--category", "tool-quirk",
        "--evidence", "three green runs after red")
assert r.returncode == 0, (r.stdout, r.stderr)
entry_id = r.stdout.strip()
assert entry_id.startswith("p-"), r.stdout
queue = agent_dir / "muse-proposals.jsonl"
rows = [json.loads(line) for line in queue.read_text().splitlines()]
assert len(rows) == 1, rows
row = rows[0]
assert row["id"] == entry_id and row["fact"].startswith("Retry flaky"), row
assert (row["project"], row["target"], row["category"], row["scope"]) == ("web", "failure", "tool-quirk", "project"), row
assert row["cwd"] == str(pathlib.Path.cwd()), row

# add: global scope carries no cwd; project default is cwd basename
r = run("add", "--fact", "Prefer rg over grep", "--scope", "global")
assert r.returncode == 0, (r.stdout, r.stderr)
rows = [json.loads(line) for line in queue.read_text().splitlines()]
assert len(rows) == 2 and rows[1]["scope"] == "global" and rows[1]["cwd"] == "", rows

# list: project filter
r = run("list", "--project", "web")
assert r.returncode == 0, (r.stdout, r.stderr)
assert len(json.loads(r.stdout)) == 1, r.stdout
r = run("list")
assert len(json.loads(r.stdout)) == 2, r.stdout

# reject: missing fact, bad enums, oversize fact
for args in (["add"], ["add", "--fact", "x", "--target", "bogus"],
             ["add", "--fact", "x", "--category", "bogus"],
             ["add", "--fact", "x" * 2001]):
    r = run(*args)
    assert r.returncode != 0, args
assert len(queue.read_text().splitlines()) == 2, "rejected adds must not append"

# Hermes store untouched: no sessions.db, no markdown created by the helper
assert not (agent_dir / "sessions.db").exists()
assert not (agent_dir / "MEMORY.md").exists()
assert not (agent_dir / "pi-hermes-memory").exists()

print("PASS: propose add/list/validate, Hermes untouched")
