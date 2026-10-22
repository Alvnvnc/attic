# Demo video script — 2:43

Final cut: <https://www.youtube.com/watch?v=0eQjCyVg3dI> (1920×1080, 30 fps, 2:43).
Recorded by `video/record.mjs`, assembled by `video/make.py`; narration timing is derived from the
recorded question timestamps in `s3-events.json`, so re-recording the app take re-times the voice-over
automatically.

| In | Out | Scene | Narration (condensed) |
| --- | --- | --- | --- |
| 0:00 | 0:17 | Title | "Every house has a memory. The plumber who fixed the water heater. The warranty that quietly expires. None of it lives anywhere a voice assistant can reach. Until now." |
| 0:17 | 0:56 | What Attic is | "Attic is an MCP server. A self-hosted skill that Alexa+ calls for anything about the home… it speaks version 2025-11-25 over Streamable HTTP. One endpoint, one bearer token, no vendor lock-in. The assistant stays stateless, and the house keeps its own data." |
| 0:56 | 1:57 | Live take | Four turns against the deployed app, with the real JSON-RPC in the right-hand panel: water heater service, fridge warranty, "the dishwasher leak is fixed, ServicePro replaced the pump for 210", "what is still broken". Two writes are visible as `log_service` + `mark_fixed`; the last answer comes from `home_brief`, not from chat history. |
| 1:57 | 2:33 | Architecture | "One Node process, one SQLite file, nine tools… Sessions, streaming and JSON-RPC are the SDK's job. The model only ever sees tool results, so it cannot invent a price or a date. This is running on a five dollar VPS, behind TLS, with a bearer token." |
| 2:33 | 2:43 | End card | "Attic. The memory of your house. Code, architecture and a friction log are on GitHub, and the live demo is open to try." |

## What the video has to prove, and where

- **A working MCP server on the Alexa+ track** — the `initialize` / `tools/list` / `tools/call` frames at
  1:00–1:50, against the deployed endpoint.
- **The simulated Alexa+ experience** — the whole of 0:56–1:57.
- **Writes are real** — at 1:29 the trace shows `tools/call · log_service` and `tools/call · mark_fixed`,
  and the ledger at 1:52 contains the resulting row ($210, ServicePro).
- **No invented facts** — every number spoken in the live take is on screen in the trace or the ledger.

## Rebuilding

```bash
# terminal 1: static scenes
python3 -m http.server 8099            # from the repo root

# terminal 2: the app (seeded, on :8788)
node --env-file=.env dist/db/seed.js --reset && node --env-file=.env dist/index.js

# record (wipes and re-records all five clips)
APP_URL=http://localhost:8788 OUT=/tmp/attic-video node video/record.mjs

# assemble: TTS is cached by text hash, so only changed lines are re-synthesised
python3 video/make.py --dir /tmp/attic-video --out attic-demo.mp4 --edge-tts /path/to/edge-tts
```

Keep the total under 3:00 — `make.py` prints the final duration and fails loudly if a line would drift
past its picture.
