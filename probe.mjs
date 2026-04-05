#!/usr/bin/env node
/**
 * probe-model-windows.mjs
 * Queries each configured provider's live /v1/models (or equivalent) endpoint
 * and reports the advertised context window size for every model.
 *
 * Usage:
 *   node ~/bin/probe-model-windows.mjs [--provider <name>] [--json] [--md] [--no-color]
 *   node ~/bin/probe-model-windows.mjs --library [--family openai|anthropic|google|...] [--md]
 *
 * Modes:
 *   (default)       Probe all providers live, overlay library data, print table
 *   --library       Print the full static library table (no live probing)
 *   --probe-limits  Actively binary-search context limits via real requests
 *   --provider      Filter to one provider (or comma-separated list)
 *   --model         Filter to one model ID within the provider
 *   --json          Machine-readable JSON output
 *   --md            Markdown table output
 *   --no-color      Plain text, no ANSI codes
 *   --no-update     Skip library auto-update
 *
 * Probe modes (auto-detected per provider, override with --billing):
 *   subscription    Content-fill binary search — all providers except openrouter
 *                   (flat-rate subscription, zero marginal cost per request)
 *   read-only       OpenRouter: reads context_length directly from /v1/models response
 *
 * Requires: openclaw config readable, gateway running (for token resolution)
 */

import { execSync, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const _provIdx = args.indexOf('--provider');
const filterProvider = _provIdx !== -1 ? (args[_provIdx + 1] || null) : null;
const _modelIdx = args.indexOf('--model');
const filterModel = _modelIdx !== -1 ? (args[_modelIdx + 1] || null) : null;
const outputJson = args.includes('--json');
const outputMd = args.includes('--md');
const doProbeLimit = args.includes('--probe-limits');
const slowMode = args.includes('--veryslow');
const noLog = args.includes('--no-log');
const _billingIdx = args.indexOf('--billing');
const billingOverride = _billingIdx !== -1 ? (args[_billingIdx + 1] || null) : null;

// Default probe log dir: ~/bin/probe-logs/YYYY-MM-DD-HHmmss.jsonl
// Disabled with --no-log. Each line is one probe request record.
const probeLogFile = (!noLog && doProbeLimit) ? (() => {
  const dir = join(__dirname, 'probe-logs');
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(dir, `${ts}.jsonl`);
})() : null;

function writeProbeLog(record) {
  if (!probeLogFile) return;
  appendFileSync(probeLogFile, JSON.stringify(record) + '\n');
}

// Billing tiers — drives probe strategy:
//
//   read-only    OpenRouter: /v1/models already returns context_length. No probing needed.
//
//   request      github-copilot, github-copilot: explicit request-based subscription.
//                Burn requests freely. Real content-fill binary search, full precision.
//                Target: ±1K, ~15 requests per model.
//
//   quota        openai-codex, anthropic, google-gemini-cli: subscription with amorphous
//                utilization quotas. Minimize requests. Use the max_tokens claim trick:
//                tiny prompt (5 tokens) + huge max_tokens claim → provider returns the
//                exact limit in the 400 error message for free. Usually 1 request total.
//                Binary search fallback (3-4 steps max) only if error has no number.
//
const READ_ONLY_PROVIDERS  = new Set(['openrouter']);
const REQUEST_BASED        = new Set(['github-copilot', 'github-copilot', 'ollama']);
// Everything else (openai-codex, anthropic, google-gemini-cli, etc.) → quota
// Note: ollama is request-based because cloud models (:cloud tag) return HTTP 500 on overflow
// rather than a 400 with token count — the max_tokens claim trick doesn't work for them.

function billingModeFor(providerName) {
  if (billingOverride) return billingOverride;
  if (READ_ONLY_PROVIDERS.has(providerName)) return 'read-only';
  if (REQUEST_BASED.has(providerName))       return 'request';
  return 'quota';
}

// ---------------------------------------------------------------------------
// 1. Load openclaw config
// ---------------------------------------------------------------------------
function getConfig(path) {
  try {
    const raw = spawnSync('openclaw', ['config', 'get', path, '--json'], { encoding: 'utf8' });
    return JSON.parse(raw.stdout.trim());
  } catch { return null; }
}

const providers = getConfig('models.providers');
if (!providers) { console.error('Could not read models.providers from openclaw config'); process.exit(1); }

// ---------------------------------------------------------------------------
// 2. Token resolution — ask gateway RPC, fall back to auth-profiles.json
// ---------------------------------------------------------------------------
function resolveToken(providerName, providerConfig) {
  // Anthropic: token lives at .default.anthropic.token in auth-profiles.json
  // (no apiKey field in providers config, and --provider flag RPC fails for anthropic)
  if (providerName === 'anthropic') {
    try {
      const profiles = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'auth-profiles.json'), 'utf8'));
      const tok = profiles?.default?.anthropic?.token;
      if (tok) return tok;
    } catch {}
  }

  // Try gateway RPC (positional format: openclaw models auth token <provider>)
  try {
    const rpc = spawnSync('openclaw', ['models', 'auth', 'token', providerName], { encoding: 'utf8' });
    const tok = rpc.stdout.trim();
    if (tok && !tok.includes('error') && !tok.includes('Error')) return tok;
  } catch {}

  // Also try --provider flag format as fallback
  try {
    const rpc = spawnSync('openclaw', ['models', 'auth', 'token', '--provider', providerName], { encoding: 'utf8' });
    const tok = rpc.stdout.trim();
    if (tok && !tok.includes('error') && !tok.includes('Error')) return tok;
  } catch {}

  // Raw apiKey in config (may be __OPENCLAW_REDACTED_ placeholder)
  const key = providerConfig?.apiKey;
  if (key && !key.startsWith('__OPENCLAW')) return key;

  // Auth profiles fallback (generic — scan for any string value in default profile)
  try {
    const profiles = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'auth-profiles.json'), 'utf8'));
    const defaultProfile = profiles?.default;
    if (defaultProfile) {
      for (const [, val] of Object.entries(defaultProfile)) {
        if (typeof val === 'string' && val.length > 10) return val;
      }
    }
  } catch {}

  return null;
}

// ---------------------------------------------------------------------------
// 3. Provider-specific probers
// ---------------------------------------------------------------------------

async function probeOpenAICompatible(name, baseUrl, token) {
  const url = baseUrl.replace(/\/$/, '') + '/models';
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    const models = data?.data || data?.models || (Array.isArray(data) ? data : []);
    return models.map(m => ({
      id: m.id || m.name,
      contextWindow: m.context_window ?? m.contextWindow ?? m.max_input_tokens ?? null,
      maxTokens: m.max_tokens ?? m.maxTokens ?? null,
      raw: { context_window: m.context_window, contextWindow: m.contextWindow, max_input_tokens: m.max_input_tokens }
    }));
  } catch (e) { return { error: e.message }; }
}

