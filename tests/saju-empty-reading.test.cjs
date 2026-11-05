'use strict';

// D1 error_logs 6475 (2026-11-05 02:02 KST): saju for 1978-04-10 12:00 male (ko, utc+9) failed all three
// attempts with root:no_displayable_text (three short, valid JSON replies of 118-220 output tokens) and the
// row kept no raw reply. Retries must name the empty-text problem, keep normal sampling, and the final log
// must carry a sample of the reply so the next row shows what the model returned.
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
    crypto: webcrypto, TextEncoder, Uint8Array, Response, Request, Headers, URL, atob, btoa,
    setTimeout(resolve) { resolve(); }, clearTimeout() {}, fetch: async () => new Response('{}'),
  };
  vm.runInNewContext(source.replace('export default {', 'globalThis.worker = {')
    + '\nglobalThis.api = { callKarmaTextAi, calculateSaju, buildSajuPrompt };', context);
  return context.api;
}

const emptyTemplate = JSON.stringify({
  pillar_reading: { year: '', month: '', day: '', hour: '' }, personality: '', strengths: [], cautions: [],
  love_style: '', career: '', daeun_reading: [], advice: '',
});

test('row 6475: empty saju template retries with explicit instruction and logs a raw sample', async () => {
  const api = loadWorker();
  const saju = api.calculateSaju('1978-04-10', '12:00', 'male', false, 'utc+9');
  const prompt = api.buildSajuPrompt(saju, 'male', 'ko', '1978-04-10');
  assert.equal(prompt.user.length, 846); // promptChars recorded in the row
  const calls = [], logs = [];
  const env = {
    AI: { async complete(request) { calls.push(request); return { text: emptyTemplate, usage: {} }; } },
    DB: { prepare(sql) { return { bind(...args) { return { async run() { if (/error_logs/.test(sql)) logs.push(args); } }; } }; } },
  };
  const result = await api.callKarmaTextAi(prompt, 'saju', env, null, 'saju', { hasTime: true, daeunCount: saju.daeun.length });
  assert.equal(result, null);
  assert.equal(calls.length, 3);
  for (const retry of calls.slice(1)) {
    assert.equal(retry.temperature, 0.5);
    assert.match(retry.messages[0].content, /Never return empty strings/);
  }
  const log = logs.find(args => /contract mismatch after retry/.test(args[0]));
  assert.ok(log);
  assert.match(log[1], /root:no_displayable_text/);
  assert.match(log[1], /raw: \{"pillar_reading":\{"year":""/);
});

test('row 6475 input: a real reading on retry is returned', async () => {
  const api = loadWorker();
  const saju = api.calculateSaju('1978-04-10', '12:00', 'male', false, 'utc+9');
  const prompt = api.buildSajuPrompt(saju, 'male', 'ko', '1978-04-10');
  const t = '임수 일간에 화 기운이 넷이라 재성 쪽으로 힘이 쏠립니다. [근거: 화4]';
  const reading = { pillar_reading: { year: t, month: t, day: t, hour: t }, personality: t, love_style: t, career: t, advice: t,
    strengths: [t, t, t], cautions: [t, t, t], daeun_reading: Array(8).fill(t) };
  let n = 0;
  const env = { AI: { async complete() { n += 1; return { text: n === 1 ? emptyTemplate : JSON.stringify(reading), usage: {} }; } } };
  const result = await api.callKarmaTextAi(prompt, 'saju', env, null, 'saju', { hasTime: true, daeunCount: 8 });
  assert.equal(result.personality, t);
  assert.equal(n, 2);
});
