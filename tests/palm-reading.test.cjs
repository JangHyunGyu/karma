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
    lines: [84, 75, 80, 68, 62, 65].map(score => ({ name: text, score, length: text, desc: text, caution: text })),
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

test('missing palm advice keeps the first reading without requesting another inspection', async () => {
  const { api } = loadWorker();
  const first = palm(76, 'A');
  delete first.advice;
  const worse = palm(101, 'A');
  const calls = [];
  const result = await api.callKarmaVisionAi('Inspect the palm.', 'data:image/jpeg;base64,/9j/', {
    AI: { async analyze() {
      calls.push(calls.length + 1);
      const payload = calls.length === 1 ? first : calls.length === 2 ? worse : { advice: 'Visible palm line.' };
      return { text: JSON.stringify(payload) };
    } },
  }, 'en', 'palm');
  assert.equal(calls.length, 1);
  assert.equal(result._apiError, undefined);
  assert.equal(result.overall_score, 76);
  assert.equal(result.advice, undefined);
});

test('a displayable palm reading with a score warning is returned and stored after one call', async () => {
  const { worker } = loadWorker();
  const writes = [];
  const pending = [];
  let calls = 0;
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');
  const response = await worker.fetch(new Request('https://example.com/api/palm-reading', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, mimeType: 'image/jpeg', lang: 'ko' }),
  }), {
    KARMA_IMAGE_BUCKET: { async put() {} },
    AI: { async analyze() { calls++; return { text: JSON.stringify(palm(101, 'A', 'ko')) }; } },
    DB: { prepare(sql) {
      return { async run() {}, bind(...values) {
        return { async run() { writes.push({ sql, values }); } };
      } };
    } },
  }, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  const body = await response.json();
  assert.equal(body.overall_score, 101);
  const imageWrite = writes.find(write => write.sql.includes('INSERT INTO karma_image_analyses'));
  assert.equal(imageWrite.values[3], 'success');
  assert.equal(JSON.parse(imageWrite.values[5]).overall_score, 101);
});

test('score warnings do not regenerate displayable palm prose and non-palm rejection is preserved', async () => {
  const { api } = loadWorker();
  for (const score of [null, '76', -1, 101, 76.5]) {
    let calls = 0;
    const result = await api.callKarmaVisionAi('Inspect the palm.', 'data:image/jpeg;base64,/9j/', {
      AI: { async analyze() { calls++; return { text: JSON.stringify(palm(score)) }; } },
    }, 'en', 'palm');
    assert.equal(result._apiError, undefined);
    assert.equal(result.summary, palm(score).summary);
    assert.equal(result.overall_score, score);
    assert.equal(calls, 1);
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
    assert.doesNotMatch(prompt, /"(?:overall_score|score)"\s*:\s*\d+/, 'numeric examples must not anchor generation');
    assert.match(prompt, /lines의 각 desc/);
    assert.match(prompt, /60~74점/);
    assert.match(prompt, /60점 미만/);
    assert.match(prompt, /관찰 한계를 성격이나 운세의 단점으로 바꾸지 마세요/);
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

test('unreadable side marriage line does not anchor palm overall score to 68 when readable lines vary widely', async () => {
  const { api } = loadWorker();
  const strongPalm = palm(68, 'B', 'ko');
  strongPalm.lines = [
    { name: '생명선', score: 88, length: '길다', desc: '선명합니다.', caution: '과로 주의.' },
    { name: '두뇌선', score: 84, length: '보통', desc: '또렷합니다.', caution: '고집 주의.' },
    { name: '감정선', score: 82, length: '길다', desc: '매끄럽습니다.', caution: '감정 소모 주의.' },
    { name: '운명선', score: 76, length: '뚜렷', desc: '가운데가 깊습니다.', caution: '일 욕심 주의.' },
    { name: '태양선', score: 72, length: '있음', desc: '약지 아래 보입니다.', caution: '과시 주의.' },
    { name: '결혼선', score: 48, length: '확인 어려움', desc: '측면이 보이지 않습니다.', caution: '측면 재촬영.' },
  ];
  const weakPalm = palm(68, 'B', 'ko');
  weakPalm.lines = [
    { name: '생명선', score: 46, length: '짧다', desc: '중간에 끊김이 보입니다.', caution: '체력 저하 주의.' },
    { name: '두뇌선', score: 52, length: '짧다', desc: '흐리고 잔선이 많습니다.', caution: '성급한 결정 주의.' },
    { name: '감정선', score: 48, length: '보통', desc: '사슬 모양으로 흔들립니다.', caution: '감정 기복 주의.' },
    { name: '운명선', score: 42, length: '희미', desc: '거의 보이지 않습니다.', caution: '목표 분산 주의.' },
    { name: '태양선', score: 44, length: '없음', desc: '선이 드러나지 않습니다.', caution: '주변 협력 점검.' },
    { name: '결혼선', score: 50, length: '확인 어려움', desc: '측면이 보이지 않습니다.', caution: '측면 재촬영.' },
  ];

  const strongResult = await api.callKarmaVisionAi('Inspect the palm.', 'data:image/jpeg;base64,/9j/', {
    AI: { async analyze() { return { text: JSON.stringify(strongPalm) }; } },
  }, 'ko', 'palm');
  const weakResult = await api.callKarmaVisionAi('Inspect the palm.', 'data:image/jpeg;base64,/9j/', {
    AI: { async analyze() { return { text: JSON.stringify(weakPalm) }; } },
  }, 'ko', 'palm');

  assert.equal(strongResult.overall_score, 81);
  assert.equal(strongResult.overall_grade, 'A');
  assert.equal(weakResult.overall_score, 47);
  assert.equal(weakResult.overall_grade, 'C');
});
