# pi-muse-msp

Muse via `muse serve` MSP (stdio JSON-RPC) as a [Pi coding agent](https://github.com/earendil-works/pi) provider (`muse-msp`).

Long-lived host, true streaming, live token usage, image input. One MSP session per Pi chat and process. Approvals are automatic by default with Pi UI as fallback.

## Install

Copy `extensions/muse-msp.ts` into your Pi extensions directory (`~/.pi/agent/extensions/`), then `/reload` or restart Pi.

Requires the `muse` CLI on `PATH` (override with `PI_MUSE_BINARY`).

## Configure

| Env | Default | Meaning |
| --- | ------- | ------- |
| `PI_MUSE_BINARY` | `muse` | Muse CLI binary |
| `PI_MUSE_MSP_SANDBOXED` | unset (unsandboxed) | `1` to serve with workspace trust instead of `--disable-sandbox` |
| `PI_MUSE_MSP_DEBUG` | unset | `1` for MSP wire debug on stderr |
| `PI_MUSE_MSP_FINGERPRINT` | built-in `sha256:…` | Expected `muse serve` schema fingerprint; mismatch only warns |

Model list is live from `model/list` with a static Spark fallback. Spark sessions start with `providerId: "meta"` so retained tool-read images keep working.

## Test

```sh
python3 tests/muse-msp/regressions.py
```

Isolated fake-host checks: event recovery, bounded retry, duplicate/resolved approvals, JSONL tool-image recovery, vision retry, salvage-fresh. No live Muse sessions touched. See [docs/STEERING.md](docs/STEERING.md) for the live steering model.

## Pinning

Built against the `pi-ai` / `pi-ai/compat` provider API. If `muse serve` or Pi changes the schema, the status line reports a fingerprint mismatch — update the extension. Pinned Pi revision noted in releases.
