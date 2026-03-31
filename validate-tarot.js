#!/usr/bin/env node
// Karma 타로 기능 검증 스크립트
// 실행: node validate-tarot.js

const fs = require('fs');
const path = require('path');

let errors = 0;
let warnings = 0;
let passed = 0;

function pass(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.error(`  ❌ ${msg}`); errors++; }
function warn(msg) { console.warn(`  ⚠️  ${msg}`); warnings++; }

// ============================================================
// 1. 파일 존재 여부 검증
// ============================================================
console.log('\n📁 [1] 파일 존재 여부');

const requiredFiles = [
  'tarot.html',
  'tarot-en.html',
  'index.html',
  'index-en.html',
  'assets/js/worker.js',
  'style.css',
  'js/components.js',
];

for (const f of requiredFiles) {
  const fp = path.join(__dirname, f);
  if (fs.existsSync(fp)) pass(`${f} 존재`);
  else fail(`${f} 없음`);
}

// ============================================================
// 2. worker.js 검증
// ============================================================
console.log('\n🔧 [2] worker.js 타로 API 검증');

const workerSrc = fs.readFileSync(path.join(__dirname, 'assets/js/worker.js'), 'utf8');

// 타로 카드 데이터 22장
const arcanaMatch = workerSrc.match(/TAROT_MAJOR_ARCANA\s*=\s*\[([\s\S]*?)\];/);
if (arcanaMatch) {
  const idMatches = arcanaMatch[1].match(/id:\s*(\d+)/g);
  if (idMatches && idMatches.length === 22) pass('TAROT_MAJOR_ARCANA 22장 정의됨');
  else fail(`TAROT_MAJOR_ARCANA 카드 수: ${idMatches ? idMatches.length : 0}장 (22장 필요)`);
} else {
  fail('TAROT_MAJOR_ARCANA 배열을 찾을 수 없음');
}

// 필수 함수 존재
if (/function\s+buildTarotPrompt/.test(workerSrc)) pass('buildTarotPrompt 함수 존재');
else fail('buildTarotPrompt 함수 없음');

if (/function\s+handleTarotReading/.test(workerSrc)) pass('handleTarotReading 함수 존재');
else fail('handleTarotReading 함수 없음');

// 라우트 등록
if (/\/api\/tarot[\s\S]{0,100}handleTarotReading/.test(workerSrc)) pass('/api/tarot 라우트 등록됨');
else fail('/api/tarot 라우트 미등록');

// 프롬프트 내 JSON 형식 지시
if (/buildTarotPrompt[\s\S]*?"cards"[\s\S]*?"overall"[\s\S]*?"advice"[\s\S]*?"keywords"/.test(workerSrc)) {
  pass('타로 프롬프트에 JSON 응답 형식 지정됨');
} else {
  fail('타로 프롬프트에 JSON 응답 형식 누락');
}