async function probeAnthropic(baseUrl, token) {
  // Resolve token from auth-profiles if not passed in
  if (!token) {
    try {
      const profiles = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'auth-profiles.json'), 'utf8'));
      token = profiles?.default?.anthropic?.token || null;
    } catch {}
  }
  // Anthropic /v1/models does not expose context_window — supplement with known values
  const knownWindows = {
    'claude-opus-4-6': 200000, 'claude-opus-4.6': 200000,
    'claude-sonnet-4-6': 200000, 'claude-sonnet-4.6': 200000,
    'claude-haiku-4-5': 200000, 'claude-haiku-4.5': 200000,
    'claude-3-5-sonnet-20241022': 200000, 'claude-3-5-haiku-20241022': 200000,
    'claude-3-opus-20240229': 200000,
  };
  const url = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/models';
  const headers = { 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  if (token) headers['x-api-key'] = token;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { error: `HTTP ${res.status} — ${token ? 'key present' : 'no key'}` };
    const data = await res.json();
    const models = data?.data || [];
    return models.map(m => ({
      id: m.id,
      contextWindow: knownWindows[m.id] ?? null,
      maxTokens: null,
      note: knownWindows[m.id] ? 'from Anthropic docs (API does not expose window)' : 'not advertised by API'
    }));
  } catch (e) { return { error: e.message }; }
}

