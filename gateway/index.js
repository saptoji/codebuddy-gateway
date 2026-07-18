const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || "127.0.0.1";
const UPSTREAM = "https://www.codebuddy.ai/v2";

// ─── Load API keys (one per line) ───────────────────────────────────────────
const keysPath = path.join(__dirname, "keys.txt");
const keys = fs
  .readFileSync(keysPath, "utf-8")
  .split("\n")
  .map((k) => k.trim())
  .filter(Boolean);

if (keys.length === 0) {
  console.error("No API keys found in keys.txt");
  process.exit(1);
}

console.log(`Loaded ${keys.length} CodeBuddy API key(s)`);

let keyIndex = 0;
function getNextKey() {
  const key = keys[keyIndex % keys.length];
  keyIndex++;
  return key;
}

// ─── Model list ─────────────────────────────────────────────────────────────
const MODEL_LIST = [
  // Claude
  "claude-opus-4.8", "claude-opus-4.8-1m",
  "claude-opus-4.7", "claude-opus-4.7-1m",
  "claude-opus-4.6", "claude-opus-4.6-1m",
  "claude-sonnet-4.6", "claude-haiku-4.5",
  // GPT
  "gpt-5.5", "gpt-5.5-xhigh",
  "gpt-5.4", "gpt-5.2", "gpt-5.1",
  "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex",
  "gpt-5.1-codex-max", "gpt-5.1-codex-mini",
  // Gemini
  "gemini-3.5-flash", "gemini-3.1-pro", "gemini-3.1-flash-lite",
  "gemini-3.0-flash", "gemini-2.5-pro", "gemini-2.5-flash",
  // GLM
  "glm-5.2", "glm-5.1", "glm-5.0", "glm-5v-turbo", "glm-4.6",
  // Kimi
  "kimi-k2.6", "kimi-k2.5",
  // DeepSeek
  "deepseek-v3", "deepseek-v3-2-volc",
];

// ─── GET /v1/models ─────────────────────────────────────────────────────────
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: MODEL_LIST.map((id) => ({
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "codebuddy",
    })),
  });
});

// ─── POST /v1/chat/completions ──────────────────────────────────────────────
app.post("/v1/chat/completions", async (req, res) => {
  const apiKey = getNextKey();
  const request = { ...req.body };

  // CodeBuddy requires a system message
  const hasSystem = (request.messages || []).some((m) => m.role === "system");
  if (!hasSystem && request.messages) {
    request.messages.unshift({
      role: "system",
      content: "You are a helpful AI assistant.",
    });
  }

  // Cap max_tokens at 32000 (CodeBuddy limit)
  if (request.max_tokens && request.max_tokens > 32000) {
    request.max_tokens = 32000;
  }

  // CodeBuddy is stream-only
  request.stream = true;
  const clientWantsStream = req.body.stream === true;

  try {
    const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      body: JSON.stringify(request),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return res.status(upstream.status).json({
        error: {
          message: `CodeBuddy API error (${upstream.status}): ${errText}`,
          type: "upstream_error",
        },
      });
    }

    // ─── Stream passthrough ──────────────────────────────────────────────
    if (clientWantsStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      upstream.body.pipe(res);
      return;
    }

    // ─── Aggregate SSE into single JSON ──────────────────────────────────
    const text = await upstream.text();
    const lines = text.split("\n");
    let content = "";
    let model = request.model;
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let finishReason = "stop";
    let toolCalls = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const chunk = JSON.parse(payload);
        const choice = chunk.choices?.[0];
        const delta = choice?.delta || {};

        if (delta.content) content += delta.content;

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id || "",
                type: "function",
                function: { name: "", arguments: "" },
              };
            }
            if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
            if (tc.function?.arguments)
              toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }

        if (choice?.finish_reason && choice.finish_reason !== "") {
          finishReason = choice.finish_reason;
        }

        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens || 0,
            completion_tokens: chunk.usage.completion_tokens || 0,
            total_tokens: chunk.usage.total_tokens || 0,
          };
        }
      } catch {
        // skip malformed chunk
      }
    }

    const message = { role: "assistant", content };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls.filter((tc) => tc.function?.name);
      if (!content) message.content = null;
      if (finishReason === "stop") finishReason = "tool_calls";
    }

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    });
  } catch (error) {
    res.status(500).json({
      error: {
        message: `Gateway error: ${error.message}`,
        type: "gateway_error",
      },
    });
  }
});

// ─── Health check ───────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", keys: keys.length });
});

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`CodeBuddy gateway running on http://${HOST}:${PORT}`);
  console.log(`Keys loaded: ${keys.length}`);
});
