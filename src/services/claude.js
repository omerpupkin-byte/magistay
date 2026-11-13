// ─── services/claude.js ────────────────────────────────────────
// One shared Claude client + a helper that asks for JSON and parses it.
// If ANTHROPIC_API_KEY is missing, hasClaude() is false and callers fall
// back to deterministic logic.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 45_000, maxRetries: 1 });
  return client;
}

export function hasClaude() {
  return !!process.env.ANTHROPIC_API_KEY;
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
