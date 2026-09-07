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
globalThis.api = { callKarmaVisionAi, getGrade };
`, context);
  return context;
}

function palm(score = 76, grade = 'C', lang = 'en') {
  const text = lang === 'en' ? 'Visible palm line.' : '손바닥의 선이 보입니다.';
  return {
    overall_score: score, overall_grade: grade,
    quality_assessment: text, visual_evidence: Array(8).fill(text),
    summary: text, advice: text,
    lines: [84, 75, 80, 68, 62, 65].map(score => ({ name: text, score, length: text, desc: text })),
    hand_shape: { type: text, desc: text },
    fortune: { wealth: text, career: text, love: text, health: text },
  };
}

const gradeCases = [[0, 'D'], [39, 'D'], [40, 'C'], [59, 'C'], [60, 'B'], [74, 'B'], [75, 'A'], [76, 'A'], [89, 'A'], [90, 'S'], [100, 'S']];

test('palm grades use the shared score thresholds even when AI supplies the wrong or no grade', async () => {
  const { api } = loadWorker();
  for (const [score, grade] of gradeCases) {
    for (const generatedGrade of ['C', undefined]) {
      const input = palm(score);
      input.overall_grade = generatedGrade;
      let calls = 0;
      const result = await api.callKarmaVisionAi('Inspect the palm.', 'data:image/jpeg;base64,/9j/', {
        AI: { async analyze() { calls++; return { text: JSON.stringify(input) }; } },
      }, 'en', 'palm');
      assert.equal(result.overall_grade, grade, `score ${score}, generated grade ${generatedGrade}`);
      assert.equal(result.overall_score, score);
      assert.deepEqual(Array.from(result.lines, line => line.score), input.lines.map(line => line.score));
      assert.equal(calls, 1);
    }
  }
});

test('invalid palm scores are rejected and non-palm photos retain their rejection', async () => {
  const { api } = loadWorker();
  for (const score of [null, '76', -1, 101, 76.5]) {
    let calls = 0;
    const result = await api.callKarmaVisionAi('Inspect the palm.', 'data:image/jpeg;base64,/9j/', {
      AI: { async analyze() { calls++; return { text: JSON.stringify(palm(score)) }; } },
    }, 'en', 'palm');
    assert.ok(result._apiError);
    assert.equal(calls, 3);
  }
  const result = await api.callKarmaVisionAi('Inspect the palm.', 'data:image/jpeg;base64,/9j/', {
    AI: { async analyze() { return { text: JSON.stringify({ error: 'No palm is visible.' }) }; } },
  }, 'en', 'palm');
  assert.equal(result.error, 'No palm is visible.');
  assert.equal(result.overall_grade, undefined);
});

test('palm API persists the corrected grade with the uploaded image before returning it', async () => {
  for (const lang of ['ko', 'en']) {
    const { worker } = loadWorker();
    const events = [];
    const writes = [];
    const pending = [];
    let prompt;
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');
    const response = await worker.fetch(new Request('https://example.com/api/palm-reading', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, mimeType: 'image/jpeg', lang }),
    }), {
      KARMA_IMAGE_BUCKET: { async put() { events.push('stored'); } },
      AI: { async analyze(input) {
        events.push('analyzed');
        prompt = input.prompt;
        assert.equal(input.media[0].url, `data:image/jpeg;base64,${image}`);
        return { text: JSON.stringify(palm(76, 'C', lang)) };
      } },
      DB: { prepare(sql) {
        return { async run() {}, bind(...values) {
          return { async run() { writes.push({ sql, values }); } };
        } };
      } },
    }, { waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(events, ['stored', 'analyzed']);
    assert.equal(result.overall_score, 76);
    assert.equal(result.overall_grade, 'A');
    const imageWrite = writes.find(write => write.sql.includes('INSERT INTO karma_image_analyses'));
    assert.equal(JSON.parse(imageWrite.values[5]).overall_grade, 'A');
    for (const write of writes.filter(write => write.sql.includes('INSERT INTO karma_analyses'))) {
      assert.equal(JSON.parse(write.values[5]).overall_grade, 'A');
      assert.equal(write.values[8], imageWrite.values[1]);
    }
    assert.doesNotMatch(prompt, /"overall_grade"\s*:/, 'the model must not be asked to generate a grade');
  }
});

test('Korean and English palm pages display the correct grade for old shared results', () => {
  for (const page of ['palm.html', 'palm-en.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
    const renderSource = html.slice(html.indexOf('function renderResult(d)'), html.indexOf('function handleShareKakao'));
    const helpers = html.slice(html.indexOf('function getGrade(s)'), html.indexOf('</script>', html.indexOf('function getGrade(s)'))).split('\nKarmaShare.init(')[0];
    const elements = new Map();
    const context = {
      _L: (ko, en) => en,
      document: {
        getElementById(id) {
          if (!elements.has(id)) elements.set(id, { style: {}, scrollIntoView() {} });
          return elements.get(id);
        },
        createElement() { return { set textContent(value) { this.innerHTML = String(value); } }; },
      },
    };
    vm.runInNewContext(helpers + '\n' + renderSource, context);
    for (const [score, grade] of gradeCases) {
      context.renderResult({ overall_score: score, overall_grade: 'C' });
      assert.equal(elements.get('totalScore').textContent, score);
      assert.equal(elements.get('totalGrade').innerHTML, `<span class="grade grade-${grade}">${grade}</span>`);
    }
  }
});
