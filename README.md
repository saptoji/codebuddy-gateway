# CodeBuddy → 9Router + Etteum Integration

Complete guide to integrate [CodeBuddy.ai](https://www.codebuddy.ai) API keys with a self-hosted **9Router** instance and **etteum-pool** for account farming and quota tracking.

## What This Repo Contains

- ✅ **Gateway bridge** (`/gateway`) — OpenAI-compatible proxy that handles CodeBuddy API quirks (MIT licensed, original work)
- ✅ **Configuration templates** (`/configs`, `/systemd`) — Ready to use
- ✅ **Setup documentation** (`/guide`) — Step-by-step guides

## What This Repo Does NOT Contain

This repository references but does **not** distribute third-party software:

- **9Router** — Proprietary load balancer. Obtain from official source.
- **etteum-pool** — Separate open-source project. Clone from [official repository](https://github.com/etteum/pool).

Users must obtain these separately. This repo only provides integration glue.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Your VPS                           │
│                                                      │
│  ┌──────────┐    ┌──────────────┐    ┌───────────┐  │
│  │  Hermes  │───▶│   9Router    │───▶│  Gateway  │  │
│  │  Agent   │    │   :20128     │    │  :8787    │  │
│  └──────────┘    └──────┬───────┘    └─────┬─────┘  │
│                         │                  │         │
│                  ┌──────┴───────┐          │         │
│                  │  etteum-pool │          │         │
│                  │  :1930 (API) │          │         │
│                  │  :1931 (UI)  │          │         │
│                  └──────────────┘          │         │
└─────────────────────────────────────────────┼────────┘
                                              │
                                              ▼
                                   https://www.codebuddy.ai/v2
```

**Two paths, one upstream:**

| Path | Use Case | Port |
|------|----------|------|
| 9Router → Gateway → CodeBuddy | General API routing, model combos, failover | 20128 |
| etteum-pool → CodeBuddy | Account farming, quota tracking, dashboard, proxy rotation | 1930 |

---

## Quick Start

1. Read [`guide/01-codebuddy-gateway.md`](guide/01-codebuddy-gateway.md) — Set up the bridge
2. Read [`guide/02-9router-integration.md`](guide/02-9router-integration.md) — Connect to 9Router
3. Read [`guide/03-etteum-pool-setup.md`](guide/03-etteum-pool-setup.md) — Set up etteum-pool

See [`troubleshooting.md`](troubleshooting.md) for common issues.

---

## CodeBuddy API Quirks

CodeBuddy's API has three non-standard behaviors that the gateway handles:

1. **Endpoint is `/v2/chat/completions`** (not `/v1`)
2. **System message is mandatory** — requests without one return `400 {"code":11101}`
3. **Streaming-only** — no non-streaming support

The gateway bridges these by:
- Rewriting `/v1` → `/v2` internally
- Auto-injecting a system message if missing
- Aggregating SSE stream into a single JSON for non-stream clients
- Round-robin rotation across multiple API keys

---

## Available Models

| Category | Models |
|----------|--------|
| Claude | `claude-opus-4.8`, `claude-opus-4.7`, `claude-opus-4.6`, `claude-sonnet-4.6`, `claude-haiku-4.5` |
| GPT | `gpt-5.5`, `gpt-5.4`, `gpt-5.2`, `gpt-5.1`, `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.1-codex` |
| Gemini | `gemini-3.5-flash`, `gemini-3.1-pro`, `gemini-3.0-flash`, `gemini-2.5-pro`, `gemini-2.5-flash` |
| GLM | `glm-5.2`, `glm-5.1`, `glm-5.0`, `glm-4.6` |
| Kimi | `kimi-k2.6`, `kimi-k2.5` |
| DeepSeek | `deepseek-v3`, `deepseek-v3-2-volc` |

---

## License

MIT — See [LICENSE](LICENSE)

The gateway bridge code in `/gateway` is original work. Third-party software (9Router, etteum-pool) retain their own licenses.
