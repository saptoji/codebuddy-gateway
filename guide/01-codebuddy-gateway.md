# Part 1: CodeBuddy Gateway Setup

This guide sets up a lightweight gateway that bridges CodeBuddy.ai's API quirks into a standard OpenAI-compatible interface.

## Why a Gateway?

CodeBuddy's API has three non-standard behaviors:

| Problem | Gateway Solution |
|---------|-----------------|
| Endpoint is `/v2/chat/completions` (not `/v1`) | Expose `/v1` on gateway, rewrite internally |
| System message is mandatory | Auto-inject `"You are a helpful assistant."` if missing |
| Stream-only API | Aggregate SSE chunks into a single JSON for `stream: false` |
| Multiple API keys | Round-robin rotation across all keys |

---

## Prerequisites

- Linux VPS (Ubuntu/Debian)
- Node.js 20+
- One or more CodeBuddy API keys (`ck_...` format, 59 characters)

---

## Step 1: Install Dependencies

```bash
mkdir -p /opt/codebuddy-gateway
cd /opt/codebuddy-gateway
npm init -y
npm install express node-fetch@2
```

---

## Step 2: Add API Keys

Create `keys.txt` with one API key per line:

```bash
cat > /opt/codebuddy-gateway/keys.txt << 'EOF'
ck_your_first_api_key_here
ck_your_second_api_key_here
ck_your_third_api_key_here
EOF
chmod 600 /opt/codebuddy-gateway/keys.txt
```

**Important:** Never commit `keys.txt` to git. The `.gitignore` in this repo already excludes it.

---

## Step 3: Create the Gateway Server

Copy [`gateway/index.js`](../gateway/index.js) from this repo to `/opt/codebuddy-gateway/index.js`:

```bash
cp gateway/index.js /opt/codebuddy-gateway/index.js
```

Or create it manually — see the [gateway source](../gateway/index.js).

---

## Step 4: Create systemd Service

```bash
cat > /etc/systemd/system/codebuddy-gateway.service << 'EOF'
[Unit]
Description=CodeBuddy Gateway - OpenAI-compatible bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/codebuddy-gateway
ExecStart=/usr/bin/node /opt/codebuddy-gateway/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable codebuddy-gateway
systemctl start codebuddy-gateway
```

---

## Step 5: Verify

```bash
# Check service status
systemctl status codebuddy-gateway

# Health check
curl http://localhost:8787/health
# Expected: {"status":"ok","keys":3}

# Test models endpoint
curl http://localhost:8787/v1/models | python3 -m json.tool | head -20

# Test chat completion (non-stream)
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

Expected response:

```json
{
  "id": "chatcmpl-1784357732",
  "object": "chat.completion",
  "model": "gpt-5.5",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "Hello"},
      "finish_reason": "stop"
    }
  ],
  "usage": {"prompt_tokens": 22, "completion_tokens": 18, "total_tokens": 40}
}
```

---

## How It Works

### Key Rotation

The gateway loads all keys from `keys.txt` at startup and rotates through them round-robin on each request. If a key fails (401/403), the next request automatically uses the next key.

### Stream Aggregation

For non-stream clients (`stream: false`), the gateway:
1. Sends `stream: true` to CodeBuddy
2. Reads all SSE chunks (`data: {...}\n\n`)
3. Concatenates `delta.content` from each chunk
4. Returns a single `chat.completion` JSON object

For stream clients (`stream: true`), the gateway pipes the SSE stream through directly.

### System Message Injection

CodeBuddy requires a `system` message. If the incoming request has no `system` role in `messages`, the gateway prepends:

```json
{"role": "system", "content": "You are a helpful AI assistant."}
```

---

## Security Notes

- The gateway binds to `127.0.0.1` (localhost only) — **do not expose port 8787 to the public internet**
- `keys.txt` has `chmod 600` — only root can read
- 9Router (or etteum-pool) should be the only public-facing endpoint

---

## Next Steps

Continue to [Part 2: 9Router Integration](02-9router-integration.md) to connect the gateway to 9Router.
