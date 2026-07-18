# CodeBuddy → 9Router Setup Guide

This guide documents how to integrate [CodeBuddy.ai](https://www.codebuddy.ai) API keys with a self-hosted **9Router** instance using a lightweight gateway bridge.

## Background

CodeBuddy.ai provides access to premium AI models (GPT-5.5, Claude Opus 4.x, Gemini 3.x, GLM, DeepSeek, Kimi, etc.) through API keys with the `ck_` prefix. However, its API has three non-standard behaviors:

1. **Endpoint is `/v2/chat/completions`** instead of the standard OpenAI `/v1/chat/completions`
2. **A `system` message is mandatory** in the `messages` array — requests without one return `400 {"code":11101,"msg":"Parse message failed"}`
3. **Streaming-only** — the API does not support non-streaming responses

Most OpenAI-compatible clients (and 9Router itself) expect `/v1/chat/completions` with optional streaming. A gateway bridge is needed to handle these differences.

---

## Architecture

```
Client / Hermes Agent
        │
        ▼
┌─────────────┐
│   9Router   │  Combos, failover, model discovery
│   :20128    │
└──────┬──────┘
       │ http://127.0.0.1:8787/v1/chat/completions
       ▼
┌─────────────────────┐
│ codebuddy-gateway   │  Bridges CodeBuddy quirks:
│ :8787               │  - /v2 → /v1 path rewrite
│ (Python, multi-     │  - Injects system message if missing
│  format: OpenAI /   │  - Aggregates SSE stream → non-stream JSON
│  Anthropic / Gemini │  - Round-robin key rotation with retry
│  / Codex)           │  - Multi-format API support
└──────┬──────────────┘
       │ https://www.codebuddy.ai/v2/chat/completions
       ▼
   CodeBuddy API
```

**Why a gateway?**

| Problem | Gateway Solution |
|---------|-----------------|
| CodeBuddy only supports `/v2` path | Expose `/v1` on gateway, rewrite internally |
| System message is mandatory | Auto-inject `"You are a helpful assistant."` if missing |
| Stream-only API | Aggregate SSE chunks into a single JSON response for `stream: false` clients |
| Multiple API keys | Round-robin rotation with retry on 401/403/429/5xx |
| Single format (OpenAI) | Multi-format: OpenAI, Anthropic, Gemini, Codex (Responses API) |

---

## Prerequisites

- A Linux VPS (this guide uses Ubuntu/Debian)
- Python 3.10+ installed
- 9Router running on the same VPS (or accessible via network)
- One or more CodeBuddy API keys (`ck_...` format, 59 characters)

---

## Step 1: Install 9Router

If you haven't installed 9Router yet, follow 9Router's official install instructions. 9Router typically runs on port 20128.

Verify 9Router is running:

```bash
curl http://localhost:20128/v1/models
```

---

## Step 2: Create the Gateway

The gateway is a Python package (`codebuddy_gateway`) that exposes multiple API formats (OpenAI, Anthropic, Gemini, Codex) and bridges CodeBuddy's quirks.

### Directory Structure

```
/opt/codebuddy-cli2api/
├── codebuddy_gateway/
│   ├── __init__.py
│   ├── __main__.py          # Entry point
│   ├── server.py            # HTTP server + route dispatch
│   ├── upstream.py          # CodeBuddy API client (stream-only)
│   ├── aggregate.py         # SSE → JSON aggregation
│   ├── rotation.py          # Key pool with round-robin + retry
│   ├── common.py            # Config, logging, model catalog
│   ├── images.py            # Image generation support
│   └── formats/             # Multi-format adapters
│       ├── openai.py        # /v1/chat/completions
│       ├── anthropic.py     # /v1/messages
│       ├── gemini.py        # :generateContent
│       └── codex.py         # /v1/responses
└── keys.txt                 # API keys (one per line)
```

### `keys.txt` — API Keys

Create a file with one CodeBuddy API key per line:

```bash
mkdir -p /opt/codebuddy-cli2api
cat > /opt/codebuddy-cli2api/keys.txt << 'EOF'
ck_your_first_api_key_here
ck_your_second_api_key_here
ck_your_third_api_key_here
EOF
chmod 600 /opt/codebuddy-cli2api/keys.txt
```

### Gateway Code

The gateway source code is available in the [`/gateway`](gateway/) directory of this repo. Copy it to `/opt/codebuddy-cli2api/codebuddy_gateway/`.

Key components:

- **`server.py`** — `ThreadingHTTPServer` that routes requests by path/method to the correct format adapter
- **`upstream.py`** — Calls CodeBuddy's `/v2/chat/completions` with `stream: true` always on
- **`aggregate.py`** — Reads SSE chunks (`data: {...}\n\n`) and assembles a single JSON response
- **`rotation.py`** — `KeyPool` class: loads keys from `keys.txt`, rotates round-robin, retries on 401/403/429/5xx

### Supported Endpoints

| Method | Path | Format | Description |
|--------|------|--------|-------------|
| GET | `/v1/models` | OpenAI | List available models (dynamic) |
| POST | `/v1/chat/completions` | OpenAI | Chat completion (stream + non-stream) |
| POST | `/v1/messages` | Anthropic | Anthropic Messages API |
| POST | `/v1/responses` | Codex | OpenAI Responses API |
| POST | `:generateContent` | Gemini | Gemini generateContent |
| GET | `/health` | — | Health check |

---

## Step 3: Create systemd Service

```bash
cat > /etc/systemd/system/codebuddy-gateway.service << 'EOF'
[Unit]
Description=CodeBuddy Gateway (CLI2API bridge)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 -u -m codebuddy_gateway --host 127.0.0.1 --port 8787
WorkingDirectory=/opt/codebuddy-cli2api
Environment=CODEBUDDY_BASE_URL=https://www.codebuddy.ai
Environment=CODEBUDDY_KEYS_FILE=/opt/codebuddy-cli2api/keys.txt
Environment=GATEWAY_LOG_LEVEL=INFO
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable codebuddy-gateway
systemctl start codebuddy-gateway
```

Verify:

```bash
systemctl status codebuddy-gateway
curl http://localhost:8787/health
# Expected: {"status":"ok","keys":3}
```

---

## Step 4: Add Provider to 9Router

### Via 9Router Dashboard (Web UI)

1. Open 9Router dashboard (usually `http://localhost:20128/dashboard`)
2. Go to **Providers** → **Add Provider**
3. Fill in:
   - **Name:** `codebuddy`
   - **Base URL:** `http://127.0.0.1:8787`
   - **API Key:** Any non-empty string (e.g., `gateway`) — the gateway handles key rotation internally
   - **Prefix:** `cb` (optional — for model name namespacing)
4. Click **Test Connection** — should show active
5. Save

### Via 9Router API (alternative)

```bash
curl -X POST http://localhost:20128/api/providers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "codebuddy",
    "baseUrl": "http://127.0.0.1:8787",
    "apiKey": "gateway",
    "prefix": "cb"
  }'
```

---

## Step 5: Build a Combo (Failover Chain)

A combo lets you chain multiple models with automatic fallback. If the first model fails, 9Router tries the next one.

### Via Dashboard

1. Go to **Combos** → **Create Combo**
2. Name it `codebuddy`
3. Add models in priority order (highest priority first):
   - `gpt-5.5`
   - `claude-opus-4.7-1m`
   - `claude-opus-4.6`
   - `gemini-3.1-pro`
   - `glm-5.2`
   - `kimi-k2.6`
   - `deepseek-v3`
4. Save

### Via API

```bash
curl -X POST http://localhost:20128/api/combos \
  -H "Content-Type: application/json" \
  -d '{
    "name": "codebuddy",
    "models": [
      "gpt-5.5",
      "claude-opus-4.7-1m",
      "claude-opus-4.6",
      "gemini-3.1-pro",
      "glm-5.2",
      "kimi-k2.6",
      "deepseek-v3"
    ]
  }'
```

> **Note:** Model availability changes over time. Always verify with `curl http://localhost:8787/v1/models` before building combos.

---

## Step 6: Test End-to-End

### Test via Gateway directly

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Say hello in one word."}
    ],
    "max_tokens": 50
  }'
