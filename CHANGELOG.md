# Changelog

## 0.2.7

- Map live `model/list` metadata onto Pi model definitions instead of
  stamping every model with the static 1M/128k/full-thinking defaults:
  `contextLimit`/`outputLimit` become `contextWindow`/`maxTokens`, priced
  rows carry their `cost` rates, and `variants` (plus
  `reasoningEffortVariants` tiers) become the `thinkingLevelMap`, with
  unlisted tiers marked unsupported (`null`). Verified against Muse
  1.4.6, whose rows report `contextLimit: 1007997` — not the rounded
  1,000,000 previously hardcoded — and whose spark-1.2 rows top out at
  `xhigh` (no `max`). Rows with missing or unusable limits fall back to
  the static defaults, rows with no variant field keep the full map, and
  the static spark-1.2 entries now carry their known xhigh ceiling so
  the offline fallback matches. New `model-metadata.py` regression
  covers the live-row parsing.
- The `muse-spark` server-default alias now inherits the default row's
  real limits and tiers instead of the static defaults, and sub-1 limit
  values can no longer floor to a zero context window or output cap.
- Fix the one outstanding `tsc` error (steer-fallback discriminant
  check) so the extension typechecks clean, and fix the persistence
  regression's Pi version parsing for Pi 1.x (`1.0.0` was read as a
  pre-0.86 minor version).
- Note for users with a curated Pi `enabledModels` list: the picker is
  scoped to that list, so add `muse-msp/muse-wonder-1.0` and
  `muse-msp/muse-wonder-1.0-contributor` to see the Wonder models —
  no extension release can opt a model into a user's allowlist.

## 0.2.6

- Keep the contributor models in the picker across live refreshes: `muse
  serve` `model/list` on Muse 1.4.6 lists only `muse-wonder-1.0`,
  `muse-spark-1.3`, and `muse-spark-1.2`, and a successful refresh replaces
  the static fallback with exactly those rows — so `muse-spark-1.3-contributor`
  and `muse-spark-1.2-contributor` vanished after every refresh even though
  `session/start` accepts them (verified). Both contributor ids join the
  static `EXTRA_MODELS` union alongside the wonder pair, so all seven entries
  survive on every registration path. Live rows still win by id when a future
  server lists them.

## 0.2.5

- Register Muse Wonder models statically: `muse-wonder-1.0` and
  `muse-wonder-1.0-contributor` now appear in the Pi model picker even
  though `muse serve` `model/list` (verified on Muse 1.4.6) advertises
  spark rows only. The ids pass straight through to `session/start`,
  which accepts them — a pong turn completed on `muse-wonder-1.0` over
  MSP. When a future server lists wonder rows itself, the live entries
  take over by id. Requires a Muse build whose catalog ships wonder
  (1.4.6 does); older builds fail the turn with the server's
  unknown-model error.

## 0.2.4

Tested against Pi 0.87.1 (`pi-ai` / `pi-ai/compat` provider API).

- Deliver background completions to the Pi thread: runs that finish while
  no Pi turn is in flight (monitor/cron wakes) previously left no trace in
  the chat. An idle watcher now polls each kept-live session's durable log
  for newly completed runs and posts each answer as a
  `muse-msp-background` custom message plus a UI notification. A completed
  run-id cursor snapshotted at every turn end keeps a turn's own answer
  from re-posting and never backfills old history; `PI_MUSE_MSP_BACKGROUND=0`
  disables delivery and `PI_MUSE_MSP_BACKGROUND_MS` overrides the 15s idle
  poll interval. Delivery is event-driven: persistent `turn/completed` and
  `session/statusChanged`-idle handlers (the host emits both for background
  wakes under fresh turnIds, wiretap-verified) nudge the watch the moment a
  wake lands; the interval poll stays as the backstop. Attribution is time-plus-text: a background run completing
  during a Pi turn is deferred and posted at the next idle tick instead of
  suppressed; only a run with text identical to the turn's answer is claimed
  as the turn's own. Delivery itself is pure local log I/O and costs no
  tokens; posted completions join the session context like any message.

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
