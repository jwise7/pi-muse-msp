# Steering model

One `muse serve` host per Pi process (lazy singleton). One MSP session per Pi chat; after a restart, a fresh session gets full Pi context.

- Pi input events stream with `streamingBehavior="steer"` to MSP `turn/steer` using the active `sessionId`/`turnId`. Fall back to Pi's queue only when MSP rejects steering. (Pi's direct RPC `type="steer"` bypasses the extension input event.)
- Esc/stop maps to `turn/interrupt`. Reserve `turn/cancel` for bridge-level failures.
- Set `turnId` to the fresh `commandId` before awaiting `turn/start` so immediate notifications can't race past filters.
- If the projector stalls but `session.jsonl` has the completed answer: return the durable answer, set `keepLive=false`, force a fresh session next turn. Never gate salvage on a live-host RPC `finally()`; time-bound `listPending`/approval calls and read `session.jsonl` first.
- Render Muse internal tools outside assistant thinking: Pi working message while active, TUI-only custom entry on completion. Never emit fake assistant `toolCall` blocks — Pi would execute them again.
- Session start for Spark must send `providerId: "meta"`; `modelId` alone routes to provider `muse`, which rejects retained tool-read images. On retained-media failure: drop the session (no `keepLive`), retry once as fresh-session vision input, then surface the error — never loop or silently drop images.
- `muse serve` has no `--yolo`: default to approval-mode allow-all, auto-select an approved choice if a request still arrives, Pi UI only as fallback. `approvalAlreadyResolved` is benign.
- On `session_shutdown`, dispose the extension-owned child with a bounded `SIGKILL` fallback. Never broad-`pkill muse serve` — each Pi chat owns one; kill only a proven stale child of the target Pi process.

## Verify

1. `python3 tests/muse-msp/regressions.py` (fake host; no live sessions).
2. After `/reload` on an idle chat: one `muse serve` child under the Pi PID; one text turn; one image request plus text follow-up.