async function probeGemini(baseUrl, token) {
  // google-gemini-cli routes through a local CLI proxy — try OpenAI-compat endpoint first
  if (baseUrl && !baseUrl.includes('generativelanguage.googleapis.com')) {
    const result = await probeOpenAICompatible('google-gemini-cli', baseUrl, token);
    if (Array.isArray(result)) return result;
  }
  // Fall back to native Gemini API if we have a direct key
  const key = token;
  if (!key) return { error: 'routes through local CLI proxy — no direct API key configured' };
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=50`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return (data?.models || []).map(m => ({
      id: m.name?.replace('models/', '') || m.displayName,
      contextWindow: m.inputTokenLimit ?? null,
      maxTokens: m.outputTokenLimit ?? null,
      note: 'from Gemini API (inputTokenLimit)'
    }));
  } catch (e) { return { error: e.message }; }
}

async function probeOllama(baseUrl) {
  const ollamaBase = (baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const url = ollamaBase + '/api/tags';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    // Local models: context window from /api/show (GGUF metadata).
    // Cloud models (:cloud tag): stubs only — /api/show has no GGUF data.
    // Cloud context is probed later via /v1/chat/completions (request-based binary search).
    const models = data?.models || [];
    const results = [];
    for (const m of models.slice(0, 20)) { // cap at 20 to avoid long waits
      const isCloud = /:(cloud|online)$/i.test(m.name);
      if (isCloud) {
        // No local weights — skip /api/show, report null. Prober handles this via OpenAI-compat.
        results.push({ id: m.name, contextWindow: null, maxTokens: null, note: 'cloud model — context probed via /v1/chat/completions' });
        continue;
      }
      try {
        const showRes = await fetch(ollamaBase + '/api/show',
          { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: m.name }), signal: AbortSignal.timeout(5000) });
        if (showRes.ok) {
          const info = await showRes.json();
          const ctx = info?.model_info?.['llama.context_length']
            ?? info?.parameters?.match?.(/num_ctx\s+(\d+)/)?.[1]
            ?? null;
          results.push({ id: m.name, contextWindow: ctx ? parseInt(ctx) : null, maxTokens: null, note: ctx ? 'from ollama show' : 'not advertised' });
        } else {
          results.push({ id: m.name, contextWindow: null, maxTokens: null });
        }
      } catch { results.push({ id: m.name, contextWindow: null, maxTokens: null }); }
    }
    return results;
  } catch (e) { return { error: e.message }; }
}

// ---------------------------------------------------------------------------
// 4. Route each provider to the right prober
// ---------------------------------------------------------------------------
async function probeProvider(name, config) {
  const baseUrl = config.baseUrl || '';
  const token = resolveToken(name, config);

  if (name === 'anthropic') return probeAnthropic(baseUrl, token);
  if (name === 'google-gemini-cli') return probeGemini(baseUrl, token);
  if (name === 'ollama') {
    // Merge /api/tags (local show data) with /v1/models (OpenAI-compat, covers cloud models).
    // probeOllama handles local models via /api/show and marks cloud stubs explicitly.
    // probeOpenAICompatible gives us the canonical model list including cloud-tagged models.
    const ollamaBase = baseUrl || 'http://127.0.0.1:11434';
    const [tagResult, compatResult] = await Promise.all([
      probeOllama(ollamaBase),
      probeOpenAICompatible(name, ollamaBase, token),
    ]);
    if (!Array.isArray(tagResult) && !Array.isArray(compatResult)) return tagResult; // both failed
    if (!Array.isArray(compatResult)) return tagResult;  // compat failed, fall back to tags only
    // Compat is source of truth for IDs; enrich with /api/show ctx window for local models.
    const showMap = new Map();
    if (Array.isArray(tagResult)) {
      for (const m of tagResult) showMap.set(m.id, m);
    }
    return compatResult.map(m => {
      const showEntry = showMap.get(m.id);
      if (showEntry?.contextWindow != null) return { ...m, contextWindow: showEntry.contextWindow, note: showEntry.note };
      if (m.contextWindow != null) return m;
      if (showEntry) return { ...m, contextWindow: showEntry.contextWindow ?? null, note: showEntry.note };
      return m;
    });
  }
  // OpenAI-compatible (github-copilot, github-copilot, openrouter, openai-codex, etc.)
  return probeOpenAICompatible(name, baseUrl, token);
}

// ---------------------------------------------------------------------------
// 5. Run probes
// ---------------------------------------------------------------------------
const results = {};
const providerNames = Object.keys(providers).filter(n => !filterProvider || n === filterProvider);

process.stderr.write(`Probing ${providerNames.length} provider(s)...\n`);

for (const name of providerNames) {
  process.stderr.write(`  → ${name}\n`);
  results[name] = await probeProvider(name, providers[name]);
}

// ---------------------------------------------------------------------------
// 6. Load library + build lookup table
// ---------------------------------------------------------------------------
let _library = [];
try {
  const lib = JSON.parse(readFileSync(join(__dirname, 'model-context-library.json'), 'utf8'));
  _library = lib.models || [];
} catch { /* library not found — fall back to inline table */ }

// Build alias → canonical entry map
const LIBRARY_MAP = new Map();
for (const entry of _library) {
  LIBRARY_MAP.set(entry.id.toLowerCase(), entry);
  for (const alias of (entry.aliases || [])) {
    LIBRARY_MAP.set(alias.toLowerCase(), entry);
  }
}

function libraryLookup(modelId) {
  return LIBRARY_MAP.get(modelId.toLowerCase()) || null;
}

// Inline fallback table (subset, in case library file is missing)
const KNOWN_WINDOWS = {
  // OpenAI / Copilot proxy models (native OpenAI limits, not what Copilot caps at)
  'gpt-5.4':                 { ctx: 400000,   note: 'OpenAI docs' },
  'gpt-5.4-mini':            { ctx: 400000,   note: 'OpenAI docs' },
  'gpt-5.3-codex':           { ctx: 400000,   note: 'OpenAI docs' },
  'gpt-5.2-codex':           { ctx: 400000,   note: 'OpenAI docs' },
  'gpt-5.1':                 { ctx: 400000,   note: 'OpenAI docs' },
  'gpt-5.1-codex':           { ctx: 400000,   note: 'OpenAI docs' },
  'gpt-5.1-codex-max':       { ctx: 400000,   note: 'OpenAI docs' },
  'gpt-5.1-codex-mini':      { ctx: 400000,   note: 'OpenAI docs' },
  'gpt-5-mini':              { ctx: 400000,   note: 'OpenAI docs' },
  'gpt-4.1':                 { ctx: 1047576,  note: 'OpenAI docs' },
  'gpt-4.1-2025-04-14':      { ctx: 1047576,  note: 'OpenAI docs' },
  'gpt-4o':                  { ctx: 128000,   note: 'OpenAI docs' },
  'gpt-4o-mini':             { ctx: 128000,   note: 'OpenAI docs' },
  'gpt-4o-2024-11-20':       { ctx: 128000,   note: 'OpenAI docs' },
  'gpt-4o-2024-08-06':       { ctx: 128000,   note: 'OpenAI docs' },
  'gpt-4o-2024-05-13':       { ctx: 128000,   note: 'OpenAI docs' },
  'gpt-4o-mini-2024-07-18':  { ctx: 128000,   note: 'OpenAI docs' },
  // Anthropic (via Copilot proxy or direct)
  'claude-opus-4-6':         { ctx: 200000,   note: 'Anthropic docs (1M w/ beta header)' },
  'claude-opus-4.6':         { ctx: 200000,   note: 'Anthropic docs (1M w/ beta header)' },
  'claude-sonnet-4-6':       { ctx: 200000,   note: 'Anthropic docs (1M w/ beta header)' },
  'claude-sonnet-4.6':       { ctx: 200000,   note: 'Anthropic docs (1M w/ beta header)' },
  'claude-opus-4.5':         { ctx: 200000,   note: 'Anthropic docs' },
  'claude-sonnet-4.5':       { ctx: 200000,   note: 'Anthropic docs' },
  'claude-sonnet-4':         { ctx: 200000,   note: 'Anthropic docs' },
  'claude-haiku-4.5':        { ctx: 200000,   note: 'Anthropic docs' },
  // Gemini (via Copilot proxy)
  'gemini-3.1-pro-preview':  { ctx: 400000,   note: 'Google docs' },
  'gemini-3.1-flash-preview':{ ctx: 1000000,  note: 'Google docs' },
  'gemini-3-flash-preview':  { ctx: 1000000,  note: 'Google docs' },
  'gemini-2.5-pro':          { ctx: 1000000,  note: 'Google docs' },
};

function augmentWithKnown(models) {
  return models.map(m => {
    const lib = libraryLookup(m.id);
    if (m.contextWindow != null) {
      return { ...m, maxOutput: lib?.maxOutputTokens ?? m.maxTokens ?? null, vision: lib?.vision ?? null, reasoning: lib?.reasoning ?? null, betaHeaders: lib?.betaHeaders ?? null, source: 'live' };
    }
    if (lib) {
      return { ...m, contextWindow: lib.contextWindow, maxOutput: lib.maxOutputTokens ?? null, vision: lib.vision ?? null, reasoning: lib.reasoning ?? null, betaHeaders: lib.betaHeaders ?? null, note: lib.notes || '', source: 'lib' };
    }
    const known = KNOWN_WINDOWS[m.id];
    if (known) return { ...m, contextWindow: known.ctx, source: 'docs' };
    return { ...m, source: '?' };
  });
}

// ---------------------------------------------------------------------------
// Library auto-update: add models seen in probe that aren't in library yet
// ---------------------------------------------------------------------------
function updateLibraryWithNewModels() {
  const libPath = join(__dirname, 'model-context-library.json');
  let libFile;
  try { libFile = JSON.parse(readFileSync(libPath, 'utf8')); } catch { return; }

  const existingIds = new Set();
  for (const m of libFile.models) {
    existingIds.add(m.id.toLowerCase());
    for (const a of (m.aliases || [])) existingIds.add(a.toLowerCase());
  }

  const newEntries = [];
  for (const [provName, data] of Object.entries(results)) {
    if (!Array.isArray(data)) continue;
    // Infer family from provider name
    const family = provName.includes('anthropic') ? 'anthropic'
      : provName.includes('gemini') || provName.includes('google') ? 'google'
      : provName.includes('ollama') ? 'local'
      : 'openai';
    for (const m of data) {
      if (!m.id || existingIds.has(m.id.toLowerCase())) continue;
      // Skip obvious non-model IDs (embeddings, audio, etc.)
      if (/embed|whisper|tts|transcri|dall-e|realtime|moderat/i.test(m.id)) continue;
      const entry = {
        family,
        id: m.id,
        aliases: [],
        contextWindow: m.contextWindow ?? null,
        maxOutputTokens: m.maxTokens ?? null,
        vision: null,
        audio: false,
        video: false,
        tools: null,
        reasoning: null,
        notes: `auto-added from ${provName} probe ${new Date().toISOString().slice(0,10)}`,
      };
      newEntries.push(entry);
      existingIds.add(m.id.toLowerCase());
    }
  }

  if (newEntries.length === 0) return;

  libFile.models.push(...newEntries);
  libFile._meta.updated = new Date().toISOString().slice(0,10);
  writeFileSync(libPath, JSON.stringify(libFile, null, 2) + '\n');
  process.stderr.write(`  ℹ️  Library updated: +${newEntries.length} new model(s): ${newEntries.map(e => e.id).join(', ')}\n`);
}

// Run library update (skip if --library or --no-update)
if (!args.includes('--library') && !args.includes('--no-update')) {
  await updateLibraryWithNewModels();
}

// Also expose library as a standalone report mode
const showLibrary = args.includes('--library');
if (showLibrary) {
  const _famIdx = args.indexOf('--family');
  const familyFilter = _famIdx !== -1 ? (args[_famIdx + 1] || null) : null;
  const rows = _library.filter(m => !familyFilter || m.family === familyFilter);
  if (outputMd || !outputJson) {
    console.log('# Model Context Window Library');
    console.log(`\nSource: https://github.com/taylorwilsdon/llm-context-limits  |  Last updated: 2026-04-03\n`);
    const families = [...new Set(rows.map(r => r.family))];
    for (const fam of families) {
      console.log(`\n## ${fam.charAt(0).toUpperCase() + fam.slice(1)}\n`);
      console.log('| Model | Context | Max Output | Vision | Reasoning | Notes |');
      console.log('|---|---|---|---|---|---|');
      for (const m of rows.filter(r => r.family === fam)) {
        const betaNote = m.betaHeaders ? ` *(${Object.entries(m.betaHeaders).map(([h,v]) => `${(v/1000).toFixed(0)}K via \`${h}\``).join(', ')})*` : '';
        console.log(`| \`${m.id}\` | ${(m.contextWindow/1000).toFixed(0)}K | ${m.maxOutputTokens ? (m.maxOutputTokens/1000).toFixed(0)+'K' : '—'} | ${m.vision ? '✅' : '❌'} | ${m.reasoning ? '✅' : '❌'} | ${(m.notes || '') + betaNote} |`);
      }
    }
  } else {
    console.log(JSON.stringify(rows, null, 2));
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 7. Active limit probing — binary search via real requests
// ---------------------------------------------------------------------------

// Generate filler text of approximately `targetTokens` tokens.
// Rule of thumb: ~4 chars per token for English prose.
// We use a short sentence so it's definitely not cached anywhere.
const FILLER_UNIT = 'The quick brown fox jumped over the lazy dog. ';
const FILLER_CHARS_PER_TOKEN = 4;

function makeFiller(targetTokens) {
  const targetChars = targetTokens * FILLER_CHARS_PER_TOKEN;
  const reps = Math.ceil(targetChars / FILLER_UNIT.length);
  let s = FILLER_UNIT.repeat(reps);
  return s.slice(0, targetChars);
}

// Approximate token count of a string (conservative estimate)
function approxTokens(s) {
  return Math.ceil(s.length / FILLER_CHARS_PER_TOKEN);
}

// Parse exact limit from error message — works for OpenAI, Anthropic, Copilot
function parseErrorLimit(errBody) {
  const text = typeof errBody === 'string' ? errBody : JSON.stringify(errBody);
  // Patterns:
  //   "maximum context length is 128000 tokens"
  //   "max_tokens: must be <= 200000"
  //   "This model's maximum context length is 128000"
  //   "Input token count (500001) exceeds the maximum of 200000"
  //   "reduce your prompt; or completion length"
  const patterns = [
    /maximum context length is (\d+)/i,
    /context length is (\d+)/i,
    /maximum of (\d+) tokens/i,
    /max(?:imum)?[_\s]tokens.*?(?:is|<=|<)\s*(\d+)/i,
    /exceeds.*?maximum.*?(\d+)/i,
    /exceeds.*?limit.*?(\d+)/i,
    /must be (?:at most|<=|<|no more than) (\d+)/i,
    /(\d{4,7}) (?:is the |)(?:max|maximum|limit)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1]);
  }
  return null;
}

