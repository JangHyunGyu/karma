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
