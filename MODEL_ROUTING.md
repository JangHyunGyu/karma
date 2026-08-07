# Karma AI routing

All Karma AI features use the single provider-neutral `AI` service binding in
`wrangler.toml`. The binding targets `KarmaAiEntrypoint` in the shared
`openrouter-api` Worker, which exposes both text completion and image analysis.

The current production model is OpenRouter `google/gemma-4-31b-it`. Text uses
the Venice BF16 endpoint; face and palm image analysis use CoreWeave BF16
because OpenRouter does not currently allow Venice for Gemma image input.
Model and provider fallbacks are disabled in the shared router.

Model selection is centralized in the shared router's
`wrangler.openrouter.toml`:

```toml
KARMA_TEXT_MODEL_ROUTES = "openrouter:google/gemma-4-31b-it"
KARMA_MEDIA_MODEL = "google/gemma-4-31b-it"
KARMA_MEDIA_PROVIDER = "coreweave"
```

Gemma accepts image input and returns textual face/palm analysis; it is not an
image-generation model.

Deploy `openrouter-api` before `karma-api` whenever the entrypoint contract
changes. A model-only configuration change requires deploying only
`openrouter-api`.