// Sleep helper
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Single probe attempt.
// strategy='request': real content fill (github-copilot, github-copilot)
// strategy='quota':   tiny prompt + large max_tokens claim (openai-codex, anthropic, etc.)
// Returns { accepted: bool, exactLimit: int|null, rateLimited: bool, error: string|null }
async function singleProbe(providerName, config, modelId, inputTokens, strategy) {
  const baseUrl = (config.baseUrl || '').replace(/\/$/, '');
  const token = resolveToken(providerName, config);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let body;
  const t0 = Date.now();
  if (strategy === 'request') {
    // Request-based: burn a real request with actual filler content.
    // Copilot charges per request not per token — zero extra cost.
    const filler = makeFiller(Math.max(1, inputTokens - 10));
    body = {
      model: modelId,
      messages: [{ role: 'user', content: filler }],
      max_tokens: 1,   // generate nothing meaningful
      stream: false,
    };
  } else {
    // Quota-based: 5-token prompt + claim inputTokens of max_tokens.
    // Provider validates the sum against the context window and returns the exact
    // limit in the 400 error body — costs ~5 input tokens regardless of inputTokens.
    body = {
      model: modelId,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: Math.max(1, inputTokens - 5),  // claim we need this much output
      stream: false,
    };
  }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.PROBE_TIMEOUT_MS || 30000)),
    });

    const latencyMs = Date.now() - t0;
    const logBase = { ts: new Date().toISOString(), provider: providerName, model: modelId, inputTokens, strategy, status: res.status, latencyMs };

    if (res.status === 429) {
      writeProbeLog({ ...logBase, result: 'rate-limited' });
      return { accepted: false, exactLimit: null, rateLimited: true, latencyMs, error: 'rate limited' };
    }
    if (res.status === 401 || res.status === 403) {
      writeProbeLog({ ...logBase, result: 'auth-error' });
      return { accepted: false, exactLimit: null, rateLimited: false, latencyMs, error: `auth error ${res.status}` };
    }
    // HTTP 500 from ollama cloud models = context overflow (opaque backend limit, no token count).
    // Treat as a clean rejection so binary search can converge — same as 400 but no exactLimit.
    if (res.status === 500) {
      writeProbeLog({ ...logBase, result: 'rejected-500', errorSnippet: '500 cloud backend limit' });
      return { accepted: false, exactLimit: null, rateLimited: false, latencyMs, error: '500 — cloud backend limit (no exact token count in error)' };
    }

    const data = await res.json().catch(() => ({}));
    const errText = data?.error?.message || data?.message || JSON.stringify(data);

    if (!res.ok) {
      const exactLimit = parseErrorLimit(errText);
      writeProbeLog({ ...logBase, result: 'rejected', exactLimit: exactLimit || null, errorSnippet: errText.slice(0, 120) });
      return { accepted: false, exactLimit, rateLimited: false, latencyMs, error: errText.slice(0, 200) };
    }

    writeProbeLog({ ...logBase, result: 'accepted' });
    return { accepted: true, exactLimit: null, rateLimited: false, latencyMs, error: null };
  } catch (e) {
    const latencyMs = Date.now() - t0;
    writeProbeLog({ ts: new Date().toISOString(), provider: providerName, model: modelId, inputTokens, strategy, latencyMs, result: 'error', error: e.message });
    return { accepted: false, exactLimit: null, rateLimited: false, latencyMs, error: e.message };
  }
}

