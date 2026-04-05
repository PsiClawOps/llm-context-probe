# llm-context-probe

Active context window probing for LLM providers. Binary-searches real API endpoints to find the **actual enforced** context limit per model — because what providers *advertise* and what they *enforce* are often different numbers.

---

## Findings

### github-copilot

| Model | Enforced | Vendor native | Copilot cap | Method | P50 | Probed |
|---|---|---|---|---|---|---|
| `claude-haiku-4.5` | 128K | 200K | 64% | error-message | 8,084ms | 2026-04-04 |
| `claude-sonnet-4.6` | 128K | 200K | 64% | error-message | 9,987ms | 2026-04-04 |
| `claude-opus-4.6` | 128K | 200K | 64% | error-message | 8,552ms | 2026-04-04 |
| `gpt-5.4` | 272K | 400K | 68% | error-message | 10,361ms | 2026-04-04 |
| `gpt-5.3-codex` | 272K | 400K | 68% | error-message | 26,897ms | 2026-04-04 |
| `gpt-5.4-mini` | 272K | 400K | 68% | error-message | 14,063ms | 2026-04-04 |
| `gemini-3.1-pro-preview` | 128K | 400K | 32% | error-message | 6,692ms | 2026-04-04 |
| `gemini-3-flash-preview` | 128K | 1,000K | 13% | error-message | 8,991ms | 2026-04-04 |
| `gpt-5-mini` | 128K | 400K | 32% | error-message | 10,902ms | 2026-04-04 |
| `gpt-4o` | 64K | 128K | 50% | error-message | — | 2026-04-03 |

*Enforced = actual prompt limit at the endpoint, not the vendor-documented native window. P50 = raw API round-trip latency on accepted near-limit requests for that run.*

**Pattern:** GitHub Copilot is not exposing native windows. As of this run, it appears to bucket models into a few enforced prompt tiers: **64K** (`gpt-4o`), **128K** (Claude 4.5/4.6, Gemini 3.1 Pro Preview, Gemini 3 Flash Preview, `gpt-5-mini`), and **272K** (`gpt-5.4`, `gpt-5.3-codex`, `gpt-5.4-mini`). The biggest compression in this sweep is `gemini-3-flash-preview`: **128K enforced on a 1M-native model**.

**Notable change:** `gpt-5.4` was previously estimated at ~194K via binary search on 2026-04-03. A fresh probe on 2026-04-04 returned an explicit `limit of 272000` error, so the earlier number was stale or undercounted.

**Methodology:** Request-based probing through the live GitHub Copilot endpoint. Most current GitHub Copilot models now return the exact enforced limit in their 400 error messages (`prompt token count of X exceeds the limit of Y`), so these results are mostly exact rather than inferred.

**Rate limiting:** No 429s encountered during this sweep. Several models were slow enough that the probe timeout had to be extended from 30s to 90s to distinguish transport timeout from true context rejection.

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

 PROVIDER/MODEL                   PROBED CTX  PREV CTX  DELTA    PROBES  METHOD           P50 LAT  P95 LAT
 ─────────────────────────────── ─────────  ────────  ──────   ──────  ──────────────  ────────  ────────
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
  "model": "claude-sonnet-4-6",
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
