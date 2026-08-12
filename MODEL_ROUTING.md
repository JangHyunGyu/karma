# Karma AI routing

All Karma AI features use the single provider-neutral `AI` service binding in
`wrangler.toml`. The binding targets `KarmaAiEntrypoint` in the shared
`openrouter-api` Worker, which exposes both text completion and image analysis.

The current production model is OpenRouter `google/gemma-4-31b-it`. Text uses
the Venice BF16 endpoint; face and palm image analysis use CoreWeave BF16
because OpenRouter does not currently allow Venice for Gemma image input.
Provider fallback inside each OpenRouter route is disabled so one cache lineage
cannot drift between endpoints. The named text preset retains its independent
official DeepSeek and OpenRouter DeepSeek route fallbacks for outages.

Model selection is centralized in the shared router's
`wrangler.openrouter.toml`:

```toml
TEXT_MODEL_PRESET = "openrouter-gemma"
OPENROUTER_PROVIDER_ORDER = "venice"
OPENROUTER_ALLOW_FALLBACKS = "false"
KARMA_MEDIA_MODEL = "google/gemma-4-31b-it"
KARMA_MEDIA_PROVIDER = "coreweave"
```

## Text context caching

Saju, compatibility, yearly fortune, daily fortune, and tarot requests reuse
large, byte-identical system contracts across users. `karma-api` derives a
short cache key from only that exact system contract plus endpoint, contract
type, and output language. Birth data, questions, and other per-user values
stay in the later user message and never enter the key.

The shared router combines the caller key with its own stable-system hash and
sends both OpenRouter `session_id` and Venice `prompt_cache_key` on strict
Venice Gemma requests. A changed system contract or retry contract gets a new
lineage, while a changed user message keeps the reusable prefix warm. D1
`perf_stats` records the key, actual provider route, cache hits, cached tokens,
and cache-write tokens.

Face and palm image analysis intentionally does not use this text cache key:
each request contains unique image data and runs on the separate CoreWeave
media route, so forcing session affinity would not provide a reusable text
prefix or a meaningful cost benefit.

Gemma accepts image input and returns textual face/palm analysis; it is not an
image-generation model.

Deploy `openrouter-api` before `karma-api` whenever the entrypoint contract
changes. A model-only configuration change requires deploying only
`openrouter-api`.
