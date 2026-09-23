# Changelog

## 0.2.3

Tested against Pi 0.85.1 and 0.87.1 (`pi-ai` / `pi-ai/compat` provider API).

- Support Pi 0.86+ transcript system messages: the provider-facing context
  now leads with `{role:"system", content:<prompt string>}` and carries no
  `systemPrompt` field. The old history renderer fell into its assistant
  branch and crashed every turn with
  `message.content.map is not a function`; system text is now folded into
  the head `## System instructions` block (deduped with `systemPrompt` on
  older Pi) and mid-conversation system updates ride along in place, on
  both fresh and reused sessions
- Key UI bridging on the first substantive message instead of the raw
  transcript head: Pi ≥0.86 shows system messages as structured sections
  in context events but rendered text in the provider transcript, which
  silently unlinked activity rows; fingerprints now also fold sections in
  so distinct prompt states never collide
- Harden assistant-history rendering against string content and unknown
  shapes so future transcript roles degrade gracefully instead of throwing
- Hide `reminderChild` session items again: the 0.2.0 generic renderer
  surfaced them as activity rows, but they carry no drill-in value

## 0.2.2

Tested against Pi 0.85.1 (`pi-ai` / `pi-ai/compat` provider API).

- Hold durable-log progress while live view events flow: the finished
  answer no longer re-renders as dimmed thinking on reasoning-heavy turns
- Salvage progress carries reasoning summaries only; assistant commits are
  terminal answers and feed text-channel recovery alone

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