// Anthropic-specific single probe — uses /v1/messages endpoint with x-api-key auth.
// Same quota trick: tiny prompt + large max_tokens → provider returns exact limit in error.
// Returns same shape as singleProbe: { accepted, exactLimit, rateLimited, latencyMs, error }
async function singleProbeAnthropic(providerName, config, modelId, inputTokens, _strategy, _slowMode) {
  const baseUrl = (config.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  const token = resolveToken(providerName, config);
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (token) headers['x-api-key'] = token;

  // Quota trick: tiny user message + large max_tokens claim → API validates the sum
  // and returns exact limit in the 400 error body.
  const body = {
    model: modelId,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: Math.max(1, inputTokens - 5),
  };

  const t0 = Date.now();
  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.PROBE_TIMEOUT_MS || 30000)),
    });

    const latencyMs = Date.now() - t0;
    const logBase = { ts: new Date().toISOString(), provider: providerName, model: modelId, inputTokens, strategy: 'quota', status: res.status, latencyMs };

    if (res.status === 429) {
      writeProbeLog({ ...logBase, result: 'rate-limited' });
      return { accepted: false, exactLimit: null, rateLimited: true, latencyMs, error: 'rate limited' };
    }
    if (res.status === 401 || res.status === 403) {
      writeProbeLog({ ...logBase, result: 'auth-error' });
      return { accepted: false, exactLimit: null, rateLimited: false, latencyMs, error: `auth error ${res.status}` };
    }

    const data = await res.json().catch(() => ({}));
    const errText = data?.error?.message || data?.message || JSON.stringify(data);

    if (!res.ok) {
      const exactLimit = parseErrorLimit(errText);
      writeProbeLog({ ...logBase, result: 'rejected', exactLimit: exactLimit || null, errorSnippet: errText.slice(0, 120) });
      return { accepted: false, exactLimit, rateLimited: false, latencyMs, error: errText.slice(0, 200) };
    }

    writeProbeLog({ ...logBase, result: 'accepted' });
    return { accepted: true, exactLimit: null, rateLimited: false, latencyMs, error: null };
  } catch (e) {
    const latencyMs = Date.now() - t0;
    writeProbeLog({ ts: new Date().toISOString(), provider: providerName, model: modelId, inputTokens, strategy: 'quota', latencyMs, result: 'error', error: e.message });
    return { accepted: false, exactLimit: null, rateLimited: false, latencyMs, error: e.message };
  }
}

// Resolve config for the built-in openai-codex provider (not in models.providers).
// Returns { baseUrl, token } or null if no token can be found.
function resolveOpenAICodexConfig() {
  // Try positional CLI format first
  try {
    const rpc = spawnSync('openclaw', ['models', 'auth', 'token', 'openai-codex'], { encoding: 'utf8' });
    const tok = rpc.stdout.trim();
    if (tok && !tok.includes('error') && !tok.includes('Error') && tok.length > 10) {
      return { baseUrl: 'https://chatgpt.com/backend-api/v1', token: tok };
    }
  } catch {}

  // Env var fallbacks
  const envTok = process.env.OPENAI_CODEX_TOKEN || process.env.OPENAI_API_KEY;
  if (envTok) return { baseUrl: 'https://chatgpt.com/backend-api/v1', token: envTok };

  return null;
}

function summarizeLatency(samples) {
  if (!samples || samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (pct) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * pct / 100))];
  return { min: sorted[0], max: sorted[sorted.length - 1], p50: p(50), p95: p(95), samples: sorted.length };
}

