# llm-context-probe

Active context window probing for LLM providers. Binary-searches real API endpoints to find the **actual enforced** context limit per model — because what providers *advertise* and what they *enforce* are often different numbers.

---

## Probed Limits

| Provider / Model | Enforced | Method | P50 | Probed | Reasoning | Input | Tools | Notes |
|---|---|---|---|---|---|---|---|---|
| `github-copilot/gpt-5.4` | 272K | error-message | 10,361ms | 2026-04-04 | ✅ `low` `medium` `high` | 🖼️ | ✅ | was ~194K on 04-03; re-probe returned exact 272K |
| `github-copilot/gpt-5.3-codex` | 272K | error-message | 26,897ms | 2026-04-04 | ✅ `low` `medium` `high` | 🖼️ | ❌ | codex-optimized; no tool use |
| `github-copilot/gpt-5.4-mini` | 272K | error-message | 14,063ms | 2026-04-04 | ✅ `low` `medium` `high` | 🖼️ | ✅ | timeout extended to 90s to finish probe |
| `github-copilot/claude-haiku-4.5` | 128K | error-message | 8,084ms | 2026-04-04 | ❌ | — | ✅ | native 200K; Copilot caps at 64% |
| `github-copilot/claude-sonnet-4.6` | 128K | error-message | 9,987ms | 2026-04-04 | ❌ | 🖼️ | ✅ | native 200K (1M w/ beta header) |
| `github-copilot/claude-opus-4.6` | 128K | error-message | 8,552ms | 2026-04-04 | ❌ | 🖼️ | ✅ | native 200K (1M w/ beta header) |
| `github-copilot/gemini-3.1-pro-preview` | 128K | error-message | 6,692ms | 2026-04-04 | ❌ | 🖼️ 🎥 | ✅ | native 400K; biggest relative cap |
| `github-copilot/gemini-3-flash-preview` | 128K | error-message | 8,991ms | 2026-04-04 | ❌ | 🖼️ 🎥 | ✅ | native 1M; 13% of native exposed |
| `github-copilot/gpt-5-mini` | 128K | error-message | 10,902ms | 2026-04-04 | ✅ `low` `medium` `high` | 🖼️ | ✅ | |
| `github-copilot/gpt-4o` | 64K | error-message | — | 2026-04-03 | ❌ | 🖼️ | ✅ | legacy; 50% of native 128K |
| | | | | | | | | |
| `openai-codex/gpt-5.4` | **272K** | source-code | — | 2026-04-04 | ✅ | 🖼️ | ✅ | direct API 1.05M; sub caps at 26% |
| `openai-codex/gpt-5.3-codex` | **272K** | source-code | — | 2026-04-04 | ✅ | 🖼️ | ❌ | direct API 400K; sub caps at 68% |
| `openai-codex/gpt-5.3-codex-spark` | **128K** | source-code | — | 2026-04-04 | ✅ | text | ❌ | matches direct API (both 128K) |
| `openai-codex/(default)` | **200K** | source-code | — | 2026-04-04 | — | — | — | fallback for unrecognized models |

**Column key:**
- **Enforced** — actual prompt-token limit at the live endpoint, not vendor-documented
- **Method** — `error-message` (exact limit from 400 body) · `binary-search` (converged estimate) · `source-code` (extracted from provider runtime) · `read-only` (from `/v1/models`)
- **P50** — median API round-trip latency on accepted near-limit requests
- **Reasoning** — whether the model supports reasoning/thinking; modes listed if known
- **Input** — 🖼️ image · 🎧 audio · 🎥 video (blank = text only)
- **Tools** — function calling / tool use support

### openai-codex (vendor-documented)

OpenAI Codex routes through `chatgpt.com/backend-api` (not `api.openai.com/v1`). The endpoint is behind CloudFlare JS challenge — can't probe from server-side. These are the vendor-published limits from [developers.openai.com](https://developers.openai.com/api/docs/models):

