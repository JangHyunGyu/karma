'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const appearanceFixture = require('./fixtures/face-appearance.cjs');

const workerPath = path.join(__dirname, '../assets/js/worker.js');
const source = fs.readFileSync(workerPath, 'utf8');
const context = {
  console: { log() {}, warn() {}, error() {} },
  crypto: webcrypto, TextEncoder, Uint8Array, Response, Request, URL, atob, btoa,
  setTimeout, clearTimeout,
  fetch: async () => new Response('{}'),
};
vm.runInNewContext(source.replace('export default {', 'const worker = {') + `
globalThis.api = { normalizeFaceAiScores, normalizeFaceAppearance, validateKarmaAiContract, callKarmaVisionAi, handleFaceReading };
`, context);
const api = context.api;

function face(scores = [81, 87, 79, 84, 76], lang = 'en') {
  const text = lang === 'en' ? 'Visible contour and proportions.' : '윤곽과 비율이 보입니다.';
  return {
    ...appearanceFixture(lang),
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

test('new face sections validate both languages and reject missing evidence or unsafe colors', () => {
  for (const lang of ['ko', 'en']) {
    const context = { lang, gender: 'female', age: '20s' };
    assert.equal(api.validateKarmaAiContract('face', api.normalizeFaceAiScores(face(undefined, lang)), context).ok, true);
    for (const change of [
      d => delete d.appearance,
      d => delete d.personal_color,
      d => { d.appearance.style.makeup = ''; },
      d => { d.appearance.highlights = []; },
      d => { d.appearance.cosmetic_consultation[0].goal = ''; },
      d => { d.appearance.cosmetic_consultation[0].options = []; },
      d => { d.appearance.cosmetic_consultation[0].options[0].name = ''; },
      d => { d.appearance.cosmetic_consultation[0].options[0].purpose = ''; },
      d => { d.appearance.cosmetic_consultation[0].options[0].caution = ''; },
      d => { delete d.appearance.style.accessories; },
      d => { d.appearance.sex_appeal = ''; },
      d => { d.personal_color.colors[0].hex = 'red;background:url(https://example.com)'; },
      d => { d.personal_color.season = 'certain'; },
      d => { d.personal_color.limitation = ''; },
      d => { d.personal_color.colors[0].name = lang === 'ko' ? 'English leak' : '한글 누출'; },
    ]) {
      const invalid = api.normalizeFaceAiScores(face(undefined, lang));
      change(invalid);
      assert.equal(api.validateKarmaAiContract('face', invalid, context).ok, false);
    }
  }
});

test('accessories and cosmetic changes are not forced when there is no grounded suggestion', () => {
  const result = api.normalizeFaceAiScores(face());
  result.appearance.style.accessories = '';
  result.appearance.cosmetic_consultation = [];
  assert.equal(api.validateKarmaAiContract('face', result, { lang: 'en', age: '30s' }).ok, true);
  assert.equal(result.appearance.style.glasses, undefined);
});

test('vision repairs a vague cosmetic question into named options without losing the observation', async () => {
  const partial = face();
  delete partial.appearance.cosmetic_consultation[0].options;
  const requests = [];
  const result = await api.callKarmaVisionAi('Inspect the photo.', 'data:image/jpeg;base64,/9j/', {
    AI: { async analyze(input) {
      requests.push(input);
      return { text: JSON.stringify(requests.length === 1 ? partial : {
        appearance: { cosmetic_consultation: face().appearance.cosmetic_consultation },
      }) };
    } },
  }, 'en', 'face', { age: '30s' });
  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /options/);
  assert.equal(result.appearance.cosmetic_consultation[0].options[0].name, 'Blepharoplasty');
  assert.equal(result.appearance.cosmetic_consultation[0].observation, partial.appearance.cosmetic_consultation[0].observation);
});

test('ordinary appeal wording is accepted without a retry or a server rejection', async () => {
  for (const [lang, age, text] of [
    ['en', '30s', 'Your eyes create an elegant and refined aura.'],
    ['ko', '50대', '차분한 눈빛에서 성숙하고 깊이 있는 우아함이 배어 나옵니다.'],
  ]) {
    const partial = face(undefined, lang);
    partial.appearance.sex_appeal = text;
    const requests = [];
    const result = await api.callKarmaVisionAi('Inspect the photo.', 'data:image/jpeg;base64,/9j/', {
      AI: { async analyze(input) {
        requests.push(input);
        return { text: JSON.stringify(partial) };
      } },
    }, lang, 'face', { gender: lang === 'ko' ? '여성' : 'female', age });
    assert.equal(requests.length, 1);
    assert.equal(result._apiError, undefined);
    assert.equal(result.appearance.sex_appeal, text);
    assert.doesNotMatch(requests[0].prompt, /섹시|성적 매력|섹슈얼|sexy|sexual|explicit_sex_appeal/i);
  }
});

test('generic elegance for teens is returned without added sexual wording', async () => {
  const partial = face(undefined, 'ko');
  const original = '차분한 눈빛에서 성숙하고 깊이 있는 우아함이 배어 나옵니다.';
  partial.appearance.sex_appeal = original;
  const result = await api.callKarmaVisionAi('Inspect the photo.', 'data:image/jpeg;base64,/9j/', {
    AI: { async analyze() { return { text: JSON.stringify(partial) }; } },
  }, 'ko', 'face', { gender: '여성', age: '10대' });
  assert.equal(result.appearance.sex_appeal, original);
  assert.equal(result._apiError, undefined);
});

test('english personal-color enums nested under appearance are not Korean-language errors', () => {
  const value = api.normalizeFaceAiScores(face(undefined, 'ko'));
  value.appearance.personal_color = {
    season: 'summer',
    undertone: 'cool',
    colors: [{ hex: '#AABBCC' }],
  };
  const contract = api.validateKarmaAiContract('face', value, { lang: 'ko', gender: '여성', age: '50대' });
  assert.equal(contract.errors.some(error => String(error).includes('korean_only')), false);
});

test('more than two cosmetic suggestions are trimmed instead of failing the reading', () => {
  const value = face(undefined, 'ko');
  const item = value.appearance.cosmetic_consultation[0];
  value.appearance.cosmetic_consultation = [item, item, item];
  const normalized = api.normalizeFaceAppearance(api.normalizeFaceAiScores(value), { gender: '여성', age: '30대' });
  assert.equal(normalized.appearance.cosmetic_consultation.length, 2);
  assert.equal(api.validateKarmaAiContract('face', normalized, { lang: 'ko', gender: '여성', age: '30대' }).ok, true);
});

test('photo pages tell users how long face and palm analysis usually takes', () => {
  const pages = {
    'face.html': ['보통 30초~1분', '길면 2분', 'loadingElapsed', "startKarmaPhotoWait('face')"],
    'face-en.html': ['30 seconds to 1 minute', 'up to 2 minutes', 'Elapsed 0:00', "startKarmaPhotoWait('face')"],
    'palm.html': ['보통 1~2분', '길면 3분', 'loadingElapsed', "startKarmaPhotoWait('palm')"],
    'palm-en.html': ['1 to 2 minutes', 'up to 3 minutes', 'Elapsed 0:00', "startKarmaPhotoWait('palm')"],
  };
  for (const [page, parts] of Object.entries(pages)) {
    const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
    for (const part of parts) assert.ok(html.includes(part), `${page} missing ${part}`);
    assert.match(html, /components\.js\?v=11/);
  }
  const helper = fs.readFileSync(path.join(__dirname, '../js/components.js'), 'utf8');
  assert.match(helper, /function startKarmaPhotoWait/);
  assert.match(helper, /2분 안쪽이면 정상입니다/);
  assert.match(helper, /3분 안쪽이면 정상입니다/);

  const elements = new Map();
  const elapsed = { textContent: '' };
  const status = { textContent: '' };
  const loading = { style: { display: 'flex' } };
  elements.set('loadingElapsed', elapsed);
  elements.set('loadingStatus', status);
  elements.set('loading', loading);
  let now = 0;
  let intervalFn = null;
  const documentElement = { lang: 'ko' };
  const timerContext = {
    document: {
      documentElement,
      getElementById(id) { return elements.get(id) || null; },
    },
    Date: class extends Date { static now() { return now; } },
    setInterval(fn) { intervalFn = fn; return 1; },
    clearInterval() { intervalFn = null; },
  };
  const start = helper.indexOf('function _L');
  const end = helper.indexOf('// ===== 야자시');
  vm.runInNewContext(helper.slice(start, end), timerContext);
  timerContext.startKarmaPhotoWait('face');
  assert.equal(elapsed.textContent, '경과 0:00');
  assert.equal(status.textContent, '사진을 읽고 있습니다.');
  now = 61000;
  intervalFn();
  assert.equal(elapsed.textContent, '경과 1:01');
  assert.match(status.textContent, /2분 안쪽이면 정상입니다/);
  now = 121000;
  intervalFn();
  assert.match(status.textContent, /거의 다 됐어요/);
  timerContext.startKarmaPhotoWait('palm');
  now += 121000;
  intervalFn();
  assert.match(status.textContent, /3분 안쪽이면 정상입니다/);
  documentElement.lang = 'en';
  now = 0;
  timerContext.startKarmaPhotoWait('face');
  assert.equal(elapsed.textContent, 'Elapsed 0:00');
  assert.equal(status.textContent, 'Reading the photo.');
  timerContext.stopKarmaPhotoWait();
  assert.equal(loading.style.display, 'none');
  assert.equal(intervalFn, null);
});

test('adult content is removed for teens, unknown ages, or uncertain subjects without mutating the response', () => {
  for (const age of ['10대', 'teens', '', undefined, '18', 'adult', '20s injected']) {
    const original = face();
    const result = api.normalizeFaceAppearance(original, { age });
    assert.equal(result.appearance.sex_appeal, '');
    assert.equal(result.appearance.cosmetic_consultation.length, 0);
    assert.ok(original.appearance.sex_appeal);
    assert.equal(result.personal_color, original.personal_color);
  }
  for (const age of ['20대', '60대 이상', '20s', '60s+']) {
    const adult = face();
    assert.ok(api.normalizeFaceAppearance(adult, { age }).appearance.sex_appeal);
    adult.appearance.adult_subject = false;
    assert.equal(api.normalizeFaceAppearance(adult, { age }).appearance.sex_appeal, '');
  }
});

test('vision repairs missing female makeup and color sections while preserving the original score', async () => {
  const requests = [];
  const partial = face();
  partial.appearance.style.makeup = '';
  delete partial.personal_color;
  const result = await api.callKarmaVisionAi('Inspect the photo.', 'data:image/jpeg;base64,/9j/', {
    AI: { async analyze(input) {
      requests.push(input);
      return { text: JSON.stringify(requests.length === 1 ? partial : {
        appearance: { style: { makeup: 'Try a soft line along the visible eye contour.' } },
        personal_color: face().personal_color,
      }) };
    } },
  }, 'en', 'face', { gender: 'female', age: '20s' });
  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /appearance.style.makeup/);
  assert.match(requests[1].prompt, /personal_color/);
  assert.equal(result.overall_score, 81);
  assert.equal(result.appearance.style.grooming, '');
  assert.ok(result.appearance.style.makeup);
  assert.ok(result.appearance.sex_appeal);
});

