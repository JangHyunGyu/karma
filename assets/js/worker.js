// Karma Worker — Single-file vanilla Cloudflare Worker
// Karma API Worker (vanilla JS, no framework)

// ============================================================
// CORS & Response Helpers
// ============================================================

const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';
const CF_ACCOUNT_ID = 'f5ced3498c8b7674581b5c9987f31585';
const CF_GATEWAY_NAME = 'archer-gateway';
const GEMINI_URL = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_NAME}/google-ai-studio/v1beta/models/${GEMINI_MODEL}:generateContent`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ============================================================
// Utility Functions (from utils.js)
// ============================================================

const SELECT_PROFILE =
  'user_id, nickname, gender, interest_gender, birth_date, birth_time, bio, region, profile_photo_url, saju_ilgan, saju_ilgan_ohang, saju_summary';

async function hashPassword(pw) {
  const data = new TextEncoder().encode(pw);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function calcAge(birthDate) {
  const [y, m, d] = birthDate.split('-').map(Number);
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return age;
}

function getGrade(score) {
  if (score >= 90) return 'S';
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

// ============================================================
// Saju (四柱) Calculation Engine (from saju.js)
// ============================================================

const CHEONGAN = ['갑', '을', '병', '정', '무', '기', '경', '신', '임', '계'];
const JIJI = ['자', '축', '인', '묘', '진', '사', '오', '미', '신', '유', '술', '해'];
const OHANG = { 목: '木', 화: '火', 토: '土', 금: '金', 수: '水' };

const CHEONGAN_OHANG = {
  갑: '목', 을: '목', 병: '화', 정: '화', 무: '토',
  기: '토', 경: '금', 신: '금', 임: '수', 계: '수',
};

const JIJI_OHANG = {
  자: '수', 축: '토', 인: '목', 묘: '목', 진: '토', 사: '화',
  오: '화', 미: '토', 신: '금', 유: '금', 술: '토', 해: '수',
};

const SANGSAENG = { 목: '화', 화: '토', 토: '금', 금: '수', 수: '목' };
const SANGGEUK = { 목: '토', 토: '수', 수: '화', 화: '금', 금: '목' };

// --- 절기 (Solar Terms) for Saju month/year boundaries ---
// The 12 절기 that mark saju month boundaries:
//  0: 소한 (~Jan 5-6)  - start of 축월(12th saju month, prev saju year)
//  1: 입춘 (~Feb 3-5)  - start of 인월(1st saju month, new saju year)
//  2: 경칩 (~Mar 5-7)  - start of 묘월(2nd)
//  3: 청명 (~Apr 4-6)  - start of 진월(3rd)
//  4: 입하 (~May 5-7)  - start of 사월(4th)
//  5: 망종 (~Jun 5-7)  - start of 오월(5th)
//  6: 소서 (~Jul 6-8)  - start of 미월(6th)
//  7: 입추 (~Aug 7-8)  - start of 신월(7th)
//  8: 백로 (~Sep 7-9)  - start of 유월(8th)
//  9: 한로 (~Oct 7-9)  - start of 술월(9th)
// 10: 입동 (~Nov 7-8)  - start of 해월(10th)
// 11: 대설 (~Dec 6-8)  - start of 자월(11th)
// Order: [소한, 입춘, 경칩, 청명, 입하, 망종, 소서, 입추, 백로, 한로, 입동, 대설]
// Each entry: [month, day] in Gregorian calendar
const SOLAR_TERMS_APPROX = [
  [1, 6],   // 소한 (Small Cold) ~Jan 5-6
  [2, 4],   // 입춘 (Start of Spring) ~Feb 3-5
  [3, 6],   // 경칩 (Awakening of Insects) ~Mar 5-7
  [4, 5],   // 청명 (Clear and Bright) ~Apr 4-6
  [5, 6],   // 입하 (Start of Summer) ~May 5-7
  [6, 6],   // 망종 (Grain in Ear) ~Jun 5-7
  [7, 7],   // 소서 (Minor Heat) ~Jul 6-8
  [8, 7],   // 입추 (Start of Autumn) ~Aug 7-8
  [9, 8],   // 백로 (White Dew) ~Sep 7-9
  [10, 8],  // 한로 (Cold Dew) ~Oct 7-9
  [11, 7],  // 입동 (Start of Winter) ~Nov 7-8
  [12, 7],  // 대설 (Major Snow) ~Dec 6-8
];

// Saju month index (1-12) corresponding to each 절기 boundary:
// After 소한 → 축월(12), after 입춘 → 인월(1), after 경칩 → 묘월(2), ...
const SAJU_MONTH_BY_TERM = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

// Get the saju month (1-12) for a given Gregorian date.
// sajuMonth 1=인월, 2=묘월, ..., 11=자월, 12=축월
function getSajuMonth(year, month, day) {
  // Walk the 절기 boundaries in reverse for the current year
  // to find which saju month the date falls in.
  // Check 대설(Dec) down to 입춘(Feb) of current year, then 소한(Jan) of current year.
  for (let i = 11; i >= 0; i--) {
    const [tm, td] = SOLAR_TERMS_APPROX[i];
    if (month > tm || (month === tm && day >= td)) {
      return SAJU_MONTH_BY_TERM[i];
    }
  }
  // Before 소한 of this year → still in 자월(11) from 대설 of prev year
  return 11;
}

// Get the 입춘-adjusted year for saju year pillar.
// Before 입춘 (~Feb 4), saju year is previous Gregorian year.
function getSajuYear(year, month, day) {
  const [ipchunMonth, ipchunDay] = SOLAR_TERMS_APPROX[1]; // 입춘
  if (month < ipchunMonth || (month === ipchunMonth && day < ipchunDay)) {
    return year - 1;
  }
  return year;
}

function yearCheongan(year) { return CHEONGAN[(year - 4) % 10]; }
function yearJiji(year) { return JIJI[(year - 4) % 12]; }

// Month 천간: based on year's heavenly stem and saju month (1-12)
// Formula: ((yearGanIndex % 5) * 2 + 2 + (sajuMonth - 1)) % 10
// sajuMonth 1=인월 starts the cycle for each year stem group
function monthCheongan(yearGanIndex, sajuMonth) {
  return CHEONGAN[((yearGanIndex % 5) * 2 + 2 + (sajuMonth - 1)) % 10];
}

// Month 지지: sajuMonth 1=인(index 2), 2=묘(3), ..., 11=자(0), 12=축(1)
function monthJiji(sajuMonth) { return JIJI[(sajuMonth + 1) % 12]; }

// Julian Day Number (Meeus algorithm for Gregorian calendar)
function julianDayNumber(year, month, day) {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y
    + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

// Day pillar using Julian Day Number.
// Verified anchor: 2019-01-27 (JDN 2458511) = 甲子 (갑자, gan=0, ji=0)
// Formula from ytliu0 Chinese Calendar:
//   T = 1 + mod(JDN - 1, 10)  (1-indexed stem, 甲=1)
//   B = 1 + mod(JDN + 1, 12)  (1-indexed branch, 子=1)
function dayPillar(year, month, day) {
  const jdn = julianDayNumber(year, month, day);
  const gan = ((jdn - 1) % 10 + 10) % 10;  // 0-indexed: 갑=0
  const ji = ((jdn + 1) % 12 + 12) % 12;    // 0-indexed: 자=0
  return { gan: CHEONGAN[gan], ji: JIJI[ji] };
}

function hourPillar(dayGan, hour) {
  const shiIndex = Math.floor(((hour + 1) % 24) / 2);
  const base = { 갑: 0, 을: 2, 병: 4, 정: 6, 무: 8, 기: 0, 경: 2, 신: 4, 임: 6, 계: 8 };
  const gan = CHEONGAN[(base[dayGan] + shiIndex) % 10];
  const ji = JIJI[shiIndex];
  return { gan, ji };
}

function calculateDaeun(birthDate, gender, monthGanIndex, monthJiIndex) {
  const [year, month, day] = birthDate.split('-').map(Number);
  const sajuYear = getSajuYear(year, month, day);
  const yearGan = yearCheongan(sajuYear);
  const yearGanIndex = CHEONGAN.indexOf(yearGan);

  const isYangGan = yearGanIndex % 2 === 0;
  const isMale = gender === 'male';
  const direction = (isYangGan && isMale) || (!isYangGan && !isMale) ? 1 : -1;
  const startAge = 3;

  const daeunList = [];
  for (let i = 1; i <= 8; i++) {
    const ganIdx = ((monthGanIndex + direction * i) % 10 + 10) % 10;
    const jiIdx = ((monthJiIndex + direction * i) % 12 + 12) % 12;
    const gan = CHEONGAN[ganIdx];
    const ji = JIJI[jiIdx];
    const ohang = CHEONGAN_OHANG[gan];
    const fromAge = startAge + (i - 1) * 10;
    const toAge = fromAge + 9;

    daeunList.push({
      gan, ji, ohang,
      jiOhang: JIJI_OHANG[ji],
      fromAge, toAge,
      label: `${fromAge}~${toAge}세`,
    });
  }
  return daeunList;
}

function calculateSaju(birthDate, birthTime, gender) {
  const [year, month, day] = (birthDate || '').split('-').map(Number);
  if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error('유효하지 않은 생년월일 형식입니다');
  }
  const hasTime = birthTime && birthTime.length >= 4;
  const hour = hasTime ? parseInt(birthTime.split(':')[0], 10) : null;

  // 입춘-adjusted year for year pillar (saju year changes at 입춘, not Jan 1)
  const sajuYear = getSajuYear(year, month, day);
  // 절기-based month for month pillar (saju month changes at each 절기, not 1st)
  const sajuMonth = getSajuMonth(year, month, day);

  const yGan = yearCheongan(sajuYear);
  const yJi = yearJiji(sajuYear);
  const yearGanIndex = CHEONGAN.indexOf(yGan);
  const mGan = monthCheongan(yearGanIndex, sajuMonth);
  const mJi = monthJiji(sajuMonth);
  const { gan: dGan, ji: dJi } = dayPillar(year, month, day);

  const pillars = [
    { name: '년주', gan: yGan, ji: yJi },
    { name: '월주', gan: mGan, ji: mJi },
    { name: '일주', gan: dGan, ji: dJi },
  ];

  if (hour !== null) {
    const { gan: hGan, ji: hJi } = hourPillar(dGan, hour);
    pillars.push({ name: '시주', gan: hGan, ji: hJi });
  }

  const ohangCount = { 목: 0, 화: 0, 토: 0, 금: 0, 수: 0 };
  for (const p of pillars) {
    ohangCount[CHEONGAN_OHANG[p.gan]]++;
    ohangCount[JIJI_OHANG[p.ji]]++;
  }

  const ilgan = dGan;
  const ilganOhang = CHEONGAN_OHANG[ilgan];

  let daeun = null;
  if (gender) {
    const mGanIdx = CHEONGAN.indexOf(mGan);
    const mJiIdx = JIJI.indexOf(mJi);
    daeun = calculateDaeun(birthDate, gender, mGanIdx, mJiIdx);
  }

  return {
    pillars, ohangCount, ilgan, ilganOhang,
    hasTime: hour !== null,
    summary: pillars.map((p) => `${p.name}: ${p.gan}${p.ji}`).join(', '),
    daeun,
  };
}

function ohangCompatibility(saju1, saju2) {
  let score = 50;
  const oh1 = saju1.ilganOhang;
  const oh2 = saju2.ilganOhang;

  if (SANGSAENG[oh1] === oh2 || SANGSAENG[oh2] === oh1) score += 20;
  if (SANGGEUK[oh1] === oh2 || SANGGEUK[oh2] === oh1) score -= 15;
  if (oh1 === oh2) score += 10;

  for (const key of Object.keys(OHANG)) {
    if (saju1.ohangCount[key] === 0 && saju2.ohangCount[key] >= 2) score += 5;
    if (saju2.ohangCount[key] === 0 && saju1.ohangCount[key] >= 2) score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

// ============================================================
// AI — Gemini API (from ai.js)
// ============================================================

// 무료키 우선 → 유료는 백업 (무료키 전부 실패 시에만 유료 사용)
function getGeminiKeys(env) {
  return [
    env.GOLF_GEMINI_API_KEY_FREE,
    env.LATIN_GEMINI_API_KEY_FREE,
    env.GEMINI_API_KEY,
  ].filter(Boolean);
}

// Gemini API 실패 시 D1에 에러 기록 (자세한 디버깅 정보 포함)
async function logApiError(env, message, detail, extra) {
  try {
    if (!env?.DB) return;
    const info = extra ? JSON.stringify(extra) : '';
    const fullStack = [detail || '', info].filter(Boolean).join('\n---\n');
    await env.DB.prepare(
      `INSERT INTO error_logs (app_id, message, stack, url, user_agent) VALUES ('karma', ?, ?, ?, 'server')`
    ).bind(
      (message || '').slice(0, 500),
      fullStack.slice(0, 2000),
      (extra?.endpoint || 'worker/gemini').slice(0, 500)
    ).run();
  } catch (e) {
    console.error('[logApiError] DB write failed:', e.message);
  }
}

async function callGemini(apiKeys, prompt, _caller, _env) {
  const endpoint = _caller || 'unknown';
  const promptPreview = prompt.slice(0, 100);
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 4096, temperature: 0.7 },
  });
  const errors = [];
  for (let i = 0; i < apiKeys.length; i++) {
    const isLast = i === apiKeys.length - 1;
    try {
      const resp = await fetch(`${GEMINI_URL}?key=${apiKeys[i]}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!resp.ok && !isLast) { errors.push(`key${i+1}: HTTP ${resp.status}`); continue; }
      if (!resp.ok && isLast) {
        const errText = await resp.text().catch(() => '');
        errors.push(`key${i+1}: HTTP ${resp.status} - ${errText.slice(0, 200)}`);
        await logApiError(_env, `[${endpoint}] Gemini API 전체 실패 (HTTP ${resp.status})`, errors.join('\n'), { endpoint, promptPreview, keyCount: apiKeys.length });
        return null;
      }
      const data = await resp.json();
      if (data.error) {
        errors.push(`key${i+1}: ${data.error?.message || data.error?.code || JSON.stringify(data.error).slice(0, 200)}`);
        if (!isLast) continue;
        await logApiError(_env, `[${endpoint}] Gemini API 전체 실패`, errors.join('\n'), { endpoint, promptPreview, keyCount: apiKeys.length });
        return null;
      }
      const parts = data.candidates?.[0]?.content?.parts || [];
      const allText = parts.filter(p => !p.thought).map(p => p.text || '').join('');
      if (!allText) {
        await logApiError(_env, `[${endpoint}] Gemini 빈 응답`, `finishReason: ${data.candidates?.[0]?.finishReason || 'N/A'}`, { endpoint, promptPreview });
        return null;
      }
      const jsonMatch = allText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        await logApiError(_env, `[${endpoint}] Gemini JSON 미발견`, `응답: ${allText.slice(0, 300)}`, { endpoint, promptPreview });
        return null;
      }
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e2) {
        await logApiError(_env, `[${endpoint}] Gemini JSON 파싱 실패`, `${e2.message}\n응답: ${jsonMatch[0].slice(0, 300)}`, { endpoint, promptPreview });
        return null;
      }
    } catch (e) {
      errors.push(`key${i+1}: ${e.message || e}`);
      if (isLast) {
        await logApiError(_env, `[${endpoint}] Gemini 네트워크 오류`, errors.join('\n'), { endpoint, promptPreview, keyCount: apiKeys.length });
        return null;
      }
    }
  }
  return null;
}

