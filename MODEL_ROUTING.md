# Karma AI routing

All Karma AI features use the single provider-neutral `AI` service binding in
`wrangler.toml`. The binding targets `KarmaAiEntrypoint` in the shared
`openrouter-api` Worker, which exposes both text completion and image analysis.

All text, face, and palm analysis uses OpenRouter `google/gemini-3.5-flash-lite`.
Google AI Studio and Google Vertex Global are the only configured providers;
retries stay on Flash Lite without falling back to Gemma or DeepSeek. The
adapter requests JSON and the supported `minimal` thinking level, and omits
temperature for Vertex compatibility.

Model selection is centralized in the shared router's
`wrangler.openrouter.toml`:

```toml
KARMA_TEXT_MODEL_PRESET = "openrouter-gemini-flash-lite"
KARMA_OPENROUTER_PROVIDER_ORDER = "google-ai-studio,google-vertex/global"
KARMA_OPENROUTER_SUMMARY_PROVIDER_ORDER = "google-ai-studio,google-vertex/global"
KARMA_OPENROUTER_ALLOW_FALLBACKS = "false"
KARMA_MEDIA_MODEL = "google/gemini-3.5-flash-lite"
KARMA_MEDIA_PROVIDER = "google-ai-studio,google-vertex/global"
KARMA_VIDEO_PROVIDER = "google-ai-studio,google-vertex/global"
```

## Text context caching

Saju, compatibility, yearly fortune, daily fortune, and tarot requests reuse
large, byte-identical system contracts across users. `karma-api` derives a
short cache key from only that exact system contract plus endpoint, contract
type, and output language. Birth data, questions, and other per-user values
stay in the later user message and never enter the key.

The shared router combines the caller key with its own stable-system hash for
the exact OpenRouter `session_id`. Gemini uses provider-managed implicit prefix
caching; the Venice-only `prompt_cache_key` is not sent. D1 `perf_stats` records
the caller key, actual model, provider route, and available cache token metrics.

Face and palm image analysis intentionally does not use this text cache key:
each request contains unique image data and runs on the separate media route.
Valid photos are saved in private R2 before AI calls, and every analysis outcome
keeps its R2 link in D1.

Flash Lite accepts image input and returns textual face/palm analysis; it is not an
image-generation model.

Deploy `openrouter-api` before `karma-api` whenever the entrypoint contract
changes. A model-only configuration change requires deploying only
`openrouter-api`.
