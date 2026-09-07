# AI failure retries — 2026-09-07

- Text and photo analysis now allow three calls to the shared AI service:
  the initial attempt and up to two retries, delayed by one and two seconds.
- Network failures, timeouts, provider HTTP 429, and server errors are retryable.
  Permanent upstream request/authentication errors stop immediately. Local input
  validation, photo rejection, and the application's usage limit do not retry.
- Connection failures and incomplete/invalid AI responses share the same budget.
  Partial valid fields survive an intervening connection failure. A connection
  failure alone does not add a misleading response-format repair instruction.
- Photo retries reuse the same image, consume one local quota entry, and persist
  the final outcome under the original request and private R2 key.
- `npm test`: all validators and 27 regression tests passed. Fault injection
  verified recovery on attempts two and three, exhaustion, mixed failures,
  permanent errors, and both face/palm persistence paths.
- `wrangler deploy --dry-run`: passed. Runtime version constants and model
  selection are unchanged.

# D1 audit and palm grade regression — 2026-09-07

- Queried `karma_analyses`, `error_logs`, `client_errors`, and `perf_stats`
  for the preceding three days. After 2026-09-05 21:00 KST, 23 analyses
  succeeded and one palm photo was rejected; no server failures were recorded.
- The earlier saju HTTP 502 at 2026-09-05 09:05 KST predates the previous fix.
  No recurrence appeared in the later analysis records.
- Palm records `17517`, `17633`, and `17635` contained score 76 with grade C,
  although the existing server and browser thresholds assign grade A to 76.
  The palm path accepted a model-generated grade without checking its score.
- Palm grades are now derived from the existing score thresholds before
  validation, D1 persistence, and the API response. Both palm pages also derive
  the grade when displaying older shared results. Scores and readings are preserved.
- All 23 recent successful responses were checked against the current response
  contracts. Only those three grades failed; applying the correction locally
  left no contract failures. Historical D1 records were not rewritten.
- Every photo outcome in the queried window retained its private R2 link.
- `npm test`: all validators and 23 regression tests passed, including grade
  boundaries, malformed scores, rejected photos, both UI languages, and image/D1
  persistence ordering. The new regressions reproduced the error before the fix.
- `wrangler deploy --dry-run`: passed with the existing service and storage bindings.

# Flash Lite verification — 2026-09-05

Verified release: `5c12b64`, with shared AI router `7508855f`.

- `npm test`: all validators and 19 regression tests passed.
- Production browser `/saju`: submitted the form, received HTTP 200, rendered
  four pillars and eight major-fortune readings, and restored the submit button.
  No browser runtime errors occurred.
- D1 recorded the new saju request with model `google/gemini-3.5-flash-lite`.
- Production face and palm endpoints each received a synthetic color-pattern
  JPEG. Both correctly returned HTTP 400 with the localized photo guidance.
  Both rejected requests retained their private image link in D1.
- Shared router regression tests: 9 passed, including model selection,
  same-model retries, image transport, and text cache separation.

These checks cover application behavior and the rejection of unsuitable images.
They do not measure the accuracy of face or palm interpretations on real photos.