async function callGeminiVision(apiKeys, prompt, imageBase64, mimeType, _env) {
  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
      ],
    }],
    generationConfig: { maxOutputTokens: 8192, temperature: 0.7 },
  });
  const errors = [];
  for (let i = 0; i < apiKeys.length; i++) {
    const isLast = i === apiKeys.length - 1;
    try {
      const resp = await fetch(`${GEMINI_URL}?key=${apiKeys[i]}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!resp.ok && !isLast) { errors.push(`key${i+1}: HTTP ${resp.status}`); continue; }
      if (!resp.ok && isLast) {
        const errText = await resp.text().catch(() => '');
        errors.push(`key${i+1}: HTTP ${resp.status} - ${errText.slice(0, 200)}`);
        await logApiError(_env, 'Gemini Vision API 전체 실패', errors.join('\n'));
        return { _apiError: 'AI 서비스가 일시적으로 불가합니다. 잠시 후 다시 시도해주세요.' };
      }
      const data = await resp.json();
      if (data.error) {
        errors.push(`key${i+1}: ${data.error?.message || JSON.stringify(data.error)}`);
        if (!isLast) continue;
        await logApiError(_env, 'Gemini Vision error (all keys failed)', errors.join('\n'));
        return { _apiError: data.error.message || JSON.stringify(data.error) };
      }
      const candidate = data.candidates?.[0];
      if (candidate?.finishReason === 'SAFETY') {
        return { _apiError: '이미지가 안전 필터에 의해 차단되었습니다. 다른 사진을 시도해주세요.' };
      }
      const parts = candidate?.content?.parts || [];
      const allText = parts.filter(p => !p.thought).map(p => p.text || '').join('');
      if (!allText) {
        console.error('Gemini Vision: empty response, candidates:', JSON.stringify(data.candidates));
        return { _apiError: 'AI가 빈 응답을 반환했습니다. 다른 사진을 시도해주세요.' };
      }
      const jsonMatch = allText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { _apiError: 'AI 응답 형식 오류' };
      try { return JSON.parse(jsonMatch[0]); } catch { return { _apiError: 'AI 응답 파싱 실패' }; }
    } catch (e) {
      errors.push(`key${i+1}: ${e.message || e}`);
      if (isLast) {
        await logApiError(_env, 'Gemini Vision call failed (all keys)', errors.join(' | '));
        return { _apiError: 'Gemini API 호출 실패: ' + (e.message || '') };
      }
    }
  }
  return { _apiError: 'API 키가 설정되지 않았습니다' };
}

async function saveImageToR2(env, image, mimeType, type) {
  if (!env.R2_BUCKET) return null;
  try {
    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    const key = `karma/${type}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const buf = Uint8Array.from(atob(image), c => c.charCodeAt(0));
    await env.R2_BUCKET.put(key, buf, { httpMetadata: { contentType: mimeType } });
    return key;
  } catch (e) {
    console.error('R2 save failed:', e.message);
    return null;
  }
}

async function handleFaceReading(request, env) {
  const { image, mimeType, gender, age, lang } = await request.json();
  if (!image) return json({ error: '이미지가 필요합니다' }, 400);

  const apiKeys = getGeminiKeys(env);
  if (!apiKeys.length) return json({ error: 'AI 서비스를 사용할 수 없습니다' }, 503);

  // R2에 이미지 저장 (비동기, 분석 결과에 영향 없음)
  const r2Key = await saveImageToR2(env, image, mimeType || 'image/jpeg', 'face');

  const prompt = `당신은 동양 관상학(面相學) 전문가입니다. 첨부된 사진을 분석하여 관상 감정을 해주세요.

중요: 먼저 사진에 사람의 얼굴이 있는지 확인하세요. 얼굴이 없거나 사람이 아닌 사진이면 반드시 다음 JSON만 반환하세요:
{"error": "얼굴 사진이 아닙니다. 사람의 정면 얼굴이 보이는 사진을 업로드해주세요."}

얼굴이 확인되면 관상 감정을 진행하세요.
${gender ? `성별: ${gender}` : ''}${age ? `, 나이대: ${age}` : ''}

다음 항목을 분석하세요:
1. 이마(천정) - 지혜, 초년운
2. 눈(눈매) - 성격, 대인관계
3. 코(준두) - 재물운, 자존심
4. 입(입술) - 언변, 식복
5. 턱/광대 - 의지력, 중년~말년운
6. 전체 인상 - 종합 관상

반드시 아래 JSON 형식으로만 응답하세요:
{
  "overall_score": 85,
  "overall_grade": "A",
  "summary": "전체 한줄 요약",
  "categories": [
    {"name": "이마 (천정)", "score": 80, "desc": "분석 내용 2~3문장"},
    {"name": "눈 (눈매)", "score": 85, "desc": "분석 내용"},
    {"name": "코 (준두)", "score": 75, "desc": "분석 내용"},
    {"name": "입 (입술)", "score": 90, "desc": "분석 내용"},
    {"name": "턱/광대", "score": 80, "desc": "분석 내용"},
    {"name": "전체 인상", "score": 85, "desc": "분석 내용"}
  ],
  "fortune": {
    "wealth": "재물운 해석",
    "career": "직업/사업운",
    "love": "연애/결혼운",
    "health": "건강운"
  },
  "advice": "관상 기반 조언 2~3문장",
  "celebrity_resemblance": "닮은 유명인 (있으면)"
}` + langInstruction(lang);

  const result = await callGeminiVision(apiKeys, prompt, image, mimeType || 'image/jpeg', env);
  if (!result) return json({ error: 'AI 분석에 실패했습니다. 얼굴이 잘 보이는 정면 사진을 사용해주세요.' }, 500);
  if (result._apiError) return json({ error: result._apiError }, 500);
  if (result.error) return json({ error: result.error }, 400);
  return json({ ...result, r2_key: r2Key });
}

async function handlePalmReading(request, env) {
  const { image, mimeType, hand, gender, lang } = await request.json();
  if (!image) return json({ error: '이미지가 필요합니다' }, 400);

  const apiKeys = getGeminiKeys(env);
  if (!apiKeys.length) return json({ error: 'AI 서비스를 사용할 수 없습니다' }, 503);

  const r2Key = await saveImageToR2(env, image, mimeType || 'image/jpeg', 'palm');

  const prompt = `당신은 동양 수상학(手相學) 전문가입니다. 첨부된 사진을 분석하여 손금 감정을 해주세요.

중요: 먼저 사진에 사람의 손바닥이 있는지 확인하세요. 손바닥이 없거나 손금이 보이지 않는 사진이면 반드시 다음 JSON만 반환하세요:
{"error": "손바닥 사진이 아닙니다. 손금이 잘 보이도록 손을 펴서 촬영한 사진을 업로드해주세요."}

손바닥이 확인되면 손금 감정을 진행하세요.
${hand ? `촬영한 손: ${hand}` : ''}${gender ? `, 성별: ${gender}` : ''}

다음 주요 손금을 분석하세요:
1. 생명선 - 건강, 활력, 수명
2. 두뇌선 (지능선) - 사고방식, 판단력
3. 감정선 - 감정, 연애, 대인관계
4. 운명선 - 직업운, 인생 방향
5. 태양선 (성공선) - 명예, 성공
6. 결혼선 - 결혼, 인연
7. 손의 형태 - 손가락 길이, 손바닥 모양

반드시 아래 JSON 형식으로만 응답하세요:
{
  "overall_score": 82,
  "overall_grade": "A",
  "summary": "전체 한줄 요약",
  "lines": [
    {"name": "생명선", "score": 85, "length": "길다/보통/짧다", "desc": "분석 내용 2~3문장"},
    {"name": "두뇌선", "score": 78, "length": "길다/보통/짧다", "desc": "분석 내용"},
    {"name": "감정선", "score": 88, "length": "길다/보통/짧다", "desc": "분석 내용"},
    {"name": "운명선", "score": 75, "length": "뚜렷/보통/희미", "desc": "분석 내용"},
    {"name": "태양선", "score": 70, "length": "있음/희미/없음", "desc": "분석 내용"},
    {"name": "결혼선", "score": 80, "length": "1개/2개/여러개", "desc": "분석 내용"}
  ],
  "hand_shape": {"type": "물형/불형/흙형/금형/나무형", "desc": "손 형태 분석"},
  "fortune": {
    "wealth": "재물운",
    "career": "직업운",
    "love": "연애/결혼운",
    "health": "건강운"
  },
  "advice": "손금 기반 조언 2~3문장"
}` + langInstruction(lang);

  const result = await callGeminiVision(apiKeys, prompt, image, mimeType || 'image/jpeg', env);
  if (!result) return json({ error: 'AI 분석에 실패했습니다. 손바닥이 잘 보이는 사진을 사용해주세요.' }, 500);
  if (result._apiError) return json({ error: result._apiError }, 500);
  if (result.error) return json({ error: result.error }, 400);
  return json({ ...result, r2_key: r2Key });
}

function getOhangRelations(ohangA, ohangB) {
  const relations = { sangsaeng: [], sanggeuk: [], same: false };
  if (SANGSAENG[ohangA] === ohangB) relations.sangsaeng.push(`${ohangA}→${ohangB}`);
  if (SANGSAENG[ohangB] === ohangA) relations.sangsaeng.push(`${ohangB}→${ohangA}`);
  if (SANGGEUK[ohangA] === ohangB) relations.sanggeuk.push(`${ohangA}→${ohangB}`);
  if (SANGGEUK[ohangB] === ohangA) relations.sanggeuk.push(`${ohangB}→${ohangA}`);
  if (ohangA === ohangB) relations.same = true;
  return relations;
}

// ============================================================
// Prompt Builders (from prompt.js)
// ============================================================

const CHEONGAN_INFO = {
  갑: { ohang: '목', yin: false, desc: '큰 나무. 리더십, 곧은 성격, 개척 정신' },
  을: { ohang: '목', yin: true, desc: '풀/덩굴. 유연함, 적응력, 부드러운 외교력' },
  병: { ohang: '화', yin: false, desc: '태양. 열정, 화려함, 밝은 에너지, 리더 기질' },
  정: { ohang: '화', yin: true, desc: '촛불. 섬세함, 따뜻한 배려, 내면의 열정' },
  무: { ohang: '토', yin: false, desc: '큰 산. 듬직함, 포용력, 안정감, 신뢰' },
  기: { ohang: '토', yin: true, desc: '논밭. 현실적, 실리 추구, 세심한 관리력' },
  경: { ohang: '금', yin: false, desc: '강철/바위. 강한 의지, 결단력, 정의감' },
  신: { ohang: '금', yin: true, desc: '보석/칼날. 예리함, 완벽주의, 심미안' },
  임: { ohang: '수', yin: false, desc: '큰 바다/강. 지혜, 포용, 대범함, 자유로움' },
  계: { ohang: '수', yin: true, desc: '이슬/시냇물. 감수성, 직관력, 내면의 깊이' },
};

const OHANG_RELATIONS = `
오행 상생(생해주는 관계): 목→화→토→금→수→목
오행 상극(제어하는 관계): 목→토, 토→수, 수→화, 화→금, 금→목
오행 과다: 해당 기운이 넘쳐 부작용 (예: 금 과다→지나친 완벽주의, 비판적)
오행 부족: 해당 기운이 없어 약점 (예: 화 부족→열정/추진력 부족, 소극적)
`;

function getOhangAnalysis(ohangCount) {
  const excess = [];
  const lack = [];
  for (const [key, val] of Object.entries(ohangCount)) {
    if (val >= 4) excess.push(`${key}(${val}개) 과다`);
    else if (val === 0) lack.push(`${key} 부족`);
  }
  return { excess, lack };
}

function langInstruction(lang) {
  if (lang === 'en') return '\n\nIMPORTANT: You MUST respond entirely in English. All text values in the JSON must be in English. Keep Korean Saju terms (like 갑, 을, 목, 화 etc.) but add English translations in parentheses.';
  return '';
}

function buildSajuPrompt(saju, gender, lang) {
  const ilganInfo = CHEONGAN_INFO[saju.ilgan] || {};
  const { excess, lack } = getOhangAnalysis(saju.ohangCount);
  const yinYang = ilganInfo.yin ? '음(陰)' : '양(陽)';
  const genderText = gender === 'male' ? '남성' : gender === 'female' ? '여성' : '';

  return `당신은 동양 사주명리학 전문가이자 상담사입니다. 사주를 처음 보는 일반인도 쉽게 이해할 수 있도록 친근하고 구체적으로 해석해주세요.
전문 용어는 괄호 안에 쉬운 설명을 덧붙이고, 실생활 예시를 들어 설명하세요.
단순한 오행 나열이 아니라, "그래서 이 사람은 어떤 사람인가"를 일상 언어로 풀어주세요.

## 기본 정보
${genderText ? `- 성별: ${genderText}` : ''}

## 사주 원국 (四柱 原局)
${saju.pillars.map(p => `- ${p.name}: ${p.gan}${p.ji}`).join('\n')}

## 일간 (日干) 분석
- 일간: ${saju.ilgan} (${saju.ilganOhang}, ${yinYang})
- 일간의 본성: ${ilganInfo.desc || ''}

## 오행 분포
- 목: ${saju.ohangCount.목} | 화: ${saju.ohangCount.화} | 토: ${saju.ohangCount.토} | 금: ${saju.ohangCount.금} | 수: ${saju.ohangCount.수}
${excess.length ? `- 과다: ${excess.join(', ')}` : ''}
${lack.length ? `- 부족: ${lack.join(', ')}` : ''}

## 오행 상생/상극 기본 원리
${OHANG_RELATIONS}
${saju.daeun ? `
## 대운 (大運) — 10년 단위 인생 흐름
${saju.daeun.map(du => `- ${du.label}: ${du.gan}${du.ji} (${du.ohang}/${du.jiOhang})`).join('\n')}
` : ''}

## 해석 지침
1. 일간의 본성 + 주변 간지와의 관계를 종합하여 성격을 분석
2. 오행 과다/부족이 실제 성격과 행동에 미치는 구체적 영향
3. 천간 간의 합/충, 지지 간의 합/충/형이 있으면 언급
4. 연애/대인관계에서 이 사주의 특징적 패턴
5. 직업/적성에 대한 구체적 조언
6. 대운 흐름에 따른 시기별 인생 해석 (각 대운이 일간에 어떤 영향을 주는지)
7. 올해 운세의 흐름과 주의사항

## 응답 형식
반드시 아래 JSON 형식으로만 응답하세요. 설명은 구체적이고 풍부하게 작성:
{
  "pillar_reading": {
    "year": "(년주 해석 3~4문장: 이 간지가 의미하는 어린 시절과 가정환경. 예: '어떤 분위기의 가정에서 자랐는지, 부모님은 어떤 성향이었을지' 등 구체적 상황 묘사)",
    "month": "(월주 해석 3~4문장: 사회생활과 직장에서의 모습. 예: '회사에서 어떤 스타일로 일하는지, 동료들에게 어떤 인상을 주는지' 등 실생활 묘사)",
    "day": "(일주 해석 3~4문장: 나의 진짜 성격과 연애/결혼운. 예: '평소에는 이런 모습이지만 가까운 사람에게는 이런 면을 보인다, 어떤 배우자를 만나면 좋다' 등)",
    "hour": "(시주 해석 3~4문장: 자녀운과 50대 이후 인생. 시주 없으면 빈 문자열)"
  },
  "personality": "(이 사람을 한마디로 표현하면 어떤 사람인지 4~5문장으로. 전문용어 없이 친구에게 설명하듯. 예: '겉으로는 조용해 보이지만 속으로는 불꽃같은 사람' 같은 비유 활용)",
  "strengths": ["강점 3가지 (각각 1~2문장. '이런 상황에서 이렇게 빛난다' 식으로 구체적 예시)"],
  "cautions": ["주의할 점 3가지 (각각 1~2문장. '이런 상황에서 이런 실수를 하기 쉽다' 식으로 구체적 예시)"],
  "love_style": "(연애 스타일 3~4문장. 어떤 사람에게 끌리는지, 연애할 때 어떤 모습인지, 이런 사람을 만나면 행복할 것이다 등 구체적으로)",
  "career": "(적합한 직업 3~4개를 구체적으로. 왜 이 직업이 맞는지 이유도 함께. 예: '분석력이 뛰어나서 데이터 분석가, 연구원에 적합하고...')",
  "daeun_reading": ["대운 8개 각각 2~3문장 해석. 배열 순서 = 대운 순서. '이 시기에는 어떤 일이 일어나기 쉽고, 어떻게 보내면 좋다' 식으로 구체적 조언 포함"],
  "advice": "(이 사주를 가진 사람에게 주는 인생 조언 3~4문장. 추상적 말 대신 '이럴 때는 이렇게 해보세요' 같은 실천 가능한 조언)"
}` + langInstruction(lang);
}

function buildFortunePrompt(saju, gender, year, lang) {
  const ilganInfo = CHEONGAN_INFO[saju.ilgan] || {};
  const genderText = gender === 'male' ? '남성' : gender === 'female' ? '여성' : '';

  return `당신은 사주명리학 기반 운세 전문가입니다. 친근하고 구체적으로, 실생활에 도움이 되도록 해석해주세요.

## 기본 정보
${genderText ? `- 성별: ${genderText}` : ''}
- 올해: ${year}년

## 사주 원국
${saju.pillars.map(p => `- ${p.name}: ${p.gan}${p.ji}`).join('\n')}
- 일간: ${saju.ilgan} (${saju.ilganOhang}) — ${ilganInfo.desc || ''}
- 오행 분포: 목${saju.ohangCount.목} 화${saju.ohangCount.화} 토${saju.ohangCount.토} 금${saju.ohangCount.금} 수${saju.ohangCount.수}

## 해석 지침
1. ${year}년의 천간/지지가 이 사주의 일간과 어떤 관계인지 분석
2. 연애운, 재물운, 건강운, 직장/사업운을 각각 구체적으로
3. 월별 운세는 실생활 조언 포함 (예: '이 달에는 큰 결정을 미루세요')
4. 전문용어 없이 쉽게 설명

## 응답 형식
반드시 아래 JSON 형식으로만 응답:
{
  "year_summary": "(${year}년 전체 운세를 4~5문장으로 요약. 올해의 키워드, 전반적 흐름, 가장 좋은 시기와 조심할 시기)",
  "love": "(연애/결혼운 5~7문장. 솔로: 새로운 만남이 올 시기와 어떤 타입을 만나게 될지, 어디서 만날 가능성이 높은지. 커플: 올해 관계의 흐름, 결혼 적기인지, 위기가 올 수 있는 시기와 극복법. 구체적 조언 포함)",
  "money": "(재물운 5~7문장. 상반기/하반기 수입 흐름, 투자해도 좋은 시기와 절대 피해야 할 시기, 뜻밖의 지출이 생길 수 있는 달, 재테크 방법 조언, 사업자는 매출 흐름 예측)",
  "health": "(건강운 4~5문장. 올해 특히 조심해야 할 신체 부위, 스트레스가 심해지는 시기, 건강 관리 구체적 방법, 운동이나 식습관 조언)",
  "career": "(직장/사업운 5~7문장. 이직하기 좋은 시기, 승진 가능성, 직장 내 인간관계 흐름, 사업자는 확장/투자 적기, 새로운 프로젝트 시작하기 좋은 때, 조심해야 할 시기)",
  "lucky": {
    "color": "(올해 행운의 색)",
    "number": "(올해 행운의 숫자)",
    "direction": "(올해 행운의 방향)",
    "month": "(올해 가장 좋은 달)"
  },
  "advice": "(올해를 잘 보내기 위한 핵심 조언 2~3문장)"
}` + langInstruction(lang);
}

function buildCompatPrompt(sajuA, sajuB, score, grade, genderA, genderB, lang) {
  const genderTextA = genderA === 'male' ? '남성' : genderA === 'female' ? '여성' : '';
  const genderTextB = genderB === 'male' ? '남성' : genderB === 'female' ? '여성' : '';
  const ilganA = CHEONGAN_INFO[sajuA.ilgan] || {};
  const ilganB = CHEONGAN_INFO[sajuB.ilgan] || {};
  const { excess: excessA, lack: lackA } = getOhangAnalysis(sajuA.ohangCount);
  const { excess: excessB, lack: lackB } = getOhangAnalysis(sajuB.ohangCount);

  const complementary = [];
  for (const key of Object.keys(sajuA.ohangCount)) {
    if (sajuA.ohangCount[key] === 0 && sajuB.ohangCount[key] >= 2) {
      complementary.push(`B가 A에게 부족한 ${key}을 보완`);
    }
    if (sajuB.ohangCount[key] === 0 && sajuA.ohangCount[key] >= 2) {
      complementary.push(`A가 B에게 부족한 ${key}을 보완`);
    }
  }

  return `당신은 동양 사주명리학 궁합 전문가입니다. 40년 경력의 역학자처럼 두 사람의 궁합을 깊이 있게 해석해주세요.
이미 계산된 점수를 바탕으로, 그 점수의 근거를 사주 원리로 설명하세요. 점수를 새로 매기지 마세요.

## Person A ${genderTextA ? `(${genderTextA})` : ''}
${sajuA.pillars.map(p => `- ${p.name}: ${p.gan}${p.ji}`).join('\n')}
- 일간: ${sajuA.ilgan} (${sajuA.ilganOhang}, ${ilganA.yin ? '음' : '양'}) — ${ilganA.desc || ''}
- 오행: 목${sajuA.ohangCount.목} 화${sajuA.ohangCount.화} 토${sajuA.ohangCount.토} 금${sajuA.ohangCount.금} 수${sajuA.ohangCount.수}
${excessA.length ? `- 과다: ${excessA.join(', ')}` : ''}
${lackA.length ? `- 부족: ${lackA.join(', ')}` : ''}

## Person B ${genderTextB ? `(${genderTextB})` : ''}
${sajuB.pillars.map(p => `- ${p.name}: ${p.gan}${p.ji}`).join('\n')}
- 일간: ${sajuB.ilgan} (${sajuB.ilganOhang}, ${ilganB.yin ? '음' : '양'}) — ${ilganB.desc || ''}
- 오행: 목${sajuB.ohangCount.목} 화${sajuB.ohangCount.화} 토${sajuB.ohangCount.토} 금${sajuB.ohangCount.금} 수${sajuB.ohangCount.수}
${excessB.length ? `- 과다: ${excessB.join(', ')}` : ''}
${lackB.length ? `- 부족: ${lackB.join(', ')}` : ''}

## 두 사람의 관계
- 궁합 점수: ${score}/100 (${grade}급)
- 일간 관계: ${sajuA.ilgan}(${sajuA.ilganOhang}) vs ${sajuB.ilgan}(${sajuB.ilganOhang})
${complementary.length ? `- 보완 관계: ${complementary.join(', ')}` : '- 보완 관계: 특별한 보완 없음'}

## 오행 상생/상극 원리
${OHANG_RELATIONS}

## 해석 지침
1. 두 일간의 오행 관계 (상생/상극/비화)가 실제 관계에 미치는 영향
2. 음양 조합이 맞는지 (양+음이 이상적)
3. 오행 과다/부족을 서로 보완하는지 여부
4. 이 커플이 갈등할 수 있는 구체적 상황
5. 관계를 발전시키기 위한 실질적 조언

## 응답 형식
반드시 아래 JSON 형식으로만 응답하세요:
{
  "summary": "(두 사람의 궁합을 한 문장으로 요약, 50자 이내)",
  "strengths": ["이 커플의 강점 3가지 (각각 구체적으로 1문장)"],
  "cautions": ["주의할 점 3가지 (각각 구체적으로 1문장)"],
  "saju_reading": "(일간 관계와 오행 조합에서 오는 궁합의 핵심을 3~4문장으로 구체적으로 해석)",
  "conflict_pattern": "(이 커플이 갈등할 때의 패턴과 해결 방법을 2문장으로)",
  "advice": "(이 커플에게 주는 구체적인 관계 발전 조언 2~3문장)"
}` + langInstruction(lang);
}

// ============================================================
// Route Handlers
// ============================================================

// --- Auth Routes (from routes/auth.js) ---

async function handleRegister(request, env) {
  const { user_id, password, nickname, gender, interest_gender, birth_date, birth_time } = await request.json();

  if (!user_id || !password || !nickname || !gender || !interest_gender || !birth_date) {
    return json({ error: '필수 항목을 모두 입력해주세요' }, 400);
  }
  if (!/^[a-zA-Z0-9]{3,20}$/.test(user_id)) {
    return json({ error: 'ID는 영문/숫자 3~20자' }, 400);
  }

  const existingId = await env.DB.prepare('SELECT id FROM lm_profiles WHERE user_id = ?').bind(user_id).first();
  if (existingId) return json({ error: '이미 사용 중인 ID입니다' }, 409);

  const existingNick = await env.DB.prepare('SELECT id FROM lm_profiles WHERE nickname = ?').bind(nickname).first();
  if (existingNick) return json({ error: '이미 사용 중인 닉네임입니다' }, 409);

  const saju = calculateSaju(birth_date, birth_time || '');
  const pw_hash = await hashPassword(password);

  await env.DB.prepare(
    `INSERT INTO lm_profiles (user_id, password_hash, nickname, gender, interest_gender, birth_date, birth_time, saju_ilgan, saju_ilgan_ohang, saju_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(user_id, pw_hash, nickname, gender, interest_gender, birth_date, birth_time || '', saju.ilgan, saju.ilganOhang, saju.summary).run();

  // 오행 커뮤니티 자동 가입
  const community = await env.DB.prepare('SELECT id FROM lm_communities WHERE ohang_type = ?').bind(saju.ilganOhang).first();
  if (community) {
    await env.DB.prepare('INSERT OR IGNORE INTO lm_community_members (community_id, user_id) VALUES (?, ?)').bind(community.id, user_id).run();
    await env.DB.prepare('UPDATE lm_communities SET member_count = member_count + 1 WHERE id = ?').bind(community.id).run();
  }

  return json({ success: true, user_id, nickname, saju_ohang: saju.ilganOhang });
}

async function handleLogin(request, env) {
  const { user_id, password } = await request.json();
  if (!user_id || !password) return json({ error: 'user_id, password 필수' }, 400);

  const pw_hash = await hashPassword(password);
  const user = await env.DB.prepare(`SELECT ${SELECT_PROFILE} FROM lm_profiles WHERE user_id = ? AND password_hash = ?`).bind(user_id, pw_hash).first();
  if (!user) return json({ error: 'ID 또는 비밀번호가 틀립니다' }, 401);

  return json({ success: true, profile: user });
}

async function handleUpdateProfile(request, env) {
  const { user_id, password, nickname, bio, region } = await request.json();
  if (!user_id || !password) return json({ error: 'user_id, password 필수' }, 400);

  const pw_hash = await hashPassword(password);
  const existing = await env.DB.prepare('SELECT id FROM lm_profiles WHERE user_id = ? AND password_hash = ?').bind(user_id, pw_hash).first();
  if (!existing) return json({ error: 'ID 또는 비밀번호가 틀립니다' }, 401);

  await env.DB.prepare("UPDATE lm_profiles SET nickname=?, bio=?, region=?, updated_at=datetime('now') WHERE user_id=?").bind(nickname || '', bio || '', region || '', user_id).run();
  return json({ success: true });
}

async function handleDeleteProfile(request, env) {
  const { user_id, password } = await request.json();
  if (!user_id || !password) return json({ error: 'user_id, password 필수' }, 400);

  const pw_hash = await hashPassword(password);
  const result = await env.DB.prepare('DELETE FROM lm_profiles WHERE user_id = ? AND password_hash = ?').bind(user_id, pw_hash).run();
  if (result.meta.changes === 0) return json({ error: 'ID 또는 비밀번호가 틀립니다' }, 401);
  return json({ success: true });
}

// --- Saju Routes (from routes/saju.js) ---

async function handleSajuAnalysis(request, env) {
  const { birth_date, birth_time, gender, lang } = await request.json();
  if (!birth_date) return json({ error: '생년월일은 필수입니다' }, 400);

  const saju = calculateSaju(birth_date, birth_time || '', gender || '');

  const apiKeys = getGeminiKeys(env);
  const ai = apiKeys.length ? await callGemini(apiKeys, buildSajuPrompt(saju, gender, lang), 'saju', env) : null;

  return json({ ...saju, ai });
}

async function handleCompatQuick(request, env) {
  const { personA, personB, lang } = await request.json();
  if (!personA?.birth_date || !personB?.birth_date) {
    return json({ error: '두 사람의 생년월일은 필수입니다' }, 400);
  }

  const sajuA = calculateSaju(personA.birth_date, personA.birth_time || '', personA.gender || '');
  const sajuB = calculateSaju(personB.birth_date, personB.birth_time || '', personB.gender || '');
  const score = ohangCompatibility(sajuA, sajuB);
  const grade = getGrade(score);
  const relations = getOhangRelations(sajuA.ilganOhang, sajuB.ilganOhang);

  const apiKeys = getGeminiKeys(env);
  const ai = apiKeys.length ? await callGemini(apiKeys, buildCompatPrompt(sajuA, sajuB, score, grade, personA.gender, personB.gender, lang), 'compat', env) : null;

  return json({ score, grade, saju_a: sajuA, saju_b: sajuB, relations, ai });
}

async function handleFortune(request, env) {
  const { birth_date, birth_time, gender, year: reqYear, lang } = await request.json();
  if (!birth_date) return json({ error: '생년월일은 필수입니다' }, 400);

  const saju = calculateSaju(birth_date, birth_time || '', gender || '');
  const year = reqYear || new Date().getFullYear();

  const apiKeys = getGeminiKeys(env);
  if (!apiKeys.length) return json({ error: 'AI 서비스를 사용할 수 없습니다' }, 503);

  const ai = await callGemini(apiKeys, buildFortunePrompt(saju, gender, year, lang), 'fortune', env);
  return json({ year, saju_summary: saju.summary, ilgan: saju.ilgan, ilganOhang: saju.ilganOhang, fortune: ai });
}

async function handleQuickSaju(request, env) {
  const { birth_a, time_a, birth_b, time_b } = await request.json();
  if (!birth_a || !birth_b) return json({ error: '생년월일은 필수입니다' }, 400);

  const sajuA = calculateSaju(birth_a, time_a || '');
  const sajuB = calculateSaju(birth_b, time_b || '');
  const score = ohangCompatibility(sajuA, sajuB);
  const grade = getGrade(score);

  return json({ score, grade, saju_a: sajuA, saju_b: sajuB });
}

// --- Match Routes (from routes/match.js) ---

async function handleMatchList(userId, env) {
  const me = await env.DB.prepare(`SELECT ${SELECT_PROFILE} FROM lm_profiles WHERE user_id = ?`).bind(userId).first();
  if (!me) return json({ error: '프로필을 찾을 수 없습니다' }, 404);

  let query = `SELECT ${SELECT_PROFILE} FROM lm_profiles WHERE user_id != ? AND is_active = 1`;
  const binds = [userId];

  if (me.interest_gender !== 'all' && me.interest_gender !== 'both') {
    query += ' AND gender = ?';
    binds.push(me.interest_gender);
  }

  const { results: others } = await env.DB.prepare(query).bind(...binds).all();
  const mySaju = calculateSaju(me.birth_date, me.birth_time || '');

  const matches = others.map((other) => {
    const otherSaju = calculateSaju(other.birth_date, other.birth_time || '');
    const score = ohangCompatibility(mySaju, otherSaju);
    return {
      user_id: other.user_id,
      nickname: other.nickname,
      age: calcAge(other.birth_date),
      gender: other.gender,
      ohang: other.saju_ilgan_ohang || otherSaju.ilganOhang,
      saju_score: score,
      grade: getGrade(score),
    };
  });

  matches.sort((a, b) => b.saju_score - a.saju_score);
  return json({ my_id: userId, matches });
}

async function handleMatchDetail(idA, idB, env) {
  const [userA, userB] = await Promise.all([
    env.DB.prepare(`SELECT ${SELECT_PROFILE} FROM lm_profiles WHERE user_id = ?`).bind(idA).first(),
    env.DB.prepare(`SELECT ${SELECT_PROFILE} FROM lm_profiles WHERE user_id = ?`).bind(idB).first(),
  ]);
  if (!userA || !userB) return json({ error: '프로필을 찾을 수 없습니다' }, 404);

  const sajuA = calculateSaju(userA.birth_date, userA.birth_time || '');
  const sajuB = calculateSaju(userB.birth_date, userB.birth_time || '');
  const score = ohangCompatibility(sajuA, sajuB);
  const grade = getGrade(score);
  const relations = getOhangRelations(sajuA.ilganOhang, sajuB.ilganOhang);

  const baseResult = {
    user_a: { user_id: idA, nickname: userA.nickname, age: calcAge(userA.birth_date), gender: userA.gender, ohang: sajuA.ilganOhang },
    user_b: { user_id: idB, nickname: userB.nickname, age: calcAge(userB.birth_date), gender: userB.gender, ohang: sajuB.ilganOhang },
    score, grade, saju_a: sajuA, saju_b: sajuB, relations,
  };

  const apiKeys = getGeminiKeys(env);
  if (!apiKeys.length) return json({ ...baseResult, ai: null });

  const ai = await callGemini(apiKeys, buildCompatPrompt(sajuA, sajuB, score, grade, userA.gender, userB.gender), 'match-detail', env);
  return json({ ...baseResult, ai });
}

// --- Social Routes (from routes/social.js) ---

async function handleLike(request, targetId, env) {
  const { user_id } = await request.json();
  if (!user_id) return json({ error: 'user_id 필수' }, 400);
  if (user_id === targetId) return json({ error: '자기 자신에게 좋아요 불가' }, 400);

  await env.DB.prepare('INSERT OR IGNORE INTO lm_likes (from_id, to_id) VALUES (?, ?)').bind(user_id, targetId).run();

  // 상호 좋아요 → 매칭
  const mutual = await env.DB.prepare('SELECT id FROM lm_likes WHERE from_id = ? AND to_id = ?').bind(targetId, user_id).first();

  if (mutual) {
    const [a, b] = [user_id, targetId].sort();
    await env.DB.prepare('INSERT OR IGNORE INTO lm_matches (user_a, user_b) VALUES (?, ?)').bind(a, b).run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO lm_notifications (user_id, type, actor_id, content) VALUES (?, 'match', ?, '매칭이 성립되었어요!')").bind(user_id, targetId),
      env.DB.prepare("INSERT INTO lm_notifications (user_id, type, actor_id, content) VALUES (?, 'match', ?, '매칭이 성립되었어요!')").bind(targetId, user_id),
    ]);
    return json({ success: true, matched: true });
  }

  await env.DB.prepare("INSERT INTO lm_notifications (user_id, type, actor_id, content) VALUES (?, 'like', ?, '누군가 관심을 보냈어요')").bind(targetId, user_id).run();
  return json({ success: true, matched: false });
}

async function handleUnlike(request, targetId, env) {
  const { user_id } = await request.json();
  await env.DB.prepare('DELETE FROM lm_likes WHERE from_id = ? AND to_id = ?').bind(user_id, targetId).run();
  return json({ success: true });
}

async function handleLikesReceived(userId, env) {
  const { results } = await env.DB.prepare(
    `SELECT p.user_id, p.nickname, p.birth_date, p.saju_ilgan_ohang, l.created_at
     FROM lm_likes l JOIN lm_profiles p ON l.from_id = p.user_id
     WHERE l.to_id = ? ORDER BY l.created_at DESC`
  ).bind(userId).all();
  return json({ likes: results.map((r) => ({ ...r, age: calcAge(r.birth_date) })) });
}

async function handleMatches(userId, env) {
  const { results } = await env.DB.prepare(
    `SELECT m.*, CASE WHEN m.user_a = ? THEN m.user_b ELSE m.user_a END as other_id
     FROM lm_matches m WHERE (m.user_a = ? OR m.user_b = ?) AND m.status = 'active'`
  ).bind(userId, userId, userId).all();

  const matchList = [];
  for (const m of results) {
    const other = await env.DB.prepare(`SELECT ${SELECT_PROFILE} FROM lm_profiles WHERE user_id = ?`).bind(m.other_id).first();
    if (!other) continue;

    const lastMsg = await env.DB.prepare(
      `SELECT content, created_at, sender_id FROM lm_messages
       WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
       ORDER BY created_at DESC LIMIT 1`
    ).bind(userId, m.other_id, m.other_id, userId).first();

    const unread = await env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM lm_messages WHERE sender_id = ? AND receiver_id = ? AND is_read = 0'
    ).bind(m.other_id, userId).first();

    matchList.push({
      user_id: other.user_id,
      nickname: other.nickname,
      age: calcAge(other.birth_date),
      ohang: other.saju_ilgan_ohang,
      matched_at: m.matched_at,
      last_message: lastMsg?.content || null,
      last_message_at: lastMsg?.created_at || null,
      unread_count: unread?.cnt || 0,
    });
  }

  matchList.sort((a, b) => {
    const ta = a.last_message_at || a.matched_at;
    const tb = b.last_message_at || b.matched_at;
    return tb.localeCompare(ta);
  });

  return json({ matches: matchList });
}

// --- Message Routes (from routes/message.js) ---

async function handleGetMessages(userId, otherId, url, env) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50') || 50, 1), 200);
  const before = url.searchParams.get('before');

  let query = `SELECT * FROM lm_messages
    WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))`;
  const binds = [userId, otherId, otherId, userId];

  if (before) {
    query += ' AND created_at < ?';
    binds.push(before);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  binds.push(limit);

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return json({ messages: results.reverse() });
}

async function handleSendMessage(request, otherId, env) {
  const { user_id, content } = await request.json();
  if (!user_id || !content?.trim()) return json({ error: 'user_id, content 필수' }, 400);

  const [a, b] = [user_id, otherId].sort();
  const match = await env.DB.prepare(
    "SELECT id FROM lm_matches WHERE user_a = ? AND user_b = ? AND status = 'active'"
  ).bind(a, b).first();
  if (!match) return json({ error: '매칭된 상대에게만 쪽지를 보낼 수 있습니다' }, 403);

  await env.DB.prepare(
    'INSERT INTO lm_messages (sender_id, receiver_id, content) VALUES (?, ?, ?)'
  ).bind(user_id, otherId, content.trim().slice(0, 500)).run();

  await env.DB.prepare(
    "INSERT INTO lm_notifications (user_id, type, actor_id, content) VALUES (?, 'message', ?, '새 쪽지가 도착했어요')"
  ).bind(otherId, user_id).run();

  return json({ success: true });
}

async function handleReadMessages(request, otherId, env) {
  const { user_id } = await request.json();
  await env.DB.prepare(
    'UPDATE lm_messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0'
  ).bind(otherId, user_id).run();
  return json({ success: true });
}

// --- Notification Routes (from routes/notification.js) ---

async function handleGetNotifications(userId, env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM lm_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).bind(userId).all();
  return json({ notifications: results });
}

async function handleUnreadCount(userId, env) {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM lm_notifications WHERE user_id = ? AND is_read = 0'
  ).bind(userId).first();
  return json({ count: row?.cnt || 0 });
}

async function handleReadNotifications(userId, env) {
  await env.DB.prepare(
    'UPDATE lm_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0'
  ).bind(userId).run();
  return json({ success: true });
}

// --- Error Log Routes (from routes/error.js) ---

async function handlePostErrorLog(request, env) {
  const { message, source, line, col, stack, page, userAgent } = await request.json();

  try {
    await env.DB.prepare(
      `INSERT INTO error_logs (app_id, message, stack, url, user_agent)
       VALUES ('karma', ?, ?, ?, ?)`
    ).bind(
      (message || '').slice(0, 500),
      (stack || `${source}:${line}:${col}`).slice(0, 1000),
      (page || '').slice(0, 200),
      (userAgent || '').slice(0, 300)
    ).run();
  } catch {}

  console.error(`[FRONT ERROR] ${page} | ${message} | ${source}:${line}:${col}`);
  return json({ ok: true });
}

async function handleGetErrorLog(env) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM error_logs WHERE app_id = 'karma' ORDER BY created_at DESC LIMIT 50"
    ).all();
    return json({ errors: results });
  } catch {
    return json({ errors: [] });
  }
}

// ============================================================
// R2 Image Management
// ============================================================

async function handleR2List(url, env) {
  if (!env.R2_BUCKET) return json({ error: 'R2 not configured' }, 500);
  const prefix = url.searchParams.get('prefix') || 'karma/';
  const cursor = url.searchParams.get('cursor') || undefined;
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

  const listed = await env.R2_BUCKET.list({ prefix, limit, cursor });
  const items = listed.objects.map(obj => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded,
    type: obj.httpMetadata?.contentType || 'unknown',
  }));

  return json({
    items,
    cursor: listed.truncated ? listed.cursor : null,
    total: items.length,
  });
}

async function handleR2Get(url, env) {
  if (!env.R2_BUCKET) return json({ error: 'R2 not configured' }, 500);
  const key = url.searchParams.get('key');
  if (!key) return json({ error: 'key required' }, 400);

  const obj = await env.R2_BUCKET.get(key);
  if (!obj) return json({ error: 'not found' }, 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'no-cache',
      ...CORS_HEADERS,
    },
  });
}

async function handleR2Delete(request, env) {
  if (!env.R2_BUCKET) return json({ error: 'R2 not configured' }, 500);
  const { key } = await request.json();
  if (!key) return json({ error: 'key required' }, 400);

  await env.R2_BUCKET.delete(key);
  return json({ ok: true, deleted: key });
}

// ============================================================
// Path Parameter Helpers
// ============================================================

function matchPath(pattern, path) {
  // Convert pattern like "/api/match-list/:user_id" to regex
  const paramNames = [];
  const regexStr = pattern.replace(/:([a-zA-Z_]+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  const match = path.match(new RegExp(`^${regexStr}$`));
  if (!match) return null;
  const params = {};
  paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
  return params;
}

// ============================================================
// Worker Entry Point
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // ---- Auth Routes ----
      if (path === '/api/register' && method === 'POST') {
        return handleRegister(request, env);
      }
      if (path === '/api/login' && method === 'POST') {
        return handleLogin(request, env);
      }
      if (path === '/api/profile' && method === 'PUT') {
        return handleUpdateProfile(request, env);
      }
      if (path === '/api/profile' && method === 'DELETE') {
        return handleDeleteProfile(request, env);
      }

      // ---- Saju Routes ----
      if (path === '/api/saju' && method === 'POST') {
        return handleSajuAnalysis(request, env);
      }
      if (path === '/api/compat-quick' && method === 'POST') {
        return handleCompatQuick(request, env);
      }
      if (path === '/api/fortune' && method === 'POST') {
        return handleFortune(request, env);
      }
      if (path === '/api/quick-saju' && method === 'POST') {
        return handleQuickSaju(request, env);
      }
      if (path === '/api/face-reading' && method === 'POST') {
        return handleFaceReading(request, env);
      }
      if (path === '/api/palm-reading' && method === 'POST') {
        return handlePalmReading(request, env);
      }

      // ---- Match Routes ----
      {
        const params = matchPath('/api/match-list/:user_id', path);
        if (params && method === 'GET') {
          return handleMatchList(params.user_id, env);
        }
      }
      {
        const params = matchPath('/api/match/:id_a/:id_b', path);
        if (params && method === 'GET') {
          return handleMatchDetail(params.id_a, params.id_b, env);
        }
      }

      // ---- Social Routes ----
      {
        const params = matchPath('/api/like/:target_id', path);
        if (params && method === 'POST') {
          return handleLike(request, params.target_id, env);
        }
        if (params && method === 'DELETE') {
          return handleUnlike(request, params.target_id, env);
        }
      }
      {
        const params = matchPath('/api/likes/received/:user_id', path);
        if (params && method === 'GET') {
          return handleLikesReceived(params.user_id, env);
        }
      }
      {
        const params = matchPath('/api/matches/:user_id', path);
        if (params && method === 'GET') {
          return handleMatches(params.user_id, env);
        }
      }

      // ---- Message Routes ----
      {
        const params = matchPath('/api/messages/:user_id/:other_id', path);
        if (params && method === 'GET') {
          return handleGetMessages(params.user_id, params.other_id, url, env);
        }
      }
      {
        const params = matchPath('/api/messages/:other_id', path);
        if (params && method === 'POST') {
          return handleSendMessage(request, params.other_id, env);
        }
      }
      {
        const params = matchPath('/api/messages/:other_id/read', path);
        if (params && method === 'PUT') {
          return handleReadMessages(request, params.other_id, env);
        }
      }

      // ---- Notification Routes ----
      {
        const params = matchPath('/api/notifications/:user_id/unread', path);
        if (params && method === 'GET') {
          return handleUnreadCount(params.user_id, env);
        }
      }
      {
        const params = matchPath('/api/notifications/:user_id/read', path);
        if (params && method === 'PUT') {
          return handleReadNotifications(params.user_id, env);
        }
      }
      {
        const params = matchPath('/api/notifications/:user_id', path);
        if (params && method === 'GET') {
          return handleGetNotifications(params.user_id, env);
        }
      }

      // ---- Error Log Routes ----
      if (path === '/api/error-log' && method === 'POST') {
        return handlePostErrorLog(request, env);
      }
      if (path === '/api/error-log' && method === 'GET') {
        return handleGetErrorLog(env);
      }

      // ---- R2 Routes ----
      if (path === '/api/r2/list' && method === 'GET') {
        return handleR2List(url, env);
      }
      if (path === '/api/r2/image' && method === 'GET') {
        return handleR2Get(url, env);
      }
      if (path === '/api/r2/delete' && method === 'DELETE') {
        return handleR2Delete(request, env);
      }

      // ---- 404 ----
      return json({ error: 'Not Found' }, 404);

    } catch (e) {
      console.error('Worker error:', e.message || e, e.stack || '');
      return json({ error: 'Internal Server Error' }, 500);
    }
  },
};
