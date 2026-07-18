# Part 2: 9Router Integration

This guide connects the CodeBuddy gateway to 9Router for load balancing, model combos, and failover.

## Prerequisites

- CodeBuddy gateway running on `127.0.0.1:8787` (see [Part 1](01-codebuddy-gateway.md))
- 9Router installed and running on the same VPS

> **Note:** 9Router is proprietary software. Obtain it from the official source. This guide does not distribute 9Router.

---

## Step 1: Verify 9Router is Running

```bash
curl http://localhost:20128/v1/models
```

If this returns a JSON list of models, 9Router is running. If not, start it first.

---

## Step 2: Add CodeBuddy as a Provider

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

## Step 3: Verify Provider Connection

After adding the provider, 9Router will test each connection. All should show `testStatus: active`.

```bash
# List providers
curl http://localhost:20128/api/providers | python3 -m json.tool
```

If a connection shows inactive:
- Verify the gateway is running: `curl http://localhost:8787/health`
- Check the Base URL uses `http://127.0.0.1:8787` (not `https://` or external IP)
- Check 9Router logs: `journalctl -u 9router --since "5 minutes ago"`

---

## Step 4: Build a Combo (Failover Chain)

A combo chains multiple models with automatic fallback. If the first model fails, 9Router tries the next.

### Via Dashboard

1. Go to **Combos** → **Create Combo**
2. Name it `codebuddy`
3. Add models in priority order (highest priority first):
   - `gpt-5.5`
   - `claude-opus-4.8`
   - `gemini-3.1-pro`
   - `glm-5.2`
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
      "claude-opus-4.8",
      "gemini-3.1-pro",
      "glm-5.2",
      "deepseek-v3"
    ]
  }'
```

---

## Step 5: Test End-to-End

### Test via 9Router

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_9ROUTER_API_KEY" \
  -d '{
    "model": "codebuddy",
    "messages": [
      {"role": "user", "content": "Say hello in one word."}
    ]
  }'
```

The response should come from the first available model in the combo:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "gpt-5.5",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "Hello"},
      "finish_reason": "stop"
    }
  ]
}
```

### Test individual models

You can also call specific models directly (bypassing the combo):

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_9ROUTER_API_KEY" \
  -d '{
    "model": "claude-opus-4.8",
    "messages": [
      {"role": "user", "content": "What is 2+2?"}
    ]
  }'
```

---

## Step 6: Use with Hermes Agent (Optional)

If you use [Hermes Agent](https://hermes-agent.nousresearch.com) with 9Router:

```bash
hermes config set custom_providers.codebuddy \
  base_url=http://localhost:20128/v1 \
  api_key=YOUR_9ROUTER_KEY \
  model=codebuddy
```

Now you can switch to the `codebuddy` provider in Hermes and it will route through 9Router → gateway → CodeBuddy.

---

## Model Discovery

9Router can auto-discover models from the gateway:

```bash
curl http://localhost:20128/api/providers/codebuddy/models | python3 -m json.tool
```

This calls the gateway's `/v1/models` endpoint and lists all available CodeBuddy models.

---

## How Failover Works

When you use a combo (e.g., `model: "codebuddy"`):

1. 9Router tries the first model (`gpt-5.5`)
2. If it fails (timeout, 500, 429), 9Router tries the next (`claude-opus-4.8`)
3. Continues down the chain until one succeeds
4. If all fail, returns an error

This means even if one model is temporarily unavailable, your request still succeeds via fallback.

---

## Next Steps

Continue to [Part 3: Etteum-Pool Setup](03-etteum-pool-setup.md) for account farming and quota tracking.
