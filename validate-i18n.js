#!/usr/bin/env node
// Karma KO/EN 페이지 쌍 동기화 검증 스크립트
// 실행: node validate-i18n.js

const fs = require('fs');
const path = require('path');

let errors = 0;
let warnings = 0;
let passed = 0;

function pass(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.error(`  ❌ ${msg}`); errors++; }
function warn(msg) { console.warn(`  ⚠️  ${msg}`); warnings++; }

const PAIRS = [
  '2026', 'compat', 'daily', 'discover', 'face', 'fortune',
  'index', 'login', 'match', 'matches', 'palm', 'register',
  'saju', 'tarot',
];

const ORPHANS = ['mbti-saju'];

const ROOT = __dirname;

function read(name) {
  const fp = path.join(ROOT, `${name}.html`);
  if (!fs.existsSync(fp)) return null;
  return fs.readFileSync(fp, 'utf8');
}

function countMatches(html, re) {
  const m = html.match(re);
  return m ? m.length : 0;
}

function extract(html, re) {
  const m = html.match(re);
  return m ? m[1].trim() : null;
}

const STRUCT_RULES = [
  { name: '<h1>',       re: /<h1[\s>]/gi },
  { name: '<h2>',       re: /<h2[\s>]/gi },
  { name: '<h3>',       re: /<h3[\s>]/gi },
  { name: '<button>',   re: /<button[\s>]/gi },
  { name: '<input>',    re: /<input[\s>]/gi },
  { name: '<select>',   re: /<select[\s>]/gi },
  { name: '<form>',     re: /<form[\s>]/gi },
  { name: '.menu-card', re: /class="[^"]*\bmenu-card\b[^"]*"/gi },
  { name: '.entry-card',re: /class="[^"]*\bentry-card\b[^"]*"/gi },
  { name: '.card',      re: /class="[^"]*\bcard\b[^"]*"/gi },
  { name: '<script src>', re: /<script[^>]*\bsrc=/gi },
];

const META_RULES = [
  { name: 'title',           re: /<title[^>]*>([\s\S]*?)<\/title>/i,            required: true  },
  { name: 'meta description',re: /<meta[^>]*name="description"[^>]*content="([^"]*)"/i, required: true  },
  { name: 'og:title',        re: /<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i, required: true  },
  { name: 'og:description',  re: /<meta[^>]*property="og:description"[^>]*content="([^"]*)"/i, required: true  },
  { name: 'og:image',        re: /<meta[^>]*property="og:image"[^>]*content="([^"]*)"/i, required: true  },
  { name: 'og:url',          re: /<meta[^>]*property="og:url"[^>]*content="([^"]*)"/i, required: false },
  { name: 'og:locale',       re: /<meta[^>]*property="og:locale"[^>]*content="([^"]*)"/i, required: false },
  { name: 'canonical',       re: /<link[^>]*rel="canonical"[^>]*href="([^"]*)"/i, required: true  },
  { name: 'hreflang ko',     re: /<link[^>]*hreflang="ko"[^>]*href="([^"]*)"/i, required: false },
  { name: 'hreflang en',     re: /<link[^>]*hreflang="en"[^>]*href="([^"]*)"/i, required: false },
  { name: 'hreflang x-default', re: /<link[^>]*hreflang="x-default"[^>]*href="([^"]*)"/i, required: false },
];

