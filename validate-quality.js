const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = __dirname;
const workerPath = path.join(root, 'assets', 'js', 'worker.js');
let workerSource = fs.readFileSync(workerPath, 'utf8');
workerSource = workerSource.replace('export default {', 'const __workerExport = {');
workerSource += `\nglobalThis.__karmaTest = { calculateSaju, buildTarotPrompt, buildSajuPrompt, buildFortunePrompt, buildDailyPrompt, buildCompatPrompt, ohangCompatibility, getGrade, parseAiJsonResponse, normalizePhotoAnalysisLang, getPhotoAnalysisMessage, getKarmaTextAnalysisMessage, koreanResponseStyleGuide, karmaAiLanguageInstruction, validateKarmaAiContract, sanitizeKarmaAnalysisInput };`;

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
check(workerSource.includes("'Content-Type': 'application/json; charset=utf-8'"), 'API JSON 응답에 UTF-8 문자셋 명시');
check(api.normalizePhotoAnalysisLang('en-US') === 'en' && api.normalizePhotoAnalysisLang('ko-KR') === 'ko', '사진 분석 요청 언어 정규화');
check(!/[가-힣]/.test(api.getPhotoAnalysisMessage('en', 'faceRejected')), '영문 관상 거절 사유에 한글 없음');
check(!/[가-힣]/.test(api.getPhotoAnalysisMessage('en', 'palmRejected')), '영문 손금 거절 사유에 한글 없음');
check(/[가-힣]/.test(api.getPhotoAnalysisMessage('ko', 'faceRejected')), '한글 관상 거절 사유 제공');
check(/[가-힣]/.test(api.getPhotoAnalysisMessage('ko', 'palmRejected')), '한글 손금 거절 사유 제공');
for (const key of ['incompleteAiResponse', 'tarotCardsRequired', 'invalidCardIds', 'aiUnavailable', 'serverError', 'birthDateRequired', 'bothBirthDatesRequired']) {
  check(!/[가-힣]/.test(api.getKarmaTextAnalysisMessage('en', key)), `영문 ${key} 오류 응답에 한글 없음`);
  check(/[가-힣]/.test(api.getKarmaTextAnalysisMessage('ko', key)), `한글 ${key} 오류 응답 제공`);
}
check(
  /keywords:\s*responseLang === 'en' \? \(ai\.keywords\?\.\[i\] \|\| ''\)/.test(workerSource),
  '영문 타로 카드별 키워드에 한국어 원본을 노출하지 않음',
);
check(api.koreanResponseStyleGuide('en') === '', '영문 AI 응답에는 한국어 문체 가드를 추가하지 않음');
check(api.koreanResponseStyleGuide('ko').includes('처음부터 한국어로 쓴 글'), '한국어 AI 응답에 원문체 가드 제공');
check(api.koreanResponseStyleGuide('ko').includes('JSON 키·구조·고정값'), '한국어 문체 가드가 구조화 응답 계약을 보존');
check(api.koreanResponseStyleGuide('ko').includes('처음 접하는 일반인'), '한국어 AI 응답이 비전문 독자를 기준으로 작성됨');
check(api.koreanResponseStyleGuide('ko').includes('결론부터 말하고'), '한국어 AI 응답이 생활 의미를 먼저 설명함');
check(api.koreanResponseStyleGuide('ko').includes('전문 용어는 내부 판단 근거로만'), '한국어 AI 응답에서 전문 용어 노출을 줄임');
check(api.koreanResponseStyleGuide('ko').includes('[근거: ...]'), '한국어 AI 응답의 근거 표기도 쉬운 말로 풀어 씀');
check(api.koreanResponseStyleGuide('ko').includes('바로 실행할 수 있게'), '한국어 AI 조언이 구체적인 행동으로 이어짐');
check(api.karmaAiLanguageInstruction('en').includes('Do not output Hangul'), '영문 AI 응답에 한글·한자 금지 지시 제공');
check(api.karmaAiLanguageInstruction('ko').includes('영문 단어나 로마자 표기'), '한국어 AI 응답에 영문 혼용 금지 지시 제공');
const languagePureSaju = {
  pillar_reading: { year: 'Year reading.', month: 'Month reading.', day: 'Day reading.', hour: 'Hour reading.' },
  personality: 'Personality reading.',
  strengths: ['Strength one.', 'Strength two.', 'Strength three.'],
  cautions: ['Caution one.', 'Caution two.', 'Caution three.'],
  love_style: 'Love reading.',
  career: 'Career reading.',
  daeun_reading: ['Cycle reading.'],
  advice: 'Advice.',
};
check(
  api.validateKarmaAiContract('saju', languagePureSaju, { hasTime: true, daeunCount: 1, lang: 'en' }).ok,
  '영문 사주 계약은 영문 전용 응답을 허용',
);
const mixedEnglishSaju = JSON.parse(JSON.stringify(languagePureSaju));
mixedEnglishSaju.career = 'Career guidance with 추진력.';
check(
  api.validateKarmaAiContract('saju', mixedEnglishSaju, { hasTime: true, daeunCount: 1, lang: 'en' }).errors.includes('career:english_only'),
  '영문 사주 응답의 한글 혼용을 계약 오류로 거절',
);
const mixedKoreanFortune = {
  year_summary: '올해의 흐름입니다.', love: '관계 흐름입니다.', money: '재물 흐름입니다.',
  health: '건강 흐름입니다.', career: 'Career advice.', advice: '조언입니다.',
  lucky: { color: '파랑', number: 7, direction: '동쪽', month: 9 },
};
check(
  api.validateKarmaAiContract('fortune', mixedKoreanFortune, { lang: 'ko' }).errors.includes('career:korean_only'),
  '한국어 운세 응답의 영문 혼용을 계약 오류로 거절',
);
const mixedEnglishPalm = {
  overall_score: 70, overall_grade: 'B', quality_assessment: 'Clear photo.',
  visual_evidence: Array.from({ length: 8 }, (_, index) => `Visible detail ${index + 1}.`),
  summary: 'Summary.', advice: 'Advice.',
  lines: Array.from({ length: 6 }, (_, index) => ({ name: `Line ${index + 1}`, length: 'Long', score: 70, desc: 'Description.' })),
  hand_shape: { type: 'Earth Type (흙형)', desc: 'Description.' },
  fortune: { wealth: 'Wealth.', career: 'Career.', love: 'Love.', health: 'Health.' },
};
check(
  api.validateKarmaAiContract('palm', mixedEnglishPalm, { lang: 'en' }).errors.includes('hand_shape.type:english_only'),
  '영문 손금 응답의 한글 유형명을 계약 오류로 거절',
);
check(workerSource.includes('accumulated = mergeAiContractPatch(accumulated, parsed)'), '사진 분석 재시도도 언어 오류 필드 패치를 병합');
check(workerSource.includes('prompt: modelPrompt'), '사진 분석에도 한국어 원문체 가드를 전달');
for (const page of ['face', 'face-en', 'palm', 'palm-en']) {
  const html = fs.readFileSync(path.join(root, `${page}.html`), 'utf8');
  check(html.indexOf('await resp.json()') < html.indexOf('!resp.ok'), `${page} 오류 응답 본문을 상태 코드보다 먼저 해석`);
}
const firstJsonOnly = api.parseAiJsonResponse('{"value":1}\n{"ignored":2}');
check(firstJsonOnly.value === 1 && firstJsonOnly.ignored === undefined, 'AI parser keeps the first complete JSON object');
const repairedComma = api.parseAiJsonResponse('{"first":"one"\n"second":"two"}');
check(repairedComma.first === 'one' && repairedComma.second === 'two', 'AI parser repairs a missing property comma');
const braceInString = api.parseAiJsonResponse('{"text":"brace } stays in text","ok":true} trailing');
check(braceInString.ok === true, 'AI parser ignores braces inside strings');
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

