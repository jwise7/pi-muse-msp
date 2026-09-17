# pi-muse-msp

Muse via `muse serve` MSP (stdio JSON-RPC) as a [Pi coding agent](https://github.com/earendil-works/pi) provider (`muse-msp`).

Long-lived host, true streaming, live token usage, image input. One MSP session per Pi chat and process. Approvals are automatic by default with Pi UI as fallback.

## Install

```sh
pi install git:github.com/jwise7/pi-muse-msp@v0.2.0
```

then `/reload` or restart Pi. Or copy `extensions/muse-msp.ts` into your Pi extensions directory (`~/.pi/agent/extensions/`) manually.

Requires the `muse` CLI on `PATH` (override with `PI_MUSE_BINARY`).

Platform: macOS/Linux. Durable-log recovery reads Muse sessions under `~/.local/share/muse/sessions`, which does not exist on other platforms.

## Configure

| Env | Default | Meaning |
| --- | ------- | ------- |
| `PI_MUSE_BINARY` | `muse` | Muse CLI binary |
| `PI_MUSE_MSP_SANDBOXED` | unset (unsandboxed) | `1` to serve with workspace trust instead of `--disable-sandbox` |
| `PI_MUSE_MSP_DEBUG` | unset | `1` for MSP wire debug on stderr |
| `PI_MUSE_MSP_FINGERPRINT` | unset (no check) | Expected `muse serve` schema fingerprint; when set, a mismatch warns in diagnostics |

Model list is live from `model/list` with a static Spark fallback. Spark sessions start with `providerId: "meta"` so retained tool-read images keep working.

To pin the fingerprint, copy the live value from `/muse-msp-doctor` into `PI_MUSE_MSP_FINGERPRINT`; future turns then warn if the host schema drifts.

## Security

Defaults favor a trusted local machine: the host runs unsandboxed (`muse serve --disable-sandbox`) and tool approvals auto-approve (`allowAll`), with an `auto-approved: <tool>` activity row as the audit trail. A prompt-injected or malicious model output could therefore run arbitrary tools without asking.

If you run untrusted tasks, enable the sandbox (`PI_MUSE_MSP_SANDBOXED=1` or `--muse-msp-sandboxed`), which serves with workspace trust and per-request approvals (still auto-decided first, Pi UI as fallback). Headless runs (`pi -p`) have no UI fallback: un-answerable approvals and clarifying questions fail the turn instead of asking.

## Commands

| Command | Meaning |
| ------- | ------- |
| `/muse-msp-doctor` | Check the host: binary, handshake, schema fingerprint, live/persisted session counts, loaded skills |
| `/muse-msp-sessions` | List Muse sessions kept for Pi chats (`*` = live) joined with the server inventory; pass `prune` to drop expired or dead entries |
| `/muse-msp-fork` | Fork this chat's live Muse session (whole history) and continue on the fork |
| `/muse-msp-subagent` | Show a finished subagent's result (pass an item id prefix from its activity row) |
| `/muse-msp-output` | Show a tool's stored output (pass an item id prefix from its activity row) |
| `/muse-msp-recover-completed` | Recover the newest completed plaintext answer from a Muse durable session log (defaults to the origin session) |

## Test

Requires the `pi` CLI on `PATH`.

```sh
python3 tests/muse-msp/regressions.py
```

Isolated fake-host checks: version sync, event recovery, bounded retry, duplicate/resolved approvals, JSONL tool-image recovery, vision retry, salvage-fresh, mid-turn steer, headless clarification cancel, hung-RPC timeouts, persisted cross-process resume, compaction context, host generation isolation, pre-ack durable recovery, terminal/usage/retry lifecycle, live model switch, todo/context/health subscribers, subagent drill-down, session fork. No live Muse sessions touched. Four machine-local suites (proposals inbox, session context, memory propose, ask/approve doc conformance) run when their non-repo dependencies are installed and otherwise print SKIP. See [docs/STEERING.md](docs/STEERING.md) for the live steering model.

## Pinning

Built against the `pi-ai` / `pi-ai/compat` provider API. If `muse serve` or Pi changes the schema and `PI_MUSE_MSP_FINGERPRINT` is set, the status line reports a fingerprint mismatch — update the extension. The tested Pi revision is noted in [CHANGELOG.md](CHANGELOG.md).