| Model | Context | Max output | Reasoning | Source |
|---|---|---|---|---|
| `gpt-5.4` | **1,050K** | 128K | ✅ `none` `low` `medium` `high` `xhigh` | [model card](https://developers.openai.com/api/docs/models/gpt-5.4) |
| `gpt-5.4-mini` | 400K | 128K | ✅ `none` `low` `medium` `high` `xhigh` | [model card](https://developers.openai.com/api/docs/models/gpt-5.4-mini) |
| `gpt-5.3-codex` | 400K | 128K | ✅ `low` `medium` `high` `xhigh` | [model card](https://developers.openai.com/api/docs/models/gpt-5.3-codex) |

> ⚠️ **gpt-5.4 jumped to 1.05M context** — confirmed on the official model card (snapshot 2026-03-05). Prompts >272K input tokens are priced at 2x input / 1.5x output for the full session.

---

## Observations

GitHub Copilot and the OpenAI Codex subscription API both bucket models into enforced prompt tiers rather than exposing native windows:

| Tier | Enforced | Provider(s) | Models |
|---|---|---|---|
| 272K | 272,000 | github-copilot, openai-codex | `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.4-mini` |
| 200K | 200,000 | openai-codex | (default/fallback for unrecognized models) |
| 128K | 128,000 | github-copilot, openai-codex | Claude 4.5/4.6, Gemini 3.x, `gpt-5-mini`, `gpt-5.3-codex-spark` |
| 64K | 64,000 | github-copilot | `gpt-4o` |

The 272K cap appears to be an upstream OpenAI limit for subscription-tier access — both github-copilot and openai-codex enforce exactly the same number.

The biggest compression is `gemini-3-flash-preview`: **128K enforced on a 1M-native model** (13%).

All current results come from the `error-message` method — GitHub Copilot now returns the exact enforced ceiling in 400 error bodies (`prompt token count of X exceeds the limit of Y`).

No 429s were encountered during this sweep. Several models required extending the probe timeout from 30s to 90s to distinguish transport timeouts from true context rejection.

---

## What this means

Tools that read `contextWindow` from config or `/v1/models` get the vendor-documented native limit — not what the endpoint actually enforces. The only way to know the real limit is to probe it directly.

That's what this script does.

---

## How it works

Three probe strategies, selected automatically per provider:

| Strategy | Providers | How |
|---|---|---|
| `request-based` | Flat-rate subscription providers (github-copilot) | Real content fill, full binary search, ~10–15 req/model. Zero marginal cost on flat-rate plans. |
| `quota-based` | Anthropic direct, OpenAI Codex | Tiny prompt + huge `max_tokens` claim. Provider returns exact limit in 400 error — 1 request if it works, binary search fallback. |
| `read-only` | OpenRouter | Reads `context_length` from `/v1/models` directly — no probing needed. |

### The `max_tokens` trick

For quota-sensitive providers, send a tiny prompt with an absurdly large `max_tokens`:

```
POST /v1/chat/completions
{ "messages": [{"role":"user","content":"hi"}],
  "max_tokens": 999995 }

→ 400: "This model's maximum context length is 200000 tokens"
```

One request, exact answer, no output tokens generated. Works on Anthropic and OpenAI; Copilot accepts the claim silently and enforces at send time instead.

---

## Usage

### Requirements

- Node.js 18+
- [OpenClaw](https://github.com/openclaw/openclaw) configured with providers (the script reads provider config and resolves auth tokens via the OpenClaw gateway)
- OpenClaw gateway running (`openclaw gateway start`)

### Quickstart

```bash
git clone https://github.com/PsiClawOps/llm-context-probe
cd llm-context-probe

# Probe a single model (fast)
node probe.mjs --probe-limits --provider github-copilot --model claude-sonnet-4-6

# Probe all models for a provider (slow mode — ~4s/request, reduces rate-limit risk)
node probe.mjs --probe-limits --provider github-copilot --veryslow

# Force re-probe even if cached within 7 days
node probe.mjs --probe-limits --provider github-copilot --force

# Increase per-request timeout for slow models
PROBE_TIMEOUT_MS=90000 node probe.mjs --probe-limits --provider github-copilot --model gemini-3.1-pro-preview

# Show static library data without probing
node probe.mjs --library

# JSON output
node probe.mjs --probe-limits --provider github-copilot --json
```

### All flags

| Flag | Description |
|---|---|
| `--probe-limits` | Actively probe context limits |
| `--provider <name>` | Filter to one provider |
| `--model <id>` | Filter to one model within a provider |
| `--force` | Re-probe even if cached within 7 days |
| `--veryslow` | ~4s between requests — safer for rate limits, ~60s/model |
| `--json` | Machine-readable JSON output |
| `--md` | Markdown table output |
| `--no-color` | Plain text, no ANSI codes |
| `--library` | Print static library table (no live probing) |
| `--billing <mode>` | Override billing mode: `request`, `quota`, or `read-only` |
| `--no-log` | Disable JSONL probe log (default: logs to `probe-logs/`) |

### Environment variables

| Variable | Description |
|---|---|
| `PROBE_TIMEOUT_MS` | Override the default 30s per-request timeout when probing slow models. Example: `90000` for 90s. |

### Output

```
[github-copilot] billing=request-based (burn freely) — probing 4 model(s)
  Probe log: /path/to/probe-logs/2026-04-03T20-19-46.jsonl

  [claude-sonnet-4-6] ranging (slow mode ~4s/probe)... ✓1K ✓8K ✓32K ✓50K ✓128K exact=128,000 (from error msg)
  [gpt-5.4] ranging... ✓1K ✓8K ✓32K ✓50K ✓128K ✓200K binary[193K–194K] → ~194K

 PROVIDER/MODEL                    PROBED CTX  PREV CTX  DELTA    PROBES  METHOD           P50 LAT  P95 LAT
 ──────────────────────────────── ─────────  ────────  ──────   ──────  ──────────────  ────────  ────────
 github-copilot/claude-sonnet-4-6  128K        200K      -72K     6       error-message   11411ms   26449ms
 github-copilot/gpt-5.4            194K        400K      -206K    15      binary-search   9842ms    24091ms
```

Enforced limits color-coded: 🟢 ≥200K / 🟡 100–199K / 🔴 <100K. Negative delta = proxy caps below native.

### Probe logs

Every request is logged to `probe-logs/YYYY-MM-DDTHH-mm-ss.jsonl`:

```json
{"ts":"2026-04-03T20:19:52Z","provider":"github-copilot","model":"claude-sonnet-4-6","inputTokens":128000,"strategy":"request","status":200,"latencyMs":10216,"result":"accepted"}
{"ts":"2026-04-03T20:20:18Z","provider":"github-copilot","model":"claude-sonnet-4-6","inputTokens":200000,"status":400,"latencyMs":26449,"result":"rejected","errorSnippet":"maximum context length is 128000 tokens"}
```

Useful for analyzing per-provider rate limits and latency patterns.

---

## Results format

Each file in `results/` is a JSON array:

```jsonc
{
  "provider": "github-copilot",
  "model": "claude-sonnet-4.6",
  "probedLimit": 128000,     // actual enforced limit found by probing
  "vendorLimit": 200000,     // vendor-documented native limit
  "delta": -72000,           // gap (negative = proxy caps below native)
  "pct": 64,                 // enforced as % of native
  "method": "error-message", // how: error-message | binary-search | lower-bound
  "probeCount": 6,           // API requests consumed
  "probedAt": "2026-04-03",
  "note": "..."
}
```

---

## Library

`library.json` covers 57 models across OpenAI, Anthropic, Google, DeepSeek, Mistral, and local families. The probe script reads this for baseline data and writes `probed` entries back when it discovers new limits. Sources: vendor docs, [taylorwilsdon/llm-context-limits](https://github.com/taylorwilsdon/llm-context-limits), and live probing.

---

## Contributing

PRs welcome for:
- **Probe results** — run the script, add output to `results/<your-provider>.json`
- **Library entries** — new model metadata in `library.json`
- **Error message patterns** — different providers format 400 errors differently; improvements to `parseErrorLimit()` help everyone
- **Provider adapters** — Anthropic Messages API, Google Gemini native, non-OpenAI-compat endpoints

---

## Why this exists

Provider documentation lies — not maliciously, but because:

1. **Proxy services** cap below the underlying model's native limit — and don't tell you
2. **`/v1/models` doesn't help** — most endpoints return the vendor native value, not the proxy's enforced limit
3. **Beta headers** can unlock larger windows but are underdocumented and often unavailable through proxies

The only way to know the real enforced limit is to ask the endpoint directly with real-sized requests.

---

## License

Apache-2.0
