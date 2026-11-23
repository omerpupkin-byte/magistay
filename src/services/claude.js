// ─── services/claude.js ────────────────────────────────────────
// One shared Claude client + a helper that asks for JSON and parses it.
// If ANTHROPIC_API_KEY is missing, hasClaude() is false and callers fall
// back to deterministic logic.

import Anthropic from '@anthropic-ai/sdk';
import { count } from './usage.js';

// The matcher runs while a traveller waits, so the default is the fastest
// model. ANTHROPIC_MODEL overrides it (e.g. a larger model for quality tests).
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
export function claudeModel() { return MODEL; }

// One step can run on a different model without touching the others, e.g.
// ANTHROPIC_MODEL_MATCH=claude-sonnet-5-5 to test ranking quality.
// Steps: match, reviews, chat.
export function modelFor(step) {
  const v = process.env['ANTHROPIC_MODEL_' + String(step || '').toUpperCase()];
  return typeof v === 'string' && /^claude-[\w.-]+$/.test(v.trim()) ? v.trim() : MODEL;
}

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
// Why the last Claude call failed, for /health. Set for every failure,
// including those the caller catches and turns into a fallback.
let lastCallFailure = null;
export function lastClaudeFailure() { return lastCallFailure; }

export async function askClaudeJSON(prompt, { maxTokens = 2048, step = null } = {}) {
  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY not set');

  let message;
  try {
    message = await c.messages.create({
      model:      modelFor(step),
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }],
    });
  } catch (e) {
    count('claudeFailedCalls');
    lastCallFailure = { step, at: new Date().toISOString(), kind: 'api',
      status: e?.status ?? null, message: String(e?.message || e).slice(0, 200) };
    throw e;
  }

  count('claudeCalls');
  count('claudeInputTokens',  message.usage?.input_tokens  || 0);
  count('claudeOutputTokens', message.usage?.output_tokens || 0);

  const raw = (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const truncated = message.stop_reason === 'max_tokens';
  try {
    return JSON.parse(extractJSON(raw));
  } catch (e) {
    count('claudeFailedCalls');
    lastCallFailure = { step, at: new Date().toISOString(), kind: truncated ? 'truncated' : 'unparseable',
      outputTokens: message.usage?.output_tokens || 0, maxTokens,
      message: truncated ? `reply cut off at ${maxTokens} tokens` : 'reply was not valid JSON' };
    throw new Error(lastCallFailure.message);
  }
}

export function extractJSON(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}