console.log('\n🗄️ D1 분석 기록');
for (const type of ['saju', 'fortune', 'daily', 'tarot', 'compat', 'face', 'palm']) {
  check(workerSource.includes(`ctx, '${type}',`), `${type} API 응답이 공통 D1 기록 경로에 연결됨`);
}
check(workerSource.includes('CREATE TABLE IF NOT EXISTS karma_analyses'), '통합 Karma 분석 테이블 생성 계약 존재');
check(workerSource.includes('INSERT OR IGNORE INTO karma_analyses'), '기존 관상·손금 기록 자동 편입 계약 존재');
check(!workerSource.includes('promptPreview'), 'AI 오류 로그에 사용자 프롬프트 원문을 저장하지 않음');
check(workerSource.includes('promptChars: _contentsSize'), 'AI 오류 로그에는 비식별 프롬프트 길이만 저장');
const sanitizedImageInput = api.sanitizeKarmaAnalysisInput({
  image: 'aGVsbG8=',
  nested: { image_data: 'd29ybGQ=', note: 'keep this' },
});
check(/^\[image omitted:/.test(sanitizedImageInput.image), '원본 이미지 base64를 D1 입력 JSON에서 제거');
check(/^\[image omitted:/.test(sanitizedImageInput.nested.image_data), '중첩 이미지 base64도 D1 입력 JSON에서 제거');
check(sanitizedImageInput.nested.note === 'keep this', '이미지가 아닌 입력 데이터는 D1 기록에 보존');

console.log(`\n결과: ${passed}개 통과, ${failures.length}개 실패`);
if (failures.length) process.exit(1);
