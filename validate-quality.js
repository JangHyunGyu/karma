const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = __dirname;
const workerPath = path.join(root, 'assets', 'js', 'worker.js');
let workerSource = fs.readFileSync(workerPath, 'utf8');
workerSource = workerSource.replace('export default {', 'const __workerExport = {');
workerSource += `\nglobalThis.__karmaTest = { calculateSaju, buildTarotPrompt, buildSajuPrompt, buildFortunePrompt, buildDailyPrompt, buildCompatPrompt, ohangCompatibility, getGrade };`;

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

const api = context.__karmaTest;
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

function metaContent(html, attr, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<meta[^>]+${attr}="${escaped}"[^>]+content="([^"]+)"`, 'i'));
  return match?.[1] || '';
}

console.log('\n🔎 한국어 검색 랜딩 품질');
const koPages = ['index', 'saju', 'daily', 'fortune', 'compat', 'tarot', 'face', 'palm', '2026', 'mbti-saju'];
const titles = new Set();
const descriptions = new Set();
for (const page of koPages) {
  const file = path.join(root, `${page}.html`);
  const html = fs.readFileSync(file, 'utf8');
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1] || '';
  const description = metaContent(html, 'name', 'description');
  check(title.length > 0 && title.length <= 40, `${page} 제목 40자 이내 (${title.length})`);
  check(description.length > 0 && description.length <= 80, `${page} 설명 80자 이내 (${description.length})`);
  check(!/직접 만든|MBTI보다 정확|챗GPT 기반/.test(title + description), `${page} 아마추어·과장 문구 없음`);
  titles.add(title);
  descriptions.add(description);
}
check(titles.size === koPages.length, '한국어 제목이 페이지별로 고유함');
check(descriptions.size === koPages.length, '한국어 설명이 페이지별로 고유함');
for (const page of ['saju', 'daily', 'fortune', 'compat', 'tarot', 'face', 'palm']) {
  const html = fs.readFileSync(path.join(root, `${page}.html`), 'utf8');
  check(html.includes('class="seo-content"'), `${page}에 크롤링 가능한 서비스 안내 본문 존재`);
}

console.log('\n🧭 사주 프롬프트 근거·변별력');
const samples = [
  { birth: '1991-02-03', time: '07:30', gender: 'female' },
  { birth: '1991-08-19', time: '21:10', gender: 'female' },
  { birth: '1984-11-27', time: '13:40', gender: 'male' },
];
const sajuPrompts = samples.map(sample => {
  const saju = api.calculateSaju(sample.birth, sample.time, sample.gender, false, 'utc+9');
  return { sample, saju, prompt: api.buildSajuPrompt(saju, sample.gender, 'ko', sample.birth) };
});
const fingerprints = sajuPrompts.map(({ prompt }) => prompt.user.match(/원국 지문: ([^\n]+)/)?.[1]);
check(new Set(fingerprints).size === samples.length, '서로 다른 생년월일의 원국 지문이 모두 다름');
for (const { sample, prompt } of sajuPrompts) {
  check(prompt.user.includes('일간 기준 역할별 표면 분포'), `${sample.birth} 십성 역할별 표면 수 포함`);
  check(prompt.user.includes('현재 대운:'), `${sample.birth} 현재 대운 판별값 포함`);
  check(prompt.system.includes('신강/신약, 용신, 희신을 확정하지 마세요'), `${sample.birth} 미계산 신강·용신 확정 금지`);
  check(prompt.system.includes('[근거: 실제 입력값]'), `${sample.birth} 근거 표기 요구`);
}

console.log('\n📅 세운·일진 프롬프트 계산 근거');
const first = sajuPrompts[0];
const fortune = api.buildFortunePrompt(first.saju, first.sample.gender, 2026, 'ko', first.sample.birth);
const daily = api.buildDailyPrompt(first.saju, first.sample.gender, '2026-07-16', 'ko', first.sample.birth);
check((fortune.user.match(/월 중순 대표 월주/g) || []).length === 12, '신년운세에 12개월 대표 월주 신호 포함');
check(fortune.user.includes('2026년 기준 현재 대운:'), '신년운세에 대상 연도 현재 대운 포함');
check(fortune.system.includes('사건을 만들어내지 말고'), '신년운세 사건 창작 금지');
check((daily.user.match(/시 .*:/g) || []).length >= 12, '오늘운세에 12개 시간주 신호 포함');
check(daily.user.includes('오늘 기준 현재 대운:'), '오늘운세에 대상 날짜 현재 대운 포함');
check(daily.system.includes('실제 사건을 예언하지 말고'), '오늘운세 사건 예언 금지');

console.log('\n🤝 궁합·타로·사진 프롬프트 안전성과 개인화');
const second = sajuPrompts[1];
const score = api.ohangCompatibility(first.saju, second.saju);
const compat = api.buildCompatPrompt(first.saju, second.saju, score, api.getGrade(score), first.sample.gender, second.sample.gender, 'ko', first.sample.birth, second.sample.birth);
const pairScores = [
  api.ohangCompatibility(sajuPrompts[0].saju, sajuPrompts[1].saju),
  api.ohangCompatibility(sajuPrompts[0].saju, sajuPrompts[2].saju),
  api.ohangCompatibility(sajuPrompts[1].saju, sajuPrompts[2].saju),
];
check(new Set(pairScores).size >= 2, `궁합 점수가 원국 조합별로 달라짐 (${pairScores.join(', ')})`);
check((compat.user.match(/원국 지문:/g) || []).length === 2, '궁합에 두 사람 원국 지문 포함');
check((compat.user.match(/현재 대운:/g) || []).length === 2, '궁합에 두 사람 현재 대운 포함');
check(compat.system.includes('외도·이혼·성욕·질병·재산 손실'), '궁합의 민감한 사실 추정 금지');

const cards = [
  { id: 0, name: 'The Fool', nameKo: '바보', up: '시작', rev: '무모함', imagery: '절벽', reversed: false },
  { id: 1, name: 'The Magician', nameKo: '마법사', up: '실행', rev: '미숙함', imagery: '도구', reversed: true },
  { id: 2, name: 'The High Priestess', nameKo: '여사제', up: '직관', rev: '혼란', imagery: '기둥', reversed: false },
];
const tarot = api.buildTarotPrompt(cards, '', 'ko');
check(tarot.system.includes('미래를 확정하지 않습니다'), '타로 미래 확정 금지');
check(tarot.system.includes('외도·질병·임신·범죄·법적 결과·투자 성과'), '타로 고위험 사실 추정 금지');
check(tarot.user.includes('현실 영역 하나만'), '무질문 타로가 한 영역을 선택해 일반론을 줄임');

check(workerSource.includes('celebrity_resemblance는 항상 빈 문자열'), '관상 실존 인물 식별 금지');
check(workerSource.includes('손금은 오락·자기성찰용 전통 해석'), '손금 결과의 전통 해석 한계 명시');
check(!workerSource.includes('수위 제한 없음'), '궁합의 무근거 성행동 추정 지시 제거');
check(!workerSource.includes('몇 살 즈음 특히 조심해야'), '사주의 무근거 발병 시기 지시 제거');

console.log(`\n결과: ${passed}개 통과, ${failures.length}개 실패`);
if (failures.length) process.exit(1);