// Full binary search probe for one model.
// billingMode: 'request' | 'quota'
// slowMode: --veryslow flag — ~4s between probes, more 429 retries, targets ~60s total
// Returns { limit, method, probeCount, note, latency }
async function probeModelLimit(providerName, config, modelId, billingMode, slowMode = false) {
  const RANGE_LEVELS = [1000, 8000, 32000, 50000, 128000, 200000, 400000, 500000, 1000000, 2000000];

  // Select the right probe function based on provider
  const probeFunc = (providerName === 'anthropic') ? singleProbeAnthropic : singleProbe;

  const isRequest = billingMode === 'request';
  // slowMode: ~4s/probe keeps well under rate limits; more retries on 429
  const PROBE_DELAY_MS  = slowMode ? 4000 : (isRequest ? 400  : 1000);
  const MAX_BACKOFF_MS  = slowMode ? 60000 : (isRequest ? 8000 : 30000);
  const MAX_PROBES      = slowMode ? 30   : (isRequest ? 20   : 6);
  const MAX_429_RETRIES = slowMode ? 5    : 1;
  const PRECISION       = isRequest ? 1000 : 10000;
  const strategy        = isRequest ? 'request' : 'quota';

  const latencies = [];  // ms per request, for stats
  let probeCount = 0;
  let delay = PROBE_DELAY_MS;
  let lastSuccess = 0;
  let firstFailure = null;
  let foundExact = null;

  // Quota mode: try max_tokens trick first — 1 request if provider reports exact limit in error.
  if (!isRequest) {
    process.stderr.write(`    [${modelId}] quota-mode: trying max_tokens claim...`);
    await sleep(delay);
    const r = await probeFunc(providerName, config, modelId, 2000000, 'quota', slowMode);
    probeCount++;
    if (r.latencyMs) latencies.push(r.latencyMs);
    if (r.exactLimit) {
      process.stderr.write(` exact=${r.exactLimit.toLocaleString()} (error msg, 1 request)\n`);
      return { limit: r.exactLimit, method: 'error-message', probeCount, note: 'exact limit from error response (1 request)', latency: summarizeLatency(latencies) };
    }
    if (r.accepted) {
      process.stderr.write(` accepted 2M claim — no validation\n`);
      return { limit: 2000000, method: 'lower-bound', probeCount, note: 'accepted 2M max_tokens — provider may not validate', latency: summarizeLatency(latencies) };
    }
    if (r.error && /auth|401|403/i.test(r.error)) {
      process.stderr.write(` auth error — skipping\n`);
      return { limit: null, method: 'auth-error', probeCount, note: r.error, latency: summarizeLatency(latencies) };
    }
    process.stderr.write(` no exact limit in error, falling back to binary search...`);
  } else {
    process.stderr.write(`    [${modelId}] ${slowMode ? 'ranging (slow mode ~4s/probe)' : 'ranging'}...`);
  }

  // --- Phase 1: Ranging — find the bracket ---
  for (const level of RANGE_LEVELS) {
    if (probeCount >= MAX_PROBES) break;
    await sleep(delay);

    const r = await probeFunc(providerName, config, modelId, level, strategy, slowMode);
    probeCount++;
    if (r.latencyMs) latencies.push(r.latencyMs);

    if (r.rateLimited) {
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      process.stderr.write(` [429 backing off ${delay}ms]`);
      await sleep(delay);
      let gaveUp = false;
      for (let attempt = 0; attempt < MAX_429_RETRIES; attempt++) {
        const retry = await probeFunc(providerName, config, modelId, level, strategy, slowMode);
        probeCount++;
        if (retry.latencyMs) latencies.push(retry.latencyMs);
        if (retry.rateLimited) {
          if (attempt < MAX_429_RETRIES - 1) {
            delay = Math.min(delay * 2, MAX_BACKOFF_MS);
            process.stderr.write(` [429 retry ${attempt+2}/${MAX_429_RETRIES}, backoff ${delay}ms]`);
            await sleep(delay);
            continue;
          }
          process.stderr.write(` [429 exhausted, skipping — try --veryslow]\n`);
          gaveUp = true; break;
        }
        if (retry.exactLimit) { foundExact = retry.exactLimit; break; }
        if (retry.accepted) { lastSuccess = level; delay = PROBE_DELAY_MS; break; }
        firstFailure = level; break;
      }
      if (gaveUp) return { limit: null, method: 'rate-limited', probeCount, note: 'rate limited — retry with --veryslow', latency: summarizeLatency(latencies) };
      if (foundExact) break;
      if (firstFailure !== null) break;
      continue;
    }

    if (r.exactLimit) {
      foundExact = r.exactLimit;
      process.stderr.write(` exact=${foundExact.toLocaleString()} (from error msg)\n`);
      break;
    }

    if (r.accepted) {
      lastSuccess = level;
      process.stderr.write(` ✓${(level/1000).toFixed(0)}K`);
      delay = PROBE_DELAY_MS;
    } else {
      firstFailure = level;
      process.stderr.write(` ✗${(level/1000).toFixed(0)}K`);
      break;
    }
  }

  if (foundExact) {
    return { limit: foundExact, method: 'error-message', probeCount, note: 'exact limit from error response', latency: summarizeLatency(latencies) };
  }

  if (firstFailure === null) {
    process.stderr.write(` → ≥${(lastSuccess/1000).toFixed(0)}K (no ceiling found)\n`);
    return { limit: lastSuccess, method: 'lower-bound', probeCount, note: `accepted all levels up to ${(lastSuccess/1000).toFixed(0)}K — true ceiling unknown`, latency: summarizeLatency(latencies) };
  }

  if (lastSuccess === 0) {
    process.stderr.write(` → failed at 1K\n`);
    return { limit: null, method: 'failed', probeCount, note: 'failed at 1K — model unavailable or wrong endpoint', latency: summarizeLatency(latencies) };
  }

  // --- Phase 2: Binary search between lastSuccess and firstFailure ---
  process.stderr.write(` binary[${(lastSuccess/1000).toFixed(0)}K–${(firstFailure/1000).toFixed(0)}K]`);

  let lo = lastSuccess;
  let hi = firstFailure;

  while ((hi - lo) > PRECISION && probeCount < MAX_PROBES) {
    const mid = Math.floor((lo + hi) / 2);
    await sleep(delay);

    const r = await probeFunc(providerName, config, modelId, mid, strategy, slowMode);
    probeCount++;
    if (r.latencyMs) latencies.push(r.latencyMs);

    if (r.rateLimited) {
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      await sleep(delay);
      continue;
    }
    if (r.exactLimit) { foundExact = r.exactLimit; break; }

    if (r.accepted) {
      lo = mid;
      process.stderr.write(` ✓${(mid/1000).toFixed(0)}K`);
      delay = PROBE_DELAY_MS;
    } else {
      hi = mid;
      process.stderr.write(` ✗${(mid/1000).toFixed(0)}K`);
    }
  }

  if (foundExact) {
    process.stderr.write(` → exact=${foundExact.toLocaleString()}\n`);
    return { limit: foundExact, method: 'error-message', probeCount, note: 'exact limit from error during binary search', latency: summarizeLatency(latencies) };
  }

  process.stderr.write(` → ~${(lo/1000).toFixed(0)}K (±${(PRECISION/1000).toFixed(0)}K)\n`);
  return {
    limit: lo,
    method: 'binary-search',
    probeCount,
    note: `binary search converged: ≤${(hi/1000).toFixed(0)}K, last success ${(lo/1000).toFixed(0)}K`,
    latency: summarizeLatency(latencies),
  };
}