function checkPair(base) {
  console.log(`\n🔗 [${base}] ↔ [${base}-en]`);
  const ko = read(base);
  const en = read(`${base}-en`);

  if (!ko) { fail(`${base}.html 없음`); return; }
  if (!en) { fail(`${base}-en.html 없음`); return; }

  // 1. lang 속성
  const koLang = extract(ko, /<html[^>]*\blang="([^"]*)"/i);
  const enLang = extract(en, /<html[^>]*\blang="([^"]*)"/i);
  if (koLang === 'ko') pass(`KO <html lang="ko">`);
  else fail(`KO <html lang="${koLang}"> (expected "ko")`);
  if (enLang === 'en') pass(`EN <html lang="en">`);
  else fail(`EN <html lang="${enLang}"> (expected "en")`);

  // 2. og:locale
  const koLocale = extract(ko, /<meta[^>]*property="og:locale"[^>]*content="([^"]*)"/i);
  const enLocale = extract(en, /<meta[^>]*property="og:locale"[^>]*content="([^"]*)"/i);
  if (koLocale && !koLocale.startsWith('ko')) fail(`KO og:locale="${koLocale}" (ko_KR expected)`);
  if (enLocale && !enLocale.startsWith('en')) fail(`EN og:locale="${enLocale}" (en_US expected)`);

  // 3. hreflang 상호 참조
  const koHrefEn = extract(ko, /<link[^>]*hreflang="en"[^>]*href="([^"]*)"/i);
  const enHrefKo = extract(en, /<link[^>]*hreflang="ko"[^>]*href="([^"]*)"/i);
  if (koHrefEn && koHrefEn.includes(`${base}-en`)) pass(`KO → EN hreflang 연결`);
  else if (koHrefEn) fail(`KO hreflang="en"이 ${base}-en을 가리키지 않음: ${koHrefEn}`);
  else warn(`KO에 hreflang="en" 없음`);
  if (enHrefKo && !enHrefKo.includes('-en')) pass(`EN → KO hreflang 연결`);
  else if (enHrefKo) fail(`EN hreflang="ko"가 KO 페이지를 가리키지 않음: ${enHrefKo}`);
  else warn(`EN에 hreflang="ko" 없음`);

  // 4. canonical 자기 참조
  const koCanon = extract(ko, /<link[^>]*rel="canonical"[^>]*href="([^"]*)"/i);
  const enCanon = extract(en, /<link[^>]*rel="canonical"[^>]*href="([^"]*)"/i);
  if (koCanon && koCanon.includes('-en')) fail(`KO canonical이 EN을 가리킴: ${koCanon}`);
  if (enCanon && !enCanon.includes('-en') && !enCanon.endsWith('/')) warn(`EN canonical 검토: ${enCanon}`);

  // 5. 메타 태그 존재 parity
  for (const r of META_RULES) {
    const koHas = r.re.test(ko); r.re.lastIndex = 0;
    const enHas = r.re.test(en); r.re.lastIndex = 0;
    if (r.required) {
      if (!koHas) fail(`KO ${r.name} 없음`);
      if (!enHas) fail(`EN ${r.name} 없음`);
    } else if (koHas !== enHas) {
      warn(`${r.name} 비대칭 (KO=${koHas}, EN=${enHas})`);
    }
  }

  // 6. 구조 요소 개수 일치
  for (const r of STRUCT_RULES) {
    const koN = countMatches(ko, r.re);
    const enN = countMatches(en, r.re);
    if (koN === enN) {
      if (koN > 0) pass(`${r.name} 개수 일치 (${koN})`);
    } else {
      fail(`${r.name} 개수 차이: KO=${koN}, EN=${enN}`);
    }
  }

  // 7. 라인수 편차
  const koLines = ko.split('\n').length;
  const enLines = en.split('\n').length;
  const diff = Math.abs(koLines - enLines);
  const ratio = diff / Math.max(koLines, enLines);
  if (ratio > 0.10) fail(`라인수 편차 >10%: KO=${koLines}, EN=${enLines} (Δ${diff})`);
  else if (ratio > 0.03) warn(`라인수 편차 >3%: KO=${koLines}, EN=${enLines} (Δ${diff})`);
  else pass(`라인수 근접 (KO=${koLines}, EN=${enLines})`);

  // 8. data-ko / data-en 쌍 확인 (KO 파일 기준)
  const koDataKoAttrs = countMatches(ko, /\bdata-ko="/g);
  const koDataEnAttrs = countMatches(ko, /\bdata-en="/g);
  if (koDataKoAttrs !== koDataEnAttrs) {
    fail(`KO 파일 내 data-ko(${koDataKoAttrs}) / data-en(${koDataEnAttrs}) 불일치`);
  }
}

// ============================================================
// EN 페이지 한글 누출 검사
// ============================================================
function checkKoreanLeak() {
  console.log('\n🈳 EN 페이지 한글 누출 검사');
  const HANGUL = /[\uac00-\ud7a3]/g;
  // 허용되는 한글 맥락 (검사에서 제외할 라인)
  const ALLOW_PATTERNS = [
    /<option[^>]*value="ko"[^>]*>[^<]*한국어/,   // 언어 선택 옵션
    /"alternateName":\s*\[[^\]]*"카르마"/,        // schema.org alternateName
    /\bdata-ko="[^"]*"/,                           // data-ko 속성값
    /^\s*\/[\/\*]/,                                // 주석 라인
    /^\s*\*/,                                      // 주석 본문
    /nameKo:\s*['"`][^'"`]*['"`]/,                 // 타로 카드 데이터
    /_L\(\s*['"`]/,                                // _L('한글', ...) 또는 _L(`...`)
    /\?\s*['"`][^'"`]*['"`]\s*:\s*['"`][^'"`]*[\uac00-\ud7a3]/, // `lang === 'en' ? 'en' : '한글'` 삼항 fallback
    /\(적마년 \/ 赤馬年\)/,                        // 2026 페이지 의도적 한자/한글 병기
  ];

  for (const base of PAIRS) {
    const en = read(`${base}-en`);
    if (!en) continue;
    const lines = en.split('\n');
    const leaks = [];
    lines.forEach((line, idx) => {
      if (!HANGUL.test(line)) return;
      HANGUL.lastIndex = 0;
      if (ALLOW_PATTERNS.some(re => re.test(line))) return;
      leaks.push({ line: idx + 1, text: line.trim().slice(0, 80) });
    });
    if (leaks.length === 0) {
      pass(`${base}-en 한글 누출 없음`);
    } else {
      fail(`${base}-en 한글 누출 ${leaks.length}건`);
      leaks.slice(0, 5).forEach(l => console.error(`       L${l.line}: ${l.text}`));
      if (leaks.length > 5) console.error(`       ... +${leaks.length - 5}`);
    }
  }
}

console.log('🔍 Karma KO/EN 페이지 쌍 동기화 검증\n');

for (const p of PAIRS) checkPair(p);

checkKoreanLeak();

// Orphan 체크
console.log(`\n🔸 [Orphan] EN 페어 없는 페이지`);
for (const o of ORPHANS) {
  if (fs.existsSync(path.join(ROOT, `${o}.html`))) {
    warn(`${o}.html — EN 페어 없음 (필요 여부 검토)`);
  }
}

// Summary
console.log('\n' + '='.repeat(50));
console.log(`✅ 통과: ${passed}  ⚠️  경고: ${warnings}  ❌ 오류: ${errors}`);
console.log('='.repeat(50));

process.exit(errors > 0 ? 1 : 0);
