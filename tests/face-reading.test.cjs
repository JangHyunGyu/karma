'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const workerPath = path.join(__dirname, '../assets/js/worker.js');
const source = fs.readFileSync(workerPath, 'utf8');
const context = {
  console: { log() {}, warn() {}, error() {} },
  crypto: webcrypto, TextEncoder, Uint8Array, Response, Request, URL, atob, btoa,
  setTimeout, clearTimeout,
  fetch: async () => new Response('{}'),
};
vm.runInNewContext(source.replace('export default {', 'const worker = {') + `
globalThis.api = { normalizeFaceAiScores, validateKarmaAiContract, callKarmaVisionAi, handleFaceReading };
`, context);
const api = context.api;

function face(scores = [81, 87, 79, 84, 76], lang = 'en') {
  const text = lang === 'en' ? 'Visible contour and proportions.' : '윤곽과 비율이 보입니다.';
  return {
    forehead_observation: {
      skin_visible: true,
      hairline_visible: false,
      observation: text,
      limitation: lang === 'en' ? 'Only the hairline is obscured.' : '헤어라인만 가려져 있습니다.',
    },
    quality_assessment: text,
    visual_evidence: Array(8).fill(text),
    summary: text,
    categories: [...scores.map(score => ({ name: text, score, desc: text })), { name: text, desc: text }],
    fortune: { wealth: text, career: text, love: text, health: text },
    advice: text,
    celebrity_resemblance: '',
  };
}

test('overall score and grade come from the five features, not a generated overall anchor', () => {
  for (const [scores, expected, grade] of [
    [[60, 82, 88, 78, 75], 77, 'A'],
    [[78, 88, 82, 92, 80], 84, 'A'],
    [[61, 64, 66, 68, 69], 66, 'B'],
    [[91, 94, 96, 90, 92], 93, 'S'],
    [[0, 0, 0, 0, 0], 0, 'D'],
    [[100, 100, 100, 100, 100], 100, 'S'],
  ]) {
    for (const anchor of [72, 78, 82]) {
      const input = { ...face(scores), overall_score: anchor, overall_grade: 'D' };
      input.categories[5].score = anchor;
      const result = api.normalizeFaceAiScores(input);
      assert.equal(result.overall_score, expected);
      assert.equal(result.overall_grade, grade);
      assert.equal(result.categories[5].score, expected);
      assert.deepEqual(Array.from(result.categories.slice(0, 5), c => c.score), scores);
      assert.equal(input.overall_score, anchor, 'normalization must not mutate the AI response');
    }
  }
});

test('valid observations are not quantized into a small set of overall scores', () => {
  const results = new Set();
  for (let value = 0; value <= 100; value++) {
    const result = api.normalizeFaceAiScores(face(Array(5).fill(value)));
    results.add(result.overall_score);
    assert.equal(result.overall_score, value);
  }
  assert.equal(results.size, 101);
});

test('visible forehead skin remains assessable even when its hairline is hidden', () => {
  for (const lang of ['ko', 'en']) {
    const result = api.normalizeFaceAiScores(face(undefined, lang));
    assert.equal(api.validateKarmaAiContract('face', result, { lang }).ok, true);
    assert.equal(result.forehead_observation.skin_visible, true);
    assert.equal(result.forehead_observation.hairline_visible, false);
    assert.equal(result.categories[0].score, 81, 'a hidden hairline must not impose a fixed low score');
  }
});

test('an unreadable forehead requires an actual obstruction and explicit boolean observations', () => {
  const result = api.normalizeFaceAiScores(face());
  result.forehead_observation.skin_visible = false;
  result.forehead_observation.limitation = '';
  assert.equal(api.validateKarmaAiContract('face', result).ok, false);
  result.forehead_observation.limitation = 'A head covering obscures the forehead skin.';
  assert.equal(api.validateKarmaAiContract('face', result).ok, true);
  result.forehead_observation.skin_visible = 'false';
  assert.equal(api.validateKarmaAiContract('face', result).ok, false);
});

