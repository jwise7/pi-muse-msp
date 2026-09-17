#!/usr/bin/env python3
"""pi-ask-and-approve conformance: every behavior the SKILL.md promises must
exist verbatim in the muse-msp extension, so doc and code cannot drift."""
import pathlib

here = pathlib.Path(__file__).resolve().parent
ext = (here.parents[1] / "extensions/muse-msp.ts").read_text()
skill_path = pathlib.Path.home() / ".config/muse/skills/pi-ask-and-approve/SKILL.md"

# auto-approval path the skill promises
for snippet in ['approvalMode: sandboxed ? "onRequest" : "allowAll"',
                '"approved" || item["decision"] === "approvedForSession"',
                'host.request("approval/decide"',
                "auto-approved: "]:
    assert snippet in ext, snippet

# headless-approval failure the skill promises
assert "automatic approval failed:" in ext

# clarification path the skill promises
for snippet in ['reason: "Pi has no interactive UI"',
                '"Muse asked a clarifying question; answer it in chat and retry"',
                '"Let me explain…"',
                "content.slice(0, 500)",
                "freeText: value.slice(0, 500)",
                '"userInput/answer"',
                '"userInput/clarify"',
                '"userInput/cancel"']:
    assert snippet in ext, snippet

if not skill_path.is_file():
    print("PASS: extension approval/clarification behaviors present "
          "(SKILL.md cross-check SKIP: not installed)")
    raise SystemExit(0)
skill = skill_path.read_text()

# the skill must actually mention each promise (no silent drift the other way)
for phrase in ["allowAll", "auto-approved", "Let me explain",
               "500 characters", "answer it in chat and retry",
               "never ask permission"]:
    assert phrase in skill, phrase

print("PASS: ask-and-approve doc matches extension")
