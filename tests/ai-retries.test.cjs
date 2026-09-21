'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function loadWorker() {
  const source = fs.readFileSync(path.join(__dirname, '../assets/js/worker.js'), 'utf8');
  const delays = [];
  const context = {
    console: { log() {}, warn() {}, error() {} },
    crypto: webcrypto, TextEncoder, Uint8Array, Response, Request, Headers, URL, atob, btoa,
    setTimeout(resolve, delay) { delays.push(delay); resolve(); }, clearTimeout() {},
    fetch: async () => new Response('{}'),
  };
  vm.runInNewContext(source.replace('export default {', 'globalThis.worker = {') + `
globalThis.api = { callKarmaTextAi, callKarmaVisionAi };
`, context);
  return { ...context, delays };
}

const text = 'A reading based on the supplied information.';
const reading = {
  pillar_reading: { year: text, month: text, day: text, hour: text },
  personality: text, love_style: text, career: text, advice: text,
  strengths: Array(3).fill(text), cautions: Array(3).fill(text), daeun_reading: Array(8).fill(text),
};
const prompt = { system: 'Return the full reading schema.', user: 'Chart facts.', lang: 'en' };
const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');

function photo(type) {
  const common = {
    quality_assessment: text, visual_evidence: Array(8).fill(text), summary: text, advice: text,
    fortune: { wealth: text, career: text, love: text, health: text },
  };
  return type === 'face' ? {
    ...require('./fixtures/face-appearance.cjs')('en'),
    ...common, celebrity_resemblance: '',
    forehead_observation: { skin_visible: true, hairline_visible: true, observation: text, limitation: '' },
    categories: Array.from({ length: 6 }, () => ({ name: text, score: 76, desc: text })),
  } : {
    ...common, overall_score: 76, overall_grade: 'C',
    lines: Array.from({ length: 6 }, () => ({ name: text, score: 76, length: text, desc: text })),
    hand_shape: { type: text, desc: text },
  };
}

test('text analysis recovers on the second or third attempt after transient provider failures', async () => {
  for (const errorMessage of ['HTTP 429 provider busy', 'HTTP 503 unavailable', 'Network connection lost', 'Request timed out']) {
    for (const failures of [1, 2]) {
      const { api, delays } = loadWorker();
      const requests = [];
      const result = await api.callKarmaTextAi(prompt, 'saju', {
        AI: { async complete(input) {
          requests.push(input);
          if (requests.length <= failures) throw new Error(errorMessage);
          return { text: JSON.stringify(reading) };
        } },
      }, null, 'saju', { hasTime: true, daeunCount: 8 });
      assert.equal(result.advice, text);
      assert.equal(requests.length, failures + 1);
      assert.deepEqual(delays, [1000, 2000].slice(0, failures));
      for (const request of requests) {
        assert.equal(request.appId, 'karma');
        assert.equal(JSON.stringify(request.messages), JSON.stringify(requests[0].messages), 'transport failures must not invent a malformed-response repair');
        assert.equal(request.cacheKey, requests[0].cacheKey);
      }
    }
  }
});

test('response repairs and transport failures share three attempts and preserve partial readings', async () => {
  const { api, delays } = loadWorker();
  const { advice, ...partial } = reading;
  const requests = [];
  const result = await api.callKarmaTextAi(prompt, 'saju', {
    AI: { async complete(input) {
      requests.push(input);
      if (requests.length === 2) throw new Error('HTTP 502 gateway error');
      return { text: JSON.stringify(requests.length === 1 ? partial : { advice }) };
    } },
  }, null, 'saju', { hasTime: true, daeunCount: 8 });
  assert.equal(requests.length, 3);
  assert.equal(result.personality, text);
  assert.equal(result.advice, advice);
  assert.equal(JSON.stringify(requests[1].messages), JSON.stringify(requests[2].messages));
  assert.deepEqual(delays, [1000, 2000]);

  const exhausted = loadWorker();
  let calls = 0;
  await assert.rejects(exhausted.api.callKarmaTextAi(prompt, 'saju', {
    AI: { async complete() {
      calls++;
      if (calls !== 2) throw new Error('HTTP 503 unavailable');
      return { text: '{broken' };
    } },
  }, null, 'saju'), error => error.code === 'AI_UNAVAILABLE');
  assert.equal(calls, 3);
  assert.deepEqual(exhausted.delays, [1000, 2000]);
});