test('invalid feature scores are rejected rather than silently clamped or replaced', () => {
  for (const invalid of [null, undefined, '82', NaN, Infinity, -1, 101, 80.5]) {
    const input = face();
    input.categories[2].score = invalid;
    const result = api.normalizeFaceAiScores(input);
    assert.equal(api.validateKarmaAiContract('face', result).ok, false, String(invalid));
  }
});

test('vision retries missing forehead evidence and preserves the uploaded image and valid scores', async () => {
  const complete = face();
  const partial = { ...complete };
  delete partial.forehead_observation;
  const requests = [];
  const imageUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const env = { AI: { async analyze(input) {
    requests.push(input);
    return { text: JSON.stringify(requests.length === 1 ? partial : {
      forehead_observation: complete.forehead_observation,
    }) };
  } } };
  const result = await api.callKarmaVisionAi('Inspect the photo.', imageUrl, env, 'en', 'face');
  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /forehead_observation/);
  assert.ok(requests.every(request => request.media[0].url === imageUrl));
  assert.equal(result.overall_score, 81);
  assert.equal(result.categories[5].score, 81);
  assert.equal(api.validateKarmaAiContract('face', result, { lang: 'en' }).ok, true);
});

test('non-face rejection remains a rejection without invented scores', async () => {
  const result = await api.callKarmaVisionAi('Inspect the photo.', 'data:image/jpeg;base64,/9j/', {
    AI: { async analyze() { return { text: JSON.stringify({ error: 'No face is visible.' }) }; } },
  }, 'en', 'face');
  assert.equal(result.error, 'No face is visible.');
  assert.equal(result.overall_score, undefined);
});

test('face handler persists the image before analysis and stores the same calculated result it returns', async () => {
  const events = [];
  const writes = [];
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');
  let prompt;
  const env = {
    KARMA_IMAGE_BUCKET: { async put(key, bytes) {
      events.push('stored');
      assert.deepEqual(Buffer.from(bytes), Buffer.from(image, 'base64'));
    } },
    AI: { async analyze(input) {
      events.push('analyzed');
      prompt = input.prompt;
      assert.equal(input.media[0].url, `data:image/jpeg;base64,${image}`);
      return { text: JSON.stringify(face()) };
    } },
    DB: { prepare(sql) {
      return { async run() {}, bind(...values) {
        return { async run() { writes.push({ sql, values }); } };
      } };
    } },
  };
  const response = await api.handleFaceReading(new Request('https://example.com/api/face-reading', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, mimeType: 'image/jpeg', lang: 'en' }),
  }), env, 'regression-test');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(events, ['stored', 'analyzed']);
  assert.equal(result.overall_score, 81);
  const imageWrite = writes.find(write => write.sql.includes('INSERT INTO karma_image_analyses'));
  assert.deepEqual(JSON.parse(imageWrite.values[5]), result);
  assert.match(imageWrite.values[1], /^karma\/face\//);
  assert.doesNotMatch(prompt, /"(?:overall_score|score)"\s*:\s*\d+/, 'numeric examples must not anchor generation');
});

test('both face pages display photo limitations safely and retain old shared results', () => {
  for (const page of ['face.html', 'face-en.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
    const renderSource = html.slice(html.indexOf('function renderResult(d)'), html.indexOf('function handleShareKakao'));
    const elements = new Map();
    const dom = {
      document: { getElementById(id) {
        if (!elements.has(id)) elements.set(id, { style: {}, scrollIntoView() {} });
        return elements.get(id);
      } },
      _L: (ko, en) => en, cleanGrade: value => value, getGrade: () => 'A',
      scoreValue: value => value, esc: value => String(value || ''),
    };
    vm.runInNewContext(renderSource, dom);
    const result = api.normalizeFaceAiScores(face());
    result.quality_assessment = '<img src=x onerror=alert(1)>';
    dom.renderResult(result);
    assert.equal(elements.get('totalScore').textContent, 81);
    assert.equal(elements.get('photoQuality').textContent, result.quality_assessment);
    assert.equal(elements.get('photoQuality').innerHTML, undefined);
    assert.equal(elements.get('scoreMethod').style.display, '');
    delete result.forehead_observation;
    dom.renderResult(result);
    assert.equal(elements.get('scoreMethod').style.display, 'none');
  }
});
