# llm-context-probe

Active context window probing for LLM providers. Binary-searches real API endpoints to find the **actual enforced** context limit per model — because what providers *advertise* and what they *enforce* are often different numbers.

---

## Findings

### github-copilot

| Model | Enforced Limit | Max Output | Vision | Audio | Video | Tools | Reasoning | Method | Requests | P50 Latency | P95 Latency | Last Probed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `gpt-5.4` | 194K | 128K | ✅ | ❌ | ❌ | ✅ | ✅ | binary-search | 15 | 9,842ms | 24,091ms | 2026-04-03 |
| `gpt-4o` | 64K | 16K | ✅ | ❌ | ❌ | ❌ | ❌ | error-message | 5 | — | — | 2026-04-03 |
| `claude-opus-4-6` | ~126K | 64K | ✅ | ❌ | ❌ | ✅ | ❌ | binary-search | 12 | — | — | 2026-04-03 |
| `claude-sonnet-4-6` | 128K | 64K | ✅ | ❌ | ❌ | ✅ | ❌ | error-message | 6 | 11,411ms | 26,449ms | 2026-04-03 |

*Enforced Limit = actual limit probed at the endpoint — not the vendor-documented native value. Latency = raw API round-trip at near-limit context sizes; inter-probe delays excluded. `—` = not recorded for this run. Max Output / modality columns sourced from vendor docs.*

**Pattern:** The GitHub Copilot proxy consistently enforces ~50–64% of the model's native context window. GPT-4o and claude-sonnet return the exact limit in their 400 error messages; gpt-5.4 and claude-opus required full binary search (the error message didn't include a number).

**Methodology:** Request-based binary search — real content-fill requests at increasing token counts until rejection. Flat-rate subscription billing means zero marginal cost per request.

**Rate limiting:** No 429s encountered during this probe run (~38 requests across 4 models). No ceiling established.

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
