'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function loadWorker() {
  const source = fs.readFileSync(path.join(__dirname, '../assets/js/worker.js'), 'utf8');
  const context = {
    console: { log() {}, warn() {}, error() {} },
    crypto: webcrypto, TextEncoder, Uint8Array, Response, Request, Headers, URL,
    atob, btoa, setTimeout, clearTimeout,
    fetch: async () => new Response('{}'),
  };
  vm.runInNewContext(source.replace('export default {', 'globalThis.worker = {') + `
globalThis.api = { callKarmaTextAi, handleSajuAnalysis };
`, context);
  return context;
}

const text = 'Explanation grounded in the supplied chart.';
const reading = {
  pillar_reading: { year: text, month: text, day: text, hour: text },
  personality: text, strengths: Array(3).fill(text), cautions: Array(3).fill(text),
  love_style: text, career: text, daeun_reading: Array(8).fill(text), advice: text,
};
const prompt = { system: 'Complete the original chart reading schema.', user: 'Chart facts.', lang: 'en' };

test('malformed AI JSON is retried with the original schema and successful attempts remain usable', async () => {
  for (const malformed of ['{"pillar_reading":', '', 'not JSON']) {
    const { api } = loadWorker();
    const requests = [];
    const result = await api.callKarmaTextAi(prompt, 'saju', { AI: { async complete(input) {
      requests.push(input);
      return { text: requests.length === 1 ? malformed : JSON.stringify(reading) };
    } } }, null, 'saju', { hasTime: true, daeunCount: 8 });
    assert.equal(requests.length, 2);
    assert.equal(result.advice, text);
    assert.ok(requests[1].messages[0].content.includes(prompt.system));
  }
});

test('a malformed patch does not discard earlier valid fields', async () => {
  const { api } = loadWorker();
  let calls = 0;
  const { advice, ...partial } = reading;
  const outputs = [JSON.stringify(partial), '{broken', JSON.stringify({ advice })];
  const result = await api.callKarmaTextAi(prompt, 'saju', { AI: { async complete() {
    return { text: outputs[calls++] };
  } } }, null, 'saju', { hasTime: true, daeunCount: 8 });
  assert.equal(calls, 3);
  assert.equal(result.advice, text);
  assert.equal(result.personality, text);
});

test('persistent malformed AI JSON stops after the bounded retry budget', async () => {
  const { api } = loadWorker();
  let calls = 0;
  const result = await api.callKarmaTextAi(prompt, 'saju', { AI: { async complete() {
    calls++;
    return { text: '{broken' };
  } } }, null, 'saju', { hasTime: true, daeunCount: 8 });
  assert.equal(calls, 3);
  assert.equal(result, null);
});

function database(writes) {
  return { prepare(sql) {
    return { async run() {}, bind(...values) {
      return {
        async first() { return null; },
        async run() { writes.push({ sql, values }); },
      };
    } };
  } };
}

test('provider rate limits are reported and logged as service unavailability, not missing analysis fields', async () => {
  for (const lang of ['ko', 'en']) {
    const { worker } = loadWorker();
    const writes = [];
    const pending = [];
    let calls = 0;
    const response = await worker.fetch(new Request('https://example.com/api/saju', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ birth_date: '1990-01-01', birth_time: '12:00', gender: 'male', lang }),
    }), {
      DB: database(writes),
      AI: { async complete() {
        calls++;
        throw new Error('Text model routes exhausted: primary: HTTP 429 Provider returned error | fallback: HTTP 429 Provider returned error');
      } },
    }, { waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.code, 'AI_RATE_LIMITED');
    assert.equal(response.headers.get('Retry-After'), '30');
    assert.equal(calls, 1, 'the shared router has already exhausted provider routes');
    assert.doesNotMatch(body.error, /incomplete|항목이 완전|Provider|primary|fallback/);
    assert.match(body.error, lang === 'ko' ? /혼잡/ : /busy/i);
    const saved = writes.find(write => write.sql.includes('INSERT INTO karma_analyses'));
    assert.equal(saved.values[3], 503);
    assert.equal(JSON.parse(saved.values[5]).code, 'AI_RATE_LIMITED');
    assert.ok(writes.some(write => write.sql.includes('INSERT INTO error_logs') && write.values[1].includes('HTTP 429')));
  }
});

test('a non-rate-limit provider outage is distinguished from malformed AI output', async () => {
  const { worker } = loadWorker();
  const response = await worker.fetch(new Request('https://example.com/api/saju', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ birth_date: '1990-01-01', gender: 'male', lang: 'en' }),
  }), { AI: { async complete() { throw new Error('HTTP 503 provider unavailable'); } } }, {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'AI_UNAVAILABLE');
});

test('malformed request JSON and non-object request bodies are client errors and never call AI', async () => {
  const { worker } = loadWorker();
  let calls = 0;
  for (const body of ['{broken', 'null', '[]', '123']) {
    const response = await worker.fetch(new Request('https://example.com/api/saju', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en' }, body,
    }), { AI: { async complete() { calls++; } } }, {});
    assert.equal(response.status, 400, body);
    assert.doesNotMatch((await response.json()).error, /position|Unexpected|Cannot destructure/);
  }
  assert.equal(calls, 0);
});

test('both saju pages show the returned service error and restore the analyze button', async () => {
  for (const file of ['saju.html', 'saju-en.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const start = html.indexOf('async function doAnalyze()');
    const end = html.indexOf('\nfunction ', start);
    const elements = new Map();
    const alerts = [];
    const context = {
      API_BASE: 'https://example.com', getBirthDate: () => '1990-01-01',
      _L: (ko, en) => en, alert: value => alerts.push(value),
      document: { getElementById(id) {
        if (!elements.has(id)) elements.set(id, { style: {}, value: '', checked: false });
        return elements.get(id);
      } },
      fetch: async () => new Response(JSON.stringify({ error: 'The analysis service is busy. Please try again shortly.' }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      }),
    };
    vm.runInNewContext(html.slice(start, end), context);
    await context.doAnalyze();
    assert.deepEqual(alerts, ['The analysis service is busy. Please try again shortly.']);
    assert.equal(elements.get('analyzeBtn').disabled, false);
    assert.equal(elements.get('loading').style.display, 'none');
  }
});