test('permanent upstream HTTP errors stop immediately while mixed transient routes can recover', async () => {
  for (const status of [400, 401, 403, 404, 413, 415, 422]) {
    const { api, delays } = loadWorker();
    let calls = 0;
    const fail = async () => { calls++; throw new Error(`Upstream HTTP ${status}`); };
    await assert.rejects(api.callKarmaTextAi(prompt, 'saju', { AI: { complete: fail } }, null, 'saju'));
    assert.ok((await api.callKarmaVisionAi('Read this image.', `data:image/jpeg;base64,${image}`, { AI: { analyze: fail } }, 'en', 'palm'))._apiError);
    assert.equal(calls, 2, 'one call per analysis, without retries');
    assert.deepEqual(delays, []);
  }
  const { api, delays } = loadWorker();
  let calls = 0;
  const result = await api.callKarmaTextAi(prompt, 'saju', {
    AI: { async complete() {
      if (++calls === 1) throw new Error('Text model routes exhausted: HTTP 401 | HTTP 503');
      return { text: JSON.stringify(reading) };
    } },
  }, null, 'saju');
  assert.equal(result.advice, text);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1000]);
});

function database(writes, rateCount = 1) {
  return {
    batches: 0,
    async batch() { this.batches++; },
    prepare(sql) {
      return { async run() {}, bind(...values) {
        return { async first() { return { count: rateCount }; }, async run() { writes.push({ sql, values }); } };
      } };
    },
  };
}

test('face and palm retries store one image, consume one local quota, and persist the final result', async () => {
  for (const type of ['face', 'palm']) {
    for (const outcome of ['success', 'exhausted', 'rejected', 'quota']) {
      const { worker, delays } = loadWorker();
      const requests = [], events = [], writes = [], pending = [];
      const db = database(writes, outcome === 'quota' ? 6 : 1);
      const response = await worker.fetch(new Request(`https://example.com/api/${type}-reading`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
        body: JSON.stringify({ image, mimeType: 'image/jpeg', lang: 'en' }),
      }), {
        DB: db,
        KARMA_IMAGE_BUCKET: { async put() { events.push('stored'); } },
        AI: { async analyze(input) {
          events.push('analyzed'); requests.push(input);
          if (outcome === 'rejected') return { text: JSON.stringify({ error: 'No suitable subject is visible.' }) };
          if (outcome === 'exhausted' || requests.length < 3) throw new Error('HTTP 503 provider unavailable');
          return { text: JSON.stringify(photo(type)) };
        } },
      }, { waitUntil(promise) { pending.push(promise); } });
      await Promise.all(pending);
      const result = await response.json();
      const expectedCalls = outcome === 'quota' ? 0 : outcome === 'rejected' ? 1 : 3;
      assert.equal(requests.length, expectedCalls);
      assert.deepEqual(delays, expectedCalls === 3 ? [1000, 2000] : []);
      assert.equal(events[0], 'stored');
      assert.equal(events.filter(event => event === 'stored').length, 1);
      assert.equal(db.batches, 1);
      assert.equal(response.status, { success: 200, exhausted: 500, rejected: 400, quota: 429 }[outcome]);
      if (outcome === 'success') assert.equal(result.overall_grade, 'A');
      for (const request of requests) {
        assert.equal(request.appId, 'karma');
        assert.equal(request.media[0].url, `data:image/jpeg;base64,${image}`);
        assert.equal(request.prompt, requests[0].prompt);
      }
      const logs = writes.filter(write => write.sql.includes('INSERT INTO karma_analyses'));
      assert.ok(logs.length);
      assert.equal(new Set(logs.map(write => write.values[0])).size, 1, 'all writes upsert the same request');
      const final = logs.at(-1).values;
      assert.equal(final[3], response.status);
      assert.match(final[8], new RegExp(`^karma/${type}/`));
      assert.deepEqual(JSON.parse(final[5]), result);
    }
  }
});