// Run limit probing across all providers/models
async function runProbeLimits() {
  const libPath = join(__dirname, 'model-context-library.json');
  let libFile;
  try { libFile = JSON.parse(readFileSync(libPath, 'utf8')); } catch { libFile = null; }

  const probeResults = []; // { provider, model, limit, method, probeCount, note, prevLimit }

  if (probeLogFile) process.stderr.write(`\n  Probe log: ${probeLogFile}\n`);

  for (const [provName, provConfig] of Object.entries(providers)) {
    if (filterProvider && provName !== filterProvider) continue;

    const mode = billingModeFor(provName);

    // For read-only providers (OpenRouter), context_length is in the /models response
    if (mode === 'read-only') {
      process.stderr.write(`\n[${provName}] read-only — reading context_length from /models\n`);
      const liveData = results[provName];
      if (Array.isArray(liveData)) {
        for (const m of liveData) {
          if (filterModel && m.id !== filterModel) continue;
          probeResults.push({ provider: provName, model: m.id, limit: m.contextWindow, method: 'advertised', probeCount: 0, note: 'read from /v1/models response' });
        }
      }
      continue;
    }

    // Get model list from live probe results
    const liveData = results[provName];
    if (!Array.isArray(liveData)) {
      process.stderr.write(`\n[${provName}] skipping — probe failed: ${liveData?.error}\n`);
      probeResults.push({
        provider: provName,
        model: '(all)',
        limit: null,
        method: 'probe-error',
        probeCount: 0,
        note: `probe failed: ${liveData?.error || 'unknown error'}`,
        prevLimit: null,
        error: liveData?.error || 'unknown'
      });
      continue;
    }

    // Filter out embedding/audio/image models — they don't accept chat completions
    const chatModels = liveData.filter(m =>
      m.id &&
      !/embed|whisper|tts|transcri|dall-e|realtime|moderat|text-embedding|inference$/i.test(m.id) &&
      (!filterModel || m.id === filterModel)
    );

    process.stderr.write(`\n[${provName}] billing=${mode === 'request' ? 'request-based (burn freely)' : 'quota-based (minimal requests)'} — probing ${chatModels.length} model(s)\n`);

    for (const m of chatModels) {
      const lib = libraryLookup(m.id);
      const prevLimit = lib?.probed?.limit ?? lib?.contextWindow ?? null;

      // Skip if recently probed (within 7 days) unless --force
      if (!args.includes('--force') && lib?.probed?.date) {
        const daysSince = (Date.now() - new Date(lib.probed.date).getTime()) / 86400000;
        if (daysSince < 7) {
          process.stderr.write(`  [${m.id}] skipping — probed ${daysSince.toFixed(0)}d ago (use --force to re-probe)\n`);
          probeResults.push({ provider: provName, model: m.id, limit: lib.probed.limit, method: 'cached', probeCount: 0, note: `cached from ${lib.probed.date}`, prevLimit });
          continue;
        }
      }

      const result = await probeModelLimit(provName, provConfig, m.id, mode, slowMode);

      probeResults.push({ provider: provName, model: m.id, ...result, prevLimit });

      // Update library with probe result
      if (result.limit != null && libFile) {
        const entry = libFile.models.find(e =>
          e.id.toLowerCase() === m.id.toLowerCase() ||
          (e.aliases || []).some(a => a.toLowerCase() === m.id.toLowerCase())
        );
        if (entry) {
          entry.probed = { limit: result.limit, method: result.method, date: new Date().toISOString().slice(0, 10), note: result.note };
          if (!entry.contextWindow) entry.contextWindow = result.limit; // fill in if missing
        } else {
          // New model — add stub
          libFile.models.push({
            family: 'unknown', id: m.id, aliases: [],
            contextWindow: result.limit,
            probed: { limit: result.limit, method: result.method, date: new Date().toISOString().slice(0, 10), note: result.note },
            notes: `auto-added from ${provName} probe`,
          });
        }
      }
    }
  }

  // Save updated library
  if (libFile) {
    libFile._meta = libFile._meta || {};
    libFile._meta.updated = new Date().toISOString().slice(0, 10);
    writeFileSync(join(__dirname, 'model-context-library.json'), JSON.stringify(libFile, null, 2) + '\n');
    process.stderr.write(`\nLibrary saved with probe results.\n`);
  }

  // --- openai-codex second pass ---
  // openai-codex is a built-in provider not listed in models.providers.
  // Add it if not already covered (i.e., not in providers config and not filtered out).
  const codexAlreadyCovered = filterProvider
    ? filterProvider === 'openai-codex'
    : Object.keys(providers).includes('openai-codex');
  if (!codexAlreadyCovered && (!filterProvider || filterProvider === 'openai-codex')) {
    const codexCfg = resolveOpenAICodexConfig();
    if (codexCfg) {
      const codexModels = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'];
      const filteredCodexModels = filterModel ? codexModels.filter(id => id === filterModel) : codexModels;
      process.stderr.write(`\n[openai-codex] quota-based (minimal requests) — probing ${filteredCodexModels.length} model(s)\n`);
      const codexProvConfig = { baseUrl: codexCfg.baseUrl, apiKey: codexCfg.token };
      for (const modelId of filteredCodexModels) {
        const lib = libraryLookup(modelId);
        const prevLimit = lib?.probed?.limit ?? lib?.contextWindow ?? null;
        if (!args.includes('--force') && lib?.probed?.date) {
          const daysSince = (Date.now() - new Date(lib.probed.date).getTime()) / 86400000;
          if (daysSince < 7) {
            process.stderr.write(`  [${modelId}] skipping \u2014 probed ${daysSince.toFixed(0)}d ago (use --force to re-probe)\n`);
            probeResults.push({ provider: 'openai-codex', model: modelId, limit: lib.probed.limit, method: 'cached', probeCount: 0, note: `cached from ${lib.probed.date}`, prevLimit });
            continue;
          }
        }
        const result = await probeModelLimit('openai-codex', codexProvConfig, modelId, 'quota', slowMode);
        probeResults.push({ provider: 'openai-codex', model: modelId, ...result, prevLimit });
        if (result.limit != null && libFile) {
          const entry = libFile.models.find(e =>
            e.id.toLowerCase() === modelId.toLowerCase() ||
            (e.aliases || []).some(a => a.toLowerCase() === modelId.toLowerCase())
          );
          if (entry) {
            entry.probed = { limit: result.limit, method: result.method, date: new Date().toISOString().slice(0, 10), note: result.note };
            if (!entry.contextWindow) entry.contextWindow = result.limit;
          }
        }
      }
    } else {
      process.stderr.write(`\n[openai-codex] skipping \u2014 no token found (try: openclaw models auth token openai-codex)\n`);
      probeResults.push({
        provider: 'openai-codex',
        model: '(all)',
        limit: null,
        method: 'probe-error',
        probeCount: 0,
        note: 'probe failed: no token found',
        prevLimit: null,
        error: 'no token found'
      });
    }
  }

  return probeResults;
}

