# Part 3: Etteum-Pool Setup

This guide sets up etteum-pool as an alternative frontend for CodeBuddy accounts, with account farming, quota tracking, and a dashboard.

> **Note:** etteum-pool is a separate open-source project. Clone it from the [official repository](https://github.com/etteum/pool). This guide does not distribute etteum-pool source code.

---

## Why etteum-pool?

While the gateway (Part 1) is a lightweight bridge, etteum-pool provides additional features:

| Feature | Gateway | etteum-pool |
|---------|---------|-------------|
| API proxy | ✅ | ✅ |
| Key rotation | ✅ round-robin | ✅ smart load balance |
| Quota tracking | ❌ | ✅ per-account |
| Dashboard UI | ❌ | ✅ 17 pages |
| Proxy rotation | ❌ | ✅ residential/DC pool |
| Filter rules | ❌ | ✅ model → account routing |
| Image generation | ❌ | ✅ Canva integration |
| BYOK (bring your own key) | ❌ | ✅ multi-tenant |
| VCC pool | ❌ | ✅ auto account creation |

Use the **gateway** for simple 9Router integration. Use **etteum-pool** when you need account management and monitoring.

---

## Prerequisites

- CodeBuddy API keys (`ck_...` format)
- [Bun](https://bun.sh) runtime installed
- SQLite (usually pre-installed on Linux)

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version
```

---

## Step 1: Clone etteum-pool

```bash
cd /opt
git clone https://github.com/etteum/pool.git etteum-pool
cd etteum-pool
bun install
```

---

## Step 2: Configure Environment

Copy the example env file and edit:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Server ports
PORT=1930
DASHBOARD_PORT=1931

# Dashboard access key (generate a random one)
API_KEY=your-random-dashboard-key-here

# Encryption key for stored credentials (generate a random one)
ENCRYPTION_KEY=your-random-encryption-key-here

# Database
DATABASE_URL=file:./etteum-pool.db
```

Generate random keys:

```bash
echo "API_KEY=$(openssl rand -hex 24)"
echo "ENCRYPTION_KEY=$(openssl rand -hex 16)"
```

> **Security:** Never commit `.env` to git. The `.gitignore` in etteum-pool already excludes it.

---

## Step 3: Build the Dashboard

etteum-pool's dashboard is a React frontend that needs to be compiled:

```bash
bun run build
```

**If build fails with TypeScript errors**, see [Troubleshooting](../troubleshooting.md#dashboard-build-fails-with-typescript-errors).

---

## Step 4: Add CodeBuddy Accounts

etteum-pool manages accounts in a SQLite database. You can add accounts via:

### Via Dashboard UI

1. Open `http://localhost:1931` in your browser
2. Enter your `API_KEY` from `.env`
3. Go to **Accounts** → **Add Account**
4. Select provider: **CodeBuddy**
5. Enter:
   - **Email:** `codebuddy-1@yourdomain.com` (label only, not used for auth)
   - **API Key:** `ck_your_api_key_here`
6. Save
7. Repeat for each key

### Via API

```bash
DASHBOARD_KEY="your-api-key-from-env"

curl -X POST http://localhost:1930/api/accounts \
  -H "Authorization: Bearer $DASHBOARD_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "codebuddy",
    "email": "codebuddy-1@yourdomain.com",
    "tokens": "{\"api_key\": \"ck_your_api_key_here\"}"
  }'
```

Repeat for each key (increment the email number).

---

## Step 5: Create systemd Service

```bash
cat > /etc/systemd/system/etteum-pool.service << 'EOF'
[Unit]
Description=Etteum Pool - AI Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/etteum-pool
ExecStart=/root/.bun/bin/bun run /opt/etteum-pool/scripts/production.ts --skip-build
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable etteum-pool
systemctl start etteum-pool
```

Verify:

```bash
systemctl status etteum-pool
curl http://localhost:1930/v1/models -H "Authorization: Bearer $DASHBOARD_KEY" | head -20
```

---

## Step 6: Verify Accounts

Trigger a health check (warmup) for all accounts:

```bash
DASHBOARD_KEY="your-api-key-from-env"

for i in 1 2 3 4 5; do
  curl -X POST "http://localhost:1930/api/auth/warmup/$i" \
    -H "Authorization: Bearer $DASHBOARD_KEY"
done
```

Check account status:

```bash
curl http://localhost:1930/api/accounts \
  -H "Authorization: Bearer $DASHBOARD_KEY" | python3 -m json.tool
```

All accounts should show `status: active` and `errorMessage: null`.

---

## Step 7: Test via etteum-pool

```bash
DASHBOARD_KEY="your-api-key-from-env"

curl http://localhost:1930/v1/chat/completions \
  -H "Authorization: Bearer $DASHBOARD_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cb-gpt-5.5",
    "messages": [
      {"role": "user", "content": "Say hello in one word."}
    ]
  }'
```

> **Note:** etteum-pool uses `cb-` prefixed model names (e.g., `cb-gpt-5.5`, `cb-claude-opus-4.8`). See the full list at `http://localhost:1930/v1/models`.

---

## Step 8: (Optional) Add etteum-pool to 9Router

You can use etteum-pool as an upstream in 9Router instead of the gateway:

### Via Dashboard

1. Go to **Providers** → **Add Provider**
2. Fill in:
   - **Name:** `etteum`
   - **Base URL:** `http://127.0.0.1:1930`
   - **API Key:** Your etteum `API_KEY` from `.env`
   - **Prefix:** `cb`
3. Test and save

### Via API

```bash
curl -X POST http://localhost:20128/api/providers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "etteum",
    "baseUrl": "http://127.0.0.1:1930",
    "apiKey": "your-etteum-api-key",
    "prefix": "cb"
  }'
```

---

## Dashboard Features

The etteum-pool dashboard (`http://localhost:1931`) provides:

| Page | Purpose |
|------|---------|
| Dashboard | Overview: total accounts, requests, tokens, latency |
| Accounts | Manage CodeBuddy accounts — login, status, quota |
| BYOK Accounts | Bring Your Own Key — end-user self-service keys |
| Proxy Pool | Residential/DC proxy rotation per account |
| Models | List of 96+ available models |
| Requests | Live request log with response details |
| Filter Rules | Route model X → account Y |
| Bot Logs | Telegram bot integration logs |
| Usage | Per-account token and credit usage |
| API Key | Manage dashboard access keys |
| Settings | Global config: ports, rate limits, defaults |
| Integration | Setup guides for OpenWebUI, Cursor, etc. |
| Image Studio | Image/video generation via Canva API |
| VCC Pool | Virtual credit card pool for auto account creation |

---

## Troubleshooting etteum-pool

See [Troubleshooting](../troubleshooting.md) for:
- Dashboard build errors (TypeScript)
- `EADDRINUSE` port conflicts
- `max_output_tokens` errors
- Account health check failures
