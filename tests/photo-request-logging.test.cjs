'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../assets/js/worker.js'), 'utf8');
const image = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]).toString('base64');

async function run(type, body, mode = 'reject', headers = {}) {
  const sandbox = { console: { log() {}, warn() {}, error() {} }, crypto: webcrypto,
    TextEncoder, Uint8Array, Response, Request, URL, atob, btoa, setTimeout, clearTimeout };
  vm.runInNewContext(source.replace('export default {', 'globalThis.worker = {'), sandbox);
  const writes = [], events = [], pending = [];
  const env = {
    DB: { prepare(sql) { return { async run() {}, bind(...values) {
      return { async run() { writes.push({ sql, values }); } };
    } }; } },
    KARMA_IMAGE_BUCKET: { async put() {
      events.push('stored');
      if (mode === 'storage-failed') throw new Error('R2 unavailable');
    } },
    AI: { async analyze(input) {
      events.push('ai');
      assert.equal(input.media[0].url, `data:image/jpeg;base64,${image}`);
      return { text: JSON.stringify({ error: '사진에 분석할 대상이 보이지 않습니다.' }) };
    } },
  };
  if (mode === 'unavailable') delete env.AI;
  const response = await sandbox.worker.fetch(new Request(`https://example.test/api/${type}-reading`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  const logs = writes.filter(write => write.sql.includes('INSERT INTO karma_analyses'));
  assert.ok(logs.length);
  return { response, events, logs, last: logs.at(-1).values,
    images: writes.filter(write => write.sql.includes('INSERT INTO karma_image_analyses')) };
}

for (const type of ['face', 'palm']) {
  test(`${type}: missing, empty, invalid and oversized images never invoke AI or become AI rejections`, async () => {
    for (const [body, headers, status] of [
      [{}, {}, 400], [{ image: '   ' }, {}, 400],
      [{ image: 'bm90LWFuLWltYWdl', mimeType: 'image/jpeg' }, {}, 400],
      [{}, { 'Content-Length': String(20 * 1024 * 1024) }, 413],
    ]) {
      const result = await run(type, body, 'reject', headers);
      assert.equal(result.response.status, status);
      assert.deepEqual(result.events, []);
      assert.equal(result.last[2], 'invalid_input');
      assert.equal(result.last[7], 'NOT_CALLED');
      assert.equal(result.last[8], '');
      assert.equal(result.images.length, 0);
    }
  });
  test(`${type}: actual AI rejection retains its image and AI service`, async () => {
    const result = await run(type, { image, mimeType: 'image/jpeg' });
    assert.equal(result.response.status, 400);
    assert.deepEqual(result.events, ['stored', 'ai']);
    assert.equal(result.last[2], 'rejected');
    assert.equal(result.last[7], 'KARMA_AI');
    assert.match(result.last[8], new RegExp(`^karma/${type}/`));
    assert.equal(result.images[0].values[7], 'KARMA_AI');
  });
  test(`${type}: storage and service failures truthfully record that AI was not called`, async () => {
    for (const mode of ['storage-failed', 'unavailable']) {
      const result = await run(type, { image, mimeType: 'image/jpeg' }, mode);
      assert.equal(result.response.status, 503);
      assert.ok(!result.events.includes('ai'));
      for (const log of result.logs) assert.equal(log.values[7], 'NOT_CALLED');
      for (const log of result.images) assert.equal(log.values[7], 'NOT_CALLED');
      assert.equal(result.last[2], 'error');
      assert.equal(Boolean(result.last[8]), mode === 'unavailable');
    }
  });
}
