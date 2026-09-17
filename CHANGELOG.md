# Changelog

## 0.2.1

Tested against Pi 0.85.1 (`pi-ai` / `pi-ai/compat` provider API).

- Publish as `pi-muse-msp` on npm for installation with
  `pi install npm:pi-muse-msp` and discovery in the Pi package catalog
- Add npm author, issue tracker, public-access policy, and search metadata

## 0.2.0

Tested against Pi 0.85.1 (`pi-ai` / `pi-ai/compat` provider API).

- Bound every awaited host RPC (session start/resume, model list, steer,
  approvals, clarification): a silent host now fails fast or falls back
  instead of hanging the turn forever
- Cap retained host stderr; harden session-log reads against short reads
  and dateless lines
- Funnel approval-dialog failures into turn errors instead of risking an
  unhandled rejection that kills the host
- Cover the full turn lifecycle: cancelled/unknown terminals, generic item
  kinds, scheduled retries, and terminal token usage in the status line
- Register trust-workspace on every session and report loaded skills from
  `/muse-msp-doctor`
- Switch the live Muse model in place on Pi model change (no session restart)
- Surface todo, context-pressure, and view-health notifications as activity
  rows and status-line state
- Drill into finished subagents (`/muse-msp-subagent`) and stored tool
  output (`/muse-msp-output`) from activity-row item ids
- Join `/muse-msp-sessions` with the server inventory; prune via one list
  call; fork the live session with `/muse-msp-fork`
- Fix a race where a turn settling before its start acknowledgement leaked
  a stale steer/fork target
- Unify session-identity cwd on the process directory (`sessionCwd()`):
  bridge, steer, fork, and turn keys can no longer disagree
- Model refresh reuses the live host when one exists and otherwise spawns
  sandboxed until a turn records the real posture (Pi applies CLI flags
  after the startup refresh): sandboxed runs never spawn an unsandboxed
  host, and refresh never respawns just to list models
- Host RPC timeouts live inside `request()`: a timed-out call drops its
  pending entry and releases its event-loop hold
- `/muse-msp-doctor` reports skills for the current chat's session first,
  falling back to the latest origin session
- Test scratch dirs clean themselves up at exit (no more `/tmp` residue)
- Ship as an installable Pi package (`pi install git:github.com/jwise7/pi-muse-msp`):
  `pi-package` keyword, `pi` manifest, core peer ranges per Pi's packaging docs

## 0.1.0

Initial public release. Tested against Pi 0.85.1 (`pi-ai` / `pi-ai/compat` provider API).

- Muse via `muse serve` MSP as a Pi provider with streaming, token usage, image input
- One MSP session per Pi chat with persisted cross-process resume
- Automatic approvals with Pi UI fallback; headless-safe clarification cancel
- Mid-turn steering onto the live MSP turn; durable-log salvage and vision retry