```

### Test via 9Router

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_9...EY" \
  -d '{
    "model": "codebuddy",
    "messages": [
      {"role": "user", "content": "Say hello in one word."}
    ]
  }'
```

If successful, you'll get a response like:

```json
{
  "id": "chatcmpl-1784357732",
  "object": "chat.completion",
  "model": "gpt-5.5",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 22, "completion_tokens": 18, "total_tokens": 40 }
}
```

---

## Step 7: Use with Hermes Agent (Optional)

If you use [Hermes Agent](https://hermes-agent.nousresearch.com) with 9Router, add CodeBuddy as a custom provider in `~/.hermes/config.yaml`:

```yaml
model:
  default: codebuddy          # combo name in 9Router
  provider: custom
  base_url: http://localhost:20128/v1
  api_key: YOUR_9ROUTER_KEY
  context_length: 1048576

custom_providers:
- name: 9router-mahoraga
  base_url: http://localhost:20128/v1
  api_key: YOUR_9ROUTER_KEY
  model: codebuddy
  discover_models: true       # auto-discover all models from 9Router
```

With `discover_models: true`, Hermes will auto-detect all models from 9Router's `/v1/models` endpoint. Every time you add a provider or combo in 9Router, it appears in Hermes automatically — no config edit needed.

---

## Available Models

Model availability on CodeBuddy changes over time. The gateway's `/v1/models` endpoint returns a dynamic list. Below is a snapshot of confirmed-live models at time of writing:

| Category | Models (confirmed live) |
|----------|------------------------|
| Claude | `claude-opus-4.7-1m`, `claude-opus-4.6`, `claude-sonnet-4.6`, `claude-haiku-4.5` |
| GPT | `gpt-5.5`, `gpt-5.4`, `gpt-5.2`, `gpt-5.1`, `gpt-5.3-codex`, `gpt-5.2-codex` |
| Gemini | `gemini-3.5-flash`, `gemini-3.1-pro`, `gemini-3.1-flash-lite`, `gemini-3.0-pro`, `gemini-3.0-flash`, `gemini-2.5-pro`, `gemini-2.5-flash` |
| GLM | `glm-5.2`, `glm-5.1`, `glm-5.0`, `glm-5v-turbo`, `glm-5.0-turbo`, `glm-4.7`, `glm-4.6`, `glm-4.6v` |
| Kimi | `kimi-k2.6`, `kimi-k2.5` |
| DeepSeek | `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v3-2-volc`, `deepseek-v3.1` |
| Others | `minimax-m2.5`, `minimax-m2.7`, `hunyuan-2.0-instruct`, `o4-mini`, `auto`, `default` |

> **Not available (yet):** `gpt-5.6`, `claude-opus-4.8`, `claude-sonnet-4.7`, `gemini-3.5-pro` — these models have not been released on CodeBuddy.ai at time of writing. Once they launch, the gateway will auto-detect them.

Always verify current availability:

```bash
curl http://localhost:8787/v1/models | python3 -m json.tool
```

---

## Troubleshooting

### `400 {"code":11101,"msg":"Parse message failed"}`

**Cause:** CodeBuddy requires a `system` message in the `messages` array. Requests without one are rejected.

**Fix:** The gateway auto-injects one if missing. If you're calling CodeBuddy directly (without the gateway), add a system message:

```json
{
  "model": "gpt-5.5",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello"}
  ]
}
```

### `400 {"code":11133,"msg":"Invalid request parameters","extError":{"param":"max_output_tokens"}}`

**Cause:** There are two possible causes:

1. **`max_tokens` value is outside the accepted range** — CodeBuddy accepts values roughly between 1 and 32000. Very small values (e.g., `max_tokens: 5`) can also trigger this on some models.

2. **Missing system message in health check** — If using etteum-pool, the `validateApiKey()` method in `src/proxy/providers/codebuddy.ts` sends a test request **without** a system message during health checks. CodeBuddy returns `11101` (Parse message failed), which etteum-pool may misreport as `11133`.

**Fix:**

- For gateway: Use `max_tokens` between 10 and 32000. The gateway caps it automatically.
- For etteum-pool: Patch `validateApiKey()` in `src/proxy/providers/codebuddy.ts` to include a system message:

```diff
  body: JSON.stringify({
    model: "gpt-5.5",
-   messages: [{ role: "user", content: "hi" }],
-   max_tokens: 100,
+   messages: [
+     { role: "system", content: "You are a helpful assistant." },
+     { role: "user", content: "hi" },
+   ],
+   max_tokens: 10,
    stream: true,
  }),
```

After patching, trigger warmup to clear stale errors:

```bash
for i in 1 2 3 4 5; do
  curl -X POST "http://localhost:1930/api/auth/warmup/$i" \
    -H "Authorization: Bearer $DASHB... 401 Authorization Required`

**Cause:** API key is invalid, expired, or not being sent correctly.

**Fix:**
- Verify the key starts with `ck_` and is 59 characters long
- Check `keys.txt` has no trailing whitespace, empty lines, or BOM
- Test the key directly:
  ```bash
  curl -X POST https://www.codebuddy.ai/v2/chat/completions \
    -H "Authorization: Bearer ck_... \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-5.5","messages":[{"role":"system","content":"You are helpful."},{"role":"user","content":"hi"}],"stream":true}'
  ```

### Gateway returns `EADDRINUSE`

**Cause:** Port 8787 is already in use by another process.

**Fix:**
```bash
# Find the process
ss -tlnp | grep 8787
kill <PID>

# Then restart
systemctl restart codebuddy-gateway
```

### 9Router shows provider as inactive

**Cause:** 9Router cannot reach the gateway.

**Fix:**
- Verify the gateway is running: `curl http://localhost:8787/health`
- Check the Base URL in 9Router uses `http://127.0.0.1:8787` (not `https://` or external IP)
- If 9Router runs on a different machine, use the VPS's internal/Tailscale IP instead of `127.0.0.1`

### Models not appearing in Hermes / Telegram

**Cause:** `discover_models: false` in Hermes config — Hermes only knows about manually listed models, never queries 9Router's `/v1/models`.

**Fix:** Set `discover_models: true` in `~/.hermes/config.yaml`:

```bash
hermes config set custom_providers.0.discover_models true
systemctl --user restart hermes-gateway
```

### Streaming responses are cut off

**Cause:** CodeBuddy may close the connection early on long responses.

**Fix:** The gateway handles this by aggregating all SSE chunks before returning. If you're streaming directly to a client, ensure your client handles `data: [DONE]` properly.

---

## Security Notes

- **Never expose the gateway port (8787) to the public internet.** It binds to `127.0.0.1` by default — keep it that way.
- Store API keys in `keys.txt` with `chmod 600`. Never commit them to git.
- 9Router should be the only public-facing endpoint. Use 9Router's built-in auth for external access.
- If you need remote access, use a reverse proxy (nginx/caddy) with TLS, or a Tailscale tunnel.

---

## Summary

| Component | Port | Purpose |
|-----------|------|---------|
| 9Router | 20128 | Load balancer, combo routing, failover |
| codebuddy-gateway | 8787 (localhost) | CodeBuddy API bridge (multi-format, path rewrite, system msg injection, stream aggregation, key rotation) |
| CodeBuddy API | 443 (remote) | Upstream provider |

```
Client → 9Router (:20128) → gateway (:8787) → codebuddy.ai/v2
```

The gateway handles three CodeBuddy quirks:
1. `/v2` → `/v1` path mapping
2. Mandatory system message injection
3. Stream-only → non-stream aggregation

Additionally, the gateway supports multiple API formats (OpenAI, Anthropic, Gemini, Codex) so any compatible client can connect directly without 9Router if needed.

Once configured, you can use any OpenAI-compatible client with 9Router as the base URL, and 9Router will route requests through the gateway to CodeBuddy with automatic key rotation and model failover.

---

*Guide based on a real setup session. Adjust model names and endpoints as CodeBuddy evolves their API.*