test('face handler uses the selected gender and age and persists only age-appropriate fields', async () => {
  for (const [gender, age, lang] of [['남성', '30대', 'ko'], ['여성', '20대', 'ko'], ['male', 'teens', 'en'], ['female', '20s', 'en']]) {
    let prompt;
    const writes = [];
    const response = await api.handleFaceReading(new Request('https://example.com/api/face-reading', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: '/9j/4AAQSkZJRg==', mimeType: 'image/jpeg', gender, age, lang }),
    }), {
      KARMA_IMAGE_BUCKET: { async put() {} },
      AI: { async analyze(input) { prompt = input.prompt; return { text: JSON.stringify(face(undefined, lang)) }; } },
      DB: { prepare(sql) { return { async run() {}, bind(...values) { return { async run() { writes.push({ sql, values }); } }; } }; } },
    }, 'appearance-test');
    assert.equal(response.status, 200);
    const result = await response.json();
    const female = ['여성', 'female'].includes(gender);
    assert.match(prompt, female ? /여성 선택: style.makeup/ : /남성 선택: style.grooming/);
    assert.match(prompt, /style.accessories/);
    assert.doesNotMatch(prompt, /"glasses"\s*:/);
    assert.match(prompt, /가장 눈에 띄는 눈빛·눈매·입술선·미소/);
    assert.doesNotMatch(prompt, /섹시|성적 매력|섹슈얼|sexy|sexual|explicit_sex_appeal/i);
    assert.match(prompt, /실제 수술·시술 명칭/);
    assert.ok(result.appearance.style[female ? 'makeup' : 'grooming']);
    assert.equal(result.appearance.style[female ? 'grooming' : 'makeup'], '');
    if (age === 'teens') {
      assert.equal(result.appearance.sex_appeal, '');
      assert.deepEqual(result.appearance.cosmetic_consultation, []);
    } else assert.ok(result.appearance.sex_appeal);
    assert.deepEqual(JSON.parse(writes.find(w => w.sql.includes('INSERT INTO karma_image_analyses')).values[5]), result);
  }
});

