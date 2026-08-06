# Karma AI routing

All Karma AI features use the single provider-neutral `AI` service binding in
`wrangler.toml`. The binding targets `KarmaAiEntrypoint` in the shared
`openrouter-api` Worker, which exposes both text completion and image analysis.

The current production model is OpenRouter `openai/gpt-5.6-luna` for Saju,
yearly and daily fortune, compatibility and match detail, tarot, face reading,
and palm reading.

Model selection is centralized in the shared router's
`wrangler.openrouter.toml`:

```toml
KARMA_TEXT_MODEL_ROUTES = "openrouter:openai/gpt-5.6-luna"
KARMA_MEDIA_MODEL = "openai/gpt-5.6-luna"
KARMA_MEDIA_PROVIDER = "openai"
```

To restore the previous DeepSeek/MiMo split, only change those three values:

```toml
KARMA_TEXT_MODEL_ROUTES = "openrouter:deepseek/deepseek-v4-flash-0731,openrouter:qwen/qwen3.7-flash"
KARMA_MEDIA_MODEL = "xiaomi/mimo-v2.5"
KARMA_MEDIA_PROVIDER = "xiaomi"
```

Deploy `openrouter-api` before `karma-api` whenever the entrypoint contract
changes. A model-only configuration change requires deploying only
`openrouter-api`.
