const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = __dirname;
const workerPath = path.join(root, 'assets', 'js', 'worker.js');
let workerSource = fs.readFileSync(workerPath, 'utf8');
workerSource = workerSource.replace('export default {', 'const __workerExport = {');
workerSource += `\nglobalThis.__karmaContracts = { validateKarmaAiContract, callDeepSeekText };`;

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
const face = {
  overall_score: 82,
  overall_grade: 'B+',
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

const fixtures = { fortune, daily, compat, face, palm };

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
check(api.validateKarmaAiContract('face', { error: '얼굴 사진이 아닙니다.' }).ok, '관상 사진 거절 JSON 허용');
check(api.validateKarmaAiContract('palm', { error: '손바닥 사진이 아닙니다.' }).ok, '손금 사진 거절 JSON 허용');

console.log('\n🔗 프롬프트 ↔ 화면 필드 매칭');
const pageContracts = {
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
  fortune: ['year_summary', 'love', 'money', 'health', 'career', 'lucky', 'color', 'number', 'direction', 'month', 'advice'],
  daily: ['overall', 'love', 'money', 'career', 'study', 'social', 'health', 'lucky', 'color', 'number', 'advice'],
  compat: ['summary', 'categories', 'personality', 'intimacy', 'finance', 'timing', 'strengths', 'cautions', 'advice'],
  face: ['overall_score', 'overall_grade', 'quality_assessment', 'visual_evidence', 'summary', 'categories', 'fortune', 'wealth', 'career', 'love', 'health', 'advice', 'celebrity_resemblance'],
  palm: ['overall_score', 'overall_grade', 'quality_assessment', 'visual_evidence', 'summary', 'lines', 'hand_shape', 'fortune', 'wealth', 'career', 'love', 'health', 'advice'],
};
for (const [type, keys] of Object.entries(promptKeys)) {
  for (const key of keys) check(workerSource.includes(`"${key}"`), `${type} 프롬프트에 ${key} 키 명시`);
}

async function testContractRetry() {
  let calls = 0;
  const env = {
    DEEPSEEK_TEXT: {
      async complete() {
        calls++;
        return {
          text: JSON.stringify(calls === 1 ? { year_summary: text } : fortune),
          usage: {},
          model: 'test-model',
          provider: 'test',
        };
      },
    },
  };
  const result = await api.callDeepSeekText(
    { system: 'Return JSON.', user: 'Test.', lang: 'ko' },
    'fortune', env, null, 'fortune'
  );
  check(calls === 2, '불완전한 텍스트 응답을 한 번 재시도');
  check(result?.advice === text, '재시도 후 완전한 응답만 반환');
}

testContractRetry().then(() => {
  console.log(`\n결과: ${passed}개 통과, ${failures.length}개 실패`);
  if (failures.length) process.exit(1);
}).catch(error => {
  console.error(error);
  process.exit(1);
});
