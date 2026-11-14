// ─── services/claude.js ────────────────────────────────────────
// One shared Claude client + a helper that asks for JSON and parses it.
// If ANTHROPIC_API_KEY is missing, hasClaude() is false and callers fall
// back to deterministic logic.

import Anthropic from '@anthropic-ai/sdk';

// The matcher runs while a traveller waits, so the default is the fastest
// model. ANTHROPIC_MODEL overrides it (e.g. a larger model for quality tests).
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
export function claudeModel() { return MODEL; }

let client = null;
// The key as it should be sent: a pasted key often arrives with a space,
// a line break or quotes around it, and Anthropic then answers
// "invalid x-api-key".
function apiKey() {
  return String(process.env.ANTHROPIC_API_KEY || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
}

function getClient() {
  if (!apiKey()) return null;
  if (!client) client = new Anthropic({ apiKey: apiKey(), timeout: 30_000, maxRetries: 0 });
  return client;
}

export function hasClaude() {
  return !!apiKey();
}

// What the stored key LOOKS like, never the key itself. For /health.
export function claudeKeyShape() {
  const raw = String(process.env.ANTHROPIC_API_KEY || '');
  if (!raw) return { set: false };
  const key = apiKey();
  return {
    set: true,
    looksLikeAnthropicKey: /^sk-ant-/.test(key),
    length: key.length,
    hadSpacesOrLineBreaks: raw !== raw.trim() || /\s/.test(key),
    hadQuotes: /^["'`]|["'`]$/.test(raw.trim()),
  };
}

// Sends one prompt, returns the parsed JSON object from the reply.
// Throws if Claude is not configured, the call fails, or the reply is not JSON.
export async function askClaudeJSON(prompt, { maxTokens = 2048 } = {}) {
  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY not set');

  const message = await c.messages.create({
    model:      MODEL,
    max_tokens: maxTokens,
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw = (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(extractJSON(raw));
}

export function extractJSON(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}