// ---------------------------------------------------------------------------
// Run --probe-limits if requested, then print results and exit
// ---------------------------------------------------------------------------
if (doProbeLimit) {
  const probeResults = await runProbeLimits();

  if (outputJson) {
    console.log(JSON.stringify(probeResults, null, 2));
    process.exit(0);
  }

  const useC = process.stdout.isTTY !== false && !args.includes('--no-color');
  const R = '\x1b[0m', B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', Re = '\x1b[31m', Cy = '\x1b[36m';
  const cc = (code, s) => useC ? code + s + R : s;

  function fmtLim(n) {
    if (n == null) return useC ? `${D}—${R}` : '—';
    const s = n >= 1000 ? `${(n/1000).toFixed(0)}K` : String(n);
    if (!useC) return s;
    if (n >= 500000) return `${G}${s}${R}`;
    if (n >= 200000) return `${G}${s}${R}`;
    if (n >= 100000) return `${Y}${s}${R}`;
    return `${Re}${s}${R}`;
  }

  const w0 = Math.max(15, ...probeResults.map(r => (r.provider + '/' + r.model).length));

  console.log('');
  const hasLatency = probeResults.some(r => r.latency);
  const latHdr = hasLatency ? '  P50 LAT  P95 LAT' : '';
  console.log(cc(B+Cy, ` ${'PROVIDER/MODEL'.padEnd(w0)}  PROBED CTX  PREV CTX  DELTA    PROBES  METHOD          ${latHdr} NOTE`));
  console.log(cc(D,     ` ${'─'.repeat(w0)}  ─────────  ────────  ──────   ──────  ──────────────  ────────  ──────── ─────────────────────────`));

  for (const r of probeResults) {
    const label = `${r.provider}/${r.model}`;
    // Error rows: show ERROR in red and the note text
    if (r.method === 'probe-error') {
      const errNote = (r.note || r.error || 'probe failed').slice(0, 60);
      const errLim = cc(Re, 'ERROR    ');
      const latStr = hasLatency ? '  —         —       ' : '';
      console.log(` ${label.padEnd(w0)}  ${errLim}  ${''.padEnd(8)}  ${cc(D, '—').padEnd(8)}  ${'0'.padEnd(6)}  ${'probe-error'.padEnd(15)}${latStr} ${cc(Re, errNote)}`);
      continue;
    }
    const lim = fmtLim(r.limit);
    const prev = r.prevLimit != null ? `${(r.prevLimit/1000).toFixed(0)}K`.padEnd(8) : cc(D, '—       ');
    const delta = (r.limit != null && r.prevLimit != null)
      ? (r.limit > r.prevLimit ? cc(G, `+${((r.limit-r.prevLimit)/1000).toFixed(0)}K`) : r.limit < r.prevLimit ? cc(Re, `-${((r.prevLimit-r.limit)/1000).toFixed(0)}K`) : cc(D, '='))
      : cc(D, '—');
    const probes = String(r.probeCount).padEnd(6);
    const method = (r.method || '—').padEnd(15);
    const latStr = hasLatency
      ? (r.latency ? `  ${String(r.latency.p50+'ms').padEnd(8)}  ${String(r.latency.p95+'ms').padEnd(8)}` : '  —         —       ')
      : '';
    const note = (r.note || '').slice(0, 40);

    console.log(` ${label.padEnd(w0)}  ${(lim+'     ').slice(0,9+10)}  ${prev}  ${delta.padEnd(8)}  ${probes}  ${method}${latStr} ${cc(D, note)}`);
  }

  console.log('');
  const total = probeResults.reduce((s, r) => s + r.probeCount, 0);
  console.log(cc(D, `  Total API requests made: ${total}  |  Library updated: ${join(__dirname, 'model-context-library.json')}`));
  console.log('');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 9. Formatted output helpers (regular mode)
// ---------------------------------------------------------------------------
const RESET = '\x1b[0m', BOLD = '\x1b[1m', DIM = '\x1b[2m',
      CYAN = '\x1b[36m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m',
      RED = '\x1b[31m', BLUE = '\x1b[34m', MAGENTA = '\x1b[35m';

function fmtCtx(n) {
  if (n == null) return `${DIM}unknown${RESET}`;
  if (n >= 1000000) return `${GREEN}${(n/1000).toFixed(0)}K${RESET}`;
  if (n >= 200000)  return `${GREEN}${(n/1000).toFixed(0)}K${RESET}`;
  if (n >= 100000)  return `${YELLOW}${(n/1000).toFixed(0)}K${RESET}`;
  return `${RED}${(n/1000).toFixed(0)}K${RESET}`;
}

function noColor(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

// ---------------------------------------------------------------------------
// 8. Output
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY !== false && !args.includes('--no-color');
const c = (code, s) => useColor ? code + s + RESET : s;

// Build flat row list
const allRows = [];
for (const [prov, data] of Object.entries(results)) {
  if (data?.error) {
    allRows.push({ provider: prov, id: null, error: data.error, ctxRaw: null, ctxStr: null, outStr: null, vision: null, reasoning: null, source: 'error', beta: null });
    continue;
  }
  const models = Array.isArray(data) ? augmentWithKnown(data) : [];
  for (const m of models) {
    const ctxStr = m.contextWindow != null
      ? (m.contextWindow >= 1000 ? `${(m.contextWindow/1000).toFixed(0)}K` : String(m.contextWindow))
      : null;
    const outStr = m.maxOutput != null
      ? (m.maxOutput >= 1000 ? `${(m.maxOutput/1000).toFixed(0)}K` : String(m.maxOutput))
      : null;
    const betaMax = m.betaHeaders ? Math.max(...Object.values(m.betaHeaders)) : null;
    const betaStr = betaMax ? `⚡${(betaMax/1000).toFixed(0)}K` : null;
    allRows.push({ provider: prov, id: m.id, error: null, ctxRaw: m.contextWindow, ctxStr, outStr, vision: m.vision, reasoning: m.reasoning, source: m.source || '?', beta: betaStr });
  }
}

if (outputJson) {
  const out = {};
  for (const [p, d] of Object.entries(results))
    out[p] = Array.isArray(d) ? augmentWithKnown(d) : d;
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

if (outputMd) {
  console.log('# Model Context Window Report');
  console.log(`\n> Generated: ${new Date().toISOString()}  |  Source: live probe + library\n`);
  console.log('| provider/model | ctx | out | vis | rsn | beta | src |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of allRows) {
    if (r.error) { console.log(`| **${r.provider}** ⚠️ | ${r.error} | | | | | |`); continue; }
    const tag = `**${r.provider}**/\`${r.id}\``;
    console.log(`| ${tag} | ${r.ctxStr || '—'} | ${r.outStr || '—'} | ${r.vision == null ? '—' : r.vision ? '✅' : '❌'} | ${r.reasoning == null ? '—' : r.reasoning ? '✅' : '❌'} | ${r.beta || '—'} | ${r.source} |`);
  }
  process.exit(0);
}

// Default: condensed one-line-per-model format
// FORMAT: provider/model  CTX  out  [vis] [rsn] [beta]  (src)

const w0 = Math.max(15, ...allRows.filter(r => r.id).map(r => (r.provider + '/' + r.id).length));

console.log('');
console.log(c(BOLD+CYAN, ` ${'PROVIDER/MODEL'.padEnd(w0)}  CTX    OUT    VIS RSN  BETA      SRC`));
console.log(c(DIM, ` ${'─'.repeat(w0)}  ─────  ─────  ─── ───  ────────  ─────`));

for (const r of allRows) {
  if (r.error) {
    console.log(c(YELLOW, ` ⚠️  ${r.provider}: ${r.error}`));
    continue;
  }

  const label = `${r.provider}/${r.id}`;
  const ctxCol  = r.ctxStr  ? (useColor ? fmtCtx(r.ctxRaw) : r.ctxStr).padEnd(useColor ? 15 : 6) : c(DIM, '—     ');
  const outCol  = (r.outStr  || c(DIM, '—')).padEnd(6);
  const visCol  = r.vision   == null ? c(DIM, ' — ') : r.vision   ? ' ✅ ' : ' ❌ ';
  const rsnCol  = r.reasoning== null ? c(DIM, ' — ') : r.reasoning? ' ✅ ' : ' ❌ ';
  const betaCol = r.beta ? c(GREEN, r.beta.padEnd(9)) : c(DIM, '—        ');
  const srcCol  = c(DIM, r.source);

  console.log(` ${label.padEnd(w0)}  ${ctxCol}  ${outCol} ${visCol}${rsnCol}  ${betaCol}  ${srcCol}`);
}

console.log('');
console.log(c(DIM, '  ctx/out in tokens (K=thousands)  │  vis=vision  rsn=reasoning  beta=extended ctx via header  src=data source'));
console.log('');
