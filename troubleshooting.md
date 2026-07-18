# Troubleshooting

Common issues and solutions for the CodeBuddy + 9Router + etteum-pool stack.

---

## Gateway Issues

### `EADDRINUSE: port 8787 in use`

**Cause:** Another process is using port 8787.

**Fix:**
```bash
# Find the process
ss -tlnp | grep 8787

# Kill it
kill <PID>

# Restart gateway
systemctl restart codebuddy-gateway
```

### Gateway returns `{"status":"ok","keys":0}`

**Cause:** `keys.txt` is empty or not found.

**Fix:**
```bash
# Verify keys.txt exists and has content
cat /opt/codebuddy-gateway/keys.txt

# Check permissions
ls -la /opt/codebuddy-gateway/keys.txt
# Should show: -rw------- (600)

# Restart after adding keys
systemctl restart codebuddy-gateway
```

### `401 Authorization Required` from CodeBuddy

**Cause:** API key is invalid, expired, or not being sent correctly.

**Fix:**
- Verify the key starts with `ck_` and is 59 characters long
- Check `keys.txt` has no trailing whitespace, empty lines, or BOM
- Test the key directly:
  ```bash
  curl -X POST https://www.codebuddy.ai/v2/chat/completions \
    -H "Authorization: Bearer ck_your_key" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-5.5","messages":[{"role":"system","content":"You are helpful."},{"role":"user","content":"hi"}],"stream":true}'
  ```

---

## CodeBuddy API Errors

### `400 {"code":11101,"msg":"Parse message failed"}`

**Cause:** CodeBuddy requires a `system` message in the `messages` array.

**Fix:** The gateway auto-injects one if missing. If calling CodeBuddy directly:

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

**Cause:** The `max_tokens` value is outside the accepted range, or the health check in etteum-pool is sending requests without a system message.

**Fix (gateway):** The gateway caps `max_tokens` at 32000. Use a value between 1 and 32000.

**Fix (etteum-pool):** This was a bug in the CodeBuddy provider's `validateApiKey()` method — it sent a test request without a system message. Patch:

```diff
# File: src/proxy/providers/codebuddy.ts, in validateApiKey()
- messages: [{ role: "user", content: "hi" }],
- max_tokens: 100,
+ messages: [
+   { role: "system", content: "You are a helpful assistant." },
+   { role: "user", content: "hi" },
+ ],
+ max_tokens: 10,
```

After patching, trigger warmup to clear stale errors:

```bash
for i in 1 2 3 4 5; do
  curl -X POST "http://localhost:1930/api/auth/warmup/$i" \
    -H "Authorization: Bearer $DASHBOARD_KEY"
done
```

---

## 9Router Issues

### Provider shows as inactive

**Cause:** 9Router cannot reach the gateway.

**Fix:**
- Verify gateway is running: `curl http://localhost:8787/health`
- Check Base URL uses `http://127.0.0.1:8787` (not `https://` or external IP)
- If 9Router runs on a different machine, use the VPS's internal/Tailscale IP

### Model not found in 9Router

**Cause:** The model name doesn't match what the gateway exposes.

**Fix:**
```bash
# List all models the gateway exposes
curl http://localhost:8787/v1/models | python3 -m json.tool
```

Use the exact model ID from that list.

### Combo fallback not working

**Cause:** All models in the combo are failing.

**Fix:**
- Test each model individually via the gateway
- Check 9Router logs: `journalctl -u 9router --since "5 minutes ago"`
- Verify the gateway is healthy: `curl http://localhost:8787/health`

---

## etteum-pool Issues

### Dashboard build fails with TypeScript errors

**Cause:** Bun's bundled TypeScript version may be incompatible with React 19 type definitions.

**Fix:** Install TypeScript 5.7 stable:

```bash
cd /opt/etteum-pool
bun add -d typescript@5.7
bun run build
```

If errors persist, try:

```bash
bun add -d @types/react@19 @types/react-dom@19
bun run build
```

### Dashboard is blank (white page)

**Cause:** Frontend assets not compiled — the server is running but there's no HTML to serve.

**Fix:**
```bash
cd /opt/etteum-pool
bun run build
systemctl restart etteum-pool
```

Verify the dashboard serves HTML:

```bash
curl http://localhost:1931 | head -5
# Should show: <!DOCTYPE html>...
```

### `EADDRINUSE` on port 1930 or 1931

**Cause:** A previous process is still holding the port.

**Fix:**
```bash
# Find processes on both ports
ss -tlnp | grep -E '1930|1931'

# Kill them
kill <PID1> <PID2>

# Restart etteum-pool
systemctl restart etteum-pool
```

### All accounts show error after setup

**Cause:** The health check (`validateApiKey()`) in the CodeBuddy provider sends requests without a system message, causing `400 {"code":11101}`.

**Fix:** Patch `src/proxy/providers/codebuddy.ts` — see the [CodeBuddy API error fix](#400-code11133msginvalid-request-parametersexterrorparammax_output_tokens) above.

### Accounts show `errorMessage` but requests still work

**Cause:** The `errorMessage` field stores the last health check error. It doesn't block requests.

**Fix:** Trigger warmup to refresh:

```bash
DASHBOARD_KEY="your-api-key"
for i in 1 2 3 4 5; do
  curl -X POST "http://localhost:1930/api/auth/warmup/$i" \
    -H "Authorization: Bearer $DASHBOARD_KEY"
done
```

Check that `errorMessage` is now `null`:

```bash
curl http://localhost:1930/api/accounts \
  -H "Authorization: Bearer $DASHBOARD_KEY" | python3 -m json.tool
```

---

## General Issues

### Port already in use after reboot

**Cause:** systemd service starts, but a process from before reboot left a stale socket.

**Fix:**
```bash
systemctl stop etteum-pool codebuddy-gateway
sleep 2
ss -tlnp | grep -E '8787|1930|1931'
# Kill any remaining processes
systemctl start codebuddy-gateway
sleep 2
systemctl start etteum-pool
```

### High memory usage

The full stack uses approximately:

| Component | Memory |
|-----------|--------|
| 9Router | ~55 MB |
| codebuddy-gateway | ~30 MB |
| etteum-pool | ~100 MB |
| Total | ~185 MB |

If memory is tight, disable etteum-pool and use only the gateway:

```bash
systemctl stop etteum-pool
systemctl disable etteum-pool
```

### Requests are slow

**Cause:** CodeBuddy's API can take 2-30 seconds depending on model and load.

**Fix:**
- Use faster models for simple tasks (`gpt-5.1`, `gemini-2.5-flash`, `claude-haiku-4.5`)
- Enable streaming for long responses
- Check etteum-pool stats for per-model latency:
  ```bash
  curl http://localhost:1930/api/stats \
    -H "Authorization: Bearer $DASHBOARD_KEY" | python3 -m json.tool
  ```

---

## Models Not Available

> **Not available (yet):** The following models have **not** been released on CodeBuddy.ai at time of writing. Once they launch, the gateway will auto-detect them via `/v1/models`.

| Model | Status |
|-------|--------|
| `gpt-5.6` | ❌ Not released |
| `gpt-5.6-codex` | ❌ Not released |
| `claude-opus-4.8` | ❌ Not released |
| `claude-opus-4.8-1m` | ❌ Not released |
| `claude-sonnet-4.7` | ❌ Not released |
| `claude-haiku-4.6` | ❌ Not released |
| `gemini-3.5-pro` | ❌ Not released |

Always verify current availability:
```bash
curl http://localhost:8787/v1/models | python3 -m json.tool
```