// callGemini 호출 확인
if (/callGemini\(apiKeys,\s*prompt,\s*'tarot'/.test(workerSrc)) pass("callGemini 호출 시 caller='tarot' 전달");
else fail('callGemini 호출 패턴 불일치');

// 카드 검증 (3장 필수)
if (/selectedCards\.length\s*!==\s*3/.test(workerSrc)) pass('카드 3장 검증 로직 존재');
else fail('카드 3장 검증 로직 없음');

// lang 파라미터 처리
if (/lang\s*\|\|\s*'ko'/.test(workerSrc)) pass('lang 기본값 ko 처리');
else fail('lang 기본값 처리 없음');

// 영문 프롬프트 분기
if (/isEn[\s\S]*?You are a professional tarot reader/.test(workerSrc)) pass('영문 프롬프트 분기 존재');
else fail('영문 프롬프트 분기 없음');

// ============================================================
// 3. tarot.html 검증
// ============================================================
console.log('\n🎴 [3] tarot.html 검증');

const tarotHtml = fs.readFileSync(path.join(__dirname, 'tarot.html'), 'utf8');

// GSAP CDN (Three.js 제거됨)
if (!/three\.min\.js/.test(tarotHtml)) pass('Three.js 제거 확인 (2D 전환)');
else fail('Three.js가 아직 남아있음');
if (/gsap\.min\.js/.test(tarotHtml)) pass('GSAP CDN 포함');
else fail('GSAP CDN 없음');

// lang="ko"
if (/lang="ko"/.test(tarotHtml)) pass('lang="ko" 설정');
else fail('lang 설정 오류');

// hreflang 링크
if (/hreflang="ko".*tarot\.html/.test(tarotHtml)) pass('hreflang ko 링크');
else fail('hreflang ko 링크 없음');
if (/hreflang="en".*tarot-en\.html/.test(tarotHtml)) pass('hreflang en 링크');
else fail('hreflang en 링크 없음');

// 카드 그리드
if (/tarotGrid/.test(tarotHtml)) pass('카드 그리드 요소 존재');
else fail('카드 그리드 없음');

// API 호출
if (/\/api\/tarot/.test(tarotHtml)) pass('API 엔드포인트 /api/tarot 호출');
else fail('API 호출 없음');

// 카드 22장 데이터
const frontCardIds = tarotHtml.match(/id:\s*(\d+),\s*name:/g);
if (frontCardIds && frontCardIds.length === 22) pass('프론트엔드 카드 데이터 22장');
else fail(`프론트엔드 카드 데이터: ${frontCardIds ? frontCardIds.length : 0}장`);

// CSS 카드 플립 애니메이션
if (/cardFlip/.test(tarotHtml)) pass('CSS 카드 플립 애니메이션');
else fail('카드 플립 없음');

// GSAP 딜링 애니메이션
if (/gsap\.to/.test(tarotHtml)) pass('GSAP 딜링 애니메이션 사용');
else fail('GSAP 애니메이션 없음');

// 파티클 이펙트
if (/createRevealParticles/.test(tarotHtml)) pass('파티클 이펙트 존재');
else fail('파티클 이펙트 없음');

// 배경 별
if (/createStars|stars-bg/.test(tarotHtml)) pass('배경 별 이펙트 존재');
else fail('배경 별 없음');

// 카드 뒷면 디자인
if (/card-back/.test(tarotHtml)) pass('카드 뒷면 디자인 존재');
else fail('카드 뒷면 없음');

// 역방향/정방향 처리
if (/reversed/.test(tarotHtml)) pass('역방향(reversed) 처리 로직');
else fail('역방향 처리 없음');

// 결과 표시
if (/showResult/.test(tarotHtml)) pass('showResult 함수 존재');
else fail('showResult 없음');
if (/showError/.test(tarotHtml)) pass('showError 함수 존재');
else fail('showError 없음');

// 카드 이미지 결과 표시
if (/tarot-cards-display/.test(tarotHtml)) pass('결과에 카드 이미지 표시');
else fail('결과 카드 이미지 없음');

// 카드 떠다니는 효과
if (/cardFloat/.test(tarotHtml)) pass('카드 플로팅 애니메이션');
else fail('카드 플로팅 없음');

// components.js 로드
if (/components\.js/.test(tarotHtml)) pass('components.js 로드');
else fail('components.js 미로드');

// GA 추적
if (/G-0RMB9BSYM1/.test(tarotHtml)) pass('Google Analytics 추적 코드');
else fail('GA 추적 코드 없음');

// SEO 메타 태그
if (/og:title/.test(tarotHtml)) pass('og:title 메타태그');
else fail('og:title 없음');
if (/og:description/.test(tarotHtml)) pass('og:description 메타태그');
else fail('og:description 없음');

// 반응형 그리드
if (/grid-template-columns.*repeat/.test(tarotHtml)) pass('반응형 카드 그리드');
else fail('반응형 그리드 없음');

// ============================================================
// 4. tarot-en.html 검증
// ============================================================
console.log('\n🌐 [4] tarot-en.html 검증');

const tarotEnHtml = fs.readFileSync(path.join(__dirname, 'tarot-en.html'), 'utf8');

if (/lang="en"/.test(tarotEnHtml)) pass('lang="en" 설정');
else fail('lang="en" 설정 오류');

if (/canonical.*tarot-en\.html/.test(tarotEnHtml)) pass('canonical URL 올바름');
else fail('canonical URL 오류');

if (/og:url.*tarot-en\.html/.test(tarotEnHtml)) pass('og:url 올바름');
else fail('og:url 오류');

if (/selected.*English/.test(tarotEnHtml)) pass('영어 옵션 selected');
else fail('영어 옵션 selected 없음');

if (/AI Tarot Reading/.test(tarotEnHtml)) pass('영문 페이지 제목');
else fail('영문 페이지 제목 없음');

// ============================================================
// 5. index.html 메뉴 검증
// ============================================================
console.log('\n📋 [5] index.html 메뉴 검증');

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const indexEnHtml = fs.readFileSync(path.join(__dirname, 'index-en.html'), 'utf8');

if (/tarot\.html/.test(indexHtml)) pass('index.html에 타로 메뉴 링크 존재');
else fail('index.html에 타로 메뉴 없음');

if (/tarot-en\.html/.test(indexEnHtml)) pass('index-en.html에 타로 메뉴 링크 존재');
else fail('index-en.html에 타로 메뉴 없음');

// 메뉴 순서 확인 (궁합 다음, 관상 앞)
const koMenuOrder = indexHtml.match(/onclick="location\.href='\/([^']+)'/g);
if (koMenuOrder) {
  const pages = koMenuOrder.map(m => m.match(/'\/([^']+)'/)[1]);
  const tarotIdx = pages.indexOf('tarot.html');
  const faceIdx = pages.indexOf('face.html');
  const compatIdx = pages.indexOf('compat.html');
  if (tarotIdx > compatIdx && tarotIdx < faceIdx) pass('메뉴 순서: 궁합 → 타로 → 관상');
  else fail(`메뉴 순서 오류: compat(${compatIdx}), tarot(${tarotIdx}), face(${faceIdx})`);
} else {
  fail('메뉴 항목을 파싱할 수 없음');
}

// ============================================================
// 6. Wikimedia 이미지 URL 검증
// ============================================================
console.log('\n🖼️  [6] 카드 이미지 URL 검증');

// 이미지 URL 함수 존재 확인
if (/getCardImageUrl/.test(tarotHtml)) pass('getCardImageUrl 함수 존재');
else fail('getCardImageUrl 함수 없음');

// 로컬 이미지 경로 사용 확인
if (/\/images\/tarot\//.test(tarotHtml)) pass('로컬 이미지 경로 사용 (/images/tarot/)');
else fail('로컬 이미지 경로 없음');

// 이미지 파일 22장 존재 확인
const tarotImgDir = path.join(__dirname, 'images', 'tarot');
if (fs.existsSync(tarotImgDir)) {
  const imgFiles = fs.readdirSync(tarotImgDir).filter(f => f.endsWith('.webp'));
  if (imgFiles.length === 22) pass(`이미지 파일 22장 존재 (WebP)`);
  else fail(`이미지 파일 수: ${imgFiles.length}개 (22개 필요)`);
} else {
  fail('images/tarot/ 디렉토리 없음');
}

// ============================================================
// 7. 데이터 일관성 검증 (worker ↔ frontend)
// ============================================================
console.log('\n🔗 [7] worker ↔ frontend 데이터 일관성');

// worker와 frontend에서 같은 카드 ID 사용하는지 확인
const workerIds = (workerSrc.match(/id:\s*(\d+),\s*name:\s*'[^']+',\s*nameKo/g) || [])
  .map(m => parseInt(m.match(/id:\s*(\d+)/)[1]));
const frontIds = (tarotHtml.match(/id:\s*(\d+),\s*name:\s*'[^']+',\s*nameKo/g) || [])
  .map(m => parseInt(m.match(/id:\s*(\d+)/)[1]));

if (workerIds.length === frontIds.length && workerIds.every((id, i) => id === frontIds[i])) {
  pass('worker와 frontend 카드 ID 일치');
} else {
  fail(`카드 ID 불일치: worker=${workerIds.length}장, frontend=${frontIds.length}장`);
}

// 카드 이름 일치 확인
const workerNames = (workerSrc.match(/name:\s*'([^']+)',\s*nameKo/g) || []).map(m => m.match(/name:\s*'([^']+)'/)[1]);
const frontNames = (tarotHtml.match(/name:\s*'([^']+)',\s*nameKo/g) || []).map(m => m.match(/name:\s*'([^']+)'/)[1]);

if (workerNames.length === frontNames.length && workerNames.every((n, i) => n === frontNames[i])) {
  pass('worker와 frontend 카드 이름 일치');
} else {
  fail('카드 이름 불일치');
  const diff = workerNames.filter((n, i) => n !== frontNames[i]);
  if (diff.length) console.log(`    불일치: ${diff.join(', ')}`);
}

// ============================================================
// 8. 보안 검증
// ============================================================
console.log('\n🔒 [8] 보안 검증');

// API 키가 프론트엔드에 노출되지 않는지
if (!/GEMINI_API_KEY/.test(tarotHtml)) pass('프론트엔드에 API 키 노출 없음');
else fail('프론트엔드에 API 키 노출됨!');

// XSS 방지 — innerHTML에 사용자 입력이 직접 들어가지 않는지
// (질문은 서버로 보내지고, 결과는 AI 응답만 표시)
if (/tarotQuestion\.value\.trim\(\)/.test(tarotHtml)) pass('사용자 입력 trim 처리');
else warn('사용자 입력 trim 확인 필요');

if (/maxlength="100"/.test(tarotHtml)) pass('질문 입력 길이 제한(100자)');
else warn('질문 입력 길이 제한 없음');

// ============================================================
// 9. 모바일 대응 검증
// ============================================================
console.log('\n📱 [9] 모바일 대응');

if (/@media.*max-width.*480/.test(tarotHtml)) pass('모바일 미디어쿼리 존재');
else warn('모바일 미디어쿼리 확인 필요');

if (/@media.*min-width.*600/.test(tarotHtml)) pass('태블릿 미디어쿼리 존재');
else warn('태블릿 미디어쿼리 확인 필요');

if (/aspect-ratio/.test(tarotHtml)) pass('카드 비율(aspect-ratio) 설정');
else warn('카드 비율 미설정');

if (/clamp\(/.test(tarotHtml)) pass('반응형 폰트 크기(clamp) 사용');
else warn('반응형 폰트 미사용');

// ============================================================
// 결과 요약
// ============================================================
console.log('\n' + '='.repeat(50));
console.log(`📊 검증 결과: ✅ ${passed}개 통과 | ❌ ${errors}개 실패 | ⚠️  ${warnings}개 경고`);
console.log('='.repeat(50));

if (errors > 0) {
  console.log('\n🚨 실패 항목을 수정하세요!');
  process.exit(1);
} else if (warnings > 0) {
  console.log('\n✨ 모든 필수 검증 통과! (경고 항목은 확인 권장)');
  process.exit(0);
} else {
  console.log('\n🎉 모든 검증 통과! 타로 기능 구현 완료!');
  process.exit(0);
}
