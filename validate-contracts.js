const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = __dirname;
const workerPath = path.join(root, 'assets', 'js', 'worker.js');
let workerSource = fs.readFileSync(workerPath, 'utf8');
workerSource = workerSource.replace('export default {', 'const __workerExport = {');
workerSource += `\nglobalThis.__karmaContracts = { validateKarmaAiContract, callKarmaTextAi, callKarmaVisionAi, buildKarmaPromptCacheKey };`;

const context = {
  console,
  fetch: global.fetch,
  Request: global.Request,
  Response: global.Response,
  Headers: global.Headers,
  URL: global.URL,
  crypto: global.crypto,
  TextEncoder: global.TextEncoder,
  TextDecoder: global.TextDecoder,
  setTimeout,
  clearTimeout,
};
context.globalThis = context;
vm.runInNewContext(workerSource, context, { filename: workerPath });

const api = context.__karmaContracts;
let passed = 0;
const failures = [];

function check(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failures.push(message);
    console.error(`  ❌ ${message}`);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const text = '검증 가능한 응답';
const fortune = {
  year_summary: text,
  love: text,
  money: text,
  health: text,
  career: text,
  lucky: { color: '파랑', number: 7, direction: '동쪽', month: 9 },
  advice: text,
};
const daily = {
  overall: text,
  love: text,
  money: text,
  career: text,
  study: text,
  social: text,
  health: text,
  lucky: { color: '초록', number: 3 },
  advice: text,
};
const compat = {
  summary: text,
  categories: Object.fromEntries(['personality', 'intimacy', 'finance', 'timing'].map(key => [key, { score: 75, desc: text }])),
  strengths: [text, text, text],
  cautions: [text, text, text],
  advice: text,
};
const saju = {
  pillar_reading: { year: text, month: text, day: text, hour: text },
  personality: text,
  strengths: [text, text, text],
  cautions: [text, text, text],
  love_style: text,
  career: text,
  daeun_reading: Array(8).fill(text),
  advice: text,
};
const tarot = {
  cards: Array.from({ length: 3 }, (_, index) => ({ position: `위치 ${index + 1}`, interpretation: text })),
  overall: text,
  advice: text,
  keywords: ['하나', '둘', '셋', '넷', '다섯'],
};
const face = {
  overall_score: 75,
  overall_grade: 'A',
  forehead_observation: { skin_visible: true, hairline_visible: false, observation: text, limitation: text },
  quality_assessment: text,
  visual_evidence: Array(8).fill(text),
  summary: text,
  categories: Array.from({ length: 6 }, (_, index) => ({ name: `부위 ${index + 1}`, score: 75, desc: text })),
  fortune: { wealth: text, career: text, love: text, health: text },
  advice: text,
  celebrity_resemblance: '',
};
const palm = {
  overall_score: 78,
  overall_grade: 'B+',
  quality_assessment: text,
  visual_evidence: Array(8).fill(text),
  summary: text,
  lines: Array.from({ length: 6 }, (_, index) => ({ name: `손금 ${index + 1}`, score: 70, length: '보통', desc: text })),
  hand_shape: { type: '물형', desc: text },
  fortune: { wealth: text, career: text, love: text, health: text },
  advice: text,
};

const fixtures = { saju, tarot, fortune, daily, compat, face, palm };

console.log('\n🧩 AI 응답 계약 완전성');
for (const [type, fixture] of Object.entries(fixtures)) {
  check(api.validateKarmaAiContract(type, fixture).ok, `${type} 완전한 응답 허용`);
  for (const key of Object.keys(fixture)) {
    const broken = clone(fixture);
    delete broken[key];
    check(!api.validateKarmaAiContract(type, broken).ok, `${type}.${key} 누락 거부`);
  }
}

const nestedFailures = [
  ['saju.pillar_reading.year', 'saju', saju, value => delete value.pillar_reading.year],
  ['saju.daeun_reading length', 'saju', saju, value => value.daeun_reading.pop()],
  ['tarot.cards length', 'tarot', tarot, value => value.cards.pop()],
  ['tarot.cards[0].interpretation', 'tarot', tarot, value => delete value.cards[0].interpretation],
  ['tarot.keywords length', 'tarot', tarot, value => value.keywords.pop()],
  ['fortune.lucky.month', 'fortune', fortune, value => delete value.lucky.month],
  ['daily.lucky.number', 'daily', daily, value => delete value.lucky.number],
  ['compat.categories.timing.desc', 'compat', compat, value => delete value.categories.timing.desc],
  ['compat.strengths length', 'compat', compat, value => value.strengths.pop()],
  ['face.categories length', 'face', face, value => value.categories.pop()],
  ['face.fortune.health', 'face', face, value => delete value.fortune.health],
  ['face.visual_evidence length', 'face', face, value => value.visual_evidence.pop()],
  ['palm.lines length', 'palm', palm, value => value.lines.pop()],
  ['palm.lines[0].length', 'palm', palm, value => delete value.lines[0].length],
  ['palm.hand_shape.desc', 'palm', palm, value => delete value.hand_shape.desc],
  ['palm.fortune.wealth', 'palm', palm, value => delete value.fortune.wealth],
];
for (const [label, type, fixture, mutate] of nestedFailures) {
  const broken = clone(fixture);
  mutate(broken);
  check(!api.validateKarmaAiContract(type, broken).ok, `${label} 누락·길이 오류 거부`);
}
const noTimeSaju = clone(saju);
noTimeSaju.pillar_reading.hour = '';
check(api.validateKarmaAiContract('saju', noTimeSaju, { hasTime: false, daeunCount: 8 }).ok, '출생시간 없는 사주의 빈 hour 허용');
check(!api.validateKarmaAiContract('saju', noTimeSaju, { hasTime: true, daeunCount: 8 }).ok, '출생시간 있는 사주의 빈 hour 거부');
check(api.validateKarmaAiContract('face', { error: '얼굴 사진이 아닙니다.' }).ok, '관상 사진 거절 JSON 허용');
check(api.validateKarmaAiContract('palm', { error: '손바닥 사진이 아닙니다.' }).ok, '손금 사진 거절 JSON 허용');

console.log('\n🔗 프롬프트 ↔ 화면 필드 매칭');
const pageContracts = {
  saju: ['d.ai.pillar_reading', 'd.ai.personality', 'd.ai.strengths', 'd.ai.cautions', 'd.ai.love_style', 'd.ai.career', 'd.ai?.daeun_reading', 'd.ai.advice'],
  tarot: ['card.interpretation', 'data.overall', 'data.advice', 'data.keywords'],
  fortune: ['f.year_summary', 'f.love', 'f.money', 'f.health', 'f.career', 'f.lucky.color', 'f.lucky.number', 'f.lucky.direction', 'f.lucky.month', 'f.advice'],
  daily: ['f.overall', 'f.love', 'f.money', 'f.career', 'f.study', 'f.social', 'f.health', 'f.lucky.color', 'f.lucky.number', 'f.advice'],
  compat: ['d.ai.summary', 'd.ai.categories', 'cat.score', 'cat.desc', 'd.ai.strengths', 'd.ai.cautions', 'd.ai.advice'],
  face: ['d.overall_score', 'd.overall_grade', 'd.summary', 'd.categories', 'd.fortune', 'fort.wealth', 'fort.career', 'fort.love', 'fort.health', 'd.advice'],
  palm: ['d.overall_score', 'd.overall_grade', 'd.summary', 'd.lines', 'd.hand_shape', 'd.fortune', 'fort.wealth', 'fort.career', 'fort.love', 'fort.health', 'd.advice'],
};
for (const [page, tokens] of Object.entries(pageContracts)) {
  for (const localePage of [`${page}.html`, `${page}-en.html`]) {
    const html = fs.readFileSync(path.join(root, localePage), 'utf8');
    for (const token of tokens) check(html.includes(token), `${localePage}가 ${token} 필드를 소비`);
  }
}

for (const localePage of ['match.html', 'match-en.html']) {
  const html = fs.readFileSync(path.join(root, localePage), 'utf8');
  for (const token of pageContracts.compat) check(html.includes(token), `${localePage}가 ${token} 필드를 소비`);
}

console.log('\n📝 프롬프트 응답 키 계약');
const promptKeys = {
  saju: ['pillar_reading', 'year', 'month', 'day', 'hour', 'personality', 'strengths', 'cautions', 'love_style', 'career', 'daeun_reading', 'advice'],
  tarot: ['cards', 'position', 'interpretation', 'overall', 'advice', 'keywords'],
  fortune: ['year_summary', 'love', 'money', 'health', 'career', 'lucky', 'color', 'number', 'direction', 'month', 'advice'],
  daily: ['overall', 'love', 'money', 'career', 'study', 'social', 'health', 'lucky', 'color', 'number', 'advice'],
  compat: ['summary', 'categories', 'personality', 'intimacy', 'finance', 'timing', 'strengths', 'cautions', 'advice'],
  face: ['overall_score', 'overall_grade', 'quality_assessment', 'visual_evidence', 'summary', 'categories', 'fortune', 'wealth', 'career', 'love', 'health', 'advice', 'celebrity_resemblance'],
  palm: ['overall_score', 'overall_grade', 'quality_assessment', 'visual_evidence', 'summary', 'lines', 'hand_shape', 'fortune', 'wealth', 'career', 'love', 'health', 'advice'],
};
for (const [type, keys] of Object.entries(promptKeys)) {
  for (const key of keys) check(workerSource.includes(`"${key}"`), `${type} 프롬프트에 ${key} 키 명시`);
}

async function testContractRetry(type, partial, complete, contractContext = {}) {
  let calls = 0;
  const env = {
    AI: {
      async complete() {
        calls++;
        return {
          text: JSON.stringify(calls === 1 ? partial : complete),
          usage: {},
          model: 'test-model',
          provider: 'test',
        };
      },
    },
  };
  const result = await api.callKarmaTextAi(
    { system: 'Return JSON.', user: 'Test.', lang: 'ko' },
    type, env, null, type, contractContext
  );
  check(calls === 2, `${type} 불완전 응답을 한 번 재시도`);
  check(result?.advice === text, `${type} 재시도 후 완전한 응답만 반환`);
}

async function testPersistentContractFailure() {
  let calls = 0;
  const env = {
    AI: {
      async complete() {
        calls++;
        return { text: '{}', usage: {}, model: 'test-model', provider: 'test' };
      },
    },
  };
  const result = await api.callKarmaTextAi(
    { system: 'Return JSON.', user: 'Test.', lang: 'ko' },
    'tarot', env, null, 'tarot'
  );
  check(calls === 3, '타로 계약 불일치가 계속되면 세 번만 시도');
  check(result === null, '타로 불완전 응답을 성공값으로 반환하지 않음');
}

async function testUnifiedVisionRoute() {
  let request = null;
  const env = {
    AI: {
      async analyze(input) {
        request = input;
        return { text: JSON.stringify(face), model: 'google/gemma-4-31b-it', provider: 'openrouter' };
      },
    },
  };
  const result = await api.callKarmaVisionAi(
    'Analyze this face.',
    'https://example.com/face.jpg',
    env,
    'ko',
    'face'
  );
  check(request?.appId === 'karma', '관상·손금 요청이 Karma 전용 모델 범위를 사용');
  check(request?.media?.[0]?.type === 'image', '관상·손금 요청이 이미지 입력을 전달');
  check(!Object.prototype.hasOwnProperty.call(request || {}, 'cacheKey'), '고유 이미지 요청에는 텍스트 접두사 캐시 키를 보내지 않음');
  check(result?.overall_score === face.overall_score, '관상·손금 응답이 공통 계약 검증을 통과');
}

async function testTextPromptCacheAffinity() {
  const requests = [];
  const env = {
    AI: {
      async complete(input) {
        requests.push(clone(input));
        return {
          text: JSON.stringify(fortune),
          usage: {},
          model: 'google/gemma-4-31b-it',
          provider: 'openrouter',
          providerName: 'Venice',
          providerRoute: 'openrouter:venice',
        };
      },
    },
  };

  await api.callKarmaTextAi(
    { system: 'Stable fortune contract.', user: 'Private birth input A.', lang: 'ko' },
    'fortune', env, null, 'fortune'
  );
  await api.callKarmaTextAi(
    { system: 'Stable fortune contract.', user: 'Different private birth input B.', lang: 'ko' },
    'fortune', env, null, 'fortune'
  );
  await api.callKarmaTextAi(
    { system: 'Changed fortune contract.', user: 'Private birth input A.', lang: 'ko' },
    'fortune', env, null, 'fortune'
  );

  check(requests.every(request => request.cacheKey?.startsWith('karma:fortune:fortune:ko:s')), 'Karma 텍스트 요청이 범위가 명시된 안정 캐시 키를 전달');
  check(requests[0]?.cacheKey === requests[1]?.cacheKey, '개인별 사용자 입력이 달라도 같은 시스템 접두사는 캐시 계보를 공유');
  check(requests[0]?.cacheKey !== requests[2]?.cacheKey, '시스템 계약이 바뀌면 Karma 캐시 계보를 분리');
  check(!requests.some(request => request.cacheKey.includes('Private') || request.cacheKey.includes('birth')), '개인 입력은 Karma 캐시 키에 포함하지 않음');
}

async function testContractPatchRetry(type, partial, patch, contractContext, verify) {
  let calls = 0;
  let retrySystem = '';
  const env = {
    AI: {
      async complete(input) {
        calls++;
        if (calls === 2) retrySystem = input.messages?.[0]?.content || '';
        return {
          text: JSON.stringify(calls === 1 ? partial : patch),
          usage: {},
          model: 'test-model',
          provider: 'test',
        };
      },
    },
  };
  const result = await api.callKarmaTextAi(
    { system: 'Return JSON.', user: 'Test.', lang: 'ko' },
    type, env, null, type, contractContext
  );
  check(calls === 2, `${type} 재시도가 누락 필드 패치를 요청`);
  check(retrySystem.includes('ONLY the missing or invalid fields'), `${type} 재시도가 전체 응답을 반복하지 않음`);
  check(verify(result), `${type} 기존 필드와 재시도 패치를 병합`);
}

Promise.resolve()
  .then(() => testContractRetry('fortune', { year_summary: text }, fortune))
  .then(() => testContractRetry('saju', { pillar_reading: text }, saju, { hasTime: true, daeunCount: 8 }))
  .then(() => testContractRetry('tarot', { cards: [] }, tarot))
  .then(() => testContractPatchRetry(
    'saju',
    { pillar_reading: saju.pillar_reading, personality: text, strengths: saju.strengths, cautions: saju.cautions },
    { love_style: text, career: text, daeun_reading: saju.daeun_reading, advice: text },
    { hasTime: true, daeunCount: 8 },
    result => api.validateKarmaAiContract('saju', result, { hasTime: true, daeunCount: 8 }).ok
  ))
  .then(() => testContractPatchRetry(
    'tarot',
    { cards: tarot.cards.slice(0, 1), overall: text },
    { cards: tarot.cards, advice: text, keywords: tarot.keywords },
    {},
    result => api.validateKarmaAiContract('tarot', result).ok && result.overall === text
  ))
  .then(() => testPersistentContractFailure())
  .then(() => testTextPromptCacheAffinity())
  .then(() => testUnifiedVisionRoute())
  .then(() => {
  console.log(`\n결과: ${passed}개 통과, ${failures.length}개 실패`);
  if (failures.length) process.exit(1);
}).catch(error => {
  console.error(error);
  process.exit(1);
});