test('both renderers escape new content, reject CSS injection, gate adult sections, and clear old results', () => {
  for (const page of ['face.html', 'face-en.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
    const renderSource = html.slice(html.indexOf('function renderResult(d)'), html.indexOf('function handleShareKakao'));
    const elements = new Map();
    const dom = {
      window: { _faceInput: { age: '20s', gender: 'female' } },
      document: { getElementById(id) {
        if (!elements.has(id)) elements.set(id, { style: {}, scrollIntoView() {} });
        return elements.get(id);
      } },
      _L: (ko, en) => en, cleanGrade: value => value, getGrade: () => 'A', scoreValue: value => value,
      esc: value => String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    };
    vm.runInNewContext(renderSource, dom);
    const result = api.normalizeFaceAiScores(face());
    result.appearance.harmony = '<img src=x onerror=alert(1)>';
    result.personal_color.colors.push({ name: 'Injected', hex: '#ffffff" onmouseover="alert(1)' });
    dom.renderResult(result);
    assert.equal(elements.get('appearance').style.display, '');
    assert.match(elements.get('appearance').innerHTML, /&lt;img/);
    assert.doesNotMatch(elements.get('appearance').innerHTML, /<img/);
    assert.match(elements.get('appearance').innerHTML, /Sensual appeal/);
    assert.match(elements.get('appearance').innerHTML, /Accessories/);
    assert.doesNotMatch(elements.get('appearance').innerHTML, />Glasses</);
    assert.equal(elements.get('cosmeticConsultation').style.display, '');
    assert.match(elements.get('cosmeticConsultation').innerHTML, /Blepharoplasty/);
    for (const label of ['Desired change', 'What it aims to change', 'Conditions &amp; risks to check']) {
      assert.ok(elements.get('cosmeticConsultation').innerHTML.includes(label));
    }
    result.appearance.style.accessories = '';
    result.appearance.style.glasses = 'legacy glasses';
    dom.renderResult(result);
    assert.doesNotMatch(elements.get('appearance').innerHTML, /Accessories|legacy glasses/);
    delete result.appearance.style.accessories;
    delete result.appearance.cosmetic_consultation[0].goal;
    delete result.appearance.cosmetic_consultation[0].options;
    dom.renderResult(result);
    assert.match(elements.get('appearance').innerHTML, /Accessories.*legacy glasses/s);
    assert.doesNotMatch(elements.get('cosmeticConsultation').innerHTML, /undefined|Desired change|Procedure to compare/);
    assert.doesNotMatch(elements.get('personalColor').innerHTML, /onmouseover|Injected/);
    assert.match(elements.get('personalColor').innerHTML, /#C98F9E/);
    dom.window._faceInput.age = 'teens';
    dom.renderResult(result);
    assert.doesNotMatch(elements.get('appearance').innerHTML, /Sensual appeal/);
    assert.equal(elements.get('cosmeticConsultation').style.display, 'none');
    delete result.appearance;
    delete result.personal_color;
    dom.renderResult(result);
    for (const id of ['appearance', 'personalColor', 'cosmeticConsultation']) {
      assert.equal(elements.get(id).style.display, 'none');
      assert.equal(elements.get(id).innerHTML, '');
    }
  }
});
