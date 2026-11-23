// Karma Worker — Single-file vanilla Cloudflare Worker
// Karma API Worker (vanilla JS, no framework)

// ============================================================
// CORS & Response Helpers
// ============================================================

let _perfStatsTableReady = false;
let _karmaImageAnalysesTableReady = false;
let _karmaAnalysesTableReady = false;
let _karmaConsistencyCacheTableReady = false;

const KARMA_CONSISTENCY_SCHEMA_VERSION = 'karma-consistency-v2';
// 2: 성형 상담 포인트를 얼굴 부위 중심으로 바꾸고 피부 관리는 보조 항목으로 제한 (2026-11-23)
const KARMA_FACE_RESULT_REVISION = 2;
const KARMA_CONSISTENCY_TTL_MS = Object.freeze({
  face: 90 * 24 * 60 * 60 * 1000,
  palm: 90 * 24 * 60 * 60 * 1000,
  saju: 30 * 24 * 60 * 60 * 1000,
  compat: 30 * 24 * 60 * 60 * 1000,
  fortune: 30 * 24 * 60 * 60 * 1000,
  daily: 7 * 24 * 60 * 60 * 1000,
  tarot: 30 * 24 * 60 * 60 * 1000,
});

async function ensurePerfStatsColumn(env, name, type) {
  try {
    await env.DB.prepare(`ALTER TABLE perf_stats ADD COLUMN ${name} ${type}`).run();
  } catch (error) {
    if (!/duplicate column|already exists/i.test(String(error?.message || error))) throw error;
  }
}

// 요청당 perf_stats 1행 기록 (fire-and-forget). harem/chatbot-api와 동일 스키마 공유.
async function logPerfStats(env, ctx, row) {
  if (!env?.DB) return;
  const doWrite = async () => {
    if (!_perfStatsTableReady) {
      try {
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS perf_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL DEFAULT (datetime('now')),
            app TEXT,
            model TEXT,
            provider_route TEXT,
            cache_key TEXT,
            cache_hit INTEGER,
            prompt_tokens INTEGER,
            cached_tokens INTEGER,
            cache_write_tokens INTEGER,
            output_tokens INTEGER,
            thought_tokens INTEGER,
            sys_chars INTEGER,
            hist_chars INTEGER,
            used_key_idx INTEGER,
            elapsed_ms INTEGER
          )
        `).run();
        await ensurePerfStatsColumn(env, 'model', 'TEXT');
        await ensurePerfStatsColumn(env, 'provider_route', 'TEXT');
        await ensurePerfStatsColumn(env, 'cache_write_tokens', 'INTEGER');
        await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_perf_stats_ts_app ON perf_stats(ts, app)').run();
        _perfStatsTableReady = true;
      } catch (e) {
        console.error('[PerfStats] Table create failed:', e.message);
        return;
      }
    }
    try {
      await env.DB.prepare(
        'INSERT INTO perf_stats (app, model, provider_route, cache_key, cache_hit, prompt_tokens, cached_tokens, cache_write_tokens, output_tokens, thought_tokens, sys_chars, hist_chars, used_key_idx, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        row.app, row.model || null, row.provider_route || null, row.cache_key, row.cache_hit,
        row.prompt_tokens, row.cached_tokens, row.cache_write_tokens || 0, row.output_tokens, row.thought_tokens,
        row.sys_chars, row.hist_chars, row.used_key_idx, row.elapsed_ms
      ).run();
    } catch (e) {
      console.warn('[PerfStats] insert error:', e.message);
    }
  };
  if (ctx?.waitUntil) ctx.waitUntil(doWrite());
  else await doWrite();
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const KARMA_ANALYSIS_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const KARMA_ANALYSIS_RATE_LIMITS = Object.freeze({
  photo: 5,
  text: 20,
});
let _karmaRateLimitsTableReady = false;

function constantTimeTextEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ''));
  const b = new TextEncoder().encode(String(right || ''));
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index] || 0) ^ (b[index] || 0);
  }
  return mismatch === 0;
}

function getKarmaAdminToken(request) {
  const authorization = String(request?.headers?.get?.('Authorization') || '');
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  return String(request?.headers?.get?.('X-Karma-Admin-Token') || '').trim();
}

function hasValidKarmaAdminToken(request, env) {
  const expected = String(env?.KARMA_ADMIN_TOKEN || '').trim();
  const provided = getKarmaAdminToken(request);
  return Boolean(expected && provided && constantTimeTextEqual(provided, expected));
}

function getKarmaAdminAuthError(request, env) {
  if (!String(env?.KARMA_ADMIN_TOKEN || '').trim()) {
    return json({ error: 'Not Found' }, 404);
  }
  if (!hasValidKarmaAdminToken(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

function getKarmaRateLimitPolicy(analysisType) {
  const photo = analysisType === 'face' || analysisType === 'palm';
  return {
    bucket: photo ? 'photo' : 'text',
    limit: photo ? KARMA_ANALYSIS_RATE_LIMITS.photo : KARMA_ANALYSIS_RATE_LIMITS.text,
    windowMs: KARMA_ANALYSIS_RATE_LIMIT_WINDOW_MS,
  };
}

const LEGACY_ACCOUNT_API_PATTERNS = Object.freeze([
  /^\/api\/(?:register|login|profile)$/,
  /^\/api\/(?:match-list|match|like|likes\/received|matches|messages|notifications)(?:\/|$)/,
]);

function isLegacyAccountApi(path) {
  return LEGACY_ACCOUNT_API_PATTERNS.some((pattern) => pattern.test(path));
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extraHeaders },
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

// 천간합 (甲己합토, 乙庚합금, 丙辛합수, 丁壬합목, 戊癸합화)
const CHEONGAN_HAP = [
  [0, 5, '토'], [1, 6, '금'], [2, 7, '수'], [3, 8, '목'], [4, 9, '화']
];
// 지지육합 (子丑합토, 寅亥합목, 卯戌합화, 辰酉합금, 巳申합수, 午未합토)
const JIJI_YUKHAP = [
  [0, 1, '토'], [2, 11, '목'], [3, 10, '화'], [4, 9, '금'], [5, 8, '수'], [6, 7, '토']
];
// 지지충 (子午, 丑未, 寅申, 卯酉, 辰戌, 巳亥)
const JIJI_CHUNG = [[0,6],[1,7],[2,8],[3,9],[4,10],[5,11]];

// 사주 내부의 합/충 관계 분석 (자기 사주 4주 간)
function analyzeInternalRelations(pillars) {
  const ganHap = [], jiHap = [], jiChung = [];
  for (let a = 0; a < pillars.length; a++) {
    for (let b = a + 1; b < pillars.length; b++) {
      const gA = CHEONGAN.indexOf(pillars[a].gan);
      const gB = CHEONGAN.indexOf(pillars[b].gan);
      const jA = JIJI.indexOf(pillars[a].ji);
      const jB = JIJI.indexOf(pillars[b].ji);
      for (const [x, y, oh] of CHEONGAN_HAP) {
        if ((gA === x && gB === y) || (gA === y && gB === x))
          ganHap.push(`${pillars[a].gan}(${pillars[a].name})-${pillars[b].gan}(${pillars[b].name}) 합${oh}`);
      }
      for (const [x, y, oh] of JIJI_YUKHAP) {
        if ((jA === x && jB === y) || (jA === y && jB === x))
          jiHap.push(`${pillars[a].ji}(${pillars[a].name})-${pillars[b].ji}(${pillars[b].name}) 합${oh}`);
      }
      for (const [x, y] of JIJI_CHUNG) {
        if ((jA === x && jB === y) || (jA === y && jB === x))
          jiChung.push(`${pillars[a].ji}(${pillars[a].name})-${pillars[b].ji}(${pillars[b].name}) 충`);
      }
    }
  }
  return { ganHap, jiHap, jiChung };
}

// 두 사주 간의 합/충 관계 분석
function analyzeSajuRelations(pillarsA, pillarsB) {
  const ganHap = [], jiHap = [], jiChung = [];

  for (const pA of pillarsA) {
    const gA = CHEONGAN.indexOf(pA.gan);
    const jA = JIJI.indexOf(pA.ji);
    for (const pB of pillarsB) {
      const gB = CHEONGAN.indexOf(pB.gan);
      const jB = JIJI.indexOf(pB.ji);
      // 천간합
      for (const [a, b, oh] of CHEONGAN_HAP) {
        if ((gA === a && gB === b) || (gA === b && gB === a)) {
          ganHap.push(`${pA.gan}(${pA.name})-${pB.gan}(${pB.name}) 합${oh}`);
        }
      }
      // 지지육합
      for (const [a, b, oh] of JIJI_YUKHAP) {
        if ((jA === a && jB === b) || (jA === b && jB === a)) {
          jiHap.push(`${pA.ji}(${pA.name})-${pB.ji}(${pB.name}) 합${oh}`);
        }
      }
      // 지지충
      for (const [a, b] of JIJI_CHUNG) {
        if ((jA === a && jB === b) || (jA === b && jB === a)) {
          jiChung.push(`${pA.ji}(${pA.name})-${pB.ji}(${pB.name}) 충`);
        }
      }
    }
  }
  return { ganHap, jiHap, jiChung };
}

// =============================================================================
// solar-terms.js — Precise 24절기 (Solar Terms) Calculator for Saju (사주)
//
// Algorithm: VSOP87 truncated series + Meeus nutation/aberration
//   (Jean Meeus "Astronomical Algorithms" 2nd Ed., Chapter 25)
// Accuracy: within ±1 minute vs bebeyam.com/KASI published data (1946-2025)
// All times in modern KST (UTC+9)
//
// Note on historical Korean timezone:
//   - Before 1954-03-21: UTC+9 (same as modern KST)
//   - 1954-03-21 ~ 1961-08-09: UTC+8:30 (old KST, 동경 127°30')
//   - After 1961-08-10: UTC+9 (current KST, 동경 135°)
//   This module always outputs modern KST (UTC+9). Published 만세력 data
//   from the 1954-1961 period may use old KST (30 minutes behind).
// =============================================================================

// ---------------------------------------------------------------------------
// 1. Julian Day Number (JDN) conversions
// ---------------------------------------------------------------------------

/**
 * Convert a Gregorian calendar date/time to Julian Day Number.
 * Meeus, Ch. 7
 */
function dateToJD(year, month, day, hour, minute, second) {
  hour = hour || 0;
  minute = minute || 0;
  second = second || 0;

  const dayFrac = day + (hour + minute / 60 + second / 3600) / 24;

  if (month <= 2) {
    year -= 1;
    month += 12;
  }

  const A = Math.floor(year / 100);
  const B = 2 - A + Math.floor(A / 4);

  return Math.floor(365.25 * (year + 4716)) +
         Math.floor(30.6001 * (month + 1)) +
         dayFrac + B - 1524.5;
}

/**
 * Convert Julian Day Number back to Gregorian calendar date/time.
 * Returns { year, month, day, hour, minute, second }
 * Meeus, Ch. 7
 */
function jdToDate(jd) {
  const z = Math.floor(jd + 0.5);
  const f = jd + 0.5 - z;

  let A;
  if (z < 2299161) {
    A = z;
  } else {
    const alpha = Math.floor((z - 1867216.25) / 36524.25);
    A = z + 1 + alpha - Math.floor(alpha / 4);
  }

  const B = A + 1524;
  const C = Math.floor((B - 122.1) / 365.25);
  const D = Math.floor(365.25 * C);
  const E = Math.floor((B - D) / 30.6001);

  const day = B - D - Math.floor(30.6001 * E);
  const month = E < 14 ? E - 1 : E - 13;
  const year = month > 2 ? C - 4716 : C - 4715;

  const dayFrac = f;
  const totalHours = dayFrac * 24;
  const hour = Math.floor(totalHours);
  const totalMinutes = (totalHours - hour) * 60;
  const minute = Math.floor(totalMinutes);
  const second = Math.round((totalMinutes - minute) * 60);

  return { year, month, day, hour, minute, second };
}

// ---------------------------------------------------------------------------
// 2. Solar longitude computation (VSOP87 simplified, Meeus Ch. 25)
// ---------------------------------------------------------------------------

/** Normalize angle to [0, 360) degrees */
function normalizeAngle(deg) {
  deg = deg % 360;
  if (deg < 0) deg += 360;
  return deg;
}

/** Degrees to radians */
function rad(deg) { return deg * Math.PI / 180; }

/** Radians to degrees */
function deg(r) { return r * 180 / Math.PI; }

/**
 * Higher-accuracy sun longitude using VSOP87 truncated series.
 * Computes the Earth's heliocentric longitude via VSOP87 (Meeus Table 25.A),
 * converts to geocentric, then applies nutation and aberration.
 * Accuracy: ~0.01° (about 15 seconds of time) for years -2000 to +6000.
 */
function sunLongitudeHighAccuracy(jd) {
  const T = (jd - 2451545.0) / 36525.0;
  const tau = T / 10; // Julian millennia from J2000.0

  // VSOP87 Series for Earth's heliocentric longitude L (Meeus Table 25.A)
  // Each term: [A, B, C] → A * cos(B + C * tau)
  // L0 terms (constant + secular)
  const L0_terms = [
    [175347046, 0, 0],
    [3341656, 4.6692568, 6283.0758500],
    [34894, 4.62610, 12566.15170],
    [3497, 2.7441, 5753.3849],
    [3418, 2.8289, 3.5232],
    [3136, 3.6277, 77713.7715],
    [2676, 4.4181, 7860.4194],
    [2343, 6.1352, 3930.2097],
    [1324, 0.7425, 11506.7698],
    [1273, 2.0371, 529.6910],
    [1199, 1.1096, 1577.3435],
    [990, 5.233, 5884.927],
    [902, 2.045, 26.298],
    [857, 3.508, 398.149],
    [780, 1.179, 5223.694],
    [753, 2.533, 5507.553],
    [505, 4.583, 18849.228],
    [492, 4.205, 775.523],
    [357, 2.920, 0.067],
    [317, 5.849, 11790.629],
    [284, 1.899, 796.298],
    [271, 0.315, 10977.079],
    [243, 0.345, 5486.778],
    [206, 4.806, 2544.314],
    [205, 1.869, 5573.143],
    [202, 2.458, 6069.777],
    [156, 0.833, 213.299],
    [132, 3.411, 2942.463],
    [126, 1.083, 20.775],
    [115, 0.645, 0.980],
    [103, 0.636, 4694.003],
    [99, 6.21, 2146.17],
    [98, 0.68, 155.42],
    [86, 5.98, 161000.69],
    [85, 1.30, 6275.96],
    [85, 3.67, 71430.70],
    [80, 1.81, 17260.15],
  ];

  const L1_terms = [
    [628331966747, 0, 0],
    [206059, 2.678235, 6283.075850],
    [4303, 2.6351, 12566.1517],
    [425, 1.590, 3.523],
    [119, 5.796, 26.298],
    [109, 2.966, 1577.344],
    [93, 2.59, 18849.23],
    [72, 1.14, 529.69],
    [68, 1.87, 398.15],
    [67, 4.41, 5507.55],
    [59, 2.89, 5223.69],
    [56, 2.17, 155.42],
    [45, 0.40, 796.30],
    [36, 0.47, 775.52],
    [29, 2.65, 7.11],
    [21, 5.34, 0.98],
    [19, 1.85, 5486.78],
    [19, 4.97, 213.30],
    [17, 2.99, 6275.96],
    [16, 0.03, 2544.31],
    [16, 1.43, 2146.17],
    [15, 1.21, 10977.08],
    [12, 2.83, 1748.02],
    [12, 3.26, 5088.63],
    [12, 5.27, 1194.45],
    [12, 2.08, 4694.00],
    [11, 0.77, 553.57],
    [10, 1.30, 6286.60],
    [10, 4.24, 1349.87],
    [9, 2.70, 242.73],
    [9, 5.64, 951.72],
    [8, 5.30, 2352.87],
    [6, 2.65, 9437.76],
    [6, 4.67, 4690.48],
  ];

  const L2_terms = [
    [52919, 0, 0],
    [8720, 1.0721, 6283.0758],
    [309, 0.867, 12566.152],
    [27, 0.05, 3.52],
    [16, 5.19, 26.30],
    [16, 3.68, 155.42],
    [10, 0.76, 18849.23],
    [9, 2.06, 77713.77],
    [7, 0.83, 775.52],
    [5, 4.66, 1577.34],
    [4, 1.03, 7.11],
    [4, 3.44, 5573.14],
    [3, 5.14, 796.30],
    [3, 6.05, 5507.55],
    [3, 1.19, 242.73],
    [3, 6.12, 529.69],
    [3, 0.31, 398.15],
    [3, 2.28, 553.57],
    [2, 4.38, 5223.69],
    [2, 3.75, 0.98],
  ];

  const L3_terms = [
    [289, 5.844, 6283.076],
    [35, 0, 0],
    [17, 5.49, 12566.15],
    [3, 5.20, 155.42],
    [1, 4.72, 3.52],
    [1, 5.30, 18849.23],
    [1, 5.97, 242.73],
  ];

  const L4_terms = [
    [114, 3.142, 0],
    [8, 4.13, 6283.08],
    [1, 3.84, 12566.15],
  ];

  const L5_terms = [
    [1, 3.14, 0],
  ];

  function evalSeries(terms, tau) {
    let sum = 0;
    for (const [A, B, C] of terms) {
      sum += A * Math.cos(B + C * tau);
    }
    return sum;
  }

  // Compute L in radians
  const L0 = evalSeries(L0_terms, tau);
  const L1 = evalSeries(L1_terms, tau);
  const L2 = evalSeries(L2_terms, tau);
  const L3 = evalSeries(L3_terms, tau);
  const L4 = evalSeries(L4_terms, tau);
  const L5 = evalSeries(L5_terms, tau);

  // Heliocentric longitude in radians
  let L = (L0 + L1 * tau + L2 * tau * tau + L3 * tau * tau * tau +
           L4 * tau * tau * tau * tau + L5 * tau * tau * tau * tau * tau) / 1e8;

  // Convert to degrees and normalize
  L = normalizeAngle(deg(L));

  // Convert heliocentric to geocentric: add 180°
  let geoLon = normalizeAngle(L + 180);

  // Aberration correction (Meeus Eq. 25.10)
  const omega = 125.04 - 1934.136 * T;
  const aberration = -20.4898 / 3600 / (1.000001018 *
    (1 - 0.016708634 * Math.cos(rad(normalizeAngle(357.52911 + 35999.05029 * T)))));

  // Nutation in longitude (Meeus Ch. 22, full series top terms)
  const omrad = rad(omega);
  const Lsun = normalizeAngle(280.4665 + 36000.7698 * T);
  const Lmoon = normalizeAngle(218.3165 + 481267.8813 * T);
  const nutLon = (-17.20 * Math.sin(omrad)
                - 1.32 * Math.sin(rad(2 * Lsun))
                - 0.23 * Math.sin(rad(2 * Lmoon))
                + 0.21 * Math.sin(2 * omrad)) / 3600;

  geoLon = geoLon + nutLon + aberration;

  return normalizeAngle(geoLon);
}

// ---------------------------------------------------------------------------
// 3. Find the JD when the Sun reaches a given ecliptic longitude
// ---------------------------------------------------------------------------

/**
 * Approximate JD for when the Sun reaches a specific longitude in a given year.
 * The key insight: for a Gregorian year Y, we need the occurrence that falls
 * within that year. The March equinox (lon=0°) occurs around March 20.
 *
 * Longitudes 0°-265° occur AFTER the March equinox → April through December.
 * Longitudes 270°-359° occur BEFORE the March equinox → January through March.
 *
 * For 절기 this breaks down as:
 *   청명(15°)~대설(255°) → after equinox, same year
 *   소한(285°), 입춘(315°), 경칩(345°) → before equinox, same Gregorian year
 */
function approxJDForSunLongitude(year, targetLon) {
  // March equinox approximate JD for the given year (Meeus Table 27.A/B)
  const Y = (year - 2000) / 1000;
  const JDE0 = 2451623.80984 + 365242.37404 * Y + 0.05169 * Y * Y
             - 0.00411 * Y * Y * Y - 0.00057 * Y * Y * Y * Y;

  // Offset in degrees from the March equinox (lon=0°).
  // Longitudes >= 270° occur BEFORE the equinox in Jan/Feb/early March,
  // so we need a negative offset from the equinox.
  let offset = targetLon;
  if (offset >= 270) {
    offset = offset - 360; // e.g., 315→-45, 285→-75, 345→-15
  }

  // Sun moves ~360° in ~365.25 days ≈ 0.9856°/day
  return JDE0 + offset * 365.25 / 360;
}

/**
 * Find the exact JD (in TDT) when the Sun's apparent longitude equals targetLon.
 * Uses Newton-Raphson iteration with bounds to ensure we find the correct year's instance.
 * @param {number} year - Gregorian year
 * @param {number} targetLon - Target ecliptic longitude in degrees [0, 360)
 * @returns {number} Julian Day (TDT)
 */
function findSunLongitudeJD(year, targetLon) {
  // Get initial approximation
  let jd = approxJDForSunLongitude(year, targetLon);

  // Establish search bounds: the result must fall within ±30 days of the initial estimate.
  // This prevents Newton-Raphson from drifting to the adjacent year's occurrence.
  const jdMin = jd - 30;
  const jdMax = jd + 30;

  // Newton-Raphson iteration
  for (let iter = 0; iter < 50; iter++) {
    const lon = sunLongitudeHighAccuracy(jd);
    let diff = targetLon - lon;

    // Handle the 360/0 boundary
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;

    // Convergence check: < 0.00001 degree ≈ 0.036 arcsec ≈ ~0.09 seconds of time
    if (Math.abs(diff) < 0.00001) break;

    // Sun moves about 360/365.25 ≈ 0.9856 degrees per day
    let step = diff * 365.25 / 360;

    // Clamp to stay within bounds
    let newJd = jd + step;
    if (newJd < jdMin) newJd = jdMin + (jd - jdMin) * 0.5;
    if (newJd > jdMax) newJd = jdMax - (jdMax - jd) * 0.5;

    jd = newJd;
  }

  return jd;
}

// ---------------------------------------------------------------------------
// 4. Delta T: difference between TDT and UT (Meeus Ch. 10, extended)
// ---------------------------------------------------------------------------

/**
 * Compute Delta T (TDT - UT) in seconds.
 * Uses polynomial expressions from Meeus and Espenak & Meeus (2006).
 */
function deltaT(year) {
  const y = year + 0.5; // approximate mid-year

  if (y >= 2005 && y < 2050) {
    const t = y - 2000;
    return 62.92 + 0.32217 * t + 0.005589 * t * t;
  } else if (y >= 1986 && y < 2005) {
    const t = y - 2000;
    return 63.86 + 0.3345 * t - 0.060374 * t * t
           + 0.0017275 * t * t * t + 0.000651814 * t * t * t * t
           + 0.00002373599 * t * t * t * t * t;
  } else if (y >= 1961 && y < 1986) {
    const t = y - 1975;
    return 45.45 + 1.067 * t - t * t / 260 - t * t * t / 718;
  } else if (y >= 1941 && y < 1961) {
    const t = y - 1950;
    return 29.07 + 0.407 * t - t * t / 233 + t * t * t / 2547;
  } else if (y >= 1920 && y < 1941) {
    const t = y - 1920;
    return 21.20 + 0.84493 * t - 0.076100 * t * t + 0.0020936 * t * t * t;
  } else if (y >= 1900 && y < 1920) {
    const t = y - 1900;
    return -2.79 + 1.494119 * t - 0.0598939 * t * t
           + 0.0061966 * t * t * t - 0.000197 * t * t * t * t;
  } else if (y >= 2050 && y < 2150) {
    // Extrapolation for 2050-2150
    const u = (y - 1820) / 100;
    return -20 + 32 * u * u - 0.5628 * (2150 - y);
  } else {
    // Fallback for far future/past
    const u = (y - 1820) / 100;
    return -20 + 32 * u * u;
  }
}

// ---------------------------------------------------------------------------
// 5. The 12 절기 (Jeolgi) that define saju month boundaries
// ---------------------------------------------------------------------------

/**
 * Solar longitudes for the 12 절기 that mark saju month boundaries.
 * Order: 소한, 입춘, 경칩, 청명, 입하, 망종, 소서, 입추, 백로, 한로, 입동, 대설
 */
const JEOLGI_LONGITUDES = [
  285,  // 소한 (Small Cold) → 축월(12th saju month)
  315,  // 입춘 (Start of Spring) → 인월(1st saju month)
  345,  // 경칩 (Awakening of Insects) → 묘월(2nd)
  15,   // 청명 (Clear and Bright) → 진월(3rd)
  45,   // 입하 (Start of Summer) → 사월(4th)
  75,   // 망종 (Grain in Ear) → 오월(5th)
  105,  // 소서 (Minor Heat) → 미월(6th)
  135,  // 입추 (Start of Autumn) → 신월(7th)
  165,  // 백로 (White Dew) → 유월(8th)
  195,  // 한로 (Cold Dew) → 술월(9th)
  225,  // 입동 (Start of Winter) → 해월(10th)
  255,  // 대설 (Major Snow) → 자월(11th)
];

const JEOLGI_NAMES = [
  '소한', '입춘', '경칩', '청명', '입하', '망종',
  '소서', '입추', '백로', '한로', '입동', '대설',
];

// ---------------------------------------------------------------------------
// 6. Lookup table cache and main API
// ---------------------------------------------------------------------------

/** Cache for computed solar terms: { year: [[m,d,h,min], ...] } */
const _solarTermsCache = {};

/**
 * Get the exact date/time (KST) of all 12 절기 for a given year.
 * @param {number} year - Gregorian year (1920-2100)
 * @returns {Array} Array of 12 entries: [[month, day, hour, minute], ...]
 *   Index 0 = 소한, 1 = 입춘, ..., 11 = 대설
 */
function getExactSolarTerms(year) {
  if (_solarTermsCache[year]) {
    return _solarTermsCache[year];
  }

  const results = [];

  for (let i = 0; i < 12; i++) {
    const targetLon = JEOLGI_LONGITUDES[i];

    // Determine which Gregorian year to search in.
    // 소한(285°) is in Jan, 입춘(315°) in Feb, ..., 대설(255°) in Dec.
    // But 소한(285°) and 입춘(315°) are in the SAME Gregorian year as the saju year,
    // while 청명(15°) through 대설(255°) also fall in the same Gregorian year.
    // All 12 절기 for a given saju year fall within the same Gregorian year.
    const searchYear = year;

    // Find the JD (TDT) when the Sun reaches this longitude
    const jdTDT = findSunLongitudeJD(searchYear, targetLon);

    // Convert TDT to UT by subtracting Delta T
    const dt = deltaT(searchYear);
    const jdUT = jdTDT - dt / 86400;

    // Convert UT to KST (UTC+9)
    const jdKST = jdUT + 9 / 24;

    // Convert JD to calendar date/time
    const date = jdToDate(jdKST);

    results.push([date.month, date.day, date.hour, date.minute]);
  }

  _solarTermsCache[year] = results;
  return results;
}

/**
 * Get the exact date/time (KST) of a specific 절기 for a given year.
 * @param {number} year - Gregorian year
 * @param {number} index - 절기 index (0=소한, 1=입춘, ..., 11=대설)
 * @returns {Array} [month, day, hour, minute]
 */
function getExactSolarTerm(year, index) {
  return getExactSolarTerms(year)[index];
}

/**
 * Get the saju month (1-12) for a given Gregorian date and time (KST).
 * Uses exact 절기 boundaries.
 * sajuMonth 1=인월, 2=묘월, ..., 11=자월, 12=축월
 * @param {number} year - Gregorian year
 * @param {number} month - Gregorian month (1-12)
 * @param {number} day - Day of month
 * @param {number} hour - Hour in KST (0-23)
 * @param {number} minute - Minute (0-59)
 * @returns {number} Saju month (1-12)
 */
function getSajuMonthExact(year, month, day, hour, minute) {
  hour = hour || 0;
  minute = minute || 0;

  const SAJU_MONTH_BY_TERM = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

  // Get solar terms for this year
  const terms = getExactSolarTerms(year);

  // Convert the input date to a comparable number (minutes since start of year)
  const inputMinutes = ((month - 1) * 31 + day) * 1440 + hour * 60 + minute;

  // Walk backwards through the 절기 boundaries
  for (let i = 11; i >= 0; i--) {
    const [tm, td, th, tmin] = terms[i];
    const termMinutes = ((tm - 1) * 31 + td) * 1440 + th * 60 + tmin;

    if (inputMinutes >= termMinutes) {
      return SAJU_MONTH_BY_TERM[i];
    }
  }

  // Before 소한 of this year → still in 자월(11) from 대설 of prev year
  return 11;
}

/**
 * Get the 입춘-adjusted year for saju year pillar (exact time version).
 * Before 입춘 of this year, saju year is previous Gregorian year.
 * @param {number} year - Gregorian year
 * @param {number} month - Gregorian month (1-12)
 * @param {number} day - Day
 * @param {number} hour - Hour in KST (0-23)
 * @param {number} minute - Minute (0-59)
 * @returns {number} Saju year
 */
function getSajuYearExact(year, month, day, hour, minute) {
  hour = hour || 0;
  minute = minute || 0;

  const terms = getExactSolarTerms(year);
  const [ipM, ipD, ipH, ipMin] = terms[1]; // 입춘

  // Compare: is the given datetime before 입춘?
  const inputVal = month * 100000000 + day * 1000000 + hour * 10000 + minute * 100;
  const ipVal = ipM * 100000000 + ipD * 1000000 + ipH * 10000 + ipMin * 100;

  if (inputVal < ipVal) {
    return year - 1;
  }
  return year;
}


// getSajuMonth/getSajuYear → 정밀 버전으로 래핑
function getSajuMonth(year, month, day, hour, minute) { return getSajuMonthExact(year, month, day, hour, minute); }
function getSajuYear(year, month, day, hour, minute) { return getSajuYearExact(year, month, day, hour, minute); }

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

// 서머타임 기간 (대한민국 실시 이력)
const DST_PERIODS = [
  [1948,6,1, 1948,9,13], [1949,4,3, 1949,9,11], [1950,4,1, 1950,9,10],
  [1951,5,6, 1951,9,9],  [1955,5,5, 1955,9,9],  [1956,5,20,1956,9,30],
  [1957,5,5, 1957,9,22], [1958,5,4, 1958,9,21], [1959,5,3, 1959,9,20],
  [1960,5,1, 1960,9,18], [1987,5,10,1987,10,11],[1988,5,8, 1988,10,9],
];

function isDST(year, month, day) {
  for (const [sy,sm,sd,ey,em,ed] of DST_PERIODS) {
    if (year !== sy) continue;
    const d = year * 10000 + month * 100 + day;
    if (d >= sy * 10000 + sm * 100 + sd && d < ey * 10000 + em * 100 + ed) return true;
  }
  return false;
}

// ===== 출생 지역별 타임존(UTC오프셋) 데이터 =====
// 키: 프론트에서 전송하는 value (utc+9 등), 값: UTC 오프셋(시간)
const BIRTH_LOCATIONS = {
  'utc+12':   { utcOffset: 12 },
  'utc+11':   { utcOffset: 11 },
  'utc+10':   { utcOffset: 10 },
  'utc+9.5':  { utcOffset: 9.5 },
  'utc+9':    { utcOffset: 9 },
  'utc+8':    { utcOffset: 8 },
  'utc+7':    { utcOffset: 7 },
  'utc+6.5':  { utcOffset: 6.5 },
  'utc+6':    { utcOffset: 6 },
  'utc+5.75': { utcOffset: 5.75 },
  'utc+5.5':  { utcOffset: 5.5 },
  'utc+5':    { utcOffset: 5 },
  'utc+4':    { utcOffset: 4 },
  'utc+3.5':  { utcOffset: 3.5 },
  'utc+3':    { utcOffset: 3 },
  'utc+2':    { utcOffset: 2 },
  'utc+1':    { utcOffset: 1 },
  'utc+0':    { utcOffset: 0 },
  'utc-3':    { utcOffset: -3 },
  'utc-4':    { utcOffset: -4 },
  'utc-5':    { utcOffset: -5 },
  'utc-6':    { utcOffset: -6 },
  'utc-7':    { utcOffset: -7 },
  'utc-8':    { utcOffset: -8 },
  'utc-9':    { utcOffset: -9 },
  'utc-10':   { utcOffset: -10 },
};

// 출생지 시간 → KST 변환 (절기 판단용)
// 반환: { kstHour, kstMinute, kstYear, kstMonth, kstDay }
function convertToKST(hour, minute, year, month, day, locationKey) {
  if (!locationKey || locationKey === 'utc+9' || locationKey === 'kr') {
    return { kstHour: hour, kstMinute: minute, kstYear: year, kstMonth: month, kstDay: day };
  }
  const loc = BIRTH_LOCATIONS[locationKey];
  if (!loc) return { kstHour: hour, kstMinute: minute, kstYear: year, kstMonth: month, kstDay: day };

  const offsetDiffMin = (9 - loc.utcOffset) * 60; // local → KST 분 차이
  let total = hour * 60 + minute + offsetDiffMin;
  let dayAdj = 0;
  while (total >= 1440) { total -= 1440; dayAdj++; }
  while (total < 0)     { total += 1440; dayAdj--; }

  const d = new Date(year, month - 1, day + dayAdj);
  return {
    kstHour: Math.floor(total / 60),
    kstMinute: total % 60,
    kstYear: d.getFullYear(),
    kstMonth: d.getMonth() + 1,
    kstDay: d.getDate(),
  };
}

// 태양시 보정: 표준시(KST, UTC+9, 동경135°) → 서울 태양시(~동경127°)
function hourPillar(dayGan, hour) {
  const shiIndex = Math.floor(((hour + 1) % 24) / 2);
  const base = { 갑: 0, 을: 2, 병: 4, 정: 6, 무: 8, 기: 0, 경: 2, 신: 4, 임: 6, 계: 8 };
  const gan = CHEONGAN[(base[dayGan] + shiIndex) % 10];
  const ji = JIJI[shiIndex];
  return { gan, ji };
}

// 두 날짜/시간 사이의 일수 차이
function dateDiffDays(y1, m1, d1, h1, min1, y2, m2, d2, h2, min2) {
  const dateA = new Date(y1, m1 - 1, d1, h1, min1);
  const dateB = new Date(y2, m2 - 1, d2, h2, min2);
  return Math.abs(dateA.getTime() - dateB.getTime()) / 86400000;
}

// 일수 → 대운 시작 나이 (3일 = 1년, 나머지 2일 이상이면 +1)
function daysToAge(days) {
  const q = Math.floor(days / 3);
  const r = days % 3;
  return r >= 2 ? q + 1 : q;
}

// 분 단위 비교값 (날짜+시간을 단일 숫자로 변환)
function toMinuteVal(m, d, h, min) {
  return ((m - 1) * 31 + d) * 1440 + h * 60 + min;
}

// 정운법: 생일에서 가장 가까운 절기까지 일수 / 3 = 대운 시작 나이
// 절기 시:분까지 비교하여 같은 날 절기도 정확히 처리
function calcDaeunStartAge(year, month, day, hour, minute, direction) {
  hour = hour || 0;
  minute = minute || 0;
  const terms = getExactSolarTerms(year);
  const birthMin = toMinuteVal(month, day, hour, minute);

  if (direction === 1) {
    // 순행: 다가올 절기 (미래)
    for (let i = 0; i < 12; i++) {
      const t = terms[i];
      const th = t[2] || 0, tmin = t[3] || 0;
      if (toMinuteVal(t[0], t[1], th, tmin) > birthMin) {
        return daysToAge(dateDiffDays(
          year, t[0], t[1], th, tmin,
          year, month, day, hour, minute
        ));
      }
    }
    // 올해 남은 절기 없음 → 내년 소한
    const n = getExactSolarTerms(year + 1)[0];
    return daysToAge(dateDiffDays(
      year + 1, n[0], n[1], n[2] || 0, n[3] || 0,
      year, month, day, hour, minute
    ));
  } else {
    // 역행: 지난 절기 (과거)
    for (let i = 11; i >= 0; i--) {
      const t = terms[i];
      const th = t[2] || 0, tmin = t[3] || 0;
      if (toMinuteVal(t[0], t[1], th, tmin) <= birthMin) {
        return daysToAge(dateDiffDays(
          year, month, day, hour, minute,
          year, t[0], t[1], th, tmin
        ));
      }
    }
    // 올해 이전 절기 없음 → 작년 대설
    const p = getExactSolarTerms(year - 1)[11];
    return daysToAge(dateDiffDays(
      year, month, day, hour, minute,
      year - 1, p[0], p[1], p[2] || 0, p[3] || 0
    ));
  }
}

function calculateDaeun(birthDate, gender, monthGanIndex, monthJiIndex, birthHour, birthMinute) {
  const [year, month, day] = birthDate.split('-').map(Number);
  const sajuYear = getSajuYear(year, month, day, birthHour, birthMinute);
  const yearGan = yearCheongan(sajuYear);
  const yearGanIndex = CHEONGAN.indexOf(yearGan);

  const isYangGan = yearGanIndex % 2 === 0;
  const isMale = gender === 'male';
  const direction = (isYangGan && isMale) || (!isYangGan && !isMale) ? 1 : -1;
  const startAge = calcDaeunStartAge(year, month, day, birthHour || 0, birthMinute || 0, direction) || 1;

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

function calculateSaju(birthDate, birthTime, gender, yajasi, location) {
  const [year, month, day] = (birthDate || '').split('-').map(Number);
  if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error('유효하지 않은 생년월일 형식입니다');
  }
  const hasTime = birthTime && birthTime.length >= 4;
  const rawHour = hasTime ? parseInt(birthTime.split(':')[0], 10) : null;
  const rawMinute = hasTime ? parseInt(birthTime.split(':')[1] || '0', 10) : 0;

  // UI가 태양시 기준(+30분 보정된) 시간대를 표시하므로 추가 -30분 보정 불필요
  // 서머타임(1948~1988) 기간만 -60분 보정 적용 (한국 출생만)
  let solarHour = rawHour;
  const isKorea = !location || location === 'utc+9' || location === 'kr';
  if (isKorea && rawHour !== null && isDST(year, month, day)) {
    let m = (rawMinute || 0) - 60;
    let h = rawHour;
    while (m < 0) { m += 60; h--; }
    if (h < 0) h += 24;
    solarHour = h;
  }

  // 해외 출생: 현지 시간 → KST 변환 (절기 경계 판단용)
  // 시주/일주는 현지 시간 기준 (사용자가 현지 시진을 선택)
  const isIntl = !isKorea && location && BIRTH_LOCATIONS[location];
  const kst = (isIntl && rawHour !== null)
    ? convertToKST(rawHour, rawMinute, year, month, day, location)
    : { kstHour: rawHour || 0, kstMinute: rawMinute, kstYear: year, kstMonth: month, kstDay: day };

  // 입춘-adjusted year for year pillar (절기 시간 단위 정밀 판단) — KST 기준
  const sajuYear = getSajuYear(kst.kstYear, kst.kstMonth, kst.kstDay, kst.kstHour, kst.kstMinute);
  // 절기-based month for month pillar (절기 시간 단위 정밀 판단) — KST 기준
  const sajuMonth = getSajuMonth(kst.kstYear, kst.kstMonth, kst.kstDay, kst.kstHour, kst.kstMinute);

  const yGan = yearCheongan(sajuYear);
  const yJi = yearJiji(sajuYear);
  const yearGanIndex = CHEONGAN.indexOf(yGan);
  const mGan = monthCheongan(yearGanIndex, sajuMonth);
  const mJi = monthJiji(sajuMonth);
  // 야자시 처리: 자시(23:30~01:30) 중 23:30~00:00에 태어난 경우
  // 야자시 적용 시 → 시주는 자시 그대로, 일주만 다음날 기준
  // 자시 select value = "00:00" (hour=0), 실제 23:30~00:00 구간은
  // UI에서 자시를 선택한 경우에 해당 (사용자가 야자시 체크 + 자시 선택)
  let dayForPillar = day;
  if (yajasi && solarHour !== null && solarHour === 0) {
    // 야자시 적용: 자시 선택 시 일주를 다음날로
    dayForPillar = day + 1;
  }
  const { gan: dGan, ji: dJi } = dayPillar(year, month, dayForPillar);

  const pillars = [
    { name: '년주', gan: yGan, ji: yJi },
    { name: '월주', gan: mGan, ji: mJi },
    { name: '일주', gan: dGan, ji: dJi },
  ];

  if (solarHour !== null) {
    const { gan: hGan, ji: hJi } = hourPillar(dGan, solarHour);
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
    daeun = calculateDaeun(birthDate, gender, mGanIdx, mJiIdx, rawHour, rawMinute);
  }

  return {
    pillars, ohangCount, ilgan, ilganOhang,
    hasTime: solarHour !== null,
    summary: pillars.map((p) => `${p.name}: ${p.gan}${p.ji}`).join(', '),
    daeun,
  };
}

// ---- English translation for saju data (lang=en) ----
const GAN_EN = { '갑':'Gap','을':'Eul','병':'Byeong','정':'Jeong','무':'Mu','기':'Gi','경':'Gyeong','신':'Sin','임':'Im','계':'Gye' };
const JI_EN = { '자':'Ja','축':'Chuk','인':'In','묘':'Myo','진':'Jin','사':'Sa','오':'O','미':'Mi','신':'Sin','유':'Yu','술':'Sul','해':'Hae' };
const OHANG_EN = { '목':'Wood','화':'Fire','토':'Earth','금':'Metal','수':'Water' };
const PILLAR_EN = { '년주':'Year','월주':'Month','일주':'Day','시주':'Hour' };

function translateSajuToEn(saju) {
  const pillars = saju.pillars.map(p => ({
    ...p,
    name: PILLAR_EN[p.name] || p.name,
    ganEn: GAN_EN[p.gan] || p.gan,
    jiEn: JI_EN[p.ji] || p.ji,
  }));

  const ohangCount = {};
  for (const [k, v] of Object.entries(saju.ohangCount)) {
    ohangCount[OHANG_EN[k] || k] = v;
  }

  const daeun = saju.daeun ? saju.daeun.map(du => ({
    ...du,
    ganEn: GAN_EN[du.gan] || du.gan,
    jiEn: JI_EN[du.ji] || du.ji,
    ohang: OHANG_EN[du.ohang] || du.ohang,
    jiOhang: OHANG_EN[du.jiOhang] || du.jiOhang,
    label: du.fromAge != null ? `Age ${du.fromAge}-${du.toAge}` : du.label,
  })) : null;

  return {
    ...saju,
    pillars,
    ohangCount,
    ilganEn: GAN_EN[saju.ilgan] || saju.ilgan,
    ilganOhang: OHANG_EN[saju.ilganOhang] || saju.ilganOhang,
    summary: pillars.map(p => `${p.name}: ${p.ganEn}-${p.jiEn}`).join(', '),
    daeun,
  };
}

function ohangCompatibility(saju1, saju2) {
  let score = 58;
  const oh1 = saju1.ilganOhang;
  const oh2 = saju2.ilganOhang;

  // 일간·음양·일지·원국 전체 합충과 오행 보완/과다 겹침을 큰 폭으로 반영해 궁합 점수 편차 확대
  if (SANGSAENG[oh1] === oh2 || SANGSAENG[oh2] === oh1) score += 14;
  if (SANGGEUK[oh1] === oh2 || SANGGEUK[oh2] === oh1) score -= 14;
  if (oh1 === oh2) score -= 4;

  const info1 = CHEONGAN_INFO[saju1.ilgan] || {};
  const info2 = CHEONGAN_INFO[saju2.ilgan] || {};
  if (Boolean(info1.yin) !== Boolean(info2.yin)) score += 6;
  else score -= 5;

  const dayA = saju1.pillars.find(p => p.name === '일주');
  const dayB = saju2.pillars.find(p => p.name === '일주');
  if (dayA && dayB) {
    const dayRel = analyzeSajuRelations([dayA], [dayB]);
    score += Math.min(12, dayRel.ganHap.length * 12);
    score += Math.min(14, dayRel.jiHap.length * 14);
    score -= Math.min(18, dayRel.jiChung.length * 18);
    const dayOhA = JIJI_OHANG[dayA.ji];
    const dayOhB = JIJI_OHANG[dayB.ji];
    if (dayOhA && dayOhB) {
      if (SANGSAENG[dayOhA] === dayOhB || SANGSAENG[dayOhB] === dayOhA) score += 8;
      if (SANGGEUK[dayOhA] === dayOhB || SANGGEUK[dayOhB] === dayOhA) score -= 8;
    }
  }

  const wholeRel = analyzeSajuRelations(saju1.pillars, saju2.pillars);
  score += Math.min(15, wholeRel.ganHap.length * 5);
  score += Math.min(18, wholeRel.jiHap.length * 6);
  score -= Math.min(24, wholeRel.jiChung.length * 8);

  for (const key of Object.keys(OHANG)) {
    if (saju1.ohangCount[key] === 0 && saju2.ohangCount[key] >= 2) score += 6;
    if (saju2.ohangCount[key] === 0 && saju1.ohangCount[key] >= 2) score += 6;
    if (saju1.ohangCount[key] >= 3 && saju2.ohangCount[key] >= 3) score -= 8;
  }

  // 전통 명리 관계를 요약한 휴리스틱이므로 과도한 0/100 확정값 배제
  return Math.max(20, Math.min(96, Math.round(score)));
}

// ============================================================
// AI - shared OpenRouter Worker using Gemma 4 31B through Venice
// ============================================================

// AI API 실패 시 D1에 에러 기록 (자세한 디버깅 정보 포함)
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
      (extra?.endpoint || 'worker/ai').slice(0, 500)
    ).run();
  } catch (e) {
    console.error('[logApiError] DB write failed:', e.message);
  }
}

function extractFirstBalancedJsonObject(value) {
  const source = String(value || '');
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (start < 0) {
      if (char !== '{') continue;
      start = index;
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  return '';
}

function repairMissingAiJsonCommas(value) {
  return String(value || '')
    .replace(/("(?:\\.|[^"\\])*")(\s+)(?="(?:\\.|[^"\\])*"\s*:)/g, '$1,$2')
    .replace(/((?:-?\d+(?:\.\d+)?|true|false|null|}|\]))(\s+)(?="(?:\\.|[^"\\])*"\s*:)/g, '$1,$2');
}

// 모델 응답 키 앞쪽의 잔여 콜론(":score" -> "score")을 제거해 객체 키 정규화 -> 구두점 퇴화 키(":")는 재시도 판정을 위해 유지
function sanitizeAiObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sanitizeAiObjectKeys);
  if (!isPlainAiObject(value)) return value;
  const sanitized = {};
  for (const [rawKey, item] of Object.entries(value)) {
    const match = /^:+([A-Za-z_][A-Za-z0-9_]*)$/.exec(rawKey);
    const cleanKey = match ? match[1] : rawKey;
    const cleanValue = sanitizeAiObjectKeys(item);
    if (!Object.prototype.hasOwnProperty.call(sanitized, cleanKey) || rawKey === cleanKey) {
      sanitized[cleanKey] = cleanValue;
    }
  }
  return sanitized;
}

function parseAiJsonResponse(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const balanced = extractFirstBalancedJsonObject(normalized);
  const greedy = (normalized.match(/\{[\s\S]*\}/) || [])[0] || '';
  const candidates = [...new Set([balanced, greedy, normalized].filter(Boolean))];
  let lastError = null;

  for (const candidate of candidates) {
    for (const attempt of [candidate, repairMissingAiJsonCommas(candidate)]) {
      try {
        return sanitizeAiObjectKeys(JSON.parse(attempt));
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new SyntaxError('AI response did not contain valid JSON');
}

function isPlainAiObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyAiText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAiScalar(value) {
  return isNonEmptyAiText(value) || (typeof value === 'number' && Number.isFinite(value));
}

function addRequiredAiTextErrors(value, keys, errors, prefix = '') {
  for (const key of keys) {
    if (!isNonEmptyAiText(value?.[key])) errors.push(`${prefix}${key}:non_empty_string`);
  }
}

function addAiScoreError(value, errors, path) {
  if (!Number.isInteger(value) || value < 0 || value > 100) errors.push(`${path}:integer_0_100`);
}

function addAiStringArrayError(value, errors, path, minimumLength) {
  if (!Array.isArray(value) || value.length < minimumLength || value.some(item => !isNonEmptyAiText(item))) {
    errors.push(`${path}:string_array_min_${minimumLength}`);
  }
}

function addAiExactStringArrayError(value, errors, path, expectedLength) {
  if (!Array.isArray(value) || value.length !== expectedLength || value.some(item => !isNonEmptyAiText(item))) {
    errors.push(`${path}:string_array_length_${expectedLength}`);
  }
}

function addFortuneObjectErrors(value, errors, prefix) {
  if (!isPlainAiObject(value)) {
    errors.push(`${prefix}:object`);
    return;
  }
  addRequiredAiTextErrors(value, ['wealth', 'career', 'love', 'health'], errors, `${prefix}.`);
}

function addLuckyObjectErrors(value, errors, prefix, keys) {
  if (!isPlainAiObject(value)) {
    errors.push(`${prefix}:object`);
    return;
  }
  for (const key of keys) {
    if (!isAiScalar(value[key])) errors.push(`${prefix}.${key}:non_empty_scalar`);
  }
}

function validateFortuneAiResponse(value) {
  const errors = [];
  if (!isPlainAiObject(value)) return { ok: false, errors: ['root:object'] };
  addRequiredAiTextErrors(value, ['year_summary', 'love', 'money', 'health', 'career', 'advice'], errors);
  addLuckyObjectErrors(value.lucky, errors, 'lucky', ['color', 'number', 'direction', 'month']);
  return { ok: errors.length === 0, errors };
}

function validateDailyAiResponse(value) {
  const errors = [];
  if (!isPlainAiObject(value)) return { ok: false, errors: ['root:object'] };
  addRequiredAiTextErrors(value, ['overall', 'love', 'money', 'career', 'study', 'social', 'health', 'advice'], errors);
  addLuckyObjectErrors(value.lucky, errors, 'lucky', ['color', 'number']);
  return { ok: errors.length === 0, errors };
}

function validateCompatAiResponse(value) {
  const errors = [];
  if (!isPlainAiObject(value)) return { ok: false, errors: ['root:object'] };
  addRequiredAiTextErrors(value, ['summary', 'advice'], errors);
  if (!isPlainAiObject(value.categories)) {
    errors.push('categories:object');
  } else {
    for (const key of ['personality', 'intimacy', 'finance', 'timing']) {
      const category = value.categories[key];
      if (!isPlainAiObject(category)) {
        errors.push(`categories.${key}:object`);
        continue;
      }
      addAiScoreError(category.score, errors, `categories.${key}.score`);
      if (!isNonEmptyAiText(category.desc)) errors.push(`categories.${key}.desc:non_empty_string`);
    }
  }
  addAiStringArrayError(value.strengths, errors, 'strengths', 3);
  addAiStringArrayError(value.cautions, errors, 'cautions', 3);
  return { ok: errors.length === 0, errors };
}

function validateSajuAiResponse(value, context = {}) {
  const errors = [];
  if (!isPlainAiObject(value)) return { ok: false, errors: ['root:object'] };
  if (!isPlainAiObject(value.pillar_reading)) {
    errors.push('pillar_reading:object');
  } else {
    addRequiredAiTextErrors(value.pillar_reading, ['year', 'month', 'day'], errors, 'pillar_reading.');
    if (typeof value.pillar_reading.hour !== 'string') {
      errors.push('pillar_reading.hour:string');
    } else if (context.hasTime && !isNonEmptyAiText(value.pillar_reading.hour)) {
      errors.push('pillar_reading.hour:non_empty_string');
    }
  }
  addRequiredAiTextErrors(value, ['personality', 'love_style', 'career', 'advice'], errors);
  addAiStringArrayError(value.strengths, errors, 'strengths', 3);
  addAiStringArrayError(value.cautions, errors, 'cautions', 3);
  const daeunCount = Number.isInteger(context.daeunCount) ? context.daeunCount : 8;
  addAiExactStringArrayError(value.daeun_reading, errors, 'daeun_reading', daeunCount);
  return { ok: errors.length === 0, errors };
}

function validateTarotAiResponse(value) {
  const errors = [];
  if (!isPlainAiObject(value)) return { ok: false, errors: ['root:object'] };
  if (!Array.isArray(value.cards) || value.cards.length !== 3) {
    errors.push('cards:array_length_3');
  } else {
    value.cards.forEach((card, index) => {
      if (!isPlainAiObject(card)) {
        errors.push(`cards[${index}]:object`);
        return;
      }
      addRequiredAiTextErrors(card, ['position', 'interpretation'], errors, `cards[${index}].`);
    });
  }
  addRequiredAiTextErrors(value, ['overall', 'advice'], errors);
  addAiExactStringArrayError(value.keywords, errors, 'keywords', 5);
  return { ok: errors.length === 0, errors };
}

function clampRubricLevel(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

// 1~5 루브릭 가중평균과 0~3 가시성 등급을 받아 구간 선형 변환 및 가시성 감점 적용 후 30~96 정수 점수 반환 (가시성 0이면 고정 차단점 반환)
function scoreFromAnchoredRubric(weighted, visibility, options = {}) {
  const vis = clampRubricLevel(Number(visibility), 0, 3);
  const obscuredScore = Number.isFinite(options.obscuredScore) ? options.obscuredScore : 48;
  const partialPenalty = Number.isFinite(options.partialPenalty) ? options.partialPenalty : 3;
  const heavyPenalty = Number.isFinite(options.heavyPenalty) ? options.heavyPenalty : 9;
  const heavyCap = Number.isFinite(options.heavyCap) ? options.heavyCap : 62;
  if (vis === 0) return obscuredScore;

  const w = Math.max(1.0, Math.min(5.0, Number(weighted)));
  const raw = w <= 3.0
    ? 34 + (w - 1.0) * 17
    : 68 + (w - 3.0) * 13.5;

  if (vis === 1) return Math.max(30, Math.min(heavyCap, Math.round(raw - heavyPenalty)));
  if (vis === 2) return Math.max(30, Math.min(92, Math.round(raw - partialPenalty)));
  return Math.max(30, Math.min(96, Math.round(raw)));
}

// 관상 부위 객체·인덱스·이마 관찰 메타를 받아 유효 rubric 존재 시 가중치와 가시성 보정을 거쳐 확정 score·정제 rubric 반환 (rubric 미존재 시 기존 score 유지)
function computeFaceCategoryScoreFromRubric(category, index, foreheadObs) {
  if (!isPlainAiObject(category)) return category;
  const rubric = category.rubric;
  const hasValidRubric = isPlainAiObject(rubric)
    && ['structure', 'symmetry', 'condition', 'visibility'].every(
      key => typeof rubric[key] === 'number' && Number.isFinite(rubric[key])
    );

  if (!hasValidRubric) {
    if (!Object.prototype.hasOwnProperty.call(category, 'rubric')) return category;
    const { rubric: _ignored, ...rest } = category;
    return rest;
  }

  const structure = clampRubricLevel(rubric.structure, 1, 5);
  const symmetry = clampRubricLevel(rubric.symmetry, 1, 5);
  const condition = clampRubricLevel(rubric.condition, 1, 5);
  let vis = clampRubricLevel(rubric.visibility, 0, 3);

  if (/사진상\s*확인\s*어려움|hard\s*to\s*verify|cannot\s*be\s*verified|unreadable/i.test(String(category.desc ?? ''))) {
    vis = 0;
  }
  if (index === 0 && isPlainAiObject(foreheadObs)) {
    if (foreheadObs.skin_visible === false) {
      vis = 0;
    } else if (foreheadObs.skin_visible === true && foreheadObs.hairline_visible === false) {
      vis = Math.min(Math.max(vis, 1), 2);
    } else if (foreheadObs.skin_visible === true && foreheadObs.hairline_visible === true) {
      vis = Math.max(vis, 2);
    }
  }

  const weighted = index === 5
    ? structure * 0.35 + symmetry * 0.25 + condition * 0.40
    : structure * 0.40 + symmetry * 0.30 + condition * 0.30;
  const score = scoreFromAnchoredRubric(weighted, vis, {
    obscuredScore: 48,
    partialPenalty: 3,
    heavyPenalty: 9,
    heavyCap: 62,
  });

  return {
    ...category,
    score,
    rubric: { structure, symmetry, condition, visibility: vis },
  };
}

function normalizeFaceAiScores(value) {
  if (!isPlainAiObject(value) || value.error || !Array.isArray(value.categories)
      || ![6, 7].includes(value.categories.length)) return value;
  // 마지막 전체 인상 항목은 앞선 세부 부위(이마·눈·코·입·턱/광대·피부)의 요약이므로 평균 계산에서 제외
  const summaryIndex = value.categories.length - 1;
  const categories = value.categories.map((category, index) => (
    index < summaryIndex
      ? computeFaceCategoryScoreFromRubric(category, index, value.forehead_observation)
      : category
  ));
  const scores = categories.slice(0, summaryIndex).map(category => category?.score);
  if (!scores.every(score => Number.isInteger(score) && score >= 0 && score <= 100)) {
    return { ...value, categories };
  }
  const overallScore = Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
  return {
    ...value,
    overall_score: overallScore,
    overall_grade: getGrade(overallScore),
    categories: categories.map((category, index) => (
      index === summaryIndex && isPlainAiObject(category)
        ? (() => {
            const { rubric: _ignored, ...rest } = category;
            return { ...rest, score: overallScore };
          })()
        : category
    )),
  };
}

function parseLooseAiJson(value) {
  let current = value;
  for (let depth = 0; depth < 2 && typeof current === 'string'; depth += 1) {
    const text = current.trim();
    if (!text) return null;
    try {
      current = JSON.parse(text);
    } catch {
      return null;
    }
  }
  return current;
}

function coerceCosmeticConsultation(value) {
  const parsed = typeof value === 'string' ? parseLooseAiJson(value) : value;
  const items = Array.isArray(parsed) ? parsed : (isPlainAiObject(parsed) ? [parsed] : []);
  return items.filter(isPlainAiObject).map(item => {
    if (typeof item.options !== 'string') {
      return isPlainAiObject(item.options) ? { ...item, options: [item.options] } : item;
    }
    const options = parseLooseAiJson(item.options);
    if (Array.isArray(options)) return { ...item, options };
    if (isPlainAiObject(options)) return { ...item, options: [options] };
    return { ...item, options: [] };
  });
}

// 성형 상담 후보 항목 객체를 받아 부위명·시술명에서 피부 관리 항목 여부를 판별해 불리언 반환, 객체가 아니면 false 반환
function isSkinCosmeticConsultationItem(item) {
  if (!isPlainAiObject(item)) return false;
  const area = String(item.area ?? '').trim();
  const optionNames = Array.isArray(item.options)
    ? item.options.map(opt => String(opt?.name ?? '')).join(' ')
    : '';
  return /피부|기색|모공|여드름|트러블|잡티|홍조|안색|결\s*관리|토닝|필링|스킨부스터|스케일링|skin\s*care|skin\s*condition|complexion|pore|acne|blemish|redness|peel|laser\s*toning|skin\s*booster|dermatolog/i.test(`${area} ${optionNames}`);
}

// 성형 상담 후보 항목 객체를 받아 부위명(area) 자체가 피부 관리인지 판별해 불리언 반환, 시술명만 피부 계열인 얼굴 부위 항목(예: 눈가 탄력)은 false 반환
function isSkinAreaCosmeticConsultationItem(item) {
  if (!isPlainAiObject(item)) return false;
  return /피부|기색|안색|모공|skin|complexion|pore/i.test(String(item.area ?? ''));
}

// 관상 카테고리 배열을 받아 피부(기색) 항목의 점수가 65점 이하이고 가림 한계가 아니며 채점표 condition이 2 이하(채점표가 없으면 점수만)인 경우 해당 항목 반환, 조건 미충족 시 null 반환
function findLowScoreSkinCategory(categories) {
  if (!Array.isArray(categories)) return null;
  const skinCategory = categories.find(category => (
    isPlainAiObject(category)
    && /피부|기색|skin|complexion/i.test(String(category.name ?? ''))
  ));
  if (!skinCategory || !Number.isInteger(skinCategory.score) || skinCategory.score > 65) return null;
  // 가림·화질 감점만으로 65점 이하가 된 경우는 피부 상태가 나쁜 것이 아니다. 채점표가 있으면 condition 2 이하만 인정한다.
  const condition = skinCategory.rubric?.condition;
  if (typeof condition === 'number' && Number.isFinite(condition) && condition > 2) return null;
  const desc = String(skinCategory.desc ?? '').trim();
  if (/사진상\s*확인\s*어려움|hard\s*to\s*verify|cannot\s*be\s*verified|unreadable/i.test(desc)) return null;
  return skinCategory;
}

// 저점수 피부 카테고리와 언어 코드를 받아 성형 상담용 피부 관리 기본 항목 객체를 생성해 반환
function buildFallbackSkinCosmeticConsultation(skinCategory, lang = 'ko') {
  const rawDesc = String(skinCategory?.desc ?? '').trim();
  const firstSentence = rawDesc.split(/(?<=[.!?])\s+/)[0]?.trim() || '';
  if (lang === 'en') {
    const observation = firstSentence && !/[가-힣]/.test(firstSentence)
      ? firstSentence
      : 'Uneven skin texture, visible pores, or redness and dullness appear across the cheeks and forehead under the current lighting.';
    return {
      area: 'Skin care',
      observation,
      goal: 'Calm visible skin trouble or redness and smooth uneven pore and surface texture for a clearer complexion.',
      options: [
        {
          name: 'Medical skin scaling and calming barrier care',
          purpose: 'Clears excess sebum and dead skin buildup while soothing redness and surface irritation.',
          caution: 'Check skin sensitivity, active inflammation, and post-care sun protection requirements during consultation.',
        },
        {
          name: 'Laser toning or skin booster treatment',
          purpose: 'Helps even out blotchy tone, residual marks, and rough pore texture across the cheeks and forehead.',
          caution: 'Confirm suitable wavelength, session intervals, and temporary dryness or redness risks for your skin type.',
        },
      ],
      question: 'Which dermatological care should come first between calming active trouble and improving pore or tone texture for my current skin barrier?',
      alternative: 'Use soft front natural light when taking photos and apply a thin color-correcting base rather than heavy matte coverage.',
    };
  }
  const observation = firstSentence && /[가-힣]/.test(firstSentence) && !/[A-Za-z]{2,}/.test(firstSentence)
    ? firstSentence
    : '볼과 이마 주변에 피부결 거칠기나 모공·붉은기·트러블 흔적이 함께 드러나 전체 기색이 다소 칙칙해 보입니다.';
  return {
    area: '피부 관리',
    observation,
    goal: '트러블 흔적과 붉은기를 가라앉히고 거친 피부결과 모공 요철을 정돈해 한결 맑고 매끈한 인상을 만듭니다.',
    options: [
      {
        name: '여드름·모공 스케일링 및 진정 관리',
        purpose: '모공 속 피지와 각질을 정돈하고 붉은기나 반복되는 트러블 부위의 자극을 완화해 피부결을 정돈합니다.',
        caution: '현재 염증 진행 여부와 피부 민감도, 시술 후 자외선 차단 및 보습 관리 조건을 진찰에서 확인해야 합니다.',
      },
      {
        name: '레이저 토닝 및 스킨부스터 시술',
        purpose: '얼룩덜룩한 색소 침착과 칙칙한 안색을 밝히고 속건조로 거칠어진 피부결의 수분감과 결을 보완합니다.',
        caution: '피부 장벽 상태에 맞는 에너지 강도와 시술 간격, 일시적인 붉은기나 건조감 가능성을 먼저 확인해야 합니다.',
      },
    ],
    question: '현재 피부 장벽 상태에서 염증·붉은기 진정 관리와 모공·색소 레이저 시술 중 무엇을 먼저 진행하는 것이 안전할까요?',
    alternative: '정면의 부드러운 자연광에서 촬영 각도를 잡고 두꺼운 커버 대신 붉은기와 요철만 얇게 보정하는 베이스 메이크업을 활용하세요.',
  };
}

function isAdultFaceAge(age) {
  const value = String(age ?? '').trim();
  if (['20대', '30대', '40대', '50대', '60대 이상', '20s', '30s', '40s', '50s', '60s+'].includes(value)) {
    return true;
  }
  // API 클라이언트에서 전달되는 숫자 나이("25", "30세")와 연령대 라벨을 함께 허용
  const years = /^\d{1,3}(?:세)?$/.test(value) ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(years) && years >= 20 && years < 130;
}

function normalizeFaceAppearance(value, context = {}) {
  if (!isPlainAiObject(value?.appearance)) return value;
  const appearance = { ...value.appearance };
  if (isPlainAiObject(appearance.style)) {
    appearance.style = { ...appearance.style };
    if (['남성', 'male'].includes(context.gender)) appearance.style.makeup = '';
    if (['여성', 'female'].includes(context.gender)) appearance.style.grooming = '';
  }
  appearance.cosmetic_consultation = coerceCosmeticConsultation(appearance.cosmetic_consultation);
  if (!isAdultFaceAge(context.age) || appearance.adult_subject !== true) {
    appearance.sex_appeal = '';
    appearance.cosmetic_consultation = [];
  } else {
    const lowSkinCategory = findLowScoreSkinCategory(value.categories);
    const hasSkinItem = appearance.cosmetic_consultation.some(isSkinCosmeticConsultationItem);
    if (lowSkinCategory && !hasSkinItem) {
      const fallbackLang = context.lang === 'en'
        || (!context.lang && /^[A-Za-z\s()/]+$/.test(String(lowSkinCategory.name ?? '')))
        ? 'en'
        : 'ko';
      appearance.cosmetic_consultation = [
        ...appearance.cosmetic_consultation,
        buildFallbackSkinCosmeticConsultation(lowSkinCategory, fallbackLang),
      ];
    }
    // 피부 점수가 낮지 않은데 붙은 피부 관리 항목은 뺀다. 성형 상담의 중심은 얼굴 부위(형태·비율)이고,
    // 피부 관리는 피부(기색) 점수가 65점 이하일 때만 맨 뒤에 덧붙이는 보조 항목이다.
    if (!lowSkinCategory) {
      appearance.cosmetic_consultation = appearance.cosmetic_consultation.filter(item => !isSkinAreaCosmeticConsultationItem(item));
    }
    const skinItems = appearance.cosmetic_consultation.filter(isSkinCosmeticConsultationItem);
    const nonSkinItems = appearance.cosmetic_consultation.filter(item => !isSkinCosmeticConsultationItem(item));
    if (skinItems.length > 0) {
      appearance.cosmetic_consultation = [...nonSkinItems.slice(0, 2), skinItems[0]];
    } else if (appearance.cosmetic_consultation.length > 2) {
      appearance.cosmetic_consultation = appearance.cosmetic_consultation.slice(0, 2);
    }
  }

  return { ...value, appearance };
}

function validateFaceAppearance(value, errors, context) {
  const appearance = value.appearance;
  if (!isPlainAiObject(appearance)) {
    errors.push('appearance:object');
  } else {
    addAiStringArrayError(appearance.types, errors, 'appearance.types', 2);
    if (appearance.types?.length > 3) errors.push('appearance.types:max_3');
    addRequiredAiTextErrors(appearance, ['harmony', 'first_impression'], errors, 'appearance.');
    if (!Array.isArray(appearance.highlights) || appearance.highlights.length < 2 || appearance.highlights.length > 3) {
      errors.push('appearance.highlights:array_length_2_to_3');
    } else {
      appearance.highlights.forEach((item, index) => {
        if (!isPlainAiObject(item)) errors.push(`appearance.highlights[${index}]:object`);
        else addRequiredAiTextErrors(item, ['feature', 'description'], errors, `appearance.highlights[${index}].`);
      });
    }
    if (!isPlainAiObject(appearance.style)) errors.push('appearance.style:object');
    else {
      addRequiredAiTextErrors(appearance.style, ['hair', 'photo'], errors, 'appearance.style.');
      for (const key of ['accessories', 'makeup', 'grooming']) {
        if (typeof appearance.style[key] !== 'string') errors.push(`appearance.style.${key}:string`);
      }
      if (['여성', 'female'].includes(context.gender)) {
        addRequiredAiTextErrors(appearance.style, ['makeup'], errors, 'appearance.style.');
      }
      if (['남성', 'male'].includes(context.gender)) {
        addRequiredAiTextErrors(appearance.style, ['grooming'], errors, 'appearance.style.');
      }
    }
    if (typeof appearance.adult_subject !== 'boolean') errors.push('appearance.adult_subject:boolean');
    if (typeof appearance.sex_appeal !== 'string') errors.push('appearance.sex_appeal:string');
    const maxCosmeticItems = Array.isArray(appearance.cosmetic_consultation)
      && appearance.cosmetic_consultation.some(isSkinCosmeticConsultationItem)
      ? 3
      : 2;
    if (!Array.isArray(appearance.cosmetic_consultation) || appearance.cosmetic_consultation.length > maxCosmeticItems) {
      errors.push('appearance.cosmetic_consultation:array_max_2');
    } else {
      appearance.cosmetic_consultation.forEach((item, index) => {
        if (!isPlainAiObject(item)) errors.push(`appearance.cosmetic_consultation[${index}]:object`);
        else {
          const prefix = `appearance.cosmetic_consultation[${index}].`;
          addRequiredAiTextErrors(item, ['area', 'observation', 'goal', 'question', 'alternative'], errors, prefix);
          if (!Array.isArray(item.options) || item.options.length < 1 || item.options.length > 2) {
            errors.push(`${prefix}options:array_length_1_to_2`);
          } else item.options.forEach((option, optionIndex) => {
            if (!isPlainAiObject(option)) errors.push(`${prefix}options[${optionIndex}]:object`);
            else addRequiredAiTextErrors(option, ['name', 'purpose', 'caution'], errors, `${prefix}options[${optionIndex}].`);
          });
        }
      });
    }
    if (isAdultFaceAge(context.age) && appearance.adult_subject === true) {
      addRequiredAiTextErrors(appearance, ['sex_appeal'], errors, 'appearance.');
    }

  }
  const color = value.personal_color;
  if (!isPlainAiObject(color)) {
    errors.push('personal_color:object');
  } else {
    if (!['spring', 'summer', 'autumn', 'winter', 'undetermined'].includes(color.season)) errors.push('personal_color.season:enum');
    if (!['warm', 'cool', 'neutral', 'undetermined'].includes(color.undertone)) errors.push('personal_color.undertone:enum');
    addRequiredAiTextErrors(color, ['observation', 'limitation', 'styling_tip'], errors, 'personal_color.');
    if (!Array.isArray(color.colors) || color.colors.length < 3 || color.colors.length > 5) {
      errors.push('personal_color.colors:array_length_3_to_5');
    } else {
      color.colors.forEach((item, index) => {
        if (!isPlainAiObject(item)) errors.push(`personal_color.colors[${index}]:object`);
        else {
          addRequiredAiTextErrors(item, ['name'], errors, `personal_color.colors[${index}].`);
          if (!/^#[0-9a-f]{6}$/i.test(item.hex || '')) errors.push(`personal_color.colors[${index}].hex:hex_color`);
        }
      });
    }
  }
}

function validateFaceAiResponse(value, context = {}) {
  const errors = [];
  if (!isPlainAiObject(value)) return { ok: false, errors: ['root:object'] };
  if (isNonEmptyAiText(value.error)) return { ok: true, errors: [] };
  addAiScoreError(value.overall_score, errors, 'overall_score');
  addRequiredAiTextErrors(value, ['overall_grade', 'quality_assessment', 'summary', 'advice'], errors);
  addAiStringArrayError(value.visual_evidence, errors, 'visual_evidence', 8);
  if (!isPlainAiObject(value.forehead_observation)) {
    errors.push('forehead_observation:object');
  } else {
    const forehead = value.forehead_observation;
    for (const key of ['skin_visible', 'hairline_visible']) {
      if (typeof forehead[key] !== 'boolean') errors.push(`forehead_observation.${key}:boolean`);
    }
    addRequiredAiTextErrors(forehead, ['observation'], errors, 'forehead_observation.');
    if (typeof forehead.limitation !== 'string') errors.push('forehead_observation.limitation:string');
    if (forehead.skin_visible === false && !isNonEmptyAiText(forehead.limitation)) {
      errors.push('forehead_observation.limitation:explain_actual_obstruction');
    }
  }
  if (!Array.isArray(value.categories) || value.categories.length !== 7) {
    errors.push('categories:array_length_7');
  } else {
    value.categories.forEach((category, index) => {
      if (!isPlainAiObject(category)) {
        errors.push(`categories[${index}]:object`);
        return;
      }
      if (!isNonEmptyAiText(category.name)) errors.push(`categories[${index}].name:non_empty_string`);
      addAiScoreError(category.score, errors, `categories[${index}].score`);
      if (!Number.isInteger(category.score)) errors.push(`categories[${index}].score:integer`);
      if (!isNonEmptyAiText(category.desc)) errors.push(`categories[${index}].desc:non_empty_string`);
    });
  }
  addFortuneObjectErrors(value.fortune, errors, 'fortune');
  if (typeof value.celebrity_resemblance !== 'string') errors.push('celebrity_resemblance:string');
  validateFaceAppearance(value, errors, context);
  return { ok: errors.length === 0, errors };
}

const PALM_UNREADABLE_PATTERN = /확인\s*어려움|hard\s*to\s*verify|confirmation\s*difficult|unconfirmed|unreadable/i;
const PALM_LINE_WEIGHTS = Object.freeze([1.5, 1.5, 1.5, 1.0, 0.7, 0.7]);

// 손금 항목 객체를 받아 유효 rubric과 length 라벨 교차 잠금을 적용해 확정 score·정제 rubric·판독 불가 여부 반환 (rubric 미존재 시 기존 score 유지)
function computePalmLineScoreFromRubric(line) {
  if (!isPlainAiObject(line)) return { line, usedRubric: false, unreadable: false };
  const lengthText = String(line.length ?? '').trim();
  const isUnreadableLabel = PALM_UNREADABLE_PATTERN.test(lengthText);
  const rubric = line.rubric;
  const hasValidRubric = isPlainAiObject(rubric)
    && ['depth', 'continuity', 'definition', 'visibility'].every(
      key => typeof rubric[key] === 'number' && Number.isFinite(rubric[key])
    );

  if (!hasValidRubric) {
    const cleanLine = Object.prototype.hasOwnProperty.call(line, 'rubric')
      ? (({ rubric: _ignored, ...rest }) => rest)(line)
      : line;
    return { line: cleanLine, usedRubric: false, unreadable: isUnreadableLabel };
  }

  let d = clampRubricLevel(rubric.depth, 1, 5);
  let c = clampRubricLevel(rubric.continuity, 1, 5);
  let f = clampRubricLevel(rubric.definition, 1, 5);
  let vis = clampRubricLevel(rubric.visibility, 0, 3);

  if (isUnreadableLabel || vis === 0) {
    return {
      line: { ...line, score: 50, rubric: { depth: d, continuity: c, definition: f, visibility: 0 } },
      usedRubric: true,
      unreadable: true,
    };
  }

  if (/^(?:없음|absent|none)$/i.test(lengthText)) {
    d = Math.min(d, 1);
    c = Math.min(c, 2);
    f = Math.min(f, 1);
  } else if (/^(?:희미|faint|weak)$/i.test(lengthText)) {
    d = Math.min(d, 2);
    c = Math.min(c, 3);
    f = Math.min(f, 2);
  } else if (/^(?:짧다|short)$/i.test(lengthText)) {
    f = Math.min(f, 2);
  } else if (/^(?:뚜렷|clear|strong|vivid)$/i.test(lengthText)) {
    d = Math.max(d, 4);
    f = Math.max(f, 4);
  } else if (/^(?:길다|long)$/i.test(lengthText)) {
    f = Math.max(f, 4);
  }

  const weighted = d * 0.40 + c * 0.35 + f * 0.25;
  const score = scoreFromAnchoredRubric(weighted, vis, {
    obscuredScore: 50,
    partialPenalty: 3,
    heavyPenalty: 8,
    heavyCap: 62,
  });

  return {
    line: { ...line, score, rubric: { depth: d, continuity: c, definition: f, visibility: vis } },
    usedRubric: true,
    unreadable: false,
  };
}

// 손금 6개 선의 루브릭 또는 기존 점수로 종합 점수(overall_score)와 등급(overall_grade)을 결정적으로 계산
function normalizePalmAiGrade(value) {
  if (!isPlainAiObject(value) || value.error) return value;
  const hasSixLines = Array.isArray(value.lines) && value.lines.length === 6 && value.lines.every(isPlainAiObject);

  if (hasSixLines) {
    const computed = value.lines.map(computePalmLineScoreFromRubric);
    const usedRubric = computed.some(item => item.usedRubric);
    if (usedRubric) {
      const normalizedLines = computed.map(item => (
        item.unreadable && !Number.isInteger(item.line?.score)
          ? { ...item.line, score: 50 }
          : item.line
      ));
      const readableLines = computed
        .map((item, index) => ({
          score: normalizedLines[index]?.score,
          weight: PALM_LINE_WEIGHTS[index] ?? 1.0,
          unreadable: item.unreadable,
        }))
        .filter(item => !item.unreadable);
      let overallScore = 50;
      if (readableLines.length > 0) {
        if (readableLines.every(item => Number.isInteger(item.score) && item.score >= 0 && item.score <= 100)) {
          const totalWeight = readableLines.reduce((sum, item) => sum + item.weight, 0);
          const weightedMean = readableLines.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight;
          overallScore = Math.max(0, Math.min(100, Math.round(weightedMean)));
        } else if (Number.isInteger(value.overall_score) && value.overall_score >= 0 && value.overall_score <= 100) {
          overallScore = value.overall_score;
        } else {
          return { ...value, lines: normalizedLines };
        }
      }
      return { ...value, lines: normalizedLines, overall_score: overallScore, overall_grade: getGrade(overallScore) };
    }
  }

  if (!Number.isInteger(value.overall_score) || value.overall_score < 0 || value.overall_score > 100) return value;
  let overallScore = value.overall_score;
  // 정면 손바닥 사진에서 측면 결혼선 등 확인 불가 선의 일괄 저점수가 전체 점수를 60점대로 고정하는 현상 보정
  if (hasSixLines && value.lines.every(line => Number.isInteger(line.score) && line.score >= 0 && line.score <= 100)) {
    const hasUnreadableLine = value.lines.some(line => PALM_UNREADABLE_PATTERN.test(String(line.length ?? '')));
    if (hasUnreadableLine) {
      const readableLines = value.lines
        .map((line, index) => ({ score: line.score, weight: index < 3 ? 1.4 : 1.0, unreadable: PALM_UNREADABLE_PATTERN.test(String(line.length ?? '')) }))
        .filter(item => !item.unreadable);
      if (readableLines.length > 0) {
        const totalWeight = readableLines.reduce((sum, item) => sum + item.weight, 0);
        const weightedMean = readableLines.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight;
        overallScore = Math.max(0, Math.min(100, Math.round(weightedMean)));
      }
    }
  }
  return { ...value, overall_score: overallScore, overall_grade: getGrade(overallScore) };
}

function validatePalmAiResponse(value) {
  const errors = [];
  if (!isPlainAiObject(value)) return { ok: false, errors: ['root:object'] };
  if (isNonEmptyAiText(value.error)) return { ok: true, errors: [] };
  addAiScoreError(value.overall_score, errors, 'overall_score');
  addRequiredAiTextErrors(value, ['overall_grade', 'quality_assessment', 'summary', 'advice'], errors);
  if (value.overall_grade !== getGrade(value.overall_score)) errors.push('overall_grade:score_threshold');
  addAiStringArrayError(value.visual_evidence, errors, 'visual_evidence', 8);
  if (!Array.isArray(value.lines) || value.lines.length !== 6) {
    errors.push('lines:array_length_6');
  } else {
    value.lines.forEach((line, index) => {
      if (!isPlainAiObject(line)) {
        errors.push(`lines[${index}]:object`);
        return;
      }
      addRequiredAiTextErrors(line, ['name', 'length', 'desc'], errors, `lines[${index}].`);
      addAiScoreError(line.score, errors, `lines[${index}].score`);
    });
  }
  if (!isPlainAiObject(value.hand_shape)) {
    errors.push('hand_shape:object');
  } else {
    addRequiredAiTextErrors(value.hand_shape, ['type', 'desc'], errors, 'hand_shape.');
  }
  addFortuneObjectErrors(value.fortune, errors, 'fortune');
  return { ok: errors.length === 0, errors };
}

const KARMA_CJK_TEXT_PATTERN = /[\u3400-\u9fff\uac00-\ud7a3]/;
const KARMA_LATIN_WORD_PATTERN = /[A-Za-z]{2,}/;

function addKarmaAiLanguageErrors(value, lang, errors, path = '') {
  if (typeof value === 'string') {
    if (/(?:^|\.)personal_color\.(?:season|undertone)$|(?:^|\.)personal_color\.colors\[\d+\]\.hex$/.test(path)) return;
    const errorPath = path || 'root';
    if (lang === 'en' && KARMA_CJK_TEXT_PATTERN.test(value)) {
      errors.push(`${errorPath}:english_only`);
    } else if (lang === 'ko' && KARMA_LATIN_WORD_PATTERN.test(value)) {
      errors.push(`${errorPath}:korean_only`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => addKarmaAiLanguageErrors(item, lang, errors, `${path}[${index}]`));
    return;
  }
  if (!isPlainAiObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    addKarmaAiLanguageErrors(item, lang, errors, path ? `${path}.${key}` : key);
  }
}

function validateKarmaAiContract(contractType, value, context = {}) {
  let contract;
  switch (contractType) {
    case 'saju': contract = validateSajuAiResponse(value, context); break;
    case 'tarot': contract = validateTarotAiResponse(value); break;
    case 'fortune': contract = validateFortuneAiResponse(value); break;
    case 'daily': contract = validateDailyAiResponse(value); break;
    case 'compat': contract = validateCompatAiResponse(value); break;
    case 'face': contract = validateFaceAiResponse(value, context); break;
    case 'palm': contract = validatePalmAiResponse(value); break;
    default: contract = { ok: true, errors: [] };
  }
  const lang = normalizeKarmaTextAnalysisLang(context.lang);
  if (context.lang != null && value != null) addKarmaAiLanguageErrors(value, lang, contract.errors);
  return { ok: contract.errors.length === 0, errors: contract.errors };
}

// Completeness and language are prompt goals, not reasons to regenerate visible results.
function normalizeKarmaDisplayResponse(value, contractType) {
  const sanitized = sanitizeAiObjectKeys(value);
  if (!isPlainAiObject(sanitized)) return value;
  const result = { ...sanitized };
  for (const key of ['strengths', 'cautions', 'daeun_reading', 'keywords', 'visual_evidence']) {
    if (key in result) result[key] = Array.isArray(result[key]) ? result[key].filter(isNonEmptyAiText) : [];
  }
  const collection = contractType === 'face' ? 'categories' : contractType === 'palm' ? 'lines' : contractType === 'tarot' ? 'cards' : '';
  if (collection) result[collection] = Array.isArray(result[collection]) ? result[collection].filter(isPlainAiObject) : [];
  if (contractType === 'compat' && !isPlainAiObject(result.categories)) result.categories = {};
  return result;
}

function getKarmaDisplayIssue(value, contractType) {
  if (!isPlainAiObject(value)) return { ok: false, errors: ['root:object'] };
  if (['face', 'palm'].includes(contractType) && isNonEmptyAiText(value.error)) return { ok: true, errors: [] };
  const textKeys = new Set(['summary', 'advice', 'personality', 'love_style', 'career', 'year_summary',
    'overall', 'love', 'money', 'health', 'study', 'social', 'wealth', 'desc', 'interpretation',
    'year', 'month', 'day', 'hour', 'quality_assessment', 'celebrity_resemblance', 'caution',
    'description', 'harmony', 'first_impression', 'hair', 'accessories', 'glasses', 'photo', 'makeup',
    'grooming', 'sex_appeal', 'observation', 'styling_tip', 'limitation', 'goal', 'purpose',
    'question', 'alternative', 'color', 'direction', 'type', 'season', 'undertone']);
  const textArrays = new Set(['strengths', 'cautions', 'daeun_reading', 'keywords', 'visual_evidence', 'types']);
  const hasText = (node, key = '') => {
    if (typeof node === 'string') return (textKeys.has(key) || key === 'overall_grade') && isNonEmptyAiText(node);
    if (typeof node === 'number') return ['overall_score', 'score', 'number'].includes(key) && Number.isFinite(node);
    if (Array.isArray(node)) return textArrays.has(key)
      ? node.some(isNonEmptyAiText) : node.some(item => hasText(item));
    return isPlainAiObject(node) && Object.entries(node).some(([name, item]) => hasText(item, name));
  };
  return hasText(value) ? { ok: true, errors: [] } : { ok: false, errors: ['root:no_displayable_text'] };
}

function mergeAiContractPatch(base, patch) {
  if (!isPlainAiObject(patch)) return isPlainAiObject(base) ? base : patch;
  if (!isPlainAiObject(base)) return { ...patch };
  const merged = { ...base };
  for (const [key, patchValue] of Object.entries(patch)) {
    const baseValue = merged[key];
    if (isPlainAiObject(baseValue) && isPlainAiObject(patchValue)) {
      merged[key] = mergeAiContractPatch(baseValue, patchValue);
    } else if (Array.isArray(patchValue)) {
      if (patchValue.length > 0 || !Array.isArray(baseValue)) merged[key] = patchValue;
    } else if (typeof patchValue === 'string') {
      if (patchValue.trim() || typeof baseValue !== 'string') merged[key] = patchValue;
    } else if (patchValue != null) {
      merged[key] = patchValue;
    }
  }
  return merged;
}

function aiContractCompletenessInstruction(contractType) {
  return `MANDATORY JSON COMPLETENESS (${contractType}): Every key in the requested response schema is required. Finishing one complete valid JSON object is more important than prose length. If needed, shorten narrative strings to 1-2 concise sentences and array items to 1 concise sentence; never omit later fields.`;
}

function aiContractPatchShape(contractType, errors, context = {}) {
  const roots = new Set(errors.map(error => String(error).split(':')[0].split(/[.[]/)[0]));
  const shape = {};
  const addText = key => { if (roots.has(key)) shape[key] = '1-2 concise sentences'; };
  const addArray = (key, length) => {
    if (roots.has(key)) shape[key] = Array.from({ length }, () => '1 concise sentence');
  };

  if (contractType === 'saju') {
    if (roots.has('pillar_reading')) {
      shape.pillar_reading = {
        year: '1 concise sentence', month: '1 concise sentence', day: '1 concise sentence',
        hour: context.hasTime ? '1 concise sentence' : '',
      };
    }
    ['personality', 'love_style', 'career', 'advice'].forEach(addText);
    addArray('strengths', 3);
    addArray('cautions', 3);
    addArray('daeun_reading', Number.isInteger(context.daeunCount) ? context.daeunCount : 8);
  } else if (contractType === 'tarot') {
    if (roots.has('cards')) {
      shape.cards = Array.from({ length: 3 }, (_, index) => ({
        position: ['Past', 'Present', 'Future'][index],
        interpretation: '1-2 concise sentences',
      }));
    }
    ['overall', 'advice'].forEach(addText);
    addArray('keywords', 5);
  }
  return shape;
}

function aiContractRetryInstruction(contractType, errors, context = {}) {
  const patchShape = aiContractPatchShape(contractType, errors, context);
  const exactShape = Object.keys(patchShape).length ? ` Match this exact patch shape: ${JSON.stringify(patchShape)}` : '';
  const languageRule = karmaAiLanguageInstruction(context.lang);
  return `CRITICAL JSON PATCH RETRY (${contractType}): Valid fields from the previous generation are already saved. Return one valid JSON object containing ONLY the missing or invalid fields listed here, with their original nesting and exact array lengths: ${errors.slice(0, 20).join(', ')}. Include every listed field. Keep each string to 1-2 concise sentences and each array item to 1 concise sentence. Do not repeat fields that are not listed.${exactShape}${languageRule ? ` ${languageRule}` : ''}`;
}

const KARMA_TEXT_ANALYSIS_MESSAGES = {
  ko: {
    incompleteAiResponse: 'AI 응답 항목이 완전하지 않습니다. 잠시 후 다시 시도해 주세요.',
    tarotCardsRequired: '타로 카드 3장을 모두 골라 주세요.',
    invalidCardIds: '선택한 카드 정보가 올바르지 않습니다.',
    aiUnavailable: 'AI 서비스를 사용할 수 없습니다.',
    aiBusy: 'AI 분석 서비스가 일시적으로 혼잡합니다. 잠시 후 다시 시도해 주세요.',
    invalidRequest: '요청 형식이 올바르지 않습니다. 입력값을 다시 확인해 주세요.',
    serverError: '서버 오류가 발생했습니다.',
    birthDateRequired: '생년월일을 입력해 주세요.',
    bothBirthDatesRequired: '두 사람의 생년월일을 모두 입력해 주세요.',
    rateLimited: '분석 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
  },
  en: {
    incompleteAiResponse: 'The AI response was incomplete. Please try again.',
    tarotCardsRequired: 'Please select exactly three card objects.',
    invalidCardIds: 'One or more selected cards are invalid.',
    aiUnavailable: 'The AI service is unavailable.',
    aiBusy: 'The AI analysis service is temporarily busy. Please try again shortly.',
    invalidRequest: 'The request format is invalid. Please check your input.',
    serverError: 'A server error occurred.',
    birthDateRequired: 'Date of birth is required.',
    bothBirthDatesRequired: 'Dates of birth are required for both people.',
    rateLimited: 'Too many analysis requests. Please try again later.',
  },
};

function normalizeKarmaTextAnalysisLang(lang) {
  return String(lang || 'ko').trim().toLowerCase().startsWith('en') ? 'en' : 'ko';
}

function karmaAiLanguageInstruction(lang) {
  if (lang == null) return '';
  return normalizeKarmaTextAnalysisLang(lang) === 'en'
    ? 'LANGUAGE PURITY: Every user-visible string value must use English only. Do not output Hangul, CJK ideographs, or untranslated Korean/Chinese terms; use English names or romanization instead.'
    : '언어 순수성: 사용자에게 보이는 모든 문자열 값은 한국어로만 작성하세요. 영문 단어나 로마자 표기를 섞지 말고 필요한 용어도 한국어로 풀어 쓰세요.';
}

function getKarmaTextAnalysisMessage(lang, key) {
  const locale = normalizeKarmaTextAnalysisLang(lang);
  return KARMA_TEXT_ANALYSIS_MESSAGES[locale][key] || KARMA_TEXT_ANALYSIS_MESSAGES[locale].serverError;
}

function incompleteAiResponseMessage(lang) {
  return getKarmaTextAnalysisMessage(lang, 'incompleteAiResponse');
}

class KarmaAiServiceError extends Error {
  constructor(lang, cause) {
    const rateLimited = Number(cause?.status) === 429
      || /\b429\b|rate[\s_-]*limit|too many requests/i.test(String(cause?.message || ''));
    super(getKarmaTextAnalysisMessage(lang, rateLimited ? 'aiBusy' : 'aiUnavailable'));
    this.name = 'KarmaAiServiceError';
    this.code = rateLimited ? 'AI_RATE_LIMITED' : 'AI_UNAVAILABLE';
    this.cause = cause;
  }
}

function karmaAiServiceErrorResponse(error) {
  if (!(error instanceof KarmaAiServiceError)) return null;
  const response = json({ error: error.message, code: error.code }, 503);
  if (error.code === 'AI_RATE_LIMITED') response.headers.set('Retry-After', '30');
  return response;
}

const KARMA_AI_MAX_ATTEMPTS = 3;

function isRetryableKarmaAiError(error) {
  // RPC may preserve only the error message, including several provider statuses.
  const statuses = [...String(error?.message || '').matchAll(/\bHTTP\s+(\d{3})\b/gi)]
    .map(match => Number(match[1]));
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) statuses.push(status);
  return !statuses.length || statuses.some(value => value >= 500 || [408, 409, 425, 429].includes(value));
}

function waitForKarmaAiRetry(attempt) {
  return new Promise(resolve => setTimeout(resolve, 1000 * (2 ** (attempt - 1))));
}

const KOREAN_NATIVE_PROSE_GUARD = `[한국어 쉬운 원문체]
- 사용자에게 보이는 모든 문장은 번역문이 아니라 처음부터 한국어로 쓴 글처럼 자연스럽게 씁니다.
- 독자는 사주·타로·관상·손금을 처음 접하는 일반인입니다. 관련 지식이 없어도 한 번에 이해할 수 있는 일상적인 말로 설명합니다.
- 먼저 일상에서 무엇을 뜻하는지 결론부터 말하고, 그 결론이 나온 근거는 뒤에서 짧게 설명합니다.
- 원국·일간·일지·대운·세운·일진·십성·재성·관성·식상·인성·비겁·합·충·상생·상극·삼정·준두 같은 전문 용어는 내부 판단 근거로만 사용하고, 사용자 문장에서는 가능하면 쉬운 말로 바꿉니다. 꼭 써야 한다면 처음 한 번만 "대운(10년 단위로 달라지는 흐름)"처럼 바로 뜻을 풀어 씁니다.
- 전문 용어, 한자, 기호, 오행 수치를 한 문장에 여러 개 늘어놓지 않습니다. 입력의 사실·고유명사·수치·단위와 요구된 JSON 키·구조·고정값은 그대로 지킵니다.
- [근거: ...] 표기가 필요할 때도 계산값만 나열하지 말고, "내 사주에서 생각을 말과 행동으로 옮기는 성향이 두드러짐"처럼 누구나 이해할 수 있는 짧은 설명을 씁니다.
- 문장 하나에는 핵심 내용 하나만 담고 짧게 씁니다. "변화 압력", "표현 자원", "관계 템포" 같은 추상적인 표현 대신 실제 생활에서 겪을 수 있는 상황이나 행동으로 풀어 씁니다.
- 조언은 "주의하세요"로 끝내지 말고, 오늘·이번 주·올해 무엇을 어떻게 해볼지 바로 실행할 수 있게 씁니다.
- 각 해석에서 잘 맞는 선택과 아쉬운 점을 분명히 고릅니다. 듣기 좋은 칭찬이나 위로로 포장하지 말고 입력 데이터·사진에서 드러나는 약점, 불균형, 결핍, 걸림돌을 가감 없이 직설적으로 짚습니다. "장단점이 공존한다", "균형이 필요하다", "가능성이 열려 있다", "대체로 무난하다"로 양쪽을 덮지 말고 어떤 상황에서 무엇이 유리하고 무엇이 걸림돌인지 냉정하게 밝힙니다. 입력 근거가 부족한 부분만 범위를 좁혀 모른다고 씁니다.
- 사주·운세·궁합·타로의 본문은 쉬운 결론 → 입력 근거 → 생활 속 장면이나 행동으로 이어갑니다. 예를 들 때는 실제로 있었던 사건처럼 꾸미지 않습니다. 특정 입력값을 먼저 길게 나열하라는 지시보다 읽기 쉬운 결론을 앞세웁니다.
- 관상·손금은 눈에 보이는 모양·위치·길이·비율을 먼저 말하고 전통 해석과 실천할 행동을 구분합니다. "돈 관리에 유의" 대신 관리할 지출이나 확인할 항목을, "관계에 노력" 대신 바꿔 볼 대화 행동을 구체적으로 적습니다.
- "성숙한 우아함", "자연스러운 조화", "깊이 있는 분위기" 같은 칭찬만으로 설명을 끝내지 않습니다. 어느 특징이 어떤 인상을 만드는지, 무엇을 어느 방향으로 바꾸면 인상이 어떻게 달라 보이는지 적습니다. 전문 용어나 긴 문장으로 직설적인 설명을 대신하지 않습니다.
- 본문에서 "기운을 채우다", "에너지를 나누다", "균형을 맞추다", "유연한 태도가 필요하다" 같은 설명을 쓰지 않습니다. 대신 실제로 할 수 있는 동작을 씁니다. 예를 들어 업무 조언은 "협업하세요"보다 "새 일을 받기 전에 담당자와 마감일을 먼저 정하세요"처럼 대상과 행동이 드러나야 합니다. 예시는 문장 수준의 기준일 뿐 모든 사람에게 같은 행동을 복사하지 않습니다.
- [근거: ...]도 전문 용어를 나열하는 부록이 아닙니다. 해석한 특징이 왜 그 결론으로 이어지는지 쉬운 말로 한 번만 풉니다. 매 문장에 근거를 붙여 흐름을 끊거나 "~할 수 있습니다"를 반복하지 않습니다. 조언의 끝은 "살펴보세요/생각해보세요"보다 무엇을 확인·기록·비교·중단할지 특정합니다.
- 정확한 표현은 확정적인 예언이 아닙니다. 근거 없이 사건·날짜·금액·성격·건강·타인의 마음을 만들어내지 않으며, 전통 해석의 한계는 짧게 밝히고 본문에서 같은 완곡어와 주의 문구를 반복하지 않습니다.
- 영어·일본어 직역 어순, 불필요한 피동·명사화·이중 완곡, 상담원이나 보고서 같은 상투어를 피하고 뜻이 분명한 능동 동사로 바로 씁니다.
- 문맥상 분명한 주어와 대명사는 자연스럽게 생략합니다. 같은 문장 시작·접속사·종결어미와 기계적인 열거를 반복하지 않고 문장 길이와 호흡을 내용에 맞게 조절합니다.
- 입력이나 작업 과정을 메타적으로 요약하지 말고, 요청된 장르와 출력 형식에 맞는 결과만 제시합니다.
<korean_style_rules>
- [대명사 생략] '당신은/당신의/그대는'을 반복하지 말고 주어를 생략하거나 '일할 때는', '가까운 관계에서는', '돈을 다룰 때는'처럼 구체적인 상황으로 문장을 시작합니다.
- [번역투·피동·명사화 금지] '~되어지다', '~에 의해', '가지고 있습니다', '취하는 것이 좋습니다', '~함에 따라', '~에 있어서', '~라는 점에서'를 쓰지 말고 자연스러운 한국어 능동문과 동사로 풀어 씁니다.
- [분열문·AI 상투어 금지] '중요한 것은 ~라는 점입니다', '~하는 이유입니다', '단순한 X를 넘어 Y입니다', '운명의 수레바퀴/새로운 지평/잠재력을 꽃피우다/청사진/신호탄/잠식하다' 같은 AI식 상투어를 쓰지 않습니다.
- [구두점과 어미 변주] 연결어미(-고, -며, -면서, -지만) 뒤에 기계적으로 쉼표(,)를 찍지 않고, '~합니다'만 연속되지 않게 '~하기 쉽습니다', '~할 때입니다', '~하는 편이 유리합니다' 등으로 종결어미 호흡을 자연스럽게 섞습니다.
- [문체 통일] 본문·요약·조언·주의점의 모든 한국어 문장은 '~다/~한다/~이다' 같은 평서형 반말로 섞어 쓰지 말고, 끝까지 '~습니다/~입니다/~세요' 등 정중한 존댓말로 통일합니다.
</korean_style_rules>`;

const ENGLISH_PLAIN_PROSE_GUARD = `[Clear, plain English]
- Write every user-visible sentence as natural English, not as a literal translation.
- Assume the reader knows nothing about Saju, tarot, face reading, or palm reading. Use familiar everyday words that make sense on the first read.
- State what the reading means in daily life first. Give the reason briefly afterward.
- Treat specialist terms such as natal chart, day master, luck cycle, annual influence, daily influence, Ten Gods, resource, output, wealth, officer, companion, combination, clash, and Three Zones as internal evidence. Prefer a plain-English explanation in the response. If a term is essential, define it immediately the first time, such as "luck cycle (a ten-year period in the reading)."
- Do not stack jargon, romanized names, symbols, elemental counts, or raw formulas in one sentence. Preserve input facts, proper nouns, numbers, units, required JSON keys, structure, and fixed values.
- If an [Evidence: ...] label is required, do not fill it with raw calculations. Use a short explanation anyone can understand, such as "your chart puts more emphasis on turning ideas into action."
- Keep one main idea per sentence and keep sentences short. Replace abstractions such as "change pressure," "expressive resources," or "relationship tempo" with a concrete situation or action from everyday life.
- Do not end advice with vague phrases such as "be careful." Say what the reader can do today, this week, or this year.
- Choose a clear strength, drawback, or priority from the supplied evidence. Do not flatter or sugarcoat; point out weaknesses, imbalances, blind spots, and stumbling blocks directly and candidly. Do not hide the conclusion behind "balance is needed," "both strengths and weaknesses," "generally fine," or "potential." Name the situation, useful choice, and likely friction within the reading; identify only the specific unknowns.
- For Saju, fortunes, compatibility, and tarot, lead with a plain conclusion, then its input evidence and a concrete everyday example or action. An example is not a claim about an event that happened. Readability takes precedence over opening with a list of chart symbols.
- For face and palm readings, start with visible shape, position, length, or proportions, then distinguish traditional interpretation from a practical action. Replace "manage money carefully" or "work on relationships" with an expense to review or a communication behavior to try.
- Praise such as "mature elegance," "natural harmony," or "a deep aura" is not an explanation. Name the feature, the visual impression it creates, and the specific adjustment that would change that impression.
- Replace "replenish your energy," "find balance," or "be flexible" with an action and its object. "Agree on an owner and a deadline before taking on new work" is clearer than "collaborate." This is a specificity example, not advice to copy into every reading.
- Explain [Evidence: ...] once in plain language instead of listing raw chart terminology after every sentence. End advice with what to check, record, compare, or stop, rather than merely asking the reader to reflect.
- Directness does not mean certainty: do not invent events, dates, amounts, personality, medical findings, or other people's feelings. State the scope briefly without repeating hedges and disclaimers throughout the reading.
- Avoid corporate, academic, mystical, or report-like filler. Use direct active verbs and vary sentence rhythm naturally.
- Do not describe the input or your writing process. Return only the requested result in the required format.`;

function karmaResponseStyleGuide(lang = 'ko') {
  return normalizeKarmaTextAnalysisLang(lang) === 'en'
    ? ENGLISH_PLAIN_PROSE_GUARD
    : KOREAN_NATIVE_PROSE_GUARD;
}

function hashKarmaPromptCacheText(value) {
  let hash = 2166136261;
  for (const character of String(value || '')) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildKarmaPromptCacheKey(endpoint, contractType, lang, systemText) {
  const stableSystem = String(systemText || '');
  if (!stableSystem.trim()) return '';
  const safePart = (value, fallback) => String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
  const endpointPart = safePart(endpoint, 'unknown');
  const contractPart = safePart(contractType, 'text');
  const languagePart = safePart(normalizeKarmaTextAnalysisLang(lang), 'ko');
  return `karma:${endpointPart}:${contractPart}:${languagePart}:s${stableSystem.length.toString(36)}_${hashKarmaPromptCacheText(stableSystem)}`;
}

async function callKarmaTextAi(prompt, _caller, _env, _ctx, contractType = '', contractContext = {}) {
  const endpoint = _caller || 'unknown';
  const isStructured = typeof prompt === 'object' && prompt.system && prompt.user;
  const promptText = String(isStructured ? prompt.user : prompt || '');
  const baseSystem = isStructured ? String(prompt.system || '') : '';
  const responseLang = isStructured ? normalizeKarmaTextAnalysisLang(prompt.lang) : 'ko';
  const validationContext = { ...contractContext, lang: responseLang };
  const proseGuard = karmaResponseStyleGuide(responseLang);
  const languageGuard = karmaAiLanguageInstruction(responseLang);
  const completenessGuard = contractType ? aiContractCompletenessInstruction(contractType) : '';
  const systemText = [baseSystem, proseGuard, languageGuard, completenessGuard].filter(Boolean).join('\n\n');
  const _contentsSize = promptText.length;

  if (!_env?.AI?.complete) {
    await logApiError(_env, `[${endpoint}] Karma AI text service missing`, '', {
      endpoint,
      contractType,
      promptChars: _contentsSize,
    });
    return null;
  }

  try {
    const maxAttempts = KARMA_AI_MAX_ATTEMPTS;
    let contractErrors = [];
    let accumulated = null;
    let lastParseError = null;
    let lastRawText = '';
    const failedModels = [];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) await waitForKarmaAiRetry(attempt);
      // error_logs 6475, 6499, 6505: a valid JSON object whose strings were all empty (or whose keys were
      // degenerate punctuation like {":": {": ": ...}}) failed three times in a row. Say exactly what was wrong
      // and exclude the model that produced the empty/degenerate output on retry.
      const retryInstruction = contractErrors.length
        ? ['The previous response could not be displayed. Return one valid JSON object matching the original schema with actual reading text. Do not return a patch.',
          contractErrors.includes('root:no_displayable_text')
            ? 'It contained no readable text: use exactly the schema keys and fill every string with real sentences grounded in the input. Never return empty strings, empty arrays, punctuation keys (such as ":"), placeholders, or a copy of the schema.'
            : ''].filter(Boolean).join(' ')
        : '';
      // Lower temperature only helps broken JSON syntax; an empty template repeats more often when sampling is narrowed.
      const isEmptyTextRetry = attempt > 0 && contractErrors.includes('root:no_displayable_text');
      const narrowRetry = attempt > 0 && contractErrors.length > 0 && !isEmptyTextRetry;
      const attemptTemperature = isEmptyTextRetry ? 0.5 : (narrowRetry ? 0.2 : 0.1);
      const attemptSystem = [systemText, retryInstruction].filter(Boolean).join('\n\n');
      const attemptPrompt = promptText;
      const messages = attemptSystem
        ? [
          { role: 'system', content: attemptSystem },
          { role: 'user', content: attemptPrompt },
        ]
        : [{ role: 'user', content: attemptPrompt }];
      const cacheKey = buildKarmaPromptCacheKey(endpoint, contractType, responseLang, attemptSystem);
      const attemptStart = Date.now();
      let result;
      try {
        result = await _env.AI.complete({
          appId: 'karma',
          messages,
          cacheKey,
          responseFormat: 'json_object',
          temperature: attemptTemperature,
          maxTokens: 16384,
          ...(failedModels.length ? { excludeModels: [...new Set(failedModels)] } : {}),
        });
      } catch (error) {
        // Transport failures and response repairs share one bounded retry budget.
        if (isRetryableKarmaAiError(error) && attempt < maxAttempts - 1) continue;
        throw new KarmaAiServiceError(responseLang, error);
      }
      if (result?.model) failedModels.push(String(result.model));
      const usage = result?.usage || {};
      await logPerfStats(_env, _ctx, {
        app: `karma:${endpoint}`,
        cache_key: cacheKey || null,
        cache_hit: Number(usage.prompt_cache_hit_tokens || 0) > 0 ? 1 : 0,
        prompt_tokens: usage.prompt_tokens || 0,
        cached_tokens: usage.prompt_cache_hit_tokens || 0,
        cache_write_tokens: usage.prompt_cache_write_tokens || usage.prompt_tokens_details?.cache_write_tokens || 0,
        output_tokens: usage.completion_tokens || 0,
        thought_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,
        sys_chars: attemptSystem.length,
        hist_chars: _contentsSize,
        used_key_idx: attempt,
        elapsed_ms: Date.now() - attemptStart,
        model: result?.model || null,
        provider_route: result?.providerRoute || result?.providerName || result?.provider || null,
      });
      let parsed;
      lastRawText = String(result?.text || '');
      try {
        parsed = parseAiJsonResponse(lastRawText);
        lastParseError = null;
      } catch (error) {
        lastParseError = error;
        if (!contractErrors.length) contractErrors = ['root:valid_json_object'];
        continue;
      }
      accumulated = normalizeKarmaDisplayResponse(parsed, contractType);
      const contract = getKarmaDisplayIssue(accumulated, contractType);
      if (contract.ok) return accumulated;
      contractErrors = contract.errors;
    }
    const rawSample = lastRawText.replace(/\s+/g, ' ').trim().slice(0, 600);
    await logApiError(_env, `[${endpoint}] AI JSON contract mismatch after retry`, [contractErrors.join(', '), lastParseError?.message, rawSample ? `raw: ${rawSample}` : ''].filter(Boolean).join('\n'), {
      endpoint,
      contractType,
      promptChars: _contentsSize,
    });
    return null;
  } catch (error) {
    const originalError = error instanceof KarmaAiServiceError ? error.cause : error;
    await logApiError(
      _env,
      `[${endpoint}] Karma AI text request failed`,
      originalError?.stack || originalError?.message || String(originalError),
      { endpoint, contractType, promptChars: _contentsSize }
    );
    if (error instanceof KarmaAiServiceError) throw error;
    return null;
  }
}

// ============================================================
// Tarot Reading
// ============================================================

const TAROT_MAJOR_ARCANA = [
  { id: 0, name: 'The Fool', nameKo: '광대',
    up: '새로운 시작, 모험, 자유, 순수, 무한한 가능성',
    rev: '무모함, 무책임, 방향 상실, 경솔한 판단',
    imagery: '절벽 끝에 서서 하늘을 바라보는 청년, 작은 개, 흰 장미, 배낭' },
  { id: 1, name: 'The Magician', nameKo: '마법사',
    up: '창조력, 의지, 능력, 집중, 자원의 활용',
    rev: '재능 낭비, 속임수, 조작, 잠재력 미발휘',
    imagery: '한 손은 하늘, 한 손은 땅을 가리키는 남자, 테이블 위 4원소(컵/지팡이/검/동전), 무한대 기호' },
  { id: 2, name: 'The High Priestess', nameKo: '여사제',
    up: '직관, 지혜, 비밀, 내면의 목소리, 무의식',
    rev: '비밀의 폭로, 직관 무시, 표면적 판단, 내면 단절',
    imagery: '두 기둥(B와 J) 사이에 앉은 여성, 달의 왕관, 토라 두루마리, 석류 커튼' },
  { id: 3, name: 'The Empress', nameKo: '여황제',
    up: '풍요, 모성, 아름다움, 자연, 감각적 기쁨',
    rev: '의존, 공허함, 창조적 정체, 과잉보호',
    imagery: '밀밭 속 왕좌에 앉은 여성, 12개 별 왕관, 금성 기호 방패, 풍성한 자연' },
  { id: 4, name: 'The Emperor', nameKo: '황제',
    up: '권위, 안정, 리더십, 질서, 구조와 통제',
    rev: '독재, 경직, 통제 상실, 미성숙한 권위',
    imagery: '돌 왕좌에 앉은 갑옷 입은 남자, 양 머리 장식, 구, 홀, 붉은 로브' },
  { id: 5, name: 'The Hierophant', nameKo: '교황',
    up: '전통, 가르침, 신앙, 규범, 영적 인도',
    rev: '기존 관념 탈피, 반항, 교조주의, 독자적 길',
    imagery: '두 제자 앞 왕좌의 종교 지도자, 삼중 왕관, 교차 열쇠, 축복 손짓' },
  { id: 6, name: 'The Lovers', nameKo: '연인',
    up: '사랑, 선택, 조화, 관계, 가치관의 합일',
    rev: '불화, 잘못된 선택, 유혹, 가치관 충돌',
    imagery: '벌거벗은 남녀, 천사 라파엘, 생명나무와 지식의 나무, 산' },
  { id: 7, name: 'The Chariot', nameKo: '전차',
    up: '승리, 의지력, 전진, 자기 통제, 결단력',
    rev: '방향 상실, 공격성, 통제력 상실, 좌절',
    imagery: '전차 위의 갑옷 전사, 흑백 스핑크스, 별 캐노피, 도시 배경' },
  { id: 8, name: 'Strength', nameKo: '힘',
    up: '내면의 힘, 용기, 인내, 부드러운 통제, 자비',
    rev: '자기 의심, 나약함, 폭발적 감정, 자신감 결여',
    imagery: '사자의 입을 부드럽게 닫는 여성, 무한대 기호, 흰 옷, 꽃 화관' },
  { id: 9, name: 'The Hermit', nameKo: '은둔자',
    up: '성찰, 고독, 지혜, 내면 탐구, 안내',
    rev: '고립, 외로움, 현실 도피, 은둔으로의 도망',
    imagery: '산꼭대기의 회색 로브 노인, 등불(다윗의 별), 지팡이' },
  { id: 10, name: 'Wheel of Fortune', nameKo: '운명의 수레바퀴',
    up: '변화, 운명, 순환, 전환점, 행운',
    rev: '불운, 변화 저항, 통제 불능, 예상치 못한 역전',
    imagery: '거대한 수레바퀴, 스핑크스, 뱀, 아누비스, 네 모서리의 천사들, TARO 글자' },
  { id: 11, name: 'Justice', nameKo: '정의',
    up: '공정, 균형, 결과, 진실, 인과응보',
    rev: '불공정, 책임 회피, 편견, 부정직',
    imagery: '왕좌의 여성, 천칭 저울, 양날검, 붉은 로브, 보라색 커튼' },
  { id: 12, name: 'The Hanged Man', nameKo: '매달린 사람',
    up: '희생, 새로운 관점, 기다림, 깨달음, 항복',
    rev: '지연, 무의미한 희생, 저항, 이기심',
    imagery: '한쪽 발로 나무에 거꾸로 매달린 남자, 후광, 평온한 표정, T자 나무' },
  { id: 13, name: 'Death', nameKo: '죽음',
    up: '끝과 시작, 변화, 전환, 해방, 필연적 변화',
    rev: '변화 저항, 정체, 두려움, 낡은 것에 집착',
    imagery: '흰 말 위의 갑옷 해골, 쓰러진 왕, 기도하는 성직자, 아이, 강, 떠오르는 태양' },
  { id: 14, name: 'Temperance', nameKo: '절제',
    up: '균형, 조화, 인내, 중용, 치유',
    rev: '불균형, 과잉, 조급함, 극단, 부조화',
    imagery: '두 컵 사이 물을 옮기는 천사, 한 발은 물 한 발은 땅, 길, 태양의 왕관' },
  { id: 15, name: 'The Devil', nameKo: '악마',
    up: '유혹, 집착, 구속, 물질주의, 중독',
    rev: '해방, 구속에서 벗어남, 자각, 독립',
    imagery: '박쥐 날개의 악마, 사슬에 묶인 남녀, 거꾸로 된 오각별, 어둠' },
  { id: 16, name: 'The Tower', nameKo: '탑',
    up: '급변, 파괴, 해방, 깨달음, 충격적 진실',
    rev: '파국 회피, 변화 두려움, 느린 붕괴, 내적 전환',
    imagery: '번개 맞은 탑, 떨어지는 사람들, 왕관, 불꽃, 어두운 하늘' },
  { id: 17, name: 'The Star', nameKo: '별',
    up: '희망, 영감, 치유, 평화, 내면의 빛',
    rev: '절망, 영감 상실, 자기 불신, 단절감',
    imagery: '별 아래 벌거벗은 여성, 두 항아리의 물(땅과 연못), 큰 별 하나와 작은 별 일곱' },
  { id: 18, name: 'The Moon', nameKo: '달',
    up: '불안, 환상, 직관, 무의식, 두려움',
    rev: '진실 드러남, 불안 해소, 혼란 극복, 명확해짐',
    imagery: '달(초승달 속 얼굴), 짖는 개와 늑대, 가재, 두 탑, 구불구불한 길' },
  { id: 19, name: 'The Sun', nameKo: '태양',
    up: '성공, 기쁨, 활력, 긍정, 명확함',
    rev: '낙관 과잉, 지연된 성공, 자만, 일시적 우울',
    imagery: '밝은 태양, 해바라기, 흰 말 위의 벌거벗은 아이, 붉은 깃발, 돌담' },
  { id: 20, name: 'Judgement', nameKo: '심판',
    up: '부활, 각성, 결단, 자기 평가, 소명',
    rev: '자기 의심, 판단 보류, 과거 미련, 소명 무시',
    imagery: '구름 위 천사의 나팔, 관에서 일어나는 사람들, 산맥, 십자가 깃발' },
  { id: 21, name: 'The World', nameKo: '세계',
    up: '완성, 성취, 통합, 여행, 하나의 순환 완료',
    rev: '미완성, 마무리 부족, 목표 지연, 아쉬운 결말',
    imagery: '월계관 안에서 춤추는 여성, 두 지팡이, 네 모서리의 동물(사자/황소/독수리/천사)' },
];

function buildTarotPrompt(cards, question, lang) {
  const isEn = normalizeKarmaTextAnalysisLang(lang) === 'en';
  const cardDescs = cards.map((c, i) => {
    const keywords = c.reversed ? c.rev : c.up;
    if (isEn) {
      const pos = i === 0 ? 'Past' : i === 1 ? 'Present' : 'Future';
      const dir = c.reversed ? 'REVERSED' : 'UPRIGHT';
      return `- ${pos}: ${c.name} [${dir}]
  Keywords (reference, translate to English in your response): ${keywords}
  Imagery (reference, translate to English in your response): ${c.imagery}`;
    }
    const pos = i === 0 ? '과거' : i === 1 ? '현재' : '미래';
    const dir = c.reversed ? '역방향' : '정방향';
    return `- ${pos}: ${c.nameKo} (${c.name}) [${dir}]
  키워드: ${keywords}
  카드 그림: ${c.imagery}`;
  }).join('\n');

  const hasQuestion = question && question.trim().length > 0;

  if (isEn) {
    const system = `You are a precise tarot interpreter. Connect only the drawn cards, their order, direction, and the querent's actual question. Tarot supports reflection; it does not establish hidden facts or guarantee future events.

**LANGUAGE: You MUST respond entirely in English. Every string in the JSON output — including card position names, interpretations, overall, advice, and keywords — must be in English. Any Korean text in the user input is internal reference data only; translate its meaning into English.**

## Interpretation Rules
1. **Direction is binding**: Upright emphasizes the card's expressed qualities. Reversed indicates delay, internalization, imbalance, or a blocked expression; choose the meaning that fits the neighboring cards.
2. **Observation before application**: Briefly cite a symbol or keyword, then explain how it frames the question.
3. **Narrative arc**: Past → Present → Future is one interpretive story. Do not invent a past choice, another person's intent, or an undisclosed event as fact.
4. **Plain language**: No mystical filler ("the universe", "energy flows", "reversed energy"). Clearly distinguish card symbolism from known facts.
5. **Calibrated claims**: Use conditional language for future outcomes and name the user-controlled action that could change the direction.
6. **Safety**: Never infer cheating, disease, pregnancy, crime, legal outcomes, or investment performance from cards. For high-stakes questions, provide reflective prompts and recommend relevant professional help when appropriate.
7. **Reversed cards**: State the specific tension shown by this spread and one practical way to test or address it; do not threaten a guaranteed loss.
8. **Banned phrases**: "The universe is telling you...", "The card speaks of...", "Energy flows/is blocked", "stay positive", "trust the process" — never.

## Spread-Specific Differentiation
- Treat the exact three-card order, direction, and question as this reading's fingerprint. Judge strictly by the absolute symbolic criteria of the drawn cards and their directions without artificially balancing good and bad.
- Do not flatter the querent or soften harsh spreads into generic encouragement. When reversed or conflicting cards appear, directly name the blind spot, avoidance, overreach, or stumbling block that is holding the situation back.
- Start overall with a clear answer to the question or a priority supported by this spread, then explain the cause-effect link between at least two drawn cards. Do not start with a generic life theme.
- Prioritize findings in a fixed order so the same spread reaches the same conclusion: (1) core tension shown by the Present card and its direction, (2) cause-and-effect transition from Past to Present, (3) conditional direction and controllable change in the Future card.
- If there is no question, choose one dominant real-life arena from this exact card combination; do not cover love, career, and personal growth with equal generic weight.
- Keywords must come from this exact spread, not a reusable tarot keyword list: select 1 from Past, 2 from Present, 1 from Future, and 1 from the action linked to the question.

## Response — JSON only
{
  "cards": [
    {"position": "Past", "interpretation": "(3-4 sentences. The past position's theme and how it may frame the current question; do not invent biography.)"},
    {"position": "Present", "interpretation": "(3-4 sentences. The current tension, resource, or decision shown by the card pair.)"},
    {"position": "Future", "interpretation": "(3-4 sentences. A conditional direction if the current pattern continues, plus what can change it.)"}
  ],
  "overall": "(3-4 sentences. Name at least two cards and connect their exact order/directions into one evidence-based theme.)",
  "advice": "(3-4 sentences. One low-risk action this week and one question to verify in real life. No medical, legal, or financial directives.)",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"]
}`;

    const user = `## Querent's Question
${hasQuestion ? question : 'General life reading — no specific question'}

## Cards Drawn (Past → Present → Future)
${cardDescs}
${hasQuestion ? `\nIMPORTANT: Every interpretation must relate back to "${question}". Don't give a generic reading.` : '\nChoose the single life area most strongly supported by this exact spread and explain why.'}`;

    return { system, user, lang: 'en' };
  }

  const system = `당신은 카드의 상징, 순서, 정·역방향과 사용자의 실제 질문만 연결하는 정확한 타로 해설가입니다. 타로는 생각을 정리하는 도구이며 숨겨진 사실을 알아내거나 미래를 확정하지 않습니다.

## 해석 규칙
1. **방향 반영**: 정방향은 카드 의미가 드러나는 방식, 역방향은 지연·내면화·과잉·막힘 중 인접 카드와 질문에 맞는 의미로 해석하세요.
2. **관찰 후 적용**: 상징이나 키워드를 짧게 근거로 든 뒤 질문에 어떤 관점을 주는지 설명하세요.
3. **서사 연결**: 과거→현재→미래를 하나의 해석 흐름으로 잇되 사용자의 과거 선택, 타인의 속마음, 공개되지 않은 사건을 사실처럼 만들지 마세요.
4. **쉬운 말로**: "에너지", "우주가", "역방향 에너지" 같은 신비주의 표현을 피하고 카드 상징과 확인된 사실을 구분하세요.
5. **미래 표현**: 미래는 현재 패턴이 이어질 때의 조건부 방향으로 쓰고 사용자가 바꿀 수 있는 행동을 함께 제시하세요.
6. **안전 원칙**: 카드로 외도·질병·임신·범죄·법적 결과·투자 성과를 추정하지 마세요. 고위험 질문은 확인할 현실 정보와 필요한 경우 전문가 도움을 안내하세요.
7. **역방향**: 이번 배열에서 나타난 구체 긴장과 확인 방법을 설명하고 손실을 확정적으로 위협하지 마세요.
8. **금지 표현**: "우주가...", "카드가 말하기를...", "에너지가 흐른다/막혀있다", "긍정적 마인드" 등

## 배열별 차별화 필수
- 뽑힌 3장의 카드명, 순서, 정/역방향, 질문을 이번 리딩의 지문으로 삼으세요. 억지로 긍정과 부정의 비율을 맞추지 말고 카드 상징과 정·역방향의 절대 기준대로 판단하세요.
- 듣기 좋은 위로로 포장하지 마세요. 역방향 카드나 충돌하는 카드 조합이 나오면 현재 회피하고 있는 문제, 잘못된 집착, 어긋난 기대, 이대로 가면 막히는 걸림돌을 직설적으로 짚으세요.
- overall 첫 문장은 질문에 대한 답이나 이 배열에서 우선할 행동을 쉬운 말로 제시하고, 뽑힌 카드 2장 이상의 원인→결과 흐름을 근거로 이어 쓰세요. 일반적인 인생 주제로 시작하지 마세요.
- 같은 배열이면 핵심 결론이 흔들리지 않도록 판단 우선순위를 [1순위: 현재 위치 카드의 정·역방향 핵심 긴장 → 2순위: 과거에서 현재로의 원인-결과 흐름 → 3순위: 미래 카드의 조건부 방향과 바꿀 행동] 순으로 고정하세요.
- 질문이 없는 경우에도 카드 조합에서 가장 강한 현실 영역 하나를 골라 깊게 파세요. 연애·직업·성장을 같은 비중의 무난한 설명으로 나열하지 마세요.
- keywords는 이번 카드 조합에서 나온 단어만 고르세요. 재사용 가능한 타로 공통 키워드 목록처럼 만들지 말고, [과거 핵심 1개, 현재 핵심 2개, 미래 핵심 1개, 질문 연결 행동 1개] 순으로 5개를 뽑으세요.

## 응답 — JSON만
{
  "cards": [
    {"position": "과거", "interpretation": "(3~4문장. 과거 위치 카드가 현재 질문의 배경을 어떻게 비추는지. 실제 과거사 창작 금지)"},
    {"position": "현재", "interpretation": "(3~4문장. 현재 위치와 앞 카드 사이에 드러난 긴장·자원·결정 포인트)"},
    {"position": "미래", "interpretation": "(3~4문장. 현재 패턴 유지 시 조건부 방향과 바꿀 수 있는 행동)"}
  ],
  "overall": "(3~4문장. 카드 2장 이상과 정·역방향을 직접 언급해 이번 배열만의 흐름으로 연결)",
  "advice": "(3~4문장. 이번 주에 할 수 있는 저위험 행동 1개와 현실에서 확인할 질문 1개. 의료·법률·재무 지시 금지)",
  "keywords": ["키워드1", "키워드2", "키워드3", "키워드4", "키워드5"]
}`;

  const user = `## 질문자의 질문
${hasQuestion ? question : '특별한 질문 없이 전체 운세를 봅니다'}

## 뽑힌 카드 (과거 → 현재 → 미래)
${cardDescs}
${hasQuestion ? `\n중요: 모든 해석은 "${question}"이라는 질문과 연결되어야 합니다. 뜬구름 잡는 해석은 하지 마세요.` : '\n이 카드 조합이 가장 강하게 지지하는 현실 영역 하나만 골라 그 이유와 함께 깊게 다뤄주세요.'}`;

  return { system, user, lang: 'ko' };
}

async function handleTarotReading(request, env) {
  let responseLang = 'ko';
  try {
    const body = await request.json();
    const { cards: selectedCards, question, lang } = body;
    responseLang = normalizeKarmaTextAnalysisLang(lang);

    if (!selectedCards || !Array.isArray(selectedCards) || selectedCards.length !== 3) {
      return json({ error: getKarmaTextAnalysisMessage(responseLang, 'tarotCardsRequired') }, 400);
    }

    // 카드 정보 매핑
    const cards = selectedCards.map(c => {
      const card = TAROT_MAJOR_ARCANA.find(t => t.id === c?.id);
      if (!card) return null;
      return { ...card, reversed: !!c.reversed };
    }).filter(Boolean);

    if (cards.length !== 3 || new Set(cards.map(card => card.id)).size !== 3) {
      return json({ error: getKarmaTextAnalysisMessage(responseLang, 'invalidCardIds') }, 400);
    }

    if (!env?.AI?.complete) {
      return json({ error: getKarmaTextAnalysisMessage(responseLang, 'aiUnavailable') }, 503);
    }

    const normalizedQuestion = String(question || '').trim().replace(/\s+/g, ' ');
    const tarotCacheKey = await buildKarmaConsistencyCacheKey('tarot', {
      cards: cards.map(card => ({ id: card.id, reversed: card.reversed })),
      question: normalizedQuestion,
      lang: responseLang,
    });
    let cacheStatus = 'HIT';
    let ai = await readKarmaConsistencyCache(env, tarotCacheKey);
    if (!isCacheableKarmaResult('tarot', ai)) {
      cacheStatus = 'MISS';
      const prompt = buildTarotPrompt(cards, normalizedQuestion, lang || 'ko');
      ai = await callKarmaTextAi(prompt, 'tarot', env, null, 'tarot');

      if (!ai) {
        return json({ error: incompleteAiResponseMessage(lang || 'ko') }, 502);
      }
      if (isCacheableKarmaResult('tarot', ai)) {
        await writeKarmaConsistencyCache(env, 'tarot', tarotCacheKey, ai);
      }
    }

    return json({
      cards: cards.map((c, i) => ({
        id: c.id,
        name: c.name,
        nameKo: c.nameKo,
        reversed: c.reversed,
        keywords: responseLang === 'en' ? (ai.keywords?.[i] || '') : (c.reversed ? c.rev : c.up),
        interpretation: ai.cards?.[i]?.interpretation || '',
      })),
      overall: ai.overall || '',
      advice: ai.advice || '',
      keywords: ai.keywords || [],
    }, 200, { 'X-Karma-Cache': cacheStatus });
  } catch (e) {
    return karmaAiServiceErrorResponse(e)
      || json({ error: getKarmaTextAnalysisMessage(responseLang, 'serverError') }, 500);
  }
}

const PHOTO_ANALYSIS_MESSAGES = {
  ko: {
    imageTooLarge: '사진 용량이 8MB를 넘습니다. 더 작은 사진을 사용해 주세요.',
    imageRequired: '사진을 먼저 올려 주세요.',
    invalidImage: '지원하지 않거나 손상된 이미지입니다. JPEG, PNG 또는 WebP 사진을 사용해 주세요.',
    imageStorageFailed: '사진 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.',
    serviceUnavailable: 'AI 분석 서비스를 사용할 수 없습니다.',
    mediaNotConnected: 'AI 미디어 분석 서비스가 연결되지 않았습니다.',
    emptyResponse: 'AI 응답이 비어 있습니다. 다른 사진으로 다시 시도해 주세요.',
    callFailed: '사진 분석 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.',
    faceAnalysisFailed: 'AI 분석에 실패했습니다. 정면 얼굴이 선명하게 나온 사진을 사용해 주세요.',
    palmAnalysisFailed: 'AI 분석에 실패했습니다. 손바닥이 잘 보이는 사진을 사용해 주세요.',
    faceRejected: '분석할 수 있는 얼굴 사진이 아닙니다. 사람의 정면 얼굴이 선명하게 나온 사진을 올려 주세요.',
    palmRejected: '분석할 수 있는 손바닥 사진이 아닙니다. 손을 활짝 펴고 손금이 잘 보이는 사진을 올려 주세요.',
    rateLimited: '사진 분석 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
  },
  en: {
    imageTooLarge: 'The image exceeds the 8 MB upload limit. Please use a smaller photo.',
    imageRequired: 'An image is required.',
    invalidImage: 'The image is damaged or unsupported. Please use a JPEG, PNG, or WebP photo.',
    imageStorageFailed: 'The photo could not be saved. Please try again later.',
    serviceUnavailable: 'The AI analysis service is unavailable.',
    mediaNotConnected: 'The AI media analysis service is not connected.',
    emptyResponse: 'The AI returned an empty response. Please try a different photo.',
    callFailed: 'The photo analysis request failed. Please try again later.',
    faceAnalysisFailed: 'AI analysis failed. Please use a clear, front-facing photo where the face is visible.',
    palmAnalysisFailed: 'AI analysis failed. Please use a clear photo where the palm is visible.',
    faceRejected: 'This is not a usable face photo. Please upload a clear, front-facing photo of a person.',
    palmRejected: 'This is not a usable palm photo. Please upload a photo with your hand open and the palm lines clearly visible.',
    rateLimited: 'Too many photo analysis requests. Please try again later.',
  },
};

function normalizePhotoAnalysisLang(lang) {
  return normalizeKarmaTextAnalysisLang(lang);
}

function getPhotoAnalysisMessage(lang, key) {
  return PHOTO_ANALYSIS_MESSAGES[normalizePhotoAnalysisLang(lang)][key];
}

async function localizePhotoAnalysisGateError(response, lang) {
  let result = {};
  try { result = await response.clone().json(); } catch (_) {}
  if (!result || typeof result !== 'object' || Array.isArray(result)) result = {};
  const status = Number(response?.status || 500);
  const errorMessage = status === 429
    ? getPhotoAnalysisMessage(lang, 'rateLimited')
    : String(result.error || `HTTP ${status}`);
  const localizedResult = { ...result, error: errorMessage };
  const retryAfter = response?.headers?.get?.('Retry-After');
  return {
    result: localizedResult,
    errorMessage,
    response: json(localizedResult, status, retryAfter ? { 'Retry-After': retryAfter } : {}),
  };
}

const PHOTO_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const PHOTO_MAX_REQUEST_BYTES = Math.ceil(PHOTO_MAX_UPLOAD_BYTES * 4 / 3) + 64 * 1024;
const PHOTO_ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function getOversizedPhotoRequestError(request) {
  const contentLength = Number(request?.headers?.get?.('Content-Length') || 0);
  if (!Number.isFinite(contentLength) || contentLength <= PHOTO_MAX_REQUEST_BYTES) return null;
  const acceptLanguage = String(request?.headers?.get?.('Accept-Language') || '');
  const lang = /^en\b/i.test(acceptLanguage) ? 'en' : 'ko';
  return json({ error: getPhotoAnalysisMessage(lang, 'imageTooLarge') }, 413);
}

function validatePhotoImageInput(image, mimeType, lang = 'ko') {
  const encoded = String(image || '').replace(/\s+/g, '');
  if (!encoded) return { error: getPhotoAnalysisMessage(lang, 'imageRequired') };
  if (base64ByteLength(encoded) > PHOTO_MAX_UPLOAD_BYTES) {
    return { error: getPhotoAnalysisMessage(lang, 'imageTooLarge'), status: 413 };
  }
  const normalizedMime = String(mimeType || 'image/jpeg').toLowerCase().split(';')[0].trim();
  if (!PHOTO_ALLOWED_MIME_TYPES.has(normalizedMime)
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
      || encoded.length % 4 === 1) {
    return { error: getPhotoAnalysisMessage(lang, 'invalidImage') };
  }

  let header;
  try {
    header = Uint8Array.from(atob(encoded.slice(0, 24)), character => character.charCodeAt(0));
  } catch (_) {
    return { error: getPhotoAnalysisMessage(lang, 'invalidImage') };
  }
  const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47
    && header[4] === 0x0d && header[5] === 0x0a && header[6] === 0x1a && header[7] === 0x0a;
  const isWebp = header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46
    && header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50;
  const signatureMatches = (normalizedMime === 'image/jpeg' && isJpeg)
    || (normalizedMime === 'image/png' && isPng)
    || (normalizedMime === 'image/webp' && isWebp);
  if (!signatureMatches) return { error: getPhotoAnalysisMessage(lang, 'invalidImage') };
  return { image: encoded, mimeType: normalizedMime, status: 200 };
}

function photoScoreInterpretationGuide(contractType) {
  if (!['face', 'palm'].includes(contractType)) return '';
  const itemPath = contractType === 'face' ? 'categories' : 'lines';
  return `## 점수와 설명 일치 원칙 (전체 인구 대상 절대평가 채점)
- ${itemPath}의 각 desc는 실제 관찰 → 판단 이유 → 전통 해석의 강점 또는 약점 → 점검할 행동 순서로 쓰되 3~4문장으로 정리하세요. 낮은 점수를 주고 설명에는 장점만 나열하지 마세요.
- 각 항목의 최종 점수는 사용자가 아니라 서버가 rubric 세부 기준(1~5점·가시성 0~3점)에 따라 계산합니다. desc 본문에는 자의적인 숫자 점수를 적지 말고 눈에 보이는 특징과 약점 근거만 적으세요.
- 모든 사람을 대상으로 한 절대값(절대평가) 기준으로 채점하세요. 한 사람 안에서 억지로 점수 차이를 벌리거나 평균을 맞추지 마세요. 모든 부위가 실제로 뛰어나면 전 부위에 높은 점수(85~96점)를 주고 모든 부위가 부족하거나 약점이 뚜렷하면 전 부위에 낮은 점수(30~59점)를 주세요. 듣기 좋은 말로 포장하거나 습관적으로 70~80점대에 몰아넣지 마세요. 전체 인구 평균 기준점은 64점(B등급)입니다.
- 모든 항목에 caution을 반드시 쓰세요. 높은 점수여도 칭찬만 쓰면 불완전한 응답입니다. desc에는 관찰과 점수의 이유를, caution에는 같은 특징의 약점이나 주의점과 대응 행동을 1~2문장으로 쓰세요. 서버가 두 내용을 이어서 표시하므로 desc에 caution 문장을 반복하지 마세요.
- 88~96점(상위권 최상급)은 전체 사람 기준 비율·대칭·윤곽·기색 또는 선의 깊이·연속성이 사진에서 흠잡을 데 없이 뚜렷한 부위에 부여하세요. 75점 이상도 caution에서 어떤 상황을 조심해야 하는지 밝히세요. 관찰된 아쉬움이 없다면 같은 강점이 지나칠 때 생길 수 있는 걸림돌을 전통 해석 안에서 조건부로 설명하세요. 실제로 보이지 않는 형태의 결함을 만들지 마세요.
- 60~74점은 일반 평균이거나 비대칭, 불균형, 피부결 거칠기, 선의 흐림 등 아쉬움이 있는 구간입니다. 60~74점은 점수를 낮춘 구체적인 아쉬움이나 전통 해석의 주의점·걸림돌 1개 이상을 반드시 직설적으로 쓰세요. 어떤 상황에서 걸림돌로 읽는지와 점검할 행동을 설명하세요.
- 60점 미만(30~59점)은 비대칭, 비율 불균형, 트러블, 가림이 뚜렷하거나 손금이 끊김, 사슬형, 섬 모양, 극도로 얕은 약점 구간입니다. 약점이 보이면 주저 없이 60점 미만을 부여하세요. 60점 미만은 점수를 낮춘 근거와 전통 해석의 약점·걸림돌을 중심으로 직설적으로 쓰세요. 칭찬을 앞세우거나 약점을 곧바로 장점으로 바꿔 설명하지 마세요.
- 낮은 점수의 원인이 흐림·가림·각도라면 확인할 수 없는 특징과 촬영 조건을 설명하세요. 관찰 한계를 성격이나 운세의 단점으로 바꾸지 마세요. 선이 없다는 해석도 해당 영역이 선명하게 보일 때만 가능합니다.
- 약점은 관찰한 형태·비율·선의 끊김 등에 연결해 전통 해석 안에서 설명하세요. 사진만 보고 실제 성격 결함, 능력 부족, 질병, 가난, 이혼, 불운을 단정하지 마세요.
- summary에는 가장 뚜렷한 강점과 우선 점검할 약점·걸림돌을 함께 직설적으로 짚으세요. 모든 항목이 75점 이상이어도 주의점을 생략하지 마세요. 낮은 항목이 관찰 한계 때문이면 그 한계와 보이는 항목의 주의점을 구분하세요.
- fortune에는 관련 항목의 약점·걸림돌이나 관찰 한계를 구체적으로 반영하세요. advice는 낮은 점수 항목에서 우선 점검할 행동으로 이어져야 합니다. 관찰 한계만 있다면 재촬영 방법을 안내하세요.
- caution은 부위마다 다른 관찰 근거와 상황에 연결하세요. "장점이 많다", "큰 문제는 없다", "균형을 유지하세요"만 쓰거나 같은 주의점을 모든 부위에 반복하지 마세요. 전체 인상의 caution은 앞선 세부 부위 중 우선 점검할 핵심 약점과 걸림돌을 요약하세요.
- 점수는 관찰 근거로 먼저 냉정하게 정하고 이 기준에 맞춰 설명하세요. 단점을 쓰려고 없는 결함을 만들거나 위로하려고 점수를 올리지 마세요. "섬세해서 그렇다", "오히려 장점이다", "노력하면 다 잘된다" 같은 말로 낮은 평가를 덮지 마세요.`;
}

function formatPhotoAiCautions(value, contractType, lang) {
  const key = contractType === 'face' ? 'categories' : contractType === 'palm' ? 'lines' : '';
  if (!key || value?.error || !Array.isArray(value?.[key])) return value;
  const label = lang === 'en' ? 'Watch out for' : '주의할 점';
  return { ...value, [key]: value[key].map(item => {
    if (!isNonEmptyAiText(item?.caution)) return item;
    const suffix = `${label}: ${item.caution.trim()}`;
    const desc = typeof item.desc === 'string' ? item.desc.trim() : '';
    return { ...item, desc: desc.endsWith(suffix) ? desc : `${desc}\n\n${suffix}` };
  }) };
}

async function callKarmaVisionAi(prompt, imageUrl, env, lang = 'ko', contractType = '', contractContext = {}, analysisContext = {}) {
  if (!env?.AI?.analyze) {
    return { _apiError: getPhotoAnalysisMessage(lang, 'mediaNotConnected') };
  }

  const proseGuard = karmaResponseStyleGuide(normalizePhotoAnalysisLang(lang));
  const responseLang = normalizePhotoAnalysisLang(lang);
  const languageGuard = karmaAiLanguageInstruction(responseLang);
  const colorFormatGuard = contractType === 'face'
    ? 'Exception for machine-readable fields: preserve personal_color.season and personal_color.undertone enum values in English and colors[].hex as #RRGGBB. Localize all descriptive text and color names.'
    : '';
  const scoreGuide = photoScoreInterpretationGuide(contractType);
  const basePrompt = [String(prompt || ''), scoreGuide, proseGuard, languageGuard, colorFormatGuard].filter(Boolean).join('\n\n');
  const maxAttempts = KARMA_AI_MAX_ATTEMPTS;
  let contractErrors = [];
  let lastError = null;
  let accumulated = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await waitForKarmaAiRetry(attempt);
    try {
      const modelPrompt = [
        basePrompt,
        contractErrors.length ? 'The previous response could not be displayed. Return the complete original JSON schema with actual photo analysis text. Do not return a patch.' : '',
      ].filter(Boolean).join('\n\n');
      analysisContext.aiCalled = true;
      const result = await env.AI.analyze({
        appId: 'karma',
        prompt: modelPrompt,
        media: [{
          type: 'image',
          url: String(imageUrl || ''),
        }],
        temperature: 0,
        maxTokens: 8000,
      });
      if (!result?.text) {
        lastError = new Error(getPhotoAnalysisMessage(lang, 'emptyResponse'));
        continue;
      }
      const parsed = parseAiJsonResponse(result.text);
      let candidate = parsed;
      if (contractType === 'face') candidate = normalizeFaceAppearance(normalizeFaceAiScores(candidate), { ...contractContext, lang: responseLang });
      if (contractType === 'palm') candidate = normalizePalmAiGrade(candidate);
      candidate = normalizeKarmaDisplayResponse(candidate, contractType);
      const contract = getKarmaDisplayIssue(candidate, contractType);
      if (contract.ok) return formatPhotoAiCautions(candidate, contractType, responseLang);
      accumulated = candidate;
      contractErrors = contract.errors;
      lastError = new Error(`AI JSON contract mismatch: ${(contractErrors.length ? contractErrors : contract.errors).join(', ')}`);
    } catch (error) {
      lastError = error;
      if (!isRetryableKarmaAiError(error)) break;
    }
  }
  await logApiError(env, 'Karma AI photo analysis failed', lastError?.stack || lastError?.message || String(lastError || ''), {
    endpoint: 'worker/karma-ai-media',
    contractType,
  });
  const failure = { _apiError: getPhotoAnalysisMessage(lang, 'callFailed') };
  if (isPlainAiObject(accumulated)) failure._keptResponse = accumulated;
  return failure;
}

function decodeBase64Bytes(encoded) {
  return Uint8Array.from(atob(String(encoded || '')), character => character.charCodeAt(0));
}

async function hashKarmaBytesSha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const HEX_NIBBLE_POPCOUNT = Object.freeze([0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]);

// 64자리 16진수 SHA-256 해시 형식 정규화 -> 유효하지 않으면 빈 문자열 반환
function normalizeHexHash64(value) {
  const trimmed = String(value || '').trim();
  return /^[0-9a-f]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : '';
}

// "<종횡비버킷>:<64자리 dHash>" 또는 "<64자리 dHash>" 문자열 파싱 -> 비율 버킷과 64자리 해시 반환
function parsePerceptualDhash(value) {
  const match = String(value || '').trim().match(/^(?:(\d{1,3}):)?([0-9a-f]{64})$/i);
  if (!match) return null;
  const aspect = match[1] ? Number(match[1]) : 0;
  return {
    aspect: Number.isInteger(aspect) && aspect > 0 && aspect <= 250 ? aspect : 0,
    hex: match[2].toLowerCase(),
  };
}

// 256비트(64자리 16진수) dHash 간 해밍 거리 계산 -> 동일 형식 불가 시 256 반환
function hammingDistanceHex256(hexA, hexB) {
  if (!/^[0-9a-f]{64}$/i.test(String(hexA || '')) || !/^[0-9a-f]{64}$/i.test(String(hexB || ''))) {
    return 256;
  }
  const a = hexA.toLowerCase();
  const b = hexB.toLowerCase();
  let distance = 0;
  for (let i = 0; i < 64; i += 1) {
    const xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    distance += HEX_NIBBLE_POPCOUNT[xor];
  }
  return distance;
}

// PNG·JPEG·WebP 바이너리 헤더에서 가로·세로 픽셀 크기 추출 -> 판별 불가 시 null 반환
function extractPhotoDimensions(bytes, mimeType) {
  if (!ArrayBuffer.isView(bytes) || bytes.length < 24) return null;
  const mime = String(mimeType || '').toLowerCase();

  if ((mime === 'image/png' || (bytes[0] === 0x89 && bytes[1] === 0x50)) && bytes.length >= 24) {
    const width = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
    const height = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  if ((mime === 'image/jpeg' || (bytes[0] === 0xff && bytes[1] === 0xd8)) && bytes.length >= 4) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) break;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      if (offset + 1 >= bytes.length) break;
      const segLength = (bytes[offset] << 8) | bytes[offset + 1];
      if (segLength < 2 || offset + segLength > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && segLength >= 7) {
        const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
        const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
        return width > 0 && height > 0 ? { width, height } : null;
      }
      offset += segLength;
    }
    return null;
  }

  if ((mime === 'image/webp' || (bytes[0] === 0x52 && bytes[1] === 0x49)) && bytes.length >= 30) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === 'VP8X') {
      const width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
      const height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (chunk === 'VP8L') {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (chunk === 'VP8 ') {
      const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
      const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
  }
  return null;
}

function computeAspectBucket(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
  return Math.max(1, Math.min(250, Math.round((width / height) * 25)));
}

function normalizeKarmaGenderKey(gender) {
  const value = String(gender || '').trim().toLowerCase();
  if (value === '남성' || value === 'male') return 'male';
  if (value === '여성' || value === 'female') return 'female';
  return value;
}

function normalizeKarmaAgeKey(age) {
  const value = String(age || '').trim().toLowerCase();
  const map = {
    '10대': '10s', teens: '10s',
    '20대': '20s', '20s': '20s',
    '30대': '30s', '30s': '30s',
    '40대': '40s', '40s': '40s',
    '50대': '50s', '50s': '50s',
    '60대 이상': '60s+', '60s+': '60s+',
  };
  return map[value] || value;
}

function normalizeKarmaLocationKey(location) {
  const value = String(location || '').trim().toLowerCase();
  return (!value || value === 'utc+9' || value === 'kr') ? 'kr' : value;
}

// YYYY-M-D 표기를 YYYY-MM-DD 형식으로 통일 -> 동일 날짜 캐시 공유
function normalizeKarmaBirthDateKey(birthDate) {
  const raw = String(birthDate || '').trim();
  const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return raw;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

// H:MM 표기를 HH:MM 형식으로 통일하고 시간 미입력은 빈 문자열 반환
function normalizeKarmaBirthTimeKey(birthTime) {
  const raw = String(birthTime || '').trim();
  if (raw.length < 4 || !raw.includes(':')) return '';
  const [hourText, minuteText] = raw.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return raw;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// 화면 렌더링 가능한 정상 응답인지 유형별 핵심 필드 확인 -> 부분 비치명 경고는 허용하고 오류·빈 응답만 캐시 제외
function isCacheableKarmaResult(analysisType, value) {
  if (!isPlainAiObject(value) || value.error || value._apiError) return false;
  switch (analysisType) {
    case 'face':
      return Number.isInteger(value.overall_score)
        && isNonEmptyAiText(value.overall_grade)
        && isNonEmptyAiText(value.summary)
        && Array.isArray(value.categories)
        && value.categories.length >= 6
        && value.categories.every(item => isPlainAiObject(item) && Number.isInteger(item.score) && isNonEmptyAiText(item.desc));
    case 'palm':
      return Number.isInteger(value.overall_score)
        && isNonEmptyAiText(value.overall_grade)
        && isNonEmptyAiText(value.summary)
        && Array.isArray(value.lines)
        && value.lines.length === 6
        && value.lines.every(item => isPlainAiObject(item) && Number.isInteger(item.score) && isNonEmptyAiText(item.desc));
    case 'saju':
      return isPlainAiObject(value.pillar_reading)
        && isNonEmptyAiText(value.personality)
        && getKarmaDisplayIssue(value, 'saju').ok;
    case 'compat':
    case 'match-detail':
      return isNonEmptyAiText(value.summary)
        && isPlainAiObject(value.categories)
        && ['personality', 'intimacy', 'finance', 'timing'].every(
          key => isPlainAiObject(value.categories[key])
            && Number.isInteger(value.categories[key].score)
            && isNonEmptyAiText(value.categories[key].desc),
        );
    case 'fortune':
      return isNonEmptyAiText(value.year_summary)
        && isPlainAiObject(value.lucky)
        && getKarmaDisplayIssue(value, 'fortune').ok;
    case 'daily':
      return isNonEmptyAiText(value.overall)
        && isPlainAiObject(value.lucky)
        && getKarmaDisplayIssue(value, 'daily').ok;
    case 'tarot':
      return Array.isArray(value.cards)
        && value.cards.length === 3
        && value.cards.every(card => isPlainAiObject(card) && isNonEmptyAiText(card.interpretation))
        && isNonEmptyAiText(value.overall);
    default:
      return false;
  }
}

// 분석 유형과 정규화된 입력 페이로드를 받아 SHA-256 기반 일관성 캐시 키 생성
async function buildKarmaConsistencyCacheKey(analysisType, payload) {
  const serialized = JSON.stringify({
    v: KARMA_CONSISTENCY_SCHEMA_VERSION,
    type: String(analysisType || ''),
    payload,
  });
  const digest = await hashKarmaBytesSha256(new TextEncoder().encode(serialized));
  return `${KARMA_CONSISTENCY_SCHEMA_VERSION}:${analysisType}:${digest}`;
}

function getKarmaEdgeCacheUrl(cacheKey) {
  return `https://karma-consistency.internal/${encodeURIComponent(String(cacheKey || ''))}`;
}

async function readKarmaEdgeCache(cacheKey) {
  const cache = typeof caches !== 'undefined' && caches?.default ? caches.default : null;
  if (!cache || !cacheKey) return null;
  try {
    const matched = await cache.match(new Request(getKarmaEdgeCacheUrl(cacheKey), { method: 'GET' }));
    if (!matched) return null;
    const parsed = await matched.json();
    return isPlainAiObject(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function writeKarmaEdgeCache(analysisType, cacheKey, result) {
  const cache = typeof caches !== 'undefined' && caches?.default ? caches.default : null;
  if (!cache || !cacheKey || !isPlainAiObject(result)) return;
  const ttlSec = Math.max(60, Math.floor((KARMA_CONSISTENCY_TTL_MS[analysisType] || (30 * 24 * 60 * 60 * 1000)) / 1000));
  try {
    await cache.put(
      new Request(getKarmaEdgeCacheUrl(cacheKey), { method: 'GET' }),
      new Response(JSON.stringify(result), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `public, max-age=${ttlSec}`,
        },
      }),
    );
  } catch (_) {}
}

async function ensureKarmaConsistencyCacheTable(db) {
  if (_karmaConsistencyCacheTableReady) return true;
  const createStmt = db.prepare(`
    CREATE TABLE IF NOT EXISTS analysis_consistency_cache (
      cache_key TEXT PRIMARY KEY,
      analysis_type TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      options_key TEXT NOT NULL DEFAULT '',
      perceptual_hash TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
    )
  `);
  if (typeof createStmt?.run !== 'function') return false;
  await createStmt.run();
  for (const columnSql of [
    "ALTER TABLE analysis_consistency_cache ADD COLUMN options_key TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE analysis_consistency_cache ADD COLUMN perceptual_hash TEXT NOT NULL DEFAULT ''",
  ]) {
    try {
      const alterStmt = db.prepare(columnSql);
      if (typeof alterStmt?.run === 'function') await alterStmt.run();
    } catch (error) {
      if (!/duplicate column|already exists/i.test(String(error?.message || error))) throw error;
    }
  }
  const idxExpiry = db.prepare('CREATE INDEX IF NOT EXISTS idx_analysis_consistency_cache_expiry ON analysis_consistency_cache(expires_at)');
  if (typeof idxExpiry?.run === 'function') await idxExpiry.run();
  const idxLookup = db.prepare('CREATE INDEX IF NOT EXISTS idx_analysis_consistency_cache_lookup ON analysis_consistency_cache(analysis_type, options_key, expires_at DESC)');
  if (typeof idxLookup?.run === 'function') await idxLookup.run();
  _karmaConsistencyCacheTableReady = true;
  return true;
}

// Edge 캐시 -> D1 순으로 일관성 캐시 조회 후 D1 적중 시 Edge 캐시 역채우기 수행
async function readKarmaConsistencyCache(env, cacheKey, analysisType = '') {
  if (!cacheKey) return null;
  const edgeHit = await readKarmaEdgeCache(cacheKey);
  if (edgeHit) return edgeHit;
  if (!env?.DB?.prepare) return null;
  try {
    const selectStmt = env.DB.prepare('SELECT analysis_type, schema_version, result_json FROM analysis_consistency_cache WHERE cache_key = ? AND expires_at > ?');
    const bound = selectStmt?.bind?.(cacheKey, Date.now());
    if (typeof bound?.first !== 'function') return null;
    if (!(await ensureKarmaConsistencyCacheTable(env.DB))) return null;
    const row = await bound.first();
    if (!row || row.schema_version !== KARMA_CONSISTENCY_SCHEMA_VERSION || typeof row.result_json !== 'string') {
      return null;
    }
    const parsed = JSON.parse(row.result_json);
    if (!isPlainAiObject(parsed)) return null;
    await writeKarmaEdgeCache(analysisType || row.analysis_type, cacheKey, parsed);
    return parsed;
  } catch (error) {
    console.warn('[KarmaConsistencyCache] 읽기 오류:', error?.message || error);
    return null;
  }
}

// 검증 통과한 분석 결과를 Edge 캐시와 D1에 동시 저장 -> 실패 시 경고 로그만 남기고 정상 응답 유지
async function writeKarmaConsistencyCache(env, analysisType, cacheKey, result, meta = {}) {
  if (!cacheKey || !isPlainAiObject(result)) return;
  await writeKarmaEdgeCache(analysisType, cacheKey, result);
  if (!env?.DB?.prepare) return;
  try {
    const probeBound = env.DB.prepare('SELECT schema_version FROM analysis_consistency_cache WHERE cache_key = ?')?.bind?.(cacheKey);
    if (typeof probeBound?.first !== 'function') return;
    if (!(await ensureKarmaConsistencyCacheTable(env.DB))) return;
    const ttl = KARMA_CONSISTENCY_TTL_MS[analysisType] || (30 * 24 * 60 * 60 * 1000);
    const expiresAt = Date.now() + ttl;
    const optionsKey = String(meta.optionsKey || '');
    const perceptualHash = String(meta.perceptualHash || '');
    const upsertStmt = env.DB.prepare(`
      INSERT INTO analysis_consistency_cache (
        cache_key, analysis_type, schema_version, options_key, perceptual_hash, result_json, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        analysis_type = excluded.analysis_type,
        schema_version = excluded.schema_version,
        options_key = excluded.options_key,
        perceptual_hash = excluded.perceptual_hash,
        result_json = excluded.result_json,
        expires_at = excluded.expires_at,
        created_at = datetime('now', '+9 hours')
    `);
    const bound = upsertStmt?.bind?.(
      cacheKey,
      String(analysisType || ''),
      KARMA_CONSISTENCY_SCHEMA_VERSION,
      optionsKey,
      perceptualHash,
      JSON.stringify(result),
      expiresAt,
    );
    if (typeof bound?.run === 'function') await bound.run();
  } catch (error) {
    console.warn('[KarmaConsistencyCache] 쓰기 오류:', error?.message || error);
  }
}

// 사진 일관성 3단계 조회 -> 인코딩 바이트 해시 -> 원본 파일 해시 -> 같은 종횡비·옵션 내 256비트 dHash 유사 매칭
async function lookupKarmaPhotoConsistencyCache(env, analysisType, {
  primaryKey,
  secondaryKey = '',
  optionsKey = '',
  perceptualHash = '',
}) {
  const tier1 = await readKarmaConsistencyCache(env, primaryKey, analysisType);
  if (isCacheableKarmaResult(analysisType, tier1)) return tier1;

  if (secondaryKey && secondaryKey !== primaryKey) {
    const tier2 = await readKarmaConsistencyCache(env, secondaryKey, analysisType);
    if (isCacheableKarmaResult(analysisType, tier2)) {
      await writeKarmaConsistencyCache(env, analysisType, primaryKey, tier2, { optionsKey, perceptualHash });
      return tier2;
    }
  }

  if (perceptualHash && optionsKey && env?.DB?.prepare) {
    try {
      const stmt = env.DB.prepare(`
        SELECT result_json, perceptual_hash
        FROM analysis_consistency_cache
        WHERE analysis_type = ?
          AND schema_version = ?
          AND options_key = ?
          AND perceptual_hash != ''
          AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT 40
      `);
      const bound = stmt?.bind?.(analysisType, KARMA_CONSISTENCY_SCHEMA_VERSION, optionsKey, Date.now());
      if (typeof bound?.all === 'function' && await ensureKarmaConsistencyCacheTable(env.DB)) {
        const res = await bound.all();
        const rows = Array.isArray(res?.results) ? res.results : [];
        for (const row of rows) {
          if (hammingDistanceHex256(perceptualHash, row?.perceptual_hash) > 8) continue;
          if (typeof row?.result_json !== 'string') continue;
          const parsed = JSON.parse(row.result_json);
          if (!isCacheableKarmaResult(analysisType, parsed)) continue;
          await writeKarmaConsistencyCache(env, analysisType, primaryKey, parsed, { optionsKey, perceptualHash });
          if (secondaryKey && secondaryKey !== primaryKey) {
            await writeKarmaConsistencyCache(env, analysisType, secondaryKey, parsed, { optionsKey, perceptualHash });
          }
          return parsed;
        }
      }
    } catch (error) {
      console.warn('[KarmaConsistencyCache] dHash 조회 오류:', error?.message || error);
    }
  }
  return null;
}

// 사진 분석 캐시 저장 -> 인코딩 해시와 원본 해시 엔트리에 옵션·dHash 메타를 함께 기록
async function storeKarmaPhotoConsistencyCache(env, analysisType, result, {
  primaryKey,
  secondaryKey = '',
  optionsKey = '',
  perceptualHash = '',
}) {
  if (!isCacheableKarmaResult(analysisType, result)) return;
  const meta = { optionsKey, perceptualHash };
  await writeKarmaConsistencyCache(env, analysisType, primaryKey, result, meta);
  if (secondaryKey && secondaryKey !== primaryKey) {
    await writeKarmaConsistencyCache(env, analysisType, secondaryKey, result, meta);
  }
}

async function saveKarmaAnalysisImageToR2(env, {
  image,
  bytes: providedBytes,
  mimeType,
  analysisType,
  requestId,
}) {
  if (!env?.KARMA_IMAGE_BUCKET) throw new Error('KARMA_IMAGE_BUCKET is not configured');

  const extension = mimeType === 'image/png'
    ? 'png'
    : mimeType === 'image/webp'
      ? 'webp'
      : 'jpg';
  const type = analysisType === 'palm' ? 'palm' : 'face';
  const safeRequestId = String(requestId || crypto.randomUUID()).replace(/[^a-zA-Z0-9-]/g, '');
  const key = `karma/${type}/${Date.now()}-${safeRequestId || crypto.randomUUID()}.${extension}`;

  const bytes = providedBytes || decodeBase64Bytes(image);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await env.KARMA_IMAGE_BUCKET.put(key, bytes, {
        httpMetadata: { contentType: mimeType },
      });
      return key;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Karma image storage failed');
}

async function ensureKarmaImageAnalysesTable(db) {
  if (_karmaImageAnalysesTableReady) return;
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS karma_image_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      r2_key TEXT NOT NULL UNIQUE,
      analysis_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      input_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error_message TEXT NOT NULL DEFAULT '',
      ai_service TEXT NOT NULL DEFAULT 'KARMA_AI',
      created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
    )
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_karma_image_analyses_type_time
    ON karma_image_analyses(analysis_type, created_at DESC, id DESC)
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_karma_image_analyses_status_time
    ON karma_image_analyses(status, created_at DESC, id DESC)
  `).run();
  _karmaImageAnalysesTableReady = true;
}

async function ensureKarmaAnalysesTable(db) {
  if (_karmaAnalysesTableReady) return;
  await ensureKarmaImageAnalysesTable(db);
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS karma_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      analysis_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      http_status INTEGER NOT NULL DEFAULT 200,
      input_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error_message TEXT NOT NULL DEFAULT '',
      ai_service TEXT NOT NULL DEFAULT '',
      r2_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
    )
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_karma_analyses_type_time
    ON karma_analyses(analysis_type, created_at DESC, id DESC)
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_karma_analyses_status_time
    ON karma_analyses(status, created_at DESC, id DESC)
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_karma_analyses_r2_key
    ON karma_analyses(r2_key)
    WHERE r2_key != ''
  `).run();
  await db.prepare(`
    INSERT OR IGNORE INTO karma_analyses (
      request_id, analysis_type, status, http_status, input_json,
      result_json, error_message, ai_service, r2_key, created_at, updated_at
    )
    SELECT
      request_id,
      analysis_type,
      status,
      CASE status WHEN 'success' THEN 200 WHEN 'rejected' THEN 400 ELSE 500 END,
      input_json,
      result_json,
      error_message,
      ai_service,
      r2_key,
      created_at,
      updated_at
    FROM karma_image_analyses
  `).run();
  _karmaAnalysesTableReady = true;
}

function sanitizeKarmaAnalysisInput(value, key = '') {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeKarmaAnalysisInput(item));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [
      name,
      sanitizeKarmaAnalysisInput(item, name),
    ]));
  }
  if (typeof value !== 'string') return value;

  const normalizedKey = String(key || '').toLowerCase();
  if (normalizedKey === 'image' || normalizedKey === 'imagedata' || normalizedKey === 'image_data') {
    return `[image omitted: ${base64ByteLength(value)} bytes]`;
  }
  if (/^data:image\//i.test(value)) {
    return `[image omitted: ${base64ByteLength(value.split(',').pop() || '')} bytes]`;
  }
  return value;
}

async function recordKarmaAnalysis(env, {
  requestId,
  analysisType,
  status,
  httpStatus,
  input,
  result,
  errorMessage,
  aiService,
  r2Key,
}) {
  if (!env?.DB) return;
  try {
    await ensureKarmaAnalysesTable(env.DB);
    await env.DB.prepare(`
      INSERT INTO karma_analyses (
        request_id, analysis_type, status, http_status, input_json,
        result_json, error_message, ai_service, r2_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        analysis_type = excluded.analysis_type,
        status = excluded.status,
        http_status = excluded.http_status,
        input_json = CASE
          WHEN excluded.input_json != '{}' THEN excluded.input_json
          ELSE karma_analyses.input_json
        END,
        result_json = excluded.result_json,
        error_message = excluded.error_message,
        ai_service = excluded.ai_service,
        r2_key = CASE
          WHEN excluded.r2_key != '' THEN excluded.r2_key
          ELSE karma_analyses.r2_key
        END,
        updated_at = datetime('now', '+9 hours')
    `).bind(
      String(requestId || crypto.randomUUID()),
      String(analysisType || 'unknown').slice(0, 40),
      ['success', 'rejected', 'invalid_input', 'error'].includes(status) ? status : 'error',
      Number.isInteger(httpStatus) ? httpStatus : 500,
      JSON.stringify(sanitizeKarmaAnalysisInput(input || {})),
      JSON.stringify({ ...result, ...(env.karmaAiTrace ? { _aiTrace: env.karmaAiTrace } : {}) }),
      String(errorMessage || '').slice(0, 2000),
      String(aiService || '').slice(0, 80),
      String(r2Key || '').slice(0, 1000),
    ).run();
  } catch (error) {
    console.error('[KarmaAnalysis] unified D1 write failed:', error?.message || error);
    await logApiError(env, 'Karma analysis log failed', error?.stack || error?.message || String(error), {
      endpoint: `worker/${analysisType || 'unknown'}-analysis-log`,
    });
  }
}

async function karmaRequestLang(request) {
  let lang = /^en\b/i.test(request?.headers?.get?.('Accept-Language') || '') ? 'en' : 'ko';
  try {
    const body = await request.clone().json();
    if (isPlainAiObject(body) && body.lang != null) lang = normalizeKarmaTextAnalysisLang(body.lang);
  } catch (_) {}
  return lang;
}

async function localizeKarmaTextGateError(response, lang) {
  let result = {};
  try { result = await response.clone().json(); } catch (_) {}
  if (!isPlainAiObject(result)) result = {};
  const status = Number(response?.status || 500);
  const errorMessage = status === 429
    ? getKarmaTextAnalysisMessage(lang, 'rateLimited')
    : String(result.error || getKarmaTextAnalysisMessage(lang, 'serverError'));
  const localizedResult = { ...result, error: errorMessage };
  const retryAfter = response?.headers?.get?.('Retry-After');
  return json(localizedResult, status, retryAfter ? { 'Retry-After': retryAfter } : {});
}

function karmaTracedEnv(env) {
  const traces = [];
  const ai = {};
  for (const method of ['complete', 'analyze']) {
    if (typeof env.AI?.[method] !== 'function') continue;
    ai[method] = async (...args) => {
      const trace = { operation: method, status: 'error', model: '', providerRoute: '' };
      traces.push(trace);
      try {
        const result = await env.AI[method](...args);
        trace.model = String(result?.model || '');
        trace.providerRoute = String(result?.providerRoute || result?.providerName || result?.provider || '');
        trace.status = 'response';
        return result;
      } catch (error) {
        trace.model = String(error?.model || '');
        trace.providerRoute = String(error?.providerRoute || '');
        throw error;
      }
    };
  }
  return { ...env, AI: ai, karmaAiTrace: traces };
}

function isValidKarmaDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function hasValidKarmaCalendarInput(body) {
  const inputs = [body, body.personA, body.personB].filter(isPlainAiObject);
  for (const input of inputs) {
    for (const key of ['birth_date', 'birth_a', 'birth_b', 'target_date']) {
      if (input[key] != null && input[key] !== '' && !isValidKarmaDate(input[key])) return false;
    }
    for (const key of ['birth_time', 'time_a', 'time_b']) {
      if (input[key] != null && input[key] !== '' && (typeof input[key] !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input[key]))) return false;
    }
  }
  return body.year == null || body.year === '' || (Number.isInteger(Number(body.year)) && Number(body.year) >= 1 && Number(body.year) <= 9999);
}

async function handleLoggedKarmaAnalysis(request, env, ctx, analysisType, handler, aiService = 'KARMA_AI') {
  env = karmaTracedEnv(env);
  const isPhotoAnalysis = ['face', 'palm'].includes(analysisType);
  const rateLimitError = await enforceKarmaAnalysisRateLimit(request, env, analysisType);
  if (rateLimitError && !isPhotoAnalysis) {
    return localizeKarmaTextGateError(rateLimitError, await karmaRequestLang(request));
  }
  const requestForLog = isPhotoAnalysis ? null : request.clone();
  const requestId = crypto.randomUUID();
  const analysisContext = { r2Key: '', aiCalled: false };
  let response;
  try {
    let body;
    if (!isPhotoAnalysis) {
      try { body = await request.clone().json(); } catch (_) {}
    }
    response = isPhotoAnalysis || (isPlainAiObject(body) && hasValidKarmaCalendarInput(body))
      ? await handler(request, env, requestId, rateLimitError, analysisContext)
      : json({ error: getKarmaTextAnalysisMessage(await karmaRequestLang(request), 'invalidRequest') }, 400);
  } catch (error) {
    response = karmaAiServiceErrorResponse(error)
      || json({ error: error?.message || 'Server error' }, 500);
  }
  const responseForLog = response.clone();
  const persist = async () => {
    let input = {};
    let result = {};
    if (requestForLog) {
      try { input = await requestForLog.json(); } catch (_) {}
    }
    try { result = await responseForLog.json(); } catch (_) {}
    const errorMessage = response.ok ? '' : String(result?.error || `HTTP ${response.status}`);
    await recordKarmaAnalysis(env, {
      requestId,
      analysisType,
      status: response.ok ? 'success'
        : isPhotoAnalysis && !analysisContext.aiCalled && [400, 413].includes(response.status) ? 'invalid_input'
        : response.status === 400 && isPhotoAnalysis && analysisContext.aiCalled ? 'rejected' : 'error',
      httpStatus: response.status,
      input,
      result,
      errorMessage,
      aiService: isPhotoAnalysis && !analysisContext.aiCalled ? 'NOT_CALLED' : aiService,
      r2Key: analysisContext.r2Key || result?.r2_key || '',
    });
  };
  if (ctx?.waitUntil) ctx.waitUntil(persist());
  else await persist();
  return response;
}

async function recordKarmaImageAnalysis(env, {
  requestId,
  r2Key,
  analysisType,
  status,
  input,
  result,
  errorMessage,
  aiService = 'KARMA_AI',
}) {
  if (!env?.DB) return;
  try {
    const resolvedRequestId = requestId || crypto.randomUUID();
    if (r2Key) {
      await ensureKarmaImageAnalysesTable(env.DB);
      await env.DB.prepare(`
        INSERT INTO karma_image_analyses (
          request_id, r2_key, analysis_type, status, input_json,
          result_json, error_message, ai_service
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(r2_key) DO UPDATE SET
          request_id = excluded.request_id,
          analysis_type = excluded.analysis_type,
          status = excluded.status,
          input_json = excluded.input_json,
          result_json = excluded.result_json,
          error_message = excluded.error_message,
          ai_service = excluded.ai_service,
          updated_at = datetime('now', '+9 hours')
      `).bind(
        resolvedRequestId,
        String(r2Key),
        analysisType === 'palm' ? 'palm' : 'face',
        ['success', 'rejected', 'error'].includes(status) ? status : 'error',
        JSON.stringify(input || {}),
        JSON.stringify({ ...result, ...(env.karmaAiTrace ? { _aiTrace: env.karmaAiTrace } : {}) }),
        String(errorMessage || '').slice(0, 2000),
        aiService,
      ).run();
    }
    await recordKarmaAnalysis(env, {
      requestId: resolvedRequestId,
      analysisType: analysisType === 'palm' ? 'palm' : 'face',
      status,
      httpStatus: status === 'success' ? 200 : status === 'rejected' ? 400 : 500,
      input,
      result,
      errorMessage,
      aiService,
      r2Key,
    });
  } catch (error) {
    console.error('[KarmaAnalysis] D1 write failed:', error?.message || error);
    await logApiError(env, 'Karma image analysis log failed', error?.stack || error?.message || String(error), {
      endpoint: `worker/${analysisType || 'image'}-analysis-log`,
      r2Key: String(r2Key).slice(0, 500),
    });
  }
}

function base64ByteLength(value) {
  const encoded = String(value || '').replace(/\s+/g, '');
  const padding = encoded.endsWith('==') ? 2 : (encoded.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
}

async function ensureKarmaRateLimitsTable(db) {
  if (_karmaRateLimitsTableReady) return;
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS karma_rate_limits (
      rate_key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL
    )
  `).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_karma_rate_limits_expiry ON karma_rate_limits(expires_at)').run();
  _karmaRateLimitsTableReady = true;
}

async function hashKarmaRateLimitKey(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function enforceKarmaAnalysisRateLimit(request, env, analysisType) {
  if (hasValidKarmaAdminToken(request, env)) return null;
  const clientIp = String(request?.headers?.get?.('CF-Connecting-IP') || '').trim();
  if (!clientIp || !env?.DB) return null;

  const policy = getKarmaRateLimitPolicy(analysisType);
  const now = Date.now();
  const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
  const expiresAt = windowStart + policy.windowMs;
  const rateKey = await hashKarmaRateLimitKey(`${policy.bucket}:${clientIp}:${windowStart}`);
  await ensureKarmaRateLimitsTable(env.DB);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO karma_rate_limits (rate_key, count, expires_at) VALUES (?, 0, ?)').bind(rateKey, expiresAt),
    env.DB.prepare('UPDATE karma_rate_limits SET count = count + 1 WHERE rate_key = ?').bind(rateKey),
    env.DB.prepare('DELETE FROM karma_rate_limits WHERE expires_at < ?').bind(now),
  ]);
  const row = await env.DB.prepare('SELECT count FROM karma_rate_limits WHERE rate_key = ?').bind(rateKey).first();
  if (Number(row?.count || 0) <= policy.limit) return null;

  const retryAfter = Math.max(1, Math.ceil((expiresAt - now) / 1000));
  return json({
    error: analysisType === 'face' || analysisType === 'palm'
      ? '사진 분석 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.'
      : '분석 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
  }, 429, { 'Retry-After': String(retryAfter) });
}

function inferHandSide(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('right') || text.includes('오른')) return 'right';
  if (text.includes('left') || text.includes('왼')) return 'left';
  return '';
}

function buildPalmHandContext(hand, dominant, lang) {
  const isEn = lang === 'en';
  const shotSide = inferHandSide(hand);
  const dominantSide = inferHandSide(dominant);
  const sideLabel = {
    right: isEn ? 'right hand' : '오른손',
    left: isEn ? 'left hand' : '왼손',
  };
  const dominantLabel = {
    right: isEn ? 'right-handed' : '오른손잡이',
    left: isEn ? 'left-handed' : '왼손잡이',
  };

  const mode = shotSide && dominantSide
    ? (shotSide === dominantSide
      ? (isEn ? 'acquired fortune: current habits, effort, and later-life flow' : '후천운: 현재 습관, 노력, 중년 이후 흐름')
      : (isEn ? 'innate fortune: born temperament and early-life tendency' : '선천운: 타고난 기질과 초년 성향'))
    : '';

  if (isEn) {
    return [
      `Dominant hand: ${dominantLabel[dominantSide] || dominant || 'not provided'}`,
      `Photo hand: ${sideLabel[shotSide] || hand || 'not provided'}`,
      mode ? `Reading mode: ${mode}` : '',
    ].filter(Boolean).join('\n');
  }

  return [
    `주 사용 손: ${dominantLabel[dominantSide] || dominant || '미입력'}`,
    `촬영한 손: ${sideLabel[shotSide] || hand || '미입력'}`,
    mode ? `해석 기준: ${mode}` : '',
  ].filter(Boolean).join('\n');
}

function faceExpertRubric() {
  return `## 전문가식 관상 판독 체크리스트
아래 순서대로 먼저 관찰한 뒤 해석하세요. 실제 전문가 감수 데이터가 아니라, 전통 관상학에 알려진 기준을 서비스용으로 구조화한 것입니다.

0. 전제: 관상은 참고용 점술/성향 해석입니다. 마의상법식 관점에서도 관상보다 몸의 생활습관, 그보다 마음가짐과 선택이 중요하다는 균형 감각을 advice에 반영하세요.
1. 사진 품질: 정면성, 초점, 조명, 얼굴 가림, 표정 과장, 필터/보정 여부를 먼저 판정. 제한이 있으면 정확히 어느 영역의 어떤 특징을 확인할 수 없는지 명시하세요. 일부 영역의 제한을 부위 전체의 관찰 불가로 확대하지 마세요.
2. 삼정: 상정(이마, 대략 30세 전후까지), 중정(눈썹~코·광대, 대략 40대까지), 하정(인중~턱, 50대 이후)을 나누어 균형을 봅니다. 세 구간 중 유난히 짧거나 긴 곳, 눌린 곳, 안정된 곳을 summary에 반영하세요.
3. 이마: 눈썹 위에서 머리카락이 시작되는 경계까지의 피부 영역입니다. 양쪽 눈썹 바로 위부터 위쪽으로 따라가며 실제 피부가 보이는 범위를 먼저 서술하고, 그 다음 가시성을 판정하세요. 머리카락이 위쪽이나 옆쪽에 있다는 이유만으로 이마가 가려졌다고 판단하지 마세요. 올린 머리, 뒤로 넘긴 머리, 가르마 사이로 드러난 피부는 보이는 이마입니다. 두건·모자·머리띠가 있어도 눈썹과 천의 경계 사이에 피부 띠나 삼각형 피부 영역이 보이면 이마의 부분 노출입니다. 이 경우 보이는 피부는 관찰하고 가려진 윗부분과 헤어라인만 제한으로 적으세요. 피부 전체가 실제로 가려지거나 프레임 밖에 있을 때만 이마가 전혀 안 보인다고 하세요.
4. 눈/눈썹: 관상에서 눈은 가장 큰 비중을 둡니다. 눈빛 선명도, 눈꼬리 방향, 눈 사이 거리, 눈두덩이 여유, 좌우 높낮이, 눈썹 농도·끊김·간격을 관찰하세요. 눈 사이가 넓으면 여유/포용, 좁으면 예민함/근심 경향처럼 전통 해석으로만 설명하세요.
5. 눈 형태 분류: 삼백안/사백안, 돌출눈, 짝눈, 눈썹과 눈이 가까운 압안, 물기 있는 도화안 같은 분류는 사진상 명확할 때만 "그런 인상"으로 언급하세요. 폭력성, 범죄성, 정신질환, 음란성 같은 낙인 표현은 금지.
6. 코/재백궁: 산근(미간 아래 코뿌리), 콧대, 준두(코끝), 난대·정위(콧방울), 정면 콧구멍 노출 여부를 봅니다. 전통적으로 재물 관리, 자존심, 현실 감각과 연결하되 실제 부자/가난 확정처럼 쓰지 마세요.
7. 입/인중: 입 크기, 입꼬리, 입술 두께와 색감, 인중 길이·선명도·흉터 여부를 봅니다. 전통적으로 언변, 식복, 관계 표현, 자식/후배 복으로 해석하되, 치아 개수처럼 사진에서 보이지 않는 정보는 언급하지 마세요.
8. 턱/광대/하정: 턱의 길이·폭·안정감, 광대 돌출과 균형, 하관의 힘을 봅니다. 전통적으로 의지력, 중년 이후 기반, 관계 지속력과 연결하세요.
9. 피부/기색: 이마·볼·코·턱 주변 피부의 윤택함, 피부결 매끄러움, 트러블·여드름·붉은기·잡티·모공 요철, 다크서클·안색의 맑고 탁함을 관찰하세요. 전통 관상에서는 얼굴빛과 살결의 윤기를 기색(氣色)이라 하여 현재의 컨디션·생활 리듬·회복력과 연결합니다. 조명·필터·화질 한계가 있으면 구분해 적고, 피부 상태나 점으로 질병·불행·사망을 단정하지 마세요.
10. 귀/점/머리카락: 사진에 보이는 경우만 참고하세요. 귀는 초년 기반, 점은 위치별 전통 해석, 머리카락은 정돈감 정도로만 다루세요.
11. 물형/동물형 관상은 전체 인상을 설명하는 보조 비유로만 사용하세요. 특정 동물형을 이유로 인격·운명을 확정하지 마세요.
12. 관찰→전통 해석→현실 조언 순서로 쓰세요. 관찰 근거 없이 성격이나 운세만 말하면 실패입니다.
13. 건강은 의학적 진단처럼 쓰지 말고, 얼굴에 보이는 피로감·긴장감·생활관리 주의 정도로만 표현하세요. 특정 질병 확정, 수명, 발병 나이 단정은 금지.
14. 얼굴 사진으로 실존 인물을 식별하거나 닮은 유명인을 추정하지 마세요. celebrity_resemblance는 항상 빈 문자열로 두세요.`;
}

function palmExpertRubric() {
  return `## 전문가식 손금 판독 체크리스트
아래 순서대로 먼저 관찰한 뒤 해석하세요. 실제 전문가 감수 데이터가 아니라, 전통 수상학에서 흔히 보는 판독 기준을 구조화한 것입니다.

1. 사진 품질: 손바닥 전체, 손목 쪽, 손가락 기저부, 새끼손가락 아래 측면, 초점, 조명, 손금 선명도를 먼저 판정. 품질이 낮으면 보이는 선만 해석.
2. 기준 손: 주 사용 손과 촬영 손을 비교해 후천운/선천운 기준을 정하고, summary에 그 기준을 반영.
3. 손 형태: 손바닥이 긴지 넓은지, 손가락 길이·마디·벌어짐, 엄지 각도, 손바닥 살집을 보고 기질과 행동 패턴을 해석.
4. 생명선: 엄지 주변을 감싸는 호의 깊이, 연속성, 끊김, 갈라짐, 잔가지, 시작점을 관찰. 길이를 수명으로 단정하지 말고 활력·회복력·생활 리듬으로 해석.
5. 두뇌선: 시작점이 생명선과 붙는지 떨어지는지, 길이, 기울기, 끊김을 보고 판단 방식·집중력·충동성을 해석.
6. 감정선: 새끼손가락 아래에서 시작해 어디로 향하는지, 곡선/직선, 사슬형/섬/끊김을 보고 애정 표현·상처 처리·집착/거리감을 해석.
7. 운명선/태양선: 손바닥 중앙 세로선과 약지 아래 세로선을 분리해 보고, 선명하지 않으면 "희미/확인 어려움"으로 처리. 없는 선을 만들지 마세요.
8. 결혼선: 새끼손가락 아래 측면이 사진에 보이지 않으면 대부분 확인 어렵습니다. 정면 손바닥 사진만으로 결혼선 수를 단정하지 마세요.
9. 관찰→전통 해석→현실 조언 순서로 쓰세요. 건강은 의학적 진단처럼 쓰지 말고 생활관리 주의와 검진 권장 정도로만 표현하세요. 특정 질병 확정, 사고 시기 단정은 금지.`;
}

async function handleFaceReading(request, env, requestId = '', analysisGateError = null, analysisContext = {}) {
  const oversizedRequest = getOversizedPhotoRequestError(request);
  if (oversizedRequest) return oversizedRequest;
  let body;
  try { body = await request.json(); } catch (_) {}
  if (!isPlainAiObject(body)) return json({ error: getKarmaTextAnalysisMessage(/^en\b/i.test(request.headers.get('Accept-Language') || '') ? 'en' : 'ko', 'invalidRequest') }, 400);
  const { image, mimeType, gender, age, lang, image_hash, image_dhash } = body;
  const analysisLang = normalizePhotoAnalysisLang(lang);
  const photoInput = validatePhotoImageInput(image, mimeType, analysisLang);
  if (photoInput.error) return json({ error: photoInput.error }, photoInput.status || 400);

  const analysisInput = { gender: gender || '', age: age || '', lang: analysisLang };
  let photoBytes;
  let r2Key;
  try {
    photoBytes = decodeBase64Bytes(photoInput.image);
    r2Key = await saveKarmaAnalysisImageToR2(env, {
      image: photoInput.image,
      bytes: photoBytes,
      mimeType: photoInput.mimeType,
      analysisType: 'face',
      requestId,
    });
    analysisContext.r2Key = r2Key;
  } catch (error) {
    console.error('[KarmaAnalysis] required face image save failed:', error?.message || error);
    return json({ error: getPhotoAnalysisMessage(analysisLang, 'imageStorageFailed') }, 503);
  }

  if (analysisGateError) {
    const localizedGate = await localizePhotoAnalysisGateError(analysisGateError, analysisLang);
    await recordKarmaImageAnalysis(env, {
      requestId,
      r2Key,
      analysisType: 'face',
      status: 'error',
      input: analysisInput,
      result: localizedGate.result,
      errorMessage: localizedGate.errorMessage,
      aiService: 'NOT_CALLED',
    });
    return localizedGate.response;
  }

  if (!env?.AI?.analyze) {
    const errorMessage = getPhotoAnalysisMessage(analysisLang, 'serviceUnavailable');
    await recordKarmaImageAnalysis(env, {
      requestId,
      r2Key,
      analysisType: 'face',
      status: 'error',
      input: analysisInput,
      result: { error: errorMessage },
      errorMessage,
      aiService: 'NOT_CALLED',
    });
    return json({ error: errorMessage }, 503);
  }

  const imageHash = await hashKarmaBytesSha256(photoBytes);
  const photoDims = extractPhotoDimensions(photoBytes, photoInput.mimeType);
  const serverAspect = photoDims ? computeAspectBucket(photoDims.width, photoDims.height) : 0;
  const parsedDhash = parsePerceptualDhash(image_dhash);
  const validPerceptualHash = parsedDhash && (!serverAspect || !parsedDhash.aspect || Math.abs(serverAspect - parsedDhash.aspect) <= 2)
    ? parsedDhash.hex
    : '';
  const resolvedAspect = serverAspect || parsedDhash?.aspect || 0;
  const faceCacheOpts = {
    gender: normalizeKarmaGenderKey(gender),
    age: normalizeKarmaAgeKey(age),
    lang: analysisLang,
    // 관상 프롬프트·후처리 규칙이 바뀌어 예전 캐시 결과를 다시 쓰면 안 될 때 올린다(관상 캐시만 새로 만든다).
    rev: KARMA_FACE_RESULT_REVISION,
  };
  const faceOptionsKey = JSON.stringify({ ...faceCacheOpts, aspect: resolvedAspect });
  const faceCacheKey = await buildKarmaConsistencyCacheKey('face', { imageHash, ...faceCacheOpts });
  const faceSourceHash = normalizeHexHash64(image_hash);
  const faceSecondaryKey = faceSourceHash && faceSourceHash !== imageHash
    ? await buildKarmaConsistencyCacheKey('face', { sourceHash: faceSourceHash, ...faceCacheOpts })
    : '';
  const cachedFaceResult = await lookupKarmaPhotoConsistencyCache(env, 'face', {
    primaryKey: faceCacheKey,
    secondaryKey: faceSecondaryKey,
    optionsKey: faceOptionsKey,
    perceptualHash: validPerceptualHash,
  });
  if (cachedFaceResult) {
    analysisContext.aiCalled = true;
    await recordKarmaImageAnalysis(env, {
      requestId,
      r2Key,
      analysisType: 'face',
      status: 'success',
      input: analysisInput,
      result: cachedFaceResult,
      errorMessage: '',
    });
    return json(cachedFaceResult, 200, { 'X-Karma-Cache': 'HIT' });
  }

  const rejectionMessage = getPhotoAnalysisMessage(analysisLang, 'faceRejected');
  const prompt = `당신은 사진에서 관찰 가능한 얼굴 특징과 전통 관상 해석을 명확히 구분하는 관상 해설가입니다. 관상은 오락·자기성찰용 전통 해석이며 실제 성격, 능력, 건강, 재산, 가족관계, 미래를 판정하지 않습니다.

중요: 먼저 사진에 사람의 얼굴이 있는지 확인하세요. 얼굴이 없거나 사람이 아닌 사진이면 반드시 다음 JSON만 반환:
{"error": ${JSON.stringify(rejectionMessage)}}

얼굴이 확인되면 관상 감정 진행.
${gender ? `성별: ${gender}` : ''}${age ? `, 나이대: ${age}` : ''}

${faceExpertRubric()}

## 외모 매력과 스타일
- appearance에는 매력 유형 키워드 2~3개, 눈에 띄는 매력 포인트 2~3개와 관찰 근거, 이목구비 조화, 사진 속 첫인상, 스타일 제안을 작성하세요. 관상 운세와 구분하고 외모 순위·백분위·점수는 만들지 마세요. 첫인상은 표정과 형태가 만드는 시각적 분위기로만 설명하고 실제 성격이나 타인의 호감을 단정하지 마세요.
- 성별은 사용자가 선택한 값만 사용하세요. 사진으로 성별을 추정하지 말고 매력 유형을 성별 고정관념에 맞추지 마세요. 헤어·액세서리·사진 각도는 보이는 얼굴형과 비율에 맞춰 구체적으로 제안하세요. style.accessories는 어울리는 액세서리가 있을 때만 종류·크기·형태와 이유를 쓰고, 근거가 없으면 빈 문자열로 두세요. 안경은 필수 항목이 아닙니다. 눈썹·눈매·얼굴 폭에 어울리는 프레임을 설명할 수 있을 때만 액세서리의 한 선택지로 제안하세요. 모두에게 얇은 메탈 프레임을 권하지 말고 glasses 키를 생성하지 마세요.
- ${['여성', 'female'].includes(gender) ? '여성 선택: style.makeup에 눈매에 맞는 아이라인·눈썹 표현과 립·블러셔 색상 제안을 포함하세요. personal_color와 색상 제안이 서로 맞아야 합니다. style.grooming은 필요 없으면 빈 문자열입니다.' : ['남성', 'male'].includes(gender) ? '남성 선택: style.grooming에 눈썹 정리·구레나룻·수염선처럼 얼굴선에 맞는 선택지를 제안하세요. 보이지 않는 수염 상태를 만들어내지 마세요. style.makeup은 빈 문자열입니다.' : '성별 미선택: 성별을 전제하지 않는 헤어·액세서리·사진 각도를 제안하세요. style.makeup과 style.grooming은 필요 없으면 빈 문자열입니다.'}
- 나이대에 맞는 일상적인 스타일을 제안하세요. 원하는 인상을 기준으로 상대적으로 덜 드러나는 부위나 아쉬운 비율을 구체적으로 설명하되, 이를 객관적인 결함이나 반드시 고칠 문제로 규정하지 마세요. 과장된 찬사, 살을 빼거나 피부색을 바꾸라는 권유는 하지 마세요.

## 성인 항목
- 선택한 나이가 20세 미만이거나 나이를 알 수 없으면 adult_subject는 false, sex_appeal은 빈 문자열, cosmetic_consultation은 빈 배열로 두세요.
- 성인 조건을 충족해도 사진 속 인물이 미성년자로 보이거나 성인인지 불확실하면 adult_subject는 false로 두고 두 성인 항목을 비우세요. 확실한 성인일 때만 true입니다.
- adult_subject가 true일 때 sex_appeal은 가장 눈에 띄는 눈빛·눈매·입술선·미소 중 실제로 보이는 1~2개를 골라, 그 형태가 만드는 인상과 그 부위를 살릴 표정·시선·각도를 2~3문장으로 씁니다. 첫 문장은 눈꼬리 방향, 눈의 가로 길이, 입술의 볼륨, 입꼬리 곡선처럼 보이는 형태를 짚습니다. 형태 없이 "우아하다", "분위기가 좋다"만 쓰지 마세요. 노골적인 묘사, 행동·경험·취향 추정, 점수나 상대의 호감 단정은 하지 마세요.
- cosmetic_consultation은 얼굴 인상을 바꾸고 싶을 때 비교할 성형·시술 상담 후보입니다. 중심은 눈·눈썹·코·입술·턱선·광대·이마·얼굴 윤곽처럼 형태와 비율이 드러나는 얼굴 부위입니다. 먼저 사진에서 상대적으로 덜 드러나거나 비율상 아쉬울 수 있는 지점을 정확히 짚고, 어떤 인상을 원할 때 바꿔 볼 부분인지 goal에 명시하세요. 사진에 보이지 않는 피부 탄력·근육 기능·조직 두께를 진단하거나 현재 모습을 결함으로 규정하지 마세요. 관찰 근거와 구체적인 조정 목표가 있는 얼굴 부위를 최대 2개까지 배열의 앞쪽에 쓰고, 그런 부위가 없으면 빈 배열로 두세요. 얼굴 부위 후보를 피부 항목으로 대신하지 마세요.
- 피부 관리 항목은 얼굴 부위 후보에 덧붙이는 보조 항목입니다. "피부 (기색)" 항목의 rubric에서 condition을 2 이하로 판정했고 사진에서 여드름·트러블, 심한 붉은기, 거친 피부결, 두드러진 모공·잡티가 뚜렷하게 보일 때만 cosmetic_consultation의 마지막에 피부 관리 항목(한국어 응답 시 area: "피부 관리", 영어 응답 시 area: "Skin care")을 1개 추가하세요. condition이 3 이상이거나 피부가 대체로 깨끗하다고 서술했다면 피부 관리 항목을 쓰지 마세요. 탄력 유지·톤 정돈·예방 같은 일반 관리 목적, 조명·화질 때문에 피부만 흐리게 보이는 경우도 쓰지 않습니다. 이 항목의 options에는 관찰된 피부 고민에 맞는 피부과 시술·관리 후보(예: 여드름·모공 스케일링 및 진정 관리, 레이저 토닝, 피코 프락셀, 홍조·혈관 레이저, 스킨부스터, 필링 등) 1~2개를 구체적인 명칭(name), 목적(purpose), 진찰 시 확인 사항(caution)과 함께 제시하세요. 피부 관리 항목이 포함될 때는 얼굴 부위 상담 후보 최대 2개에 피부 관리 1개를 더해 최대 3개까지 작성할 수 있으며, 피부 관리 항목은 2개 이상 쓰지 않습니다.
- cosmetic_consultation과 각 항목의 options는 JSON 배열입니다. 배열 전체를 따옴표로 감싼 문자열로 반환하지 마세요.
- 각 항목의 options에는 실제 수술·시술 명칭(name), 그 방법이 목표 부위의 어느 모양·비율을 바꾸기 위한 것인지(purpose), 진찰에서 확인할 조건 또는 핵심 위험(caution)을 가진 후보 1~2개를 적으세요. "어떤 시술이 가능한가요" 같은 질문만 쓰면 불완전한 결과입니다. 명칭 없이 "눈가 개선", "탄력 시술"로 뭉뚱그리지 마세요. 후보는 정보 제공을 위한 비교 대상이며 이 사진의 사람에게 적합하거나 필요하다고 판정하거나 결과·회복 기간을 보장하지 마세요. 보이는 특징만으로 질환이나 수술 적응증을 추정하지 마세요.
- question은 제시한 후보와 원하는 변화에 대해 전문의에게 확인할 한 가지 구체적인 질문입니다. observation에는 실제 보이는 폭·길이·선·비율, goal에는 원하는 변화, options에는 방법과 목적을 나눠 적고 같은 말을 반복하지 마세요. 안내 문구는 화면에서 한 번 보여주므로 각 문장을 "전문의에게 상담하세요"로 끝내지 마세요.
- observation은 현재 보이는 특징만 씁니다. "입체감을 살리면 더 세련되어진다" 같은 제안을 관찰인 것처럼 쓰지 마세요. goal도 "조화롭고 세련되게"로 끝내지 말고 어느 선을 덜 강조하거나 어느 부위가 더 드러나게 하려는지 밝히세요. 정면 사진 하나에서 측면 돌출 정도를 확정하지 마세요.
- alternative에는 해당 부위의 인상을 달리 보여 줄 헤어·메이크업·안경·촬영 각도 중 하나만 구체적으로 제안하세요. 마사지·표정 운동·스트레칭·홈케어·기기·제품으로 탄력이나 얼굴 구조를 바꿀 수 있다는 설명은 쓰지 마세요.

## 사진 기반 퍼스널 컬러
- 피부에 비친 색감과 눈·머리카락의 명도 대비를 관찰해 계절과 웜·쿨·중립 계열을 잠정 제안하세요. 피부 밝기를 매력의 우열로 평가하지 말고 성별·인종으로 색을 정하지 마세요.
- 조명 색, 필터, 염색, 메이크업, 노출 때문에 판별하기 어려우면 season과 undertone을 undetermined로 두세요. 확실한 진단이나 신뢰도 수치를 만들지 마세요. limitation에는 사진의 구체적인 한계와 자연광에서 색을 비교할 방법을 설명하세요.
- colors는 옷·액세서리로 비교해 볼 색 3~5개이며 name은 응답 언어의 색 이름, hex는 #RRGGBB 형식입니다. 판별이 어려워도 비교용 색을 제안하되 styling_tip에 비교용임을 밝히세요. 여성 메이크업 색과 남성 의류·안경 색 등 선택한 스타일과 연결하세요.
- season, undertone의 열거값과 hex는 기계 판독용이므로 번역하지 마세요. 나머지 설명과 색 이름만 요청 언어로 작성하세요.

## 사진별 차별화 필수
- 먼저 사진에서 실제로 보이는 특징을 관찰하고, 그 특징을 모든 해석의 근거로 사용하세요.
- JSON의 첫 항목인 \`forehead_observation.observation\`에 양쪽 눈썹과 그 위 피부, 머리카락 또는 천의 경계 위치를 먼저 묘사한 다음 boolean을 작성하세요. \`skin_visible\`은 눈썹 위 이마 피부가 일부라도 보이면 true이며 이마 피부가 전혀 보이지 않을 때만 false입니다. \`hairline_visible\`은 머리카락 시작 경계가 보이는지를 뜻하는 별개 값입니다. \`limitation\`에는 가려진 정확한 위치와 원인만 쓰고 제한이 없으면 빈 문자열을 쓰세요. 두건·모자가 있다는 사실만으로 skin_visible을 false로 정하지 마세요. 일부 노출을 전체 가림으로 표현하면 관찰 오류입니다.
- \`quality_assessment\`, \`visual_evidence\`, 이마 설명은 이 관찰과 일치해야 합니다. 피부가 보이고 헤어라인만 안 보이면 "이마가 안 보인다"고 쓰거나 이마 전체에 관찰 불가 감점을 적용하지 마세요.
- \`visual_evidence\`에는 사진에서 확인한 구체 관찰값을 8개 이상 넣으세요. 예: 이마 노출/폭, 눈매 방향, 눈썹 간격, 콧대와 코끝, 입술 두께, 턱선, 광대, 피부결/트러블/기색, 얼굴형, 좌우 비대칭, 조명/가림 여부.
- 각 \`categories.desc\`의 첫 문장은 반드시 해당 부위의 실제 관찰 특징으로 시작하세요. 관찰 없이 성격·운세부터 말하지 마세요.
- 부위의 형태 대부분을 실제로 관찰할 수 없을 때만 해당 부위의 설명에 "사진상 확인 어려움"과 구체 원인을 쓰세요. 부분 가림은 보이는 특징을 먼저 설명하고 확인할 수 없는 특징만 한정하세요.
- 이마·눈·코·입·턱/광대·피부(기색) 순서의 첫 여섯 항목은 반드시 각 부위의 구조화 채점표 \`rubric\`(\`structure\`, \`symmetry\`, \`condition\`, \`visibility\`)을 먼저 관찰 기준으로 판정하세요. 서버가 이 \`rubric\` 값을 가중·보정 공식으로 계산해 첫 여섯 항목의 최종 \`score\`(전체 사람을 대상으로 한 절대값 30~96 정수, 평균 기준 64~68)를 확정·잠금합니다. 임의로 점수를 먼저 정하거나 한 사람 안에서 억지로 점수 차이를 벌리지 마세요. 여섯 부위가 모두 뛰어나면 모두 4~5등급으로 높게, 모두 부족하면 모두 1~2등급으로 낮게 있는 그대로 절대평가하세요.
  * \`structure\` (1~5 정수): 해당 부위의 골격·비율·폭·길이·입체감 정돈도 (5=매우 반듯하고 이상적인 비율·윤곽, 4=안정적이고 조화로운 형태, 3=평범한 일반 평균 수준, 2=과소·과다·비율 아쉬움 뚜렷, 1=윤곽 함몰·비율 불균형 심함)
  * \`symmetry\` (1~5 정수): 좌우 대칭과 인접 이목구비와의 간격·위치 균형 (5=좌우 대칭 및 비율 간격 매우 고름, 4=미세 차이 외 전반적으로 균형, 3=일상적인 미세 비대칭 수준, 2=눈·광대·코끝·입꼬리 등 좌우 차이·틀어짐 뚜렷, 1=비대칭·편차 심함)
  * \`condition\` (1~5 정수): 살결·피부결·윤기·안색·긴장도·생기 (5=매우 맑고 매끈하며 생기가 또렷함, 4=깨끗하고 정돈된 인상, 3=평범한 생활감, 2=다크서클·건조·거친 결·트러블·홍조·잡티·피로감 뚜렷, 1=심한 트러블·염증·흉터·극심한 칙칙함). 특히 피부(기색) 항목에서 여드름·트러블·홍조·거친 모공/결이 보이면 \`condition\`을 2 이하로 평가하세요.
  * \`visibility\` (0~3 정수): 사진에서 해당 부위가 실제로 관찰 가능한 정도 (3=부위 전체와 경계까지 선명히 보임, 2=핵심 형태·피부는 보이나 헤어라인 일부 가림·가벼운 그림자/보정 한계 있음 — 이마 피부가 보이고 헤어라인만 안 보이면 반드시 2로 두고 일괄 감점하지 마세요, 1=상당 부분 가려졌거나 심한 흐림·역광으로 일부 윤곽만 겨우 추론 가능, 0=완전히 가려져 형태 확인 불가 — 이 경우에만 "사진상 확인 어려움"으로 판정)
- \`score\`는 위 \`rubric\` 평가 수준과 일치하는 30~96 정수로 함께 제시하세요(매우 뛰어남 88~96, 우수함 75~87, 보통·아쉬움 60~74, 뚜렷한 약점·불균형·트러블·가림 30~59). 설명에는 점수의 근거와 약점·걸림돌을 직설적으로 포함하세요. 같은 사진의 같은 관찰은 항상 동일한 \`rubric\` 단계와 평가를 받아야 합니다.
- 점수 예시는 제공하지 않습니다. 미리 정한 대표 숫자나 구간에서 고르거나 점수 차이를 만들려고 임의로 흩뜨리지 마세요.
- 아래 예시 문구를 그대로 베끼지 마세요. 실제 사진 특징이 다르면 요약·점수도 달라져야 합니다.
- summary, fortune, advice는 각각 \`visual_evidence\`의 실제 관찰값 1개 이상과 연결하세요. 관찰값과 연결되지 않는 운세 문장은 삭제하거나 더 구체화하세요.
- 종합 점수·등급과 일곱 번째 전체 인상 점수는 서버가 첫 여섯 부위(이마·눈·코·입·턱/광대·피부) 점수의 산술평균을 반올림해서 계산합니다. \`overall_score\`, \`overall_grade\`, 일곱 번째 \`score\`를 생성하지 마세요. 종합 점수를 먼저 정한 뒤 부위 점수를 맞추지 마세요.

## 정확성 원칙
- 점수는 사진 품질과 해당 부위의 가시성, 전통 관상 기준의 균형을 요약하는 오락용 지표입니다. 사람의 가치나 능력 점수가 아닙니다.
- 관찰 가능한 형태를 성격 결함, 부모덕, 범죄성, 지능, 건강 상태, 부유함과 직접 연결하지 마세요. 전통적으로 어떤 상징으로 읽는지 조건부로 설명하세요.
- 재물·관계·생활관리 항목은 선택을 돌아볼 질문으로 바꾸고 의학·법률·재무 사실이나 미래 시점을 만들지 마세요.
- 얼굴 사진으로 실존 인물을 식별하거나 닮은 유명인을 추정하지 말고 celebrity_resemblance는 항상 빈 문자열로 반환하세요.

## 분석 항목
1. 이마(천정) - 지혜, 초년운, 부모덕
2. 눈(눈매) - 성격 민낯, 대인관계, 의심·질투 여부
3. 코(준두) - 재물운, 자존심, 돈 모이는지 새는지
4. 입(입술) - 언변, 식복, 말로 손해 보는지
5. 턱/광대 - 의지력, 중년~말년운, 말년 고독 여부
6. 피부(기색) - 피부결, 윤기, 트러블·홍조·잡티 여부, 현재 컨디션과 생활 리듬
7. 전체 인상 - 종합 관상

반드시 아래 JSON 형식으로만 응답. 첫 여섯 categories의 rubric과 score에 적힌 null은 형식 자리표시자이므로 반드시 실제 관찰에 근거한 정수로 바꾸세요. boolean 자리표시자도 사진에 맞게 true 또는 false로 바꾸세요:
{
  "forehead_observation": {
    "observation": "(눈썹 위 이마 피부의 실제 노출 범위와 보이는 형태)",
    "limitation": "(확인할 수 없는 정확한 영역과 원인. 없으면 빈 문자열)",
    "skin_visible": null,
    "hairline_visible": null
  },
  "quality_assessment": "(사진 품질, 정면성, 가림/조명/보정 여부. 분석 한계가 있으면 명시)",
  "visual_evidence": ["(사진에서 확인한 구체 특징 1)", "(사진에서 확인한 구체 특징 2)", "(최소 8개)"],
  "summary": "(한줄 요약. 가장 뚜렷한 관찰 2개와 전통적 상징을 구분해 설명. 실제 인생사 단정 금지)",
  "categories": [
    {"name": "이마 (천정)", "rubric": {"structure": null, "symmetry": null, "condition": null, "visibility": null}, "score": null, "desc": "(3~4문장. forehead_observation과 일치하는 실제 형태와 rubric·점수 근거, 점수에 맞는 전통 해석의 강점 또는 약점, 점검할 행동)", "caution": "(관찰 근거에 연결된 약점 또는 주의점과 대응 행동 1~2문장. 높은 점수여도 필수. 확인 어려운 부위는 관찰 한계와 재촬영 방법)"},
    {"name": "눈 (눈매)", "rubric": {"structure": null, "symmetry": null, "condition": null, "visibility": null}, "score": null, "desc": "(3~4문장. 실제 형태와 rubric·점수 근거, 전통적인 관계 표현의 강점 또는 주의점, 대화할 때 점검할 행동)", "caution": "(관찰 근거에 연결된 약점 또는 주의점과 대응 행동 1~2문장. 높은 점수여도 필수. 확인 어려운 부위는 관찰 한계와 재촬영 방법)"},
    {"name": "코 (준두)", "rubric": {"structure": null, "symmetry": null, "condition": null, "visibility": null}, "score": null, "desc": "(3~4문장. 실제 형태와 rubric·점수 근거, 전통적인 재물관리 상징의 강점 또는 약점, 예산을 점검하는 방법)", "caution": "(관찰 근거에 연결된 약점 또는 주의점과 대응 행동 1~2문장. 높은 점수여도 필수. 확인 어려운 부위는 관찰 한계와 재촬영 방법)"},
    {"name": "입 (입술)", "rubric": {"structure": null, "symmetry": null, "condition": null, "visibility": null}, "score": null, "desc": "(3~4문장. 실제 형태와 rubric·점수 근거, 전통적인 의사표현의 강점 또는 주의점, 말할 때 점검할 행동)", "caution": "(관찰 근거에 연결된 약점 또는 주의점과 대응 행동 1~2문장. 높은 점수여도 필수. 확인 어려운 부위는 관찰 한계와 재촬영 방법)"},
    {"name": "턱/광대", "rubric": {"structure": null, "symmetry": null, "condition": null, "visibility": null}, "score": null, "desc": "(3~4문장. 실제 형태와 rubric·점수 근거, 전통적인 지속력 상징의 강점 또는 약점, 일을 이어갈 때 점검할 행동)", "caution": "(관찰 근거에 연결된 약점 또는 주의점과 대응 행동 1~2문장. 높은 점수여도 필수. 확인 어려운 부위는 관찰 한계와 재촬영 방법)"},
    {"name": "피부 (기색)", "rubric": {"structure": null, "symmetry": null, "condition": null, "visibility": null}, "score": null, "desc": "(3~4문장. 실제 피부결·윤기·트러블·붉은기·잡티·안색 관찰과 rubric·점수 근거, 전통 기색 해석의 활력·컨디션 강점 또는 약점, 수면·수분·생활 리듬에서 점검할 행동)", "caution": "(관찰된 피부 상태나 조명·보정 한계에 연결된 주의점과 대응 행동 1~2문장. 높은 점수여도 필수. 확인 어려운 경우 관찰 한계와 재촬영 방법)"},
    {"name": "전체 인상", "desc": "(3~4문장. 첫 여섯 부위의 강점과 낮은 점수의 약점 또는 관찰 한계를 요약하고 점검할 행동을 설명)", "caution": "(관찰 근거에 연결된 약점 또는 주의점과 대응 행동 1~2문장. 높은 점수여도 필수. 확인 어려운 부위는 관찰 한계와 재촬영 방법)"}
  ],
  "fortune": {
    "wealth": "(코·하관 관찰을 근거로 전통 관상에서 말하는 재물 관리 상징과 현실적인 예산 점검 질문 3~4문장. 부·손실·시기 예측 금지)",
    "career": "(이마·눈·하관 관찰을 근거로 전통 관상에서 말하는 업무 표현 경향과 현실 점검 질문 3~4문장. 능력·직업 적합성 단정 금지)",
    "love": "(눈·입·하관 관찰을 근거로 전통 관상에서 말하는 관계 표현 상징과 대화 질문 3~4문장. 실제 성격·관계 결과 단정 금지)",
    "health": "(건강운 3~4문장. 사진상 보이는 피로감·긴장감·생활관리 주의 중심. 특정 질환 확정이나 발병 나이 단정 금지)"
  },
  "advice": "(관찰 근거에 연결된 우선순위와 실행할 행동 2~3문장. 막연한 격언이나 필연적인 운명 단정 금지)",
  "celebrity_resemblance": "",
  "appearance": {
    "types": ["(사진에서 느껴지는 매력 유형)", "(또 다른 매력 유형)"],
    "highlights": [{"feature": "(부위)", "description": "(눈에 띄는 특징과 이유)"}, {"feature": "(다른 부위)", "description": "(관찰 근거)"}],
    "harmony": "(얼굴형과 이목구비 비율이 만드는 인상)",
    "first_impression": "(사진 속 표정과 형태가 만드는 분위기)",
    "style": {"hair": "(가르마·기장·볼륨 위치와 얼굴 비율상의 이유)", "accessories": "(어울리는 액세서리의 종류·크기·형태와 이유. 안경은 어울릴 때만 포함. 제안 근거가 없으면 빈 문자열)", "photo": "(시선·턱 방향·입매 중 바꿔 볼 행동과 강조되는 특징)", "makeup": "(여성 선택 시 메이크업 제안, 해당 없으면 빈 문자열)", "grooming": "(남성 선택 시 눈썹·수염선 등 제안, 해당 없으면 빈 문자열)"},
    "adult_subject": null,
    "sex_appeal": "(항상 작성: 가장 눈에 띄는 부위 하나의 실제 형태, 그 형태가 만드는 인상, 그 부위를 살릴 표정·시선·각도를 2~3문장으로.)",
    "cosmetic_consultation": [{"area": "(관찰한 얼굴 부위)", "observation": "(덜 드러나는 선이나 상대적인 폭·길이·비율과 사진의 한계)", "goal": "(어떤 인상을 원할 때 어느 부분을 어떻게 바꾸려는지)", "options": [{"name": "(비교할 실제 수술·시술 명칭)", "purpose": "(해당 방법으로 바꾸려는 구체적인 모양·비율. 개인의 결과 보장 금지)", "caution": "(이 후보를 비교할 때 진찰에서 확인할 조건 또는 핵심 위험)"}], "question": "(이 후보와 원하는 변화에 대해 진찰에서 확인할 구체적인 질문)", "alternative": "(같은 부위의 인상을 달리 보여 줄 헤어·메이크업·액세서리·촬영 각도 중 하나, 홈케어 금지)"}]
  },
  "personal_color": {
    "season": "(spring/summer/autumn/winter/undetermined 중 하나)",
    "undertone": "(warm/cool/neutral/undetermined 중 하나)",
    "observation": "(사진에 보이는 색감과 명도 대비, 잠정 제안 이유)",
    "limitation": "(사진의 한계와 자연광에서 비교하는 방법)",
    "colors": [{"name": "(색 이름)", "hex": "(#RRGGBB)"}, {"name": "(색 이름)", "hex": "(#RRGGBB)"}, {"name": "(색 이름)", "hex": "(#RRGGBB)"}],
    "styling_tip": "(추천 색을 옷·안경·메이크업에 적용하거나 비교할 방법)"
  }
}` + langInstruction(analysisLang);

  const imageUrl = `data:${photoInput.mimeType};base64,${photoInput.image}`;
  const result = await callKarmaVisionAi(prompt, imageUrl, env, analysisLang, 'face', { gender, age }, analysisContext);
  if (!result) {
    const errorMessage = getPhotoAnalysisMessage(analysisLang, 'faceAnalysisFailed');
    await recordKarmaImageAnalysis(env, {
      requestId,
      r2Key,
      analysisType: 'face',
      status: 'error',
      input: analysisInput,
      result: { error: errorMessage },
      errorMessage,
    });
    return json({ error: errorMessage }, 500);
  }
  if (result._apiError) {
    await recordKarmaImageAnalysis(env, {
      requestId,
      r2Key,
      analysisType: 'face',
      status: 'error',
      input: analysisInput,
      result: isPlainAiObject(result._keptResponse) ? result._keptResponse : { error: result._apiError },
      errorMessage: result._apiError,
    });
    return json({ error: result._apiError }, 500);
  }
  if (result.error) {
    const localizedResult = { ...result, error: rejectionMessage };
    await recordKarmaImageAnalysis(env, {
      requestId,
      r2Key,
      analysisType: 'face',
      status: 'rejected',
      input: analysisInput,
      result: localizedResult,
      errorMessage: rejectionMessage,
    });
    return json({ error: rejectionMessage }, 400);
  }
  await storeKarmaPhotoConsistencyCache(env, 'face', result, {
    primaryKey: faceCacheKey,
    secondaryKey: faceSecondaryKey,
    optionsKey: faceOptionsKey,
    perceptualHash: validPerceptualHash,
  });
  await recordKarmaImageAnalysis(env, {
    requestId,
    r2Key,
    analysisType: 'face',
    status: 'success',
    input: analysisInput,
    result,
    errorMessage: '',
  });
  return json(result, 200, { 'X-Karma-Cache': 'MISS' });
}

async function handlePalmReading(request, env, requestId = '', analysisGateError = null, analysisContext = {}) {
  const oversizedRequest = getOversizedPhotoRequestError(request);
  if (oversizedRequest) return oversizedRequest;
  let body;
  try { body = await request.json(); } catch (_) {}
  if (!isPlainAiObject(body)) return json({ error: getKarmaTextAnalysisMessage(/^en\b/i.test(request.headers.get('Accept-Language') || '') ? 'en' : 'ko', 'invalidRequest') }, 400);
  const { image, mimeType, hand, dominant, gender, lang, image_hash, image_dhash } = body;
  const analysisLang = normalizePhotoAnalysisLang(lang);
  const photoInput = validatePhotoImageInput(image, mimeType, analysisLang);
  if (photoInput.error) return json({ error: photoInput.error }, photoInput.status || 400);

  const analysisInput = {
    hand: hand || '',
    dominant: dominant || '',
    gender: gender || '',
    lang: analysisLang,
  };
  let photoBytes;
  let r2Key;
  try {
    photoBytes = decodeBase64Bytes(photoInput.image);
    r2Key = await saveKarmaAnalysisImageToR2(env, {
      image: photoInput.image,
      bytes: photoBytes,
      mimeType: photoInput.mimeType,
      analysisType: 'palm',
      requestId,
    });
    analysisContext.r2Key = r2Key;
  } catch (error) {
    console.error('[KarmaAnalysis] required palm image save failed:', error?.message || error);
    return json({ error: getPhotoAnalysisMessage(analysisLang, 'imageStorageFailed') }, 503);
  }

  if (analysisGateError) {
    const localizedGate = await localizePhotoAnalysisGateError(analysisGateError, analysisLang);
    await recordKarmaImageAnalysis(env, {
      requestId,
      r2Key,
      analysisType: 'palm',
      status: 'error',
      input: analysisInput,
      result: localizedGate.result,
      errorMessage: localizedGate.errorMessage,
      aiService: 'NOT_CALLED',
    });
    return localizedGate.response;
  }

  if (!env?.AI?.analyze) {
    const errorMessage = getPhotoAnalysisMessage(analysisLang, 'serviceUnavailable');
    await recordKarmaImageAnalysis(env, {
      requestId,
      r2Key,
      analysisType: 'palm',
      status: 'error',
      input: analysisInput,
      result: { error: errorMessage },
      errorMessage,
      aiService: 'NOT_CALLED',
    });
    return json({ error: errorMessage }, 503);
  }
  const imageHash = await hashKarmaBytesSha256(photoBytes);
  const photoDims = extractPhotoDimensions(photoBytes, photoInput.mimeType);
  const serverAspect = photoDims ? computeAspectBucket(photoDims.width, photoDims.height) : 0;
  const parsedDhash = parsePerceptualDhash(image_dhash);
  const validPerceptualHash = parsedDhash && (!serverAspect || !parsedDhash.aspect || Math.abs(serverAspect - parsedDhash.aspect) <= 2)
    ? parsedDhash.hex
    : '';
  const resolvedAspect = serverAspect || parsedDhash?.aspect || 0;
  const palmCacheOpts = {
    hand: inferHandSide(hand),
    dominant: inferHandSide(dominant),
    gender: normalizeKarmaGenderKey(gender),
    lang: analysisLang,
  };
  const palmOptionsKey = JSON.stringify({ ...palmCacheOpts, aspect: resolvedAspect });
  const palmCacheKey = await buildKarmaConsistencyCacheKey('palm', { imageHash, ...palmCacheOpts });
  const palmSourceHash = normalizeHexHash64(image_hash);
  const palmSecondaryKey = palmSourceHash && palmSourceHash !== imageHash
    ? await buildKarmaConsistencyCacheKey('palm', { sourceHash: palmSourceHash, ...palmCacheOpts })
    : '';
  const cachedPalmResult = await lookupKarmaPhotoConsistencyCache(env, 'palm', {
    primaryKey: palmCacheKey,
    secondaryKey: palmSecondaryKey,
    optionsKey: palmOptionsKey,
    perceptualHash: validPerceptualHash,
  });
  if (cachedPalmResult) {
    analysisContext.aiCalled = true;
    await recordKarmaImageAnalysis(env, {
      requestId,
      r2Key,
      analysisType: 'palm',
      status: 'success',
      input: analysisInput,
      result: cachedPalmResult,
      errorMessage: '',
    });
    return json(cachedPalmResult, 200, { 'X-Karma-Cache': 'HIT' });
  }
  const handContext = buildPalmHandContext(hand, dominant, analysisLang);

  const rejectionMessage = getPhotoAnalysisMessage(analysisLang, 'palmRejected');
  const prompt = `당신은 사진에서 관찰 가능한 손바닥 특징과 전통 수상학 해석을 명확히 구분하는 손금 해설가입니다. 손금은 오락·자기성찰용 전통 해석이며 실제 성격, 건강, 수명, 재산, 관계, 미래 사건을 판정하지 않습니다.

중요: 먼저 사진에 사람의 손바닥이 있는지 확인하세요. 손바닥이 없거나 손금이 보이지 않는 사진이면 반드시 다음 JSON만 반환:
{"error": ${JSON.stringify(rejectionMessage)}}

손바닥이 확인되면 손금 감정 진행.
${handContext}${gender ? `\n성별: ${gender}` : ''}

${palmExpertRubric()}

## 사진별 차별화 필수
- 먼저 사진에서 실제로 보이는 손바닥 특징을 관찰하고, 그 특징을 모든 해석의 근거로 사용하세요.
- \`visual_evidence\`에는 사진에서 확인한 구체 관찰값을 8개 이상 넣으세요. 예: 손바닥 폭, 손가락 길이/벌어짐, 엄지 각도, 생명선 깊이/끊김, 두뇌선 기울기, 감정선 위치, 운명선 선명도, 태양선 유무, 결혼선 가시성, 굳은살/흉터/조명/흐림 여부.
- 각 \`lines.desc\`의 첫 문장은 반드시 해당 손금의 실제 관찰 특징으로 시작하세요. 관찰 없이 운세부터 말하지 마세요.
- 보이지 않는 선은 지어내지 말고 \`length\`를 "확인 어려움"으로 두고 \`rubric.visibility\`를 0으로 설정하세요. 서버가 확인 어려운 선은 50점으로 고정 처리하고, 정면 사진 특성상 측면 결혼선 하나만 안 보이는 경우에는 그 한 줄 때문에 전체 손금 총점(overall_score)까지 일괄 깎이지 않도록 가중평균 계산에서 자동 제외합니다.
- 6개 손금 각각은 반드시 구조화 채점표 \`rubric\`(\`depth\`, \`continuity\`, \`definition\`, \`visibility\`)을 먼저 관찰 기준으로 판정하세요. 서버가 이 \`rubric\`과 \`length\` 라벨 교차 잠금 규칙을 적용해 각 선의 최종 \`score\`(전체 사람을 대상으로 한 절대값 30~96 범위, 평균 기준 64~68)와 \`overall_score\`·\`overall_grade\`를 확정·잠금합니다. 습관적으로 68점·78점 같은 고정 점수를 주거나 한 손바닥 안에서 억지로 점수 격차를 만들지 마세요. 모든 선이 깊고 좋으면 모두 높게(4~5등급) 주고, 모든 선이 얕고 흐리면 모두 낮게(1~2등급) 있는 그대로 절대평가하세요. 같은 손금 사진의 같은 관찰은 항상 동일한 \`rubric\` 단계와 평가를 받아야 합니다.
  * \`depth\` (1~5 정수): 주선의 음각 깊이·굵기·존재감 (5=매우 깊고 선명히 패임, 4=또렷하고 안정적인 깊이, 3=평균적인 일반 선, 2=얕고 가늘며 힘이 부족함, 1=매우 희미하거나 흔적만 있음·없음)
  * \`continuity\` (1~5 정수): 끊김·사슬형·섬 모양·교차 잡선 방해 없이 이어지는 정도 (5=시작부터 끝까지 매끈하고 연속적, 4=미세 잔가지 외 주선 흐름 안정적, 3=일부 약화·작은 갈라짐 있음, 2=중간 끊김·사슬형·섬·장애선 뚜렷, 1=여러 곳 끊기거나 심하게 흩어짐)
  * \`definition\` (1~5 정수): 시작점·끝점·방향·길이·고유 형태의 완성도 (5=모양과 궤적이 이상적으로 정돈됨, 4=분명하고 균형 잡힌 형태, 3=무난한 일반 형태, 2=짧거나 꺾임·흐트러짐 아쉬움, 1=궤적이 불분명하거나 형성 미약)
  * \`visibility\` (0~3 정수): 사진에서 해당 손금이 관찰 가능한 정도 (3=선 전체가 선명히 보임, 2=주요 흐름은 보이나 일부 그림자·초점/해상도 한계 있음, 1=흐리거나 빛 반사로 일부만 희미하게 추론 가능, 0=가림·측면 미노출·과노출 등으로 전혀 안 보임 — 이 경우 \`length\`를 "확인 어려움"으로 설정)
- \`length\` 선택값과 \`rubric\`은 서로 일치해야 합니다(예: \`없음\`이면 depth/definition 낮게, \`희미\`면 depth 2 이하, \`뚜렷\`·\`길다\`는 선명도와 연속성이 뒷받침될 때만 선택, 확인 불가 시 \`확인 어려움\` 및 \`visibility\` 0). \`score\`는 위 \`rubric\` 수준에 맞는 30~96 정수로 함께 제시하세요(최상급 86~96, 우수 75~85, 보통·아쉬움 60~74, 얕거나 끊김 등 약점 뚜렷 30~59).
- 주 사용 손과 촬영한 손이 같으면 후천운, 다르면 선천운 기준을 반드시 반영하세요.
- 아래 예시 문구를 그대로 베끼지 마세요. 실제 손금 특징이 다르면 요약·점수·조언도 달라져야 합니다.
- summary 첫 문장은 손 형태 또는 가장 뚜렷한 손금 1개와, 가장 약하거나 끊긴 손금(또는 확인 어려운 손금) 1개를 함께 언급해 이 손만의 강점과 걸림돌 대비를 직설적으로 만드세요.
- fortune의 wealth/career/love/health는 각각 관련 손금명 또는 손 형태 관찰값을 하나 이상 근거로 삼고, 약한 선이 시사하는 걸림돌과 주의 행동을 숨기지 말고 구체적으로 쓰세요. 근거 없이 일반 운세처럼 말하지 마세요.
- overall_score는 실제로 판독된 주요 손금(생명선·두뇌선·감정선·운명선·태양선)의 선명도·깊이·연속성과 손바닥 기세를 종합한 40~95점 기준을 따르되, 최종 overall_score와 overall_grade는 서버가 6개 lines의 가중평균(확인 어려움 제외)과 공통 등급 기준으로 확정합니다. 등급을 생성하지 마세요.

## 직설 모드 원칙
- 각 손금의 설명은 보이는 선의 위치·깊이·갈라짐 → 전통 해석에서의 강점 또는 약점 → 생활에서 점검할 행동으로 이어집니다. "기운이 좋다", "균형을 잡아라"로 끝내지 마세요. 흐린 선은 관찰 한계이지 불운의 증거가 아닙니다.
- 재물·직업·연애 항목은 해당 손금의 해석 안에서 우선할 선택과 조심할 행동을 하나씩 구체화하세요. 같은 "계획하고 소통하세요"를 분야명만 바꿔 반복하지 마세요. 보이지 않는 결혼선으로 상대 유형이나 결혼 횟수를 만들지 마세요.
- **끊긴 선·흐린 선·섬(島)·흉터**는 먼저 실제 관찰로 기록한 뒤 전통 수상학상 어떤 경향으로 보는지 설명
- 결혼선은 측면이 보여야 판단 가능. 안 보이면 확인 어렵다고 쓰고, 이혼·재혼·불륜을 단정하지 마세요.
- 건강 관련 내용은 의학적 진단이 아니라 생활관리 주의로만 표현하세요.
- 재물선이 약하면 전통 수상학의 돈 관리 상징과 현실 점검 질문으로 설명하되 실제 습관·부·손실을 단정하지 마세요.
- 점수 낮은 항목은 낮은 점수 + 직설적 설명. 평균 올리려 억지로 75+ 매기지 말 것

## 주요 손금 분석
1. 생명선 - 활력·회복력·생활 리듬
2. 두뇌선 - 사고방식·판단력·감정 컨트롤
3. 감정선 - 연애 패턴·상처·집착 성향
4. 운명선 - 직업 안정성·방황 시기
5. 태양선 - 명예·성공 가능성 (없으면 없는 대로)
6. 결혼선 - 측면이 보일 때만 관계 지속 패턴 참고
7. 손 형태 - 성격 민낯

반드시 아래 JSON 형식으로만 응답. lines의 rubric과 score, overall_score의 null은 자리표시자이므로 실제 관찰에 근거한 정수로 바꾸세요:
{
  "overall_score": null,
  "quality_assessment": "(사진 품질, 손바닥 전체 노출, 초점, 조명, 손금 선명도, 분석 한계)",
  "visual_evidence": ["(사진에서 확인한 구체 특징 1)", "(사진에서 확인한 구체 특징 2)", "(최소 8개)"],
  "summary": "(한줄 요약. 가장 뚜렷한 선 1개와 약하거나 확인 어려운 선 1개의 실제 관찰 및 전통적 상징. 사건·연령 예측 금지)",
  "lines": [
    {"name": "생명선", "rubric": {"depth": null, "continuity": null, "definition": null, "visibility": null}, "score": null, "length": "길다/보통/짧다/확인 어려움", "desc": "(3~4문장. 생명선의 실제 깊이·연속성·호 형태와 rubric·점수 이유, 점수에 맞는 강점 또는 약점, 생활 점검 행동. 질병/사고 단정 금지)", "caution": "(관찰 근거에 연결된 약점 또는 주의점과 대응 행동 1~2문장. 높은 점수여도 필수. 확인 어려운 부위는 관찰 한계와 재촬영 방법)"},
    {"name": "두뇌선", "rubric": {"depth": null, "continuity": null, "definition": null, "visibility": null}, "score": null, "length": "길다/보통/짧다/확인 어려움", "desc": "(3~4문장. 실제 선의 시작·길이·기울기와 rubric·점수 이유, 전통 해석의 강점 또는 약점, 판단할 때 점검할 행동. 정신건강 추정 금지)", "caution": "(관찰 근거에 연결된 약점 또는 주의점과 대응 행동 1~2문장. 높은 점수여도 필수. 확인 어려운 부위는 관찰 한계와 재촬영 방법)"},
    {"name": "감정선", "rubric": {"depth": null, "continuity": null, "definition": null, "visibility": null}, "score": null, "length": "길다/보통/짧다/확인 어려움", "desc": "(3~4문장. 감정선의 위치·곡선·끊김과 rubric·점수 이유, 전통 해석의 강점 또는 관계에서 주의할 점, 대화할 때 점검할 행동)", "caution": "(관찰 근거에 연결된 약점 또는 주의점과 대응 행동 1~2문장. 높은 점수여도 필수. 확인 어려운 부위는 관찰 한계와 재촬영 방법)"},
    {"name": "운명선", "rubric": {"depth": null, "continuity": null, "definition": null, "visibility": null}, "score": null, "length": "뚜렷/보통/희미/확인 어려움", "desc": "(3~4문장. 중앙 세로선의 선명도와 rubric·점수 이유, 전통 해석의 강점 또는 업무에서 주의할 점, 일할 때 점검할 행동)", "caution": "(관찰 근거에 연결된 약점 또는 주의점과 대응 행동 1~2문장. 높은 점수여도 필수. 확인 어려운 부위는 관찰 한계와 재촬영 방법)"},
    {"name": "태양선", "rubric": {"depth": null, "continuity": null, "definition": null, "visibility": null}, "score": null, "length": "있음/희미/없음/확인 어려움", "desc": "(3~4문장. 실제 가시성과 rubric·점수 이유, 전통 해석의 강점 또는 성취 표현의 약점, 성과를 알릴 때 점검할 행동. 성공 예측 금지)", "caution": "(관찰 근거에 연결된 약점 또는 주의점과 대응 행동 1~2문장. 높은 점수여도 필수. 확인 어려운 부위는 관찰 한계와 재촬영 방법)"},
    {"name": "결혼선", "rubric": {"depth": null, "continuity": null, "definition": null, "visibility": null}, "score": null, "length": "1개/2개/여러개/확인 어려움", "desc": "(3~4문장. 새끼손가락 아래 측면이 보일 때만 관찰과 rubric·점수 이유, 전통 해석의 강점 또는 주의점, 관계 점검 행동. 안 보이면 관찰 한계와 재촬영 방법만 설명)", "caution": "(관찰 근거에 연결된 약점 또는 주의점과 대응 행동 1~2문장. 높은 점수여도 필수. 확인 어려운 부위는 관찰 한계와 재촬영 방법)"}
  ],
  "hand_shape": {"type": "물형/불형/흙형/금형/나무형", "desc": "(손 형태로 본 성격 민낯 2~3문장)"},
  "fortune": {
    "wealth": "(재물 관련 선의 관찰과 전통적 돈 관리 상징, 현실 예산 점검 질문 3~4문장. 부·손실·시기 예측 금지)",
    "career": "(운명선·두뇌선 관찰과 전통적 업무 방식 상징, 현실 점검 질문 3~4문장. 직업 적합성·성공 단정 금지)",
    "love": "(연애/결혼운 3~4문장. 감정선·결혼선 가시성에 근거해 관계 방식, 맞는 상대 유형, 갈등 주의점을 경향으로 설명)",
    "health": "(건강운 3~4문장. 손의 긴장도·선명도·생활 리듬 기반 주의. 특정 질병 확정, 사고 시기 단정 금지. 필요 시 일반적 검진 권장)"
  },
  "advice": "(손금 기반 조언 3~4문장. 격언 금지. 관찰된 손금 특징에 연결해 이번 달/올해 실천할 행동을 구체적으로)"
}` + langInstruction(analysisLang);

  const imageUrl = `data:${photoInput.mimeType};base64,${photoInput.image}`;
  const result = await callKarmaVisionAi(prompt, imageUrl, env, analysisLang, 'palm', {}, analysisContext);
  if (!result) {
    const errorMessage = getPhotoAnalysisMessage(analysisLang, 'palmAnalysisFailed');
    await recordKarmaImageAnalysis(env, {
      requestId,
      r2Key,
      analysisType: 'palm',
      status: 'error',
      input: analysisInput,
      result: { error: errorMessage },
      errorMessage,
    });
    return json({ error: errorMessage }, 500);
  }
  if (result._apiError) {
    await recordKarmaImageAnalysis(env, {
      requestId,
      r2Key,
      analysisType: 'palm',
      status: 'error',
      input: analysisInput,
      result: isPlainAiObject(result._keptResponse) ? result._keptResponse : { error: result._apiError },
      errorMessage: result._apiError,
    });
    return json({ error: result._apiError }, 500);
  }
  if (result.error) {
    const localizedResult = { ...result, error: rejectionMessage };
    await recordKarmaImageAnalysis(env, {
      requestId,
      r2Key,
      analysisType: 'palm',
      status: 'rejected',
      input: analysisInput,
      result: localizedResult,
      errorMessage: rejectionMessage,
    });
    return json({ error: rejectionMessage }, 400);
  }
  await storeKarmaPhotoConsistencyCache(env, 'palm', result, {
    primaryKey: palmCacheKey,
    secondaryKey: palmSecondaryKey,
    optionsKey: palmOptionsKey,
    perceptualHash: validPerceptualHash,
  });
  await recordKarmaImageAnalysis(env, {
    requestId,
    r2Key,
    analysisType: 'palm',
    status: 'success',
    input: analysisInput,
    result,
    errorMessage: '',
  });
  return json(result, 200, { 'X-Karma-Cache': 'MISS' });
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
  const entries = Object.entries(ohangCount).sort((a, b) => b[1] - a[1]);
  const max = entries[0]?.[1] ?? 0;
  const min = entries[entries.length - 1]?.[1] ?? 0;
  for (const [key, val] of Object.entries(ohangCount)) {
    if (val >= 4) excess.push(`${key}(${val}개) 과다`);
    else if (val === 0) lack.push(`${key} 부족`);
  }
  const dominant = entries.filter(([, val]) => val === max).map(([key, val]) => `${key}(${val})`);
  const sparse = entries.filter(([, val]) => val === min).map(([key, val]) => `${key}(${val})`);
  return { excess, lack, dominant, sparse };
}

function inverseOhangRelation(map, target) {
  return Object.keys(map).find(key => map[key] === target) || '';
}

function buildSajuEvidence(saju) {
  const count = saju.ohangCount;
  const day = saju.ilganOhang;
  const resource = inverseOhangRelation(SANGSAENG, day);
  const output = SANGSAENG[day];
  const wealth = SANGGEUK[day];
  const authority = inverseOhangRelation(SANGGEUK, day);
  const peerCount = count[day] || 0;
  const resourceCount = count[resource] || 0;
  const outputCount = count[output] || 0;
  const wealthCount = count[wealth] || 0;
  const authorityCount = count[authority] || 0;
  const surfaceSupport = peerCount + resourceCount;
  const surfaceDrain = outputCount + wealthCount + authorityCount;
  const balance = surfaceSupport > surfaceDrain
    ? '표면 글자 기준 일간 지원 쪽이 우세'
    : surfaceSupport < surfaceDrain
      ? '표면 글자 기준 일간 소모·통제 쪽이 우세'
      : '표면 글자 기준 지원과 소모가 비슷함';
  const { dominant, sparse, lack } = getOhangAnalysis(count);
  return {
    resource, output, wealth, authority,
    roleLine: `비겁 ${day}${peerCount} / 인성 ${resource}${resourceCount} / 식상 ${output}${outputCount} / 재성 ${wealth}${wealthCount} / 관성 ${authority}${authorityCount}`,
    balance,
    dominant: dominant.join(', '),
    sparse: sparse.join(', '),
    missing: lack.join(', ') || '없음',
    fingerprint: `${saju.pillars.map(p => `${p.gan}${p.ji}`).join('-')}|${['목','화','토','금','수'].map(k => `${k}${count[k]}`).join('-')}|S${surfaceSupport}D${surfaceDrain}`,
  };
}

function karmaTodayKst(now = new Date()) {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getAgeAt(birthDate, targetDate) {
  if (!birthDate) return null;
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const target = typeof targetDate === 'string' ? new Date(`${targetDate}T12:00:00Z`) : targetDate;
  if (!by || Number.isNaN(target?.getTime?.())) return null;
  let age = target.getUTCFullYear() - by;
  if ((target.getUTCMonth() + 1) < bm || ((target.getUTCMonth() + 1) === bm && target.getUTCDate() < bd)) age--;
  return Math.max(0, age);
}

function getActiveDaeun(saju, birthDate, targetDate) {
  const age = getAgeAt(birthDate, targetDate);
  const daeun = age == null ? null : (saju.daeun || []).find(d => age >= d.fromAge && age <= d.toAge) || null;
  return { age, daeun };
}

function formatActiveDaeun(saju, birthDate, targetDate) {
  const { age, daeun } = getActiveDaeun(saju, birthDate, targetDate);
  if (age == null) return '출생일 미전달로 현재 대운 판별 불가';
  if (!daeun) return `만 ${age}세, 계산된 8개 대운 범위 밖`;
  return `만 ${age}세 → ${daeun.label} ${daeun.gan}${daeun.ji}(${daeun.ohang}/${daeun.jiOhang})`;
}

function buildMonthlySignals(saju, year) {
  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const sajuYear = getSajuYear(year, month, 15, 12, 0);
    const sajuMonth = getSajuMonth(year, month, 15, 12, 0);
    const yGan = yearCheongan(sajuYear);
    const gan = monthCheongan(CHEONGAN.indexOf(yGan), sajuMonth);
    const ji = monthJiji(sajuMonth);
    const rel = analyzeSajuRelations([{ name: `${month}월`, gan, ji }], saju.pillars);
    const relation = getOhangRelations(saju.ilganOhang, CHEONGAN_OHANG[gan]);
    const facts = [];
    if (relation.sangsaeng.length) facts.push(`일간과 상생 ${relation.sangsaeng.join('/')}`);
    if (relation.sanggeuk.length) facts.push(`일간과 상극 ${relation.sanggeuk.join('/')}`);
    if (relation.same) facts.push('일간과 같은 오행');
    if (rel.ganHap.length) facts.push(`천간합 ${rel.ganHap.join('/')}`);
    if (rel.jiHap.length) facts.push(`지지합 ${rel.jiHap.join('/')}`);
    if (rel.jiChung.length) facts.push(`지지충 ${rel.jiChung.join('/')}`);
    return `${month}월 중순 대표 월주 ${gan}${ji}: ${facts.join(', ') || '뚜렷한 합충 없음'}`;
  });
}

function buildHourlySignals(saju, dayGan) {
  const labels = ['23~01시','01~03시','03~05시','05~07시','07~09시','09~11시','11~13시','13~15시','15~17시','17~19시','19~21시','21~23시'];
  return labels.map((label, index) => {
    const hour = index === 0 ? 0 : index * 2;
    const pillar = hourPillar(dayGan, hour);
    const rel = analyzeSajuRelations([{ name: label, ...pillar }], saju.pillars);
    const facts = [];
    if (rel.ganHap.length) facts.push(`천간합 ${rel.ganHap.join('/')}`);
    if (rel.jiHap.length) facts.push(`지지합 ${rel.jiHap.join('/')}`);
    if (rel.jiChung.length) facts.push(`지지충 ${rel.jiChung.join('/')}`);
    return `${label} ${pillar.gan}${pillar.ji}: ${facts.join(', ') || '뚜렷한 합충 없음'}`;
  });
}

const OHANG_LUCKY_MAP = Object.freeze({
  목: Object.freeze({ color: { ko: '청록색', en: 'Teal' }, direction: { ko: '동쪽', en: 'East' }, numbers: [3, 8] }),
  화: Object.freeze({ color: { ko: '다홍색', en: 'Coral Red' }, direction: { ko: '남쪽', en: 'South' }, numbers: [2, 7] }),
  토: Object.freeze({ color: { ko: '황토색', en: 'Warm Ochre' }, direction: { ko: '중앙(남서/북동)', en: 'Center (Southwest/Northeast)' }, numbers: [5, 10] }),
  금: Object.freeze({ color: { ko: '백색', en: 'Ivory White' }, direction: { ko: '서쪽', en: 'West' }, numbers: [4, 9] }),
  수: Object.freeze({ color: { ko: '남색', en: 'Deep Navy' }, direction: { ko: '북쪽', en: 'North' }, numbers: [1, 6] }),
});

const EN_MONTH_NAMES = Object.freeze([
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

// 원국 오행 수에서 가장 부족한 오행 결정적 선택 -> 동률 시 상생·상극·인성·관성·비겁 순 우선순위 적용
function selectWeakestOhang(saju) {
  const counts = saju?.ohangCount || {};
  const ilganOhang = saju?.ilganOhang || '목';
  const tieOrder = [
    SANGSAENG[ilganOhang],
    SANGGEUK[ilganOhang],
    inverseOhangRelation(SANGSAENG, ilganOhang),
    inverseOhangRelation(SANGGEUK, ilganOhang),
    ilganOhang,
  ].filter(Boolean);
  const candidates = ['목', '화', '토', '금', '수'];
  return [...candidates].sort((a, b) => {
    const diff = (counts[a] || 0) - (counts[b] || 0);
    if (diff !== 0) return diff;
    const idxA = tieOrder.indexOf(a);
    const idxB = tieOrder.indexOf(b);
    return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
  })[0];
}

// 사주 원국·대상 연도·언어로 신년운세 행운 기준값(색·숫자·방향·최고의 달) 결정적 산출
function calculateFortuneLucky(saju, year, lang) {
  const normalizedLang = normalizeKarmaTextAnalysisLang(lang);
  const weakOhang = selectWeakestOhang(saju);
  const entry = OHANG_LUCKY_MAP[weakOhang] || OHANG_LUCKY_MAP['목'];
  const yGan = yearCheongan(year);
  const yJi = yearJiji(year);
  const ganIdx = Math.max(0, CHEONGAN.indexOf(yGan));
  const jiIdx = Math.max(0, JIJI.indexOf(yJi));
  const number = String(entry.numbers[(ganIdx + jiIdx) % 2]);

  let bestMonth = 1;
  let bestScore = -Infinity;
  for (let month = 1; month <= 12; month += 1) {
    const sajuYear = getSajuYear(year, month, 15, 12, 0);
    const sajuMonth = getSajuMonth(year, month, 15, 12, 0);
    const mYGan = yearCheongan(sajuYear);
    const gan = monthCheongan(CHEONGAN.indexOf(mYGan), sajuMonth);
    const ji = monthJiji(sajuMonth);
    const ganOhang = CHEONGAN_OHANG[gan];
    const jiOhang = JIJI_OHANG[ji];
    const rel = analyzeSajuRelations([{ name: `${month}월`, gan, ji }], saju.pillars);
    const ilRel = getOhangRelations(saju.ilganOhang, ganOhang);
    let score = 0;
    if (ganOhang === weakOhang) score += 4;
    if (jiOhang === weakOhang) score += 3;
    if (rel.ganHap.length) score += rel.ganHap.length * 4;
    if (rel.jiHap.length) score += rel.jiHap.length * 4;
    if (rel.jiChung.length) score -= rel.jiChung.length * 5;
    if (ilRel.sangsaeng.length) score += 3;
    if (ilRel.sanggeuk.length) score -= 2;
    if (score > bestScore) {
      bestScore = score;
      bestMonth = month;
    }
  }

  return {
    color: entry.color[normalizedLang],
    number,
    direction: entry.direction[normalizedLang],
    month: normalizedLang === 'en' ? EN_MONTH_NAMES[bestMonth] : `${bestMonth}월`,
  };
}

// 신년운세 AI 응답 객체에 서버 확정 행운 요소만 깨끗한 구조로 설정 -> 비객체 시 원본 그대로 반환
function normalizeFortuneLucky(ai, saju, year, lang) {
  if (!isPlainAiObject(ai)) return ai;
  const lucky = calculateFortuneLucky(saju, year, lang);
  return {
    ...ai,
    lucky: {
      color: lucky.color,
      number: lucky.number,
      direction: lucky.direction,
      month: lucky.month,
    },
  };
}

// 사주 원국·대상 날짜·언어로 오늘의 행운 기준값(색·숫자) 결정적 산출
function calculateDailyLucky(saju, todayStr, lang) {
  const normalizedLang = normalizeKarmaTextAnalysisLang(lang);
  const weakOhang = selectWeakestOhang(saju);
  const entry = OHANG_LUCKY_MAP[weakOhang] || OHANG_LUCKY_MAP['목'];
  const [tY, tM, tD] = String(todayStr || karmaTodayKst()).split('-').map(Number);
  const dp = dayPillar(tY, tM, tD);
  const ganIdx = Math.max(0, CHEONGAN.indexOf(dp.gan));
  const jiIdx = Math.max(0, JIJI.indexOf(dp.ji));
  const parity = Math.abs(ganIdx + jiIdx + (Number.isFinite(tD) ? tD : 0)) % 2;
  return {
    color: entry.color[normalizedLang],
    number: String(entry.numbers[parity]),
  };
}

// 오늘의 운세 AI 응답 객체에 서버 확정 행운 요소만 깨끗한 구조로 설정 -> 비객체 시 원본 그대로 반환
function normalizeDailyLucky(ai, saju, todayStr, lang) {
  if (!isPlainAiObject(ai)) return ai;
  const lucky = calculateDailyLucky(saju, todayStr, lang);
  return {
    ...ai,
    lucky: {
      color: lucky.color,
      number: lucky.number,
    },
  };
}

function clampCompatScore(value) {
  return Math.max(20, Math.min(96, Math.round(value)));
}

// 두 사주 원국과 생년월일로 궁합 4개 영역(성격·친밀감·재물·대운 타이밍) 절대점수 결정적 산출 (20~96 정수)
function calculateCompatCategoryScores(sajuA, sajuB, birthDateA = '', birthDateB = '', targetDate = karmaTodayKst()) {
  const infoA = CHEONGAN_INFO[sajuA.ilgan] || {};
  const infoB = CHEONGAN_INFO[sajuB.ilgan] || {};
  const yinYangDiff = Boolean(infoA.yin) !== Boolean(infoB.yin);
  const ohA = sajuA.ilganOhang;
  const ohB = sajuB.ilganOhang;
  const wholeRel = analyzeSajuRelations(sajuA.pillars, sajuB.pillars);

  let personality = 58;
  if (SANGSAENG[ohA] === ohB || SANGSAENG[ohB] === ohA) personality += 14;
  if (SANGGEUK[ohA] === ohB || SANGGEUK[ohB] === ohA) personality -= 14;
  if (ohA === ohB) personality -= 4;
  personality += yinYangDiff ? 6 : -5;
  personality += Math.min(14, wholeRel.ganHap.length * 6);
  personality += Math.min(12, wholeRel.jiHap.length * 5);
  personality -= Math.min(22, wholeRel.jiChung.length * 9);
  for (const key of Object.keys(OHANG)) {
    if ((sajuA.ohangCount[key] || 0) >= 3 && (sajuB.ohangCount[key] || 0) >= 3) {
      personality -= 6;
    }
  }

  let intimacy = 58;
  const dayA = sajuA.pillars.find(p => p.name === '일주');
  const dayB = sajuB.pillars.find(p => p.name === '일주');
  if (dayA && dayB) {
    const dayRel = analyzeSajuRelations([dayA], [dayB]);
    if (dayRel.ganHap.length) intimacy += 10;
    if (dayRel.jiHap.length) intimacy += 16;
    if (dayRel.jiChung.length) intimacy -= 20;
    const dayOhA = JIJI_OHANG[dayA.ji];
    const dayOhB = JIJI_OHANG[dayB.ji];
    if (dayOhA && dayOhB) {
      if (SANGSAENG[dayOhA] === dayOhB || SANGSAENG[dayOhB] === dayOhA) intimacy += 10;
      if (SANGGEUK[dayOhA] === dayOhB || SANGGEUK[dayOhB] === dayOhA) intimacy -= 10;
      if (dayOhA === dayOhB) intimacy += 2;
    }
  }
  intimacy += yinYangDiff ? 5 : -4;
  for (const elem of ['수', '화']) {
    const cntA = sajuA.ohangCount[elem] || 0;
    const cntB = sajuB.ohangCount[elem] || 0;
    if ((cntA === 0 && cntB >= 2) || (cntB === 0 && cntA >= 2)) intimacy += 5;
    if (cntA >= 3 && cntB >= 3) intimacy -= 6;
  }

  let finance = 58;
  const wealthA = SANGGEUK[ohA];
  const wealthB = SANGGEUK[ohB];
  const bSupportWealthA = sajuB.ohangCount[wealthA] || 0;
  const aSupportWealthB = sajuA.ohangCount[wealthB] || 0;
  if (bSupportWealthA >= 2) finance += 6;
  else if (bSupportWealthA === 0) finance -= 4;
  if (aSupportWealthB >= 2) finance += 6;
  else if (aSupportWealthB === 0) finance -= 4;
  const earthMetalSum = (sajuA.ohangCount['토'] || 0) + (sajuA.ohangCount['금'] || 0)
    + (sajuB.ohangCount['토'] || 0) + (sajuB.ohangCount['금'] || 0);
  if (earthMetalSum >= 3 && earthMetalSum <= 6) finance += 6;
  else if (earthMetalSum <= 1) finance -= 8;
  else if (earthMetalSum >= 8) finance -= 6;
  finance += Math.min(8, wholeRel.jiHap.length * 4);
  finance -= Math.min(16, wholeRel.jiChung.length * 7);

  let timing = 58;
  const activeA = getActiveDaeun(sajuA, birthDateA, targetDate).daeun;
  const activeB = getActiveDaeun(sajuB, birthDateB, targetDate).daeun;
  const scoreOwnActiveDaeun = (saju, daeun) => {
    if (!daeun) return 0;
    let delta = 0;
    for (const elem of [daeun.ohang, daeun.jiOhang].filter(Boolean)) {
      const count = saju.ohangCount[elem] || 0;
      if (count === 0) delta += 6;
      else if (count >= 3) delta -= 6;
    }
    const selfRel = analyzeSajuRelations([{ name: '대운', gan: daeun.gan, ji: daeun.ji }], saju.pillars);
    if (selfRel.jiChung.length) delta -= 7;
    return delta;
  };
  timing += scoreOwnActiveDaeun(sajuA, activeA);
  timing += scoreOwnActiveDaeun(sajuB, activeB);
  if (activeA && activeB) {
    const daeunRel = analyzeSajuRelations(
      [{ name: 'A대운', gan: activeA.gan, ji: activeA.ji }],
      [{ name: 'B대운', gan: activeB.gan, ji: activeB.ji }],
    );
    if (daeunRel.ganHap.length || daeunRel.jiHap.length) timing += 8;
    if (daeunRel.jiChung.length) timing -= 12;
    if (SANGSAENG[activeA.ohang] === activeB.ohang || SANGSAENG[activeB.ohang] === activeA.ohang) timing += 5;
    if (SANGGEUK[activeA.ohang] === activeB.ohang || SANGGEUK[activeB.ohang] === activeA.ohang) timing -= 5;
  }
  let complementBonus = 0;
  for (const key of Object.keys(OHANG)) {
    const cntA = sajuA.ohangCount[key] || 0;
    const cntB = sajuB.ohangCount[key] || 0;
    if ((cntA === 0 && cntB >= 2) || (cntB === 0 && cntA >= 2)) {
      complementBonus += 4;
    }
  }
  timing += Math.min(8, complementBonus);
  timing -= Math.min(12, wholeRel.jiChung.length * 4);

  return {
    personality: clampCompatScore(personality),
    intimacy: clampCompatScore(intimacy),
    finance: clampCompatScore(finance),
    timing: clampCompatScore(timing),
  };
}

// 궁합 AI 응답의 categories 4개 영역 점수에 서버 확정 점수를 강제 잠금
function normalizeCompatAiScores(ai, categoryScores) {
  if (!isPlainAiObject(ai) || !isPlainAiObject(categoryScores) || !isPlainAiObject(ai.categories)) return ai;
  const nextCategories = { ...ai.categories };
  for (const key of ['personality', 'intimacy', 'finance', 'timing']) {
    if (isPlainAiObject(nextCategories[key]) && Number.isInteger(categoryScores[key])) {
      nextCategories[key] = { ...nextCategories[key], score: categoryScores[key] };
    }
  }
  return { ...ai, categories: nextCategories };
}

function langInstruction(lang) {
  if (normalizeKarmaTextAnalysisLang(lang) === 'en') return '\n\nIMPORTANT: You MUST respond entirely in English. Every text value in the JSON must contain English and romanized Saju names only. Never include Hangul, Chinese characters, Korean labels, or untranslated Korean/Chinese terms.';
  return '';
}

function buildSajuPrompt(saju, gender, lang, birthDate) {
  const ilganInfo = CHEONGAN_INFO[saju.ilgan] || {};
  const { excess, lack, dominant, sparse } = getOhangAnalysis(saju.ohangCount);
  const yinYang = ilganInfo.yin ? '음(陰)' : '양(陽)';
  const genderText = gender === 'male' ? '남성' : gender === 'female' ? '여성' : '';
  const rel = analyzeInternalRelations(saju.pillars);
  const evidence = buildSajuEvidence(saju);
  const activeDaeun = formatActiveDaeun(saju, birthDate, karmaTodayKst());

  const system = `당신은 사주 원국의 계산값을 근거로 설명하는 명리 해설가입니다. 좋은 말이나 나쁜 말을 만들기보다 입력된 원국이 다른 이유를 정확히 구분하세요.

## 정확성 원칙
- 입력에 없는 과거 사건, 가족사, 질병, 이혼, 파산, 범죄, 수명과 미래 사건을 사실처럼 만들지 마세요.
- 현재 계산기는 겉으로 드러난 천간·지지 오행 수, 합·충, 대운을 제공합니다. 지장간·월령 가중치·12운성 전체가 없으므로 신강/신약, 용신, 희신을 확정하지 마세요.
- 성격·연애·직업·대운은 전통 명리 관점의 경향으로 설명하고, 의료·법률·재무 결론은 내리지 마세요.
- 시주가 없으면 hour는 빈 문자열로 두고 자녀운·말년을 추정하지 마세요.
- 각 핵심 문단에는 반드시 [근거: 실제 입력값]을 한 번 이상 표시하세요. 근거가 없으면 쓰지 마세요.

## 오행 상생/상극 기본 원리
${OHANG_RELATIONS}

## 개인화 및 냉정한 직설 원칙 (누구나 비슷한 좋은 말 위주 풀이면 실패)
- 해석의 출발점은 원국 지문, 일간 역할별 오행 수, 우세·희소 오행, 내부 합/충, 현재 대운입니다. 성별이나 일반 사주 상식만으로 결론을 만들지 마세요.
- 모든 사람을 대상으로 한 전통 명리학의 절대 기준대로 판단하세요. 억지로 좋은 말과 나쁜 말의 비율을 맞추지 마세요. 원국과 대운의 오행 균형·합충이 실제로 좋으면 좋은 대로 풀고 편중·충돌이 심하면 그 약점과 걸림돌을 있는 그대로 짚으세요.
- 듣기 좋은 칭찬으로 포장하지 마세요. 과다 오행(3개 이상)·결핍 오행(0개)·지지충·역할 편중이 만드는 성격적 약점, 인간관계 마찰, 금전·업무상의 걸림돌을 피하지 말고 각 항목에서 직설적으로 짚으세요.
- pillar_reading, personality, love_style, career, daeun_reading, advice는 각각 최소 하나 이상의 입력 근거(특정 주柱, 일간, 과다/부족 오행, 합/충, 대운 구간)를 직접 반영해야 합니다.
- strengths와 cautions는 같은 말을 긍정/부정으로 바꾼 목록이 아니어야 합니다. 서로 다른 근거에서 나온 강점 3개와 실제 발목을 잡는 치명적 약점·걸림돌 3개를 명확히 골라야 합니다.
- 항목 선택 우선순위(동일 원국 일관성 유지): strengths 3개는 천간합/지지육합→최다·우세 오행 강점→일간 고유의 강점 순서로, cautions 3개는 지지충→부족/결핍 오행→과다 오행 편중(또는 대운 충돌) 순서로 고정 선정하세요.
- daeun_reading에서도 8개 대운을 습관적으로 무난하거나 좋게 쓰지 마세요. 각 대운이 원국과 만나는 절대 기준대로 판단하여 과다 오행을 더 키우거나 일지·월지를 충하는 대운은 소모·갈등·정체가 커지는 시기로, 부족한 오행을 채우는 대운은 확장·전환 시기로 있는 그대로 구분하세요.
- 단순히 0개/4개 이상일 때만 차이를 찾지 마세요. 매번 제공된 우세·희소 오행과 십성 역할 수를 비교해 이 원국만의 대비를 잡으세요.
- 첫 문단은 원국 지문의 특정 두 신호가 함께 만드는 강점과 걸림돌을 쉬운 생활 언어로 먼저 말하고 근거를 이어 쓰세요. 다른 사주에 그대로 붙일 수 있는 문장은 삭제하세요.

## 응답 형식
반드시 아래 JSON 형식으로만 응답. 문체는 명확하고 구체적으로:
{
  "pillar_reading": {
    "year": "(년주가 전체 원국에서 맡는 역할과 전통적 초년·외부환경 경향 3~4문장. 실제 가족사를 지어내지 말 것)",
    "month": "(월주와 월지의 계절·사회 활동 경향 3~4문장. 직장 사건을 지어내지 말 것)",
    "day": "(일간·일지 관계로 본 자기표현과 가까운 관계 방식 3~4문장)",
    "hour": "(시주가 있을 때만 장기 목표·표현 경향 3~4문장. 시주 없으면 빈 문자열)"
  },
  "personality": "(서로 다른 계산 근거 2개 이상을 연결한 성향 4~5문장)",
  "strengths": ["서로 다른 근거에서 나온 강점 3가지. 각 항목에 근거 표기"],
  "cautions": ["서로 다른 근거에서 나온 주의 경향 3가지. 단정 대신 작동 조건과 대응 행동 명시"],
  "love_style": "(일간·일지·재성/관성 수를 근거로 관계의 표현·갈등·조율 방식 4~5문장)",
  "career": "(식상·재성·관성·인성의 표면 수를 비교해 잘 맞는 업무 환경 3개와 부담이 큰 환경 2개, 이유 포함)",
  "daeun_reading": ["대운 8개를 입력 순서대로 각각 2~3문장. 원국과 해당 대운 오행의 상호작용 및 준비할 행동만 설명. 사건 확정 금지"],
  "advice": "(현재 대운과 가장 희소한 역할을 근거로 지금 실행할 행동 3~4문장)"
}` + langInstruction(lang);

  const user = `## 기본 정보
${genderText ? `- 성별: ${genderText}` : ''}
${birthDate ? `- 생년월일: ${birthDate}` : ''}
- 현재 대운: ${activeDaeun}

## 사주 원국 (四柱 原局)
${saju.pillars.map(p => `- ${p.name}: ${p.gan}${p.ji} (${CHEONGAN_OHANG[p.gan]}/${JIJI_OHANG[p.ji]})`).join('\n')}

## 일간 (日干) 분석
- 일간: ${saju.ilgan} (${saju.ilganOhang}, ${yinYang})
- 일간의 본성: ${ilganInfo.desc || ''}

## 오행 분포
- 목: ${saju.ohangCount.목} | 화: ${saju.ohangCount.화} | 토: ${saju.ohangCount.토} | 금: ${saju.ohangCount.금} | 수: ${saju.ohangCount.수}
${excess.length ? `- 과다: ${excess.join(', ')}` : ''}
${lack.length ? `- 부족: ${lack.join(', ')}` : ''}
- 최다 오행: ${dominant.join(', ')}
- 최저 오행: ${sparse.join(', ')}

## 일간 기준 역할별 표면 분포
- ${evidence.roleLine}
- ${evidence.balance}
- 주의: 이 값은 지장간·월령 가중치가 없는 표면 비교이므로 신강/신약·용신을 확정하는 자료가 아님

## 사주 내부 합/충 관계 (코드로 계산된 결과)
${rel.ganHap.length ? `- 천간합: ${rel.ganHap.join(', ')}` : '- 천간합: 없음'}
${rel.jiHap.length ? `- 지지육합: ${rel.jiHap.join(', ')}` : '- 지지육합: 없음'}
${rel.jiChung.length ? `- 지지충: ${rel.jiChung.join(', ')}` : '- 지지충: 없음'}
${saju.daeun ? `
## 대운 (大運) — 10년 단위 인생 흐름
${saju.daeun.map(du => `- ${du.label}: ${du.gan}${du.ji} (${du.ohang}/${du.jiOhang})`).join('\n')}
` : ''}

## 개인화 키 (반복 방지 기준)
- 원국 지문: ${evidence.fingerprint}
- 원국 키: ${saju.pillars.map(p => `${p.name}:${p.gan}${p.ji}`).join('|')}
- 오행 키: 목${saju.ohangCount.목}-화${saju.ohangCount.화}-토${saju.ohangCount.토}-금${saju.ohangCount.금}-수${saju.ohangCount.수}
- 합충 키: 천간합=${rel.ganHap.length ? rel.ganHap.join('/') : '없음'}; 지지육합=${rel.jiHap.length ? rel.jiHap.join('/') : '없음'}; 지지충=${rel.jiChung.length ? rel.jiChung.join('/') : '없음'}`;

  return { system, user, lang };
}

function buildFortunePrompt(saju, gender, year, lang, birthDate, luckyOverride = null) {
  const ilganInfo = CHEONGAN_INFO[saju.ilgan] || {};
  const genderText = gender === 'male' ? '남성' : gender === 'female' ? '여성' : '';
  const { excess, lack, dominant, sparse } = getOhangAnalysis(saju.ohangCount);
  const evidence = buildSajuEvidence(saju);
  const activeDaeun = formatActiveDaeun(saju, birthDate, `${year}-07-01`);
  const monthlySignals = buildMonthlySignals(saju, year);
  const luckyBaseline = luckyOverride || calculateFortuneLucky(saju, year, lang);
  const yGan = yearCheongan(year);
  const yJi = yearJiji(year);
  const yOhang = CHEONGAN_OHANG[yGan];
  const yJiOhang = JIJI_OHANG[yJi];
  const ilOhang = saju.ilganOhang;
  const relations = getOhangRelations(ilOhang, yOhang);
  const yearPillar = [{ name: '세운', gan: yGan, ji: yJi }];
  const yearRel = analyzeSajuRelations(yearPillar, saju.pillars);
  const iljiPillar = saju.pillars.find(p => p.name === '일주') || {};
  const iljiOhang = iljiPillar.ji ? JIJI_OHANG[iljiPillar.ji] : '';
  const branchRelations = iljiOhang ? getOhangRelations(iljiOhang, yJiOhang) : { sangsaeng: [], sanggeuk: [], same: false };
  const branchRelDesc = [];
  if (branchRelations.sangsaeng.length) branchRelDesc.push(`상생(${branchRelations.sangsaeng.join(', ')})`);
  if (branchRelations.sanggeuk.length) branchRelDesc.push(`상극(${branchRelations.sanggeuk.join(', ')})`);
  if (branchRelations.same) branchRelDesc.push('비화(같은 오행)');
  let yearCycleIndex = 0;
  for (let i = 0; i < 60; i++) {
    if (CHEONGAN[i % 10] === yGan && JIJI[i % 12] === yJi) {
      yearCycleIndex = i;
      break;
    }
  }

  // 세운과 일간의 관계 요약
  const relDesc = [];
  if (relations.sangsaeng.length) relDesc.push(`상생(${relations.sangsaeng.join(', ')})`);
  if (relations.sanggeuk.length) relDesc.push(`상극(${relations.sanggeuk.join(', ')})`);
  if (relations.same) relDesc.push('비화(같은 오행)');

  const system = `당신은 원국·현재 대운·세운의 계산된 관계를 구분해 설명하는 명리 해설가입니다. 올해의 사건을 만들어내지 말고, 어떤 조건에서 어떤 선택이 유리하거나 부담스러운지를 근거와 함께 설명하세요.

## 절대 금지
- 입력에 없는 이별·외도·손실·퇴사·수술·질환을 일어날 사실처럼 단정
- 오행만으로 특정 장기나 질병, 투자 상품의 수익·손실, 법적 문제를 예측
- 계산되지 않은 신강/신약·용신을 확정하거나 월별 합충 근거 없이 특정 월을 좋다/나쁘다고 지정
- "전반적으로 무난", "긍정적으로 생각" 같은 재사용 가능한 문장
- 해마다 같은 결론 반복 금지. 입력의 세운 60갑자 순번, 세운-원국 합/충, 일지-세운 지지 관계를 근거로 해당 연도만의 사건·월·행운 요소를 골라라

## 개인화 및 냉정한 직설 필수 (가장 중요 — 누구나 비슷한 좋은 말이 나오면 실패다)
- 세운(올해 천간·지지)은 모든 사람이 똑같이 공유하는 값이다. 세운의 오행만 설명하는 도입부는 절대 금지(예: "올해는 ○(○) 기운이 강한 해라..." 금지).
- 해석의 출발점은 항상 **이 사람의 원국**(일간, 역할별 표면 수, 최다·최저 오행, 내부 합충)이다. 세운은 방아쇠이며 현재 대운을 함께 고려하라.
- 모든 분야(love, money, health, career)를 다 잘 풀린다고 미화하지 마라. 전체 사람들을 기준으로 한 절대적인 세운·대운 길흉에 따라 세운이 원국의 과다 오행을 더 키우거나 일지·월지를 충·상극하면 올해 가장 취약한 걸림돌과 손해 보기 쉬운 행동 패턴을 직설적으로 경고하라. 결핍 오행을 채우거나 합을 이루면 기회를 그대로 짚어라. 모든 분야가 다 충돌하면 전부 냉정하게 경고하고 모두 상생·합이면 전부 긍정 흐름으로 서술하라.
- 일간·오행 구성이 다른 두 사람은 같은 해라도 결론이 확연히 달라야 한다. 같은 세운이 어떤 역할을 늘리는지 원국 지문과 비교하라.
- year_summary 첫 문장은 올해 우선할 선택과 부담이 커질 수 있는 걸림돌 상황을 쉬운 말로 직설 제시하고, 원국의 특정 신호와 세운 또는 현재 대운의 관계를 근거로 이어 쓰세요.
- love, money, health, career, advice는 서로 다른 근거를 써야 합니다. 같은 "올해 조심" 문장을 분야명만 바꿔 반복하지 말고, 원국 오행·일지 관계·세운 합/충·대운 중 무엇을 근거로 삼았는지 문장 안에 드러내세요.
- 각 항목에 [근거: 입력 신호]를 최소 한 번 표시하세요. lucky의 월은 제공된 월별 대표 신호 중 실제 합·충 또는 일간 관계가 있는 달만 선택하세요.

## 해석 원칙
1. 세운·월운의 합충은 확정 사건이 아니라 변화 압력이 나타나는 영역과 대응 행동으로 번역하세요.
2. 월을 언급할 때는 아래 월별 대표 월주의 실제 합·충·상생·상극을 문장 안에 함께 적으세요.
3. 건강은 수면·과로·식사·스트레스 같은 일반 생활관리만 다루고 증상은 의료진에게 확인하도록 안내하세요.
4. 연애는 관계에서 나타날 수 있는 표현·갈등 패턴과 대화 방법을 설명하고 외도·이별을 예언하지 마세요.
5. 돈은 예산·계약 검토·충동지출 관리처럼 일반적인 의사결정 절차만 제안하고 종목·손실 규모를 예측하지 마세요.
6. 직장은 역할·협업·결정 속도의 경향과 준비 행동을 설명하되 승진·퇴사 확률을 만들지 마세요.

## 응답 형식
반드시 아래 JSON 형식으로만 응답:
{
  "year_summary": "(원국 지문+현재 대운+세운을 연결한 올해 흐름 4~5문장. 근거가 있는 상대적 기회 월과 점검 월 포함)",
  "love": "(일지·관성/재성 표면 수·세운 관계를 근거로 표현 방식과 갈등 조율 5~6문장)",
  "money": "(재성 표면 수·세운 관계를 근거로 소비·계약·예산 관리 포인트 5~6문장. 투자 예측 금지)",
  "health": "(원국의 과다·희소 신호를 근거로 한 일반 생활 리듬 점검 4~5문장. 진단·발병 예측 금지)",
  "career": "(식상·관성·인성 표면 수와 현재 대운·세운을 근거로 업무 방식과 준비 행동 5~6문장)",
  "lucky": {
    "color": "(올해 행운의 색)",
    "number": "(올해 행운의 숫자)",
    "direction": "(올해 행운의 방향)",
    "month": "(올해 가장 좋은 달)"
  },
  "advice": "(올해 핵심 조언 3~4문장. 근거와 실행 시점을 포함하되 결과를 위협적으로 단정하지 말 것)"
}` + langInstruction(lang);

  const user = `## 기본 정보
${genderText ? `- 성별: ${genderText}` : ''}
${birthDate ? `- 생년월일: ${birthDate}` : ''}
- 올해: ${year}년
- ${year}년 기준 현재 대운: ${activeDaeun}

## 사주 원국 (해석의 1순위 근거)
${saju.pillars.map(p => `- ${p.name}: ${p.gan}${p.ji} (${CHEONGAN_OHANG[p.gan]}/${JIJI_OHANG[p.ji]})`).join('\n')}
- 일간: ${saju.ilgan} (${ilOhang}) — ${ilganInfo.desc || ''}
- 오행 분포: 목${saju.ohangCount.목} 화${saju.ohangCount.화} 토${saju.ohangCount.토} 금${saju.ohangCount.금} 수${saju.ohangCount.수}
${excess.length ? `- 과다: ${excess.join(', ')}` : ''}
${lack.length ? `- 부족: ${lack.join(', ')}` : ''}
- 최다: ${dominant.join(', ')} / 최저: ${sparse.join(', ')}
- 일간 역할별 표면 수: ${evidence.roleLine}
- 표면 균형: ${evidence.balance} (신강/신약 확정값 아님)
${saju.daeun ? `
## 대운 흐름
${saju.daeun.map(du => `- ${du.label}: ${du.gan}${du.ji} (${du.ohang}/${du.jiOhang})`).join('\n')}
` : ''}

## ${year}년 세운 (年運 — 원국에 작용하는 방아쇠)
- 천간: ${yGan} (${yOhang})
- 지지: ${yJi} (${yJiOhang})
- 60갑자 순번: ${yearCycleIndex + 1}/60
- 세운과 일간(${saju.ilgan}, ${ilOhang})의 관계: ${relDesc.length ? relDesc.join(', ') : '특별한 관계 없음'}
- 일지(${iljiPillar.ji || '미상'}, ${iljiOhang || '미상'})와 세운 지지(${yJi}, ${yJiOhang})의 관계: ${branchRelDesc.length ? branchRelDesc.join(', ') : '특별한 관계 없음'}

## 세운-원국 합/충 (코드 계산)
- 천간합: ${yearRel.ganHap.length ? yearRel.ganHap.join(', ') : '없음'}
- 지지육합: ${yearRel.jiHap.length ? yearRel.jiHap.join(', ') : '없음'}
- 지지충: ${yearRel.jiChung.length ? yearRel.jiChung.join(', ') : '없음'}

## 월별 대표 신호 (각 양력 월 15일 정오 기준 월주, 사건 확정값 아님)
${monthlySignals.map(line => `- ${line}`).join('\n')}

## 개인화 키 (동년생/같은 해 반복 방지)
- 원국 지문: ${evidence.fingerprint}
- 원국 키: ${saju.pillars.map(p => `${p.name}:${p.gan}${p.ji}`).join('|')}
- 오행 키: 목${saju.ohangCount.목}-화${saju.ohangCount.화}-토${saju.ohangCount.토}-금${saju.ohangCount.금}-수${saju.ohangCount.수}
- 세운 키: ${year}-${yGan}${yJi}-${String(yearCycleIndex + 1).padStart(2, '0')}/60
- 관계 키: 일간관계=${relDesc.length ? relDesc.join('/') : '없음'}; 일지관계=${branchRelDesc.length ? branchRelDesc.join('/') : '없음'}; 합충=${yearRel.ganHap.concat(yearRel.jiHap, yearRel.jiChung).join('/') || '없음'}

## 서버 확정 행운 기준값 (아래 4개 값을 그대로 lucky 객체에 반영)
- color: ${luckyBaseline.color}
- number: ${luckyBaseline.number}
- direction: ${luckyBaseline.direction}
- month: ${luckyBaseline.month}`;

  return { system, user, lang };
}

function buildDailyPrompt(saju, gender, todayStr, lang, birthDate, luckyOverride = null) {
  const ilganInfo = CHEONGAN_INFO[saju.ilgan] || {};
  const genderText = gender === 'male' ? '남성' : gender === 'female' ? '여성' : '';
  const { excess, lack, dominant, sparse } = getOhangAnalysis(saju.ohangCount);
  const evidence = buildSajuEvidence(saju);
  const activeDaeun = formatActiveDaeun(saju, birthDate, todayStr);
  const ilOhang = saju.ilganOhang;
  const luckyBaseline = luckyOverride || calculateDailyLucky(saju, todayStr, lang);

  const [tY, tM, tD] = todayStr.split('-').map(Number);
  const yGan = yearCheongan(tY);
  const yJi = yearJiji(tY);
  const yOhang = CHEONGAN_OHANG[yGan];

  // 오늘의 일진 (일간지)
  const todayDP = dayPillar(tY, tM, tD);
  const todayGan = todayDP.gan;
  const todayJi = todayDP.ji;
  const todayGanOhang = CHEONGAN_OHANG[todayGan];
  const todayJiOhang = JIJI_OHANG[todayJi];
  const todayPillar = [{ name: '일진', gan: todayGan, ji: todayJi }];
  const hourlySignals = buildHourlySignals(saju, todayGan);
  const dailyRel = analyzeSajuRelations(todayPillar, saju.pillars);
  const iljiPillar = saju.pillars.find(p => p.name === '일주') || {};
  const iljiOhang = iljiPillar.ji ? JIJI_OHANG[iljiPillar.ji] : '';
  const branchRelations = iljiOhang ? getOhangRelations(iljiOhang, todayJiOhang) : { sangsaeng: [], sanggeuk: [], same: false };
  const branchRelDesc = [];
  if (branchRelations.sangsaeng.length) branchRelDesc.push(`상생(${branchRelations.sangsaeng.join(', ')})`);
  if (branchRelations.sanggeuk.length) branchRelDesc.push(`상극(${branchRelations.sanggeuk.join(', ')})`);
  if (branchRelations.same) branchRelDesc.push('비화(같은 오행)');
  let dayCycleIndex = 0;
  for (let i = 0; i < 60; i++) {
    if (CHEONGAN[i % 10] === todayGan && JIJI[i % 12] === todayJi) {
      dayCycleIndex = i;
      break;
    }
  }
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][new Date(Date.UTC(tY, tM - 1, tD)).getUTCDay()];

  const relations = getOhangRelations(ilOhang, todayGanOhang);
  const relDesc = [];
  if (relations.sangsaeng.length) relDesc.push(`상생(${relations.sangsaeng.join(', ')})`);
  if (relations.sanggeuk.length) relDesc.push(`상극(${relations.sanggeuk.join(', ')})`);
  if (relations.same) relDesc.push('비화(같은 오행)');

  const system = `당신은 개인 원국·현재 대운·오늘 일진의 계산된 관계를 구분해 설명하는 일진 해설가입니다. 실제 사건을 예언하지 말고 오늘 선택에 참고할 상대적 흐름과 행동을 근거 중심으로 안내하세요.

## 절대 금지
- 입력에 없는 싸움·분실·사고·질병·계약 실패를 오늘 발생할 사실처럼 단정
- 오행만으로 신체 부위의 증상이나 투자·결제 결과를 예측
- 시간주 근거가 없는 시간대를 임의로 좋다/나쁘다고 지정
- "긍정적으로 보내세요", "마음가짐이 중요" 같은 재사용 가능한 조언
- 매일 같은 문장 구조와 결론 반복 금지. 입력의 오늘 날짜 식별자, 60갑자 순번, 일진-원국 합/충을 근거로 날짜별로 다른 사건·시간대·행운 색·숫자를 골라라

## 개인화 및 냉정한 직설 필수 (가장 중요 — 누구나 비슷한 결과가 나오면 실패다)
- 오늘의 일진(천간·지지)은 모든 사람이 똑같이 공유하는 값이다. 일진의 오행만 설명하는 도입부는 절대 금지(예: "오늘은 ○(○) 기운이 강한 날이라..." 금지).
- 해석의 출발점은 항상 **이 사람의 원국**(일간, 역할별 표면 수, 최다·최저 오행, 합충)과 현재 대운이다. 일진이 이 지문을 어떻게 건드리는지로 풀어라.
- 6개 분야(love, money, career, study, social, health)를 습관적으로 무난하거나 좋은 말로 채우지 마라. 오늘 일진과 원국의 실제 합·충·상생·상극을 절대 기준으로 평가하라. 과다 오행을 자극하거나 충·상극을 이루는 분야는 오늘 꼬이기 쉬운 걸림돌과 감정 마찰, 지출 실수를 직설적으로 짚어라. 일진이 원국 전체와 충돌하면 전 분야를 냉정하게 경고하고 전체와 상생·합이면 좋은 흐름으로 서술하라.
- 일간·오행 구성이 다른 두 사람은 같은 날이라도 결론이 확연히 달라야 한다. 오행 과다/부족이 다르면 조심할 영역·시간대·조언이 달라진다.
- overall 첫 문장은 오늘 우선할 일이나 가장 경계해야 할 걸림돌 행동을 쉬운 말로 먼저 제시하고, 원국의 특정 신호와 오늘 일진 또는 현재 대운의 관계를 근거로 이어 쓰세요.
- love, money, career, study, social, health는 같은 경고를 분야명만 바꿔 반복하면 실패입니다. 각 항목마다 원국 오행·일지 관계·일진 합/충·요일/60갑자 순번 중 서로 다른 근거를 골라야 합니다.
- 각 항목에 [근거: 입력 신호]를 표시하세요. lucky.color와 lucky.number는 오늘 일진과 가장 희소한 표면 오행에서 도출하세요.

## 해석 원칙
1. 일진 합충은 사건 확정이 아니라 반응이 커지기 쉬운 주제와 점검 행동으로 번역하세요.
2. 시간대를 언급할 때는 아래 시간주 신호의 실제 합·충을 함께 적으세요. 신호가 없으면 정확한 시간 예측을 만들지 마세요.
3. 연애·대인관계는 말투, 속도, 경청처럼 사용자가 조절할 수 있는 행동을 제안하세요.
4. 금전은 예산 확인·결제 보류·계약 재검토 같은 일반 절차만 제안하고 손실이나 투자 성과를 예측하지 마세요.
5. 건강은 과음·과로·수면·식사 같은 일반 생활관리만 다루고 증상을 예측하지 마세요.
6. 직장·학업은 집중과 의사소통 방식의 상대적 흐름을 설명하고 실패 확률을 만들지 마세요.
7. 합/충이 없더라도 오늘 지지와 일지의 오행 관계를 반드시 해석 근거로 삼아 전날과 다른 포인트를 만든다

## 응답 형식
반드시 아래 JSON 형식으로만 응답:
{
  "overall": "(원국 지문+현재 대운+일진을 연결한 총운 3~4문장. 시간 신호가 있을 때만 상대적 편의 시간대 포함)",
  "love": "(일지와 일진 관계에 근거한 표현·대화 포인트 3~4문장. 만남·싸움 예언 금지)",
  "money": "(재성 표면 수와 일진 관계에 근거한 지출·계약 점검 3~4문장. 투자 예측 금지)",
  "career": "(관성·식상 표면 수와 일진 관계에 근거한 업무 행동 3~4문장)",
  "study": "(인성·식상 표면 수를 근거로 한 학습 방식 2~3문장)",
  "social": "(비겁과 일진 합충을 근거로 한 대화·약속 관리 2~3문장)",
  "health": "(일반적인 수면·식사·과로 관리 2~3문장. 증상·질병 예측 금지)",
  "lucky": {
    "color": "(오늘의 행운의 색)",
    "number": "(오늘의 행운의 숫자)"
  },
  "advice": "(입력 근거에 연결된 오늘의 실행 행동 1~2문장. 위협적 단정 금지)"
}` + langInstruction(lang);

  const user = `## 기본 정보
${genderText ? `- 성별: ${genderText}` : ''}
${birthDate ? `- 생년월일: ${birthDate}` : ''}
- 오늘 날짜: ${todayStr}
- 요일: ${weekday}요일
- 오늘 날짜 식별자: ${todayStr}-${todayGan}${todayJi}-${String(dayCycleIndex + 1).padStart(2, '0')}/60
- 오늘 기준 현재 대운: ${activeDaeun}

## 사주 원국 (해석의 1순위 근거)
${saju.pillars.map(p => `- ${p.name}: ${p.gan}${p.ji} (${CHEONGAN_OHANG[p.gan]}/${JIJI_OHANG[p.ji]})`).join('\n')}
- 일간: ${saju.ilgan} (${ilOhang}) — ${ilganInfo.desc || ''}
- 오행 분포: 목${saju.ohangCount.목} 화${saju.ohangCount.화} 토${saju.ohangCount.토} 금${saju.ohangCount.금} 수${saju.ohangCount.수}
${excess.length ? `- 과다: ${excess.join(', ')}` : ''}
${lack.length ? `- 부족: ${lack.join(', ')}` : ''}
- 최다: ${dominant.join(', ')} / 최저: ${sparse.join(', ')}
- 일간 역할별 표면 수: ${evidence.roleLine}
- 표면 균형: ${evidence.balance} (신강/신약 확정값 아님)
${saju.daeun ? `
## 대운 흐름
${saju.daeun.map(du => `- ${du.label}: ${du.gan}${du.ji} (${du.ohang}/${du.jiOhang})`).join('\n')}
` : ''}

## 오늘의 일진 (日辰 — 원국에 작용하는 방아쇠)
- 천간: ${todayGan} (${todayGanOhang})
- 지지: ${todayJi} (${todayJiOhang})
- 60갑자 순번: ${dayCycleIndex + 1}/60
- 오늘 일진과 일간(${saju.ilgan}, ${ilOhang})의 관계: ${relDesc.length ? relDesc.join(', ') : '특별한 관계 없음'}
- 일지(${iljiPillar.ji || '미상'}, ${iljiOhang || '미상'})와 오늘 지지(${todayJi}, ${todayJiOhang})의 관계: ${branchRelDesc.length ? branchRelDesc.join(', ') : '특별한 관계 없음'}

## 일진-원국 합/충 (코드 계산)
- 천간합: ${dailyRel.ganHap.length ? dailyRel.ganHap.join(', ') : '없음'}
- 지지육합: ${dailyRel.jiHap.length ? dailyRel.jiHap.join(', ') : '없음'}
- 지지충: ${dailyRel.jiChung.length ? dailyRel.jiChung.join(', ') : '없음'}

## 시간주-원국 신호 (두 시간 단위 대표 시주, 사건 확정값 아님)
${hourlySignals.map(line => `- ${line}`).join('\n')}

## ${tY}년 세운 (참고)
- 천간: ${yGan} (${yOhang})
- 지지: ${yJi} (${JIJI_OHANG[yJi]})

## 개인화 키 (같은 날짜 반복 방지)
- 원국 지문: ${evidence.fingerprint}
- 원국 키: ${saju.pillars.map(p => `${p.name}:${p.gan}${p.ji}`).join('|')}
- 오행 키: 목${saju.ohangCount.목}-화${saju.ohangCount.화}-토${saju.ohangCount.토}-금${saju.ohangCount.금}-수${saju.ohangCount.수}
- 일진 키: ${todayStr}-${todayGan}${todayJi}-${String(dayCycleIndex + 1).padStart(2, '0')}/60-${weekday}
- 관계 키: 일간관계=${relDesc.length ? relDesc.join('/') : '없음'}; 일지관계=${branchRelDesc.length ? branchRelDesc.join('/') : '없음'}; 합충=${dailyRel.ganHap.concat(dailyRel.jiHap, dailyRel.jiChung).join('/') || '없음'}

## 서버 확정 오늘의 행운 기준값 (아래 2개 값을 그대로 lucky 객체에 반영)
- color: ${luckyBaseline.color}
- number: ${luckyBaseline.number}`;

  return { system, user, lang };
}

function buildCompatPrompt(sajuA, sajuB, score, grade, genderA, genderB, lang, birthDateA, birthDateB, categoryScores = null) {
  const genderTextA = genderA === 'male' ? '남성' : genderA === 'female' ? '여성' : '';
  const genderTextB = genderB === 'male' ? '남성' : genderB === 'female' ? '여성' : '';
  const ilganA = CHEONGAN_INFO[sajuA.ilgan] || {};
  const ilganB = CHEONGAN_INFO[sajuB.ilgan] || {};
  const { excess: excessA, lack: lackA } = getOhangAnalysis(sajuA.ohangCount);
  const { excess: excessB, lack: lackB } = getOhangAnalysis(sajuB.ohangCount);
  const evidenceA = buildSajuEvidence(sajuA);
  const evidenceB = buildSajuEvidence(sajuB);
  const today = karmaTodayKst();
  const activeDaeunA = formatActiveDaeun(sajuA, birthDateA, today);
  const activeDaeunB = formatActiveDaeun(sajuB, birthDateB, today);
  const resolvedCategoryScores = categoryScores || calculateCompatCategoryScores(sajuA, sajuB, birthDateA, birthDateB, today);

  // 보완 관계 (완화: 차이 3 이상이면 보완으로 판정)
  const complementary = [];
  for (const key of Object.keys(sajuA.ohangCount)) {
    const diff = sajuB.ohangCount[key] - sajuA.ohangCount[key];
    if (diff >= 3) complementary.push(`B가 A의 부족한 ${key}(${sajuA.ohangCount[key]}→${sajuB.ohangCount[key]})을 보완`);
    if (diff <= -3) complementary.push(`A가 B의 부족한 ${key}(${sajuB.ohangCount[key]}→${sajuA.ohangCount[key]})을 보완`);
    if (sajuA.ohangCount[key] === 0 && sajuB.ohangCount[key] >= 2) complementary.push(`B가 A에게 없는 ${key}을 채워줌`);
    if (sajuB.ohangCount[key] === 0 && sajuA.ohangCount[key] >= 2) complementary.push(`A가 B에게 없는 ${key}을 채워줌`);
  }

  // 합/충 관계 계산
  const rel = analyzeSajuRelations(sajuA.pillars, sajuB.pillars);
  const ilganRel = getOhangRelations(sajuA.ilganOhang, sajuB.ilganOhang);
  const relDesc = [];
  if (ilganRel.sangsaeng.length) relDesc.push(`상생(${ilganRel.sangsaeng.join(', ')})`);
  if (ilganRel.sanggeuk.length) relDesc.push(`상극(${ilganRel.sanggeuk.join(', ')})`);
  if (ilganRel.same) relDesc.push('비화(같은 오행)');

  // 음양 조합 분석
  const yinYangA = ilganA.yin ? '음' : '양';
  const yinYangB = ilganB.yin ? '음' : '양';
  const yinYangMatch = yinYangA !== yinYangB; // 양+음이 이상적

  // 대운 시기 분석 데이터
  const daeunInfoA = sajuA.daeun ? sajuA.daeun.map(d => `${d.label}: ${d.gan}${d.ji}(${d.ohang}/${d.jiOhang})`).join(', ') : '정보없음';
  const daeunInfoB = sajuB.daeun ? sajuB.daeun.map(d => `${d.label}: ${d.gan}${d.ji}(${d.ohang}/${d.jiOhang})`).join(', ') : '정보없음';

  const system = `당신은 두 원국의 계산된 공통점과 차이를 설명하는 명리 궁합 해설가입니다. 점수를 미화하지 말되, 관계의 미래나 사적인 행동을 사주만으로 예언하지 마세요.

## 해석 원칙 (CRITICAL)
- **두루뭉술한 일반론 금지**. 주어진 데이터(일간, 일지, 오행 분포, 합/충, 대운)를 직접 인용
- A가 B에게 부담을 줄 수 있는 상호작용과 B가 A에게 부담을 줄 수 있는 상호작용을 각각 근거와 함께 명시
- 외도·이혼·성욕·질병·재산 손실·임신·출산 시기를 추정하거나 사실처럼 단정하지 마세요.
- 일지와 수화 비율은 전통 명리의 관계 템포 참고값일 뿐 실제 성행동·충실도·성적 지향을 판단하는 자료가 아닙니다.
- 궁합 점수는 일간·일지·전체 원국의 합충·오행 보완을 가중 합산한 서비스용 휴리스틱이며 관계 성공 확률이 아닙니다.
- 현재 대운이 판별된 경우에도 두 사람의 관계 사건을 확정하지 말고 각자가 예민해질 수 있는 주제와 대화 방법만 설명하세요.
- 각 categories.desc와 advice에 [근거: 실제 조합 신호]를 표시하세요.

## 조합별 차별화 및 절대평가 채점 필수
- summary 첫 문장은 두 사람이 실제 대화나 결정에서 맞아떨어지거나 정면으로 부딪힐 수 있는 지점을 쉬운 말로 직설적으로 짚고, A와 B의 정확한 일간/오행 관계 또는 가장 큰 합·충 하나를 근거로 이어 쓰세요. "잘 맞지만 노력 필요" 같은 관계 공통문으로 시작하면 실패입니다.
- categories의 4개 점수(personality, intimacy, finance, timing)는 모든 커플을 대상으로 한 절대값(20~96점) 기준으로 서버가 조합 계산식으로 확정한 값입니다. user의 서버 확정 영역별 점수를 그대로 score에 넣고, 각 영역의 desc 서술 톤과 강점·갈등 수위도 해당 확정 점수에 맞춰 일관되게 작성하세요. 네 영역 모두 합·상생·보완이 뛰어나면 네 영역 모두 80~96점, 상극·지지충·과다 오행 겹침이면 20~55점 수준으로 서술 수위를 맞추세요.
- 상극·지지충·과다 오행 겹침으로 점수가 낮은 영역(60점 미만)은 좋은 말로 포장하지 마세요. 누가 누구를 어떤 방식으로 지치게 하는지, 어떤 상황에서 갈등과 걸림돌이 터지는지를 가감 없이 서술하세요.
- personality, intimacy, finance, timing은 각각 서로 다른 계산 근거를 써야 합니다. 같은 충돌을 네 항목에 복사하지 말고, 일간 관계·일지/수화 비율·재성/토금 비율·현재 대운을 나눠 반영하세요.
- strengths와 cautions는 반드시 실제 조합 신호에서 뽑으세요. 오행 보완이 없는데 "서로 보완"이라고 쓰거나, 지지충이 없는데 큰 충돌처럼 꾸미지 마세요.
- advice는 이 커플만의 금지 행동과 허용 행동을 나눠 적으세요. 다른 커플에게 그대로 붙여도 말이 되면 다시 써야 합니다.

## 오행 상생/상극 원리
${OHANG_RELATIONS}

## 카테고리별 해석 지침

### 1. 성격/관계 궁합 (personality)
- 두 일간 오행 관계를 의사결정 속도·표현 방식·갈등 처리의 차이로 설명
- 지지충이 있으면 대화가 어긋날 수 있는 주제와 멈춤 규칙을 구체적으로 제안
- 한쪽이 다른 쪽을 지치게 하는 패턴을 **누가 누구를 어떻게** 지치게 하는지 명시
- 관계의 지속 여부를 단정하지 말고 유지에 도움이 되는 조건과 부담 조건을 구분

### 2. 친밀감 궁합 (intimacy)
- 일지 관계와 수/화 표면 비율을 정서적 거리, 애정 표현 속도, 함께 쉬는 방식의 전통적 경향으로만 설명
- 실제 성행동, 성욕 강도, 주도권, 외도 가능성을 추측하지 마세요.
- 합은 편안함, 충은 리듬 차이가 두드러질 수 있다는 참고로 설명하고 동의·대화·경계 확인 방법을 제안하세요.

### 3. 재물궁합 (finance)
- 재성·토금 표면 수 차이를 예산 수립과 위험 선호의 전통적 경향으로 설명하되 실제 소비 습관을 단정하지 마세요.
- 공동 계좌, 큰 계약, 가족 지원처럼 합의가 필요한 상황의 점검 질문을 제안하세요.
- 투자 성과, 파산, 손실 규모를 예측하지 마세요.

### 4. 현재 대운 궁합 (timing)
- 전체 대운을 임의로 매핑하지 말고 현재 판별된 대운 두 개를 원국과 비교하세요.
- 큰 결정을 금지하거나 관계 위기 연도를 예언하지 말고, 각자 우선순위가 달라질 수 있는 영역과 사전 합의 항목을 제안하세요.

## 응답 형식 (JSON 엄수)
반드시 아래 JSON 형식으로만 응답하세요. categories의 각 score는 0~100 정수:
{
  "summary": "(두 사람의 궁합을 한 문장으로 솔직하게. 50자 이내. 예: '초반 불타지만 3년 고비 못 넘길 조합' 같이 직설)",
  "categories": {
    "personality": { "score": 0, "desc": "(일간·합충 근거로 본 의사소통과 갈등 처리 5~7문장)" },
    "intimacy": { "score": 0, "desc": "(일지·수화 표면 비율 근거로 본 정서적 친밀감과 애정 표현 5~7문장. 성행동 추정 금지)" },
    "finance": { "score": 0, "desc": "(재성·토금 표면 수 근거로 본 공동 재무 의사결정 5~7문장. 실제 습관·성과 단정 금지)" },
    "timing": { "score": 0, "desc": "(두 사람의 현재 대운 근거로 본 우선순위와 합의 포인트 5~7문장. 사건 예언 금지)" }
  },
  "strengths": ["이 커플 강점 3가지 (각각 2문장. 과장 금지, 진짜 빛나는 지점만)"],
  "cautions": ["실제 조합 근거에서 나온 주의점 3가지. 시기·외도·이혼 예언 금지"],
  "advice": "(이 조합에 맞는 대화·경계·재무 합의 행동 5~7문장. 결과 위협이나 미래 단정 금지)"
}` + langInstruction(lang);

  const user = `## Person A ${genderTextA ? `(${genderTextA})` : ''}
${birthDateA ? `- 생년월일: ${birthDateA}` : ''}
${sajuA.pillars.map(p => `- ${p.name}: ${p.gan}${p.ji} (${CHEONGAN_OHANG[p.gan]}/${JIJI_OHANG[p.ji]})`).join('\n')}
- 일간: ${sajuA.ilgan} (${sajuA.ilganOhang}, ${yinYangA}) — ${ilganA.desc || ''}
- 오행: 목${sajuA.ohangCount.목} 화${sajuA.ohangCount.화} 토${sajuA.ohangCount.토} 금${sajuA.ohangCount.금} 수${sajuA.ohangCount.수}
${excessA.length ? `- 과다: ${excessA.join(', ')}` : ''}
${lackA.length ? `- 부족: ${lackA.join(', ')}` : ''}
- 역할별 표면 수: ${evidenceA.roleLine}
- 원국 지문: ${evidenceA.fingerprint}
- 현재 대운: ${activeDaeunA}
${sajuA.daeun ? `- 대운: ${daeunInfoA}` : ''}

## Person B ${genderTextB ? `(${genderTextB})` : ''}
${birthDateB ? `- 생년월일: ${birthDateB}` : ''}
${sajuB.pillars.map(p => `- ${p.name}: ${p.gan}${p.ji} (${CHEONGAN_OHANG[p.gan]}/${JIJI_OHANG[p.ji]})`).join('\n')}
- 일간: ${sajuB.ilgan} (${sajuB.ilganOhang}, ${yinYangB}) — ${ilganB.desc || ''}
- 오행: 목${sajuB.ohangCount.목} 화${sajuB.ohangCount.화} 토${sajuB.ohangCount.토} 금${sajuB.ohangCount.금} 수${sajuB.ohangCount.수}
${excessB.length ? `- 과다: ${excessB.join(', ')}` : ''}
${lackB.length ? `- 부족: ${lackB.join(', ')}` : ''}
- 역할별 표면 수: ${evidenceB.roleLine}
- 원국 지문: ${evidenceB.fingerprint}
- 현재 대운: ${activeDaeunB}
${sajuB.daeun ? `- 대운: ${daeunInfoB}` : ''}

## 두 사주 간 합/충 분석 (코드로 계산된 결과)
- 일간 오행 관계: ${relDesc.length ? relDesc.join(', ') : '특별한 관계 없음'}
${rel.ganHap.length ? `- 천간합: ${rel.ganHap.join(', ')}` : '- 천간합: 없음'}
${rel.jiHap.length ? `- 지지육합: ${rel.jiHap.join(', ')}` : '- 지지육합: 없음'}
${rel.jiChung.length ? `- 지지충: ${rel.jiChung.join(', ')}` : '- 지지충: 없음'}
${complementary.length ? `- 오행 보완: ${complementary.join(', ')}` : '- 오행 보완: 없음'}
- 음양 조합: A(${yinYangA}) + B(${yinYangB}) — ${yinYangMatch ? '음양 조화 (이상적)' : '동일 음양 (에너지 충돌 가능)'}
- 수화 비율: A(수${sajuA.ohangCount.수}/화${sajuA.ohangCount.화}), B(수${sajuB.ohangCount.수}/화${sajuB.ohangCount.화})
- 재성: A=${SANGGEUK[sajuA.ilganOhang]}, B=${SANGGEUK[sajuB.ilganOhang]}
- 토금 비율: A(토${sajuA.ohangCount.토}/금${sajuA.ohangCount.금}), B(토${sajuB.ohangCount.토}/금${sajuB.ohangCount.금})

## 대운
- A: ${daeunInfoA}
- B: ${daeunInfoB}

## 궁합 점수
- ${score}/100 (${grade}급)
- 서버 확정 영역별 점수 (변경 금지): personality=${resolvedCategoryScores.personality}, intimacy=${resolvedCategoryScores.intimacy}, finance=${resolvedCategoryScores.finance}, timing=${resolvedCategoryScores.timing}

## 조합 키 (반복 방지 기준)
- A 원국 키: ${sajuA.pillars.map(p => `${p.name}:${p.gan}${p.ji}`).join('|')}
- B 원국 키: ${sajuB.pillars.map(p => `${p.name}:${p.gan}${p.ji}`).join('|')}
- 오행 차이 키: 목${sajuA.ohangCount.목}:${sajuB.ohangCount.목}-화${sajuA.ohangCount.화}:${sajuB.ohangCount.화}-토${sajuA.ohangCount.토}:${sajuB.ohangCount.토}-금${sajuA.ohangCount.금}:${sajuB.ohangCount.금}-수${sajuA.ohangCount.수}:${sajuB.ohangCount.수}
- 관계 키: 일간=${relDesc.length ? relDesc.join('/') : '없음'}; 천간합=${rel.ganHap.length ? rel.ganHap.join('/') : '없음'}; 지지육합=${rel.jiHap.length ? rel.jiHap.join('/') : '없음'}; 지지충=${rel.jiChung.length ? rel.jiChung.join('/') : '없음'}; 보완=${complementary.length ? complementary.join('/') : '없음'}`;

  return { system, user, lang };
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
  const requestLang = /^en\b/i.test(request.headers.get('Accept-Language') || '') ? 'en' : 'ko';
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: getKarmaTextAnalysisMessage(requestLang, 'invalidRequest') }, 400);
  }
  if (!isPlainAiObject(body)) return json({ error: getKarmaTextAnalysisMessage(requestLang, 'invalidRequest') }, 400);
  const { birth_date, birth_time, gender, lang, yajasi, birth_location } = body;
  const responseLang = normalizeKarmaTextAnalysisLang(lang);
  if (!birth_date) return json({ error: getKarmaTextAnalysisMessage(responseLang, 'birthDateRequired') }, 400);

  const normalizedBirthDate = normalizeKarmaBirthDateKey(birth_date);
  const normalizedBirthTime = normalizeKarmaBirthTimeKey(birth_time);
  const saju = calculateSaju(normalizedBirthDate, normalizedBirthTime, gender || '', !!yajasi, birth_location || '');

  if (!env?.AI?.complete) return karmaAiServiceErrorResponse(new KarmaAiServiceError(responseLang));
  const sajuValidationCtx = {
    hasTime: saju.hasTime,
    daeunCount: Array.isArray(saju.daeun) ? saju.daeun.length : 0,
  };
  const sajuCacheKey = await buildKarmaConsistencyCacheKey('saju', {
    birthDate: normalizedBirthDate,
    birthTime: normalizedBirthTime,
    gender: normalizeKarmaGenderKey(gender),
    yajasi: Boolean(yajasi),
    birthLocation: normalizeKarmaLocationKey(birth_location),
    activeDaeun: formatActiveDaeun(saju, normalizedBirthDate, karmaTodayKst()),
    lang: responseLang,
  });
  let cacheStatus = 'HIT';
  let ai = await readKarmaConsistencyCache(env, sajuCacheKey, 'saju');
  if (!isCacheableKarmaResult('saju', ai)) {
    cacheStatus = 'MISS';
    ai = await callKarmaTextAi(
      buildSajuPrompt(saju, gender, responseLang, normalizedBirthDate),
      'saju', env, null, 'saju', sajuValidationCtx,
    );
    if (isCacheableKarmaResult('saju', ai)) {
      await writeKarmaConsistencyCache(env, 'saju', sajuCacheKey, ai);
    }
  }
  if (!ai) return json({ error: incompleteAiResponseMessage(responseLang) }, 502);

  const out = responseLang === 'en' ? translateSajuToEn(saju) : saju;
  return json({ ...out, ai }, 200, { 'X-Karma-Cache': cacheStatus });
}

async function handleCompatQuick(request, env) {
  const { personA, personB, lang } = await request.json();
  const responseLang = normalizeKarmaTextAnalysisLang(lang);
  if (!personA?.birth_date || !personB?.birth_date) {
    return json({ error: getKarmaTextAnalysisMessage(responseLang, 'bothBirthDatesRequired') }, 400);
  }

  const birthDateA = normalizeKarmaBirthDateKey(personA.birth_date);
  const birthTimeA = normalizeKarmaBirthTimeKey(personA.birth_time);
  const birthDateB = normalizeKarmaBirthDateKey(personB.birth_date);
  const birthTimeB = normalizeKarmaBirthTimeKey(personB.birth_time);
  const sajuA = calculateSaju(birthDateA, birthTimeA, personA.gender || '', !!personA.yajasi, personA.birth_location || '');
  const sajuB = calculateSaju(birthDateB, birthTimeB, personB.gender || '', !!personB.yajasi, personB.birth_location || '');
  const score = ohangCompatibility(sajuA, sajuB);
  const grade = getGrade(score);
  const relations = getOhangRelations(sajuA.ilganOhang, sajuB.ilganOhang);

  if (!env?.AI?.complete) return json({ error: incompleteAiResponseMessage(responseLang) }, 503);
  const categoryScores = calculateCompatCategoryScores(sajuA, sajuB, birthDateA, birthDateB);
  const normalizeCompatPersonKey = (person, normDate, normTime) => ({
    birthDate: normDate,
    birthTime: normTime,
    gender: normalizeKarmaGenderKey(person?.gender),
    yajasi: Boolean(person?.yajasi),
    birthLocation: normalizeKarmaLocationKey(person?.birth_location),
  });
  const compatCacheKey = await buildKarmaConsistencyCacheKey('compat', {
    personA: normalizeCompatPersonKey(personA, birthDateA, birthTimeA),
    personB: normalizeCompatPersonKey(personB, birthDateB, birthTimeB),
    categoryScores,
    lang: responseLang,
  });
  let cacheStatus = 'HIT';
  let ai = await readKarmaConsistencyCache(env, compatCacheKey, 'compat');
  if (!isCacheableKarmaResult('compat', ai)) {
    cacheStatus = 'MISS';
    ai = await callKarmaTextAi(
      buildCompatPrompt(sajuA, sajuB, score, grade, personA.gender, personB.gender, responseLang, birthDateA, birthDateB, categoryScores),
      'compat', env, null, 'compat',
    );
    if (ai) {
      ai = normalizeCompatAiScores(ai, categoryScores);
      if (isCacheableKarmaResult('compat', ai)) {
        await writeKarmaConsistencyCache(env, 'compat', compatCacheKey, ai);
      }
    }
  }
  if (!ai) return json({ error: incompleteAiResponseMessage(responseLang) }, 502);

  const outA = responseLang === 'en' ? translateSajuToEn(sajuA) : sajuA;
  const outB = responseLang === 'en' ? translateSajuToEn(sajuB) : sajuB;
  const outRelations = responseLang === 'en' ? {
    sangsaeng: relations.sangsaeng.map(r => r.replace(/[목화토금수]/g, m => OHANG_EN[m]||m)),
    sanggeuk: relations.sanggeuk.map(r => r.replace(/[목화토금수]/g, m => OHANG_EN[m]||m)),
    same: relations.same,
  } : relations;
  return json({ score, grade, saju_a: outA, saju_b: outB, relations: outRelations, ai }, 200, { 'X-Karma-Cache': cacheStatus });
}

async function handleFortune(request, env) {
  const { birth_date, birth_time, gender, year: reqYear, lang, yajasi, birth_location } = await request.json();
  const responseLang = normalizeKarmaTextAnalysisLang(lang);
  if (!birth_date) return json({ error: getKarmaTextAnalysisMessage(responseLang, 'birthDateRequired') }, 400);

  const normalizedBirthDate = normalizeKarmaBirthDateKey(birth_date);
  const normalizedBirthTime = normalizeKarmaBirthTimeKey(birth_time);
  const saju = calculateSaju(normalizedBirthDate, normalizedBirthTime, gender || '', !!yajasi, birth_location || '');
  const year = reqYear || Number(karmaTodayKst().slice(0, 4));

  if (!env?.AI?.complete) return json({ error: getKarmaTextAnalysisMessage(responseLang, 'aiUnavailable') }, 503);

  const luckyBaseline = calculateFortuneLucky(saju, year, responseLang);
  const fortuneCacheKey = await buildKarmaConsistencyCacheKey('fortune', {
    birthDate: normalizedBirthDate,
    birthTime: normalizedBirthTime,
    gender: normalizeKarmaGenderKey(gender),
    yajasi: Boolean(yajasi),
    birthLocation: normalizeKarmaLocationKey(birth_location),
    year: Number(year),
    lang: responseLang,
  });
  let cacheStatus = 'HIT';
  let ai = await readKarmaConsistencyCache(env, fortuneCacheKey, 'fortune');
  if (!isCacheableKarmaResult('fortune', ai)) {
    cacheStatus = 'MISS';
    ai = await callKarmaTextAi(
      buildFortunePrompt(saju, gender, year, responseLang, normalizedBirthDate, luckyBaseline),
      'fortune', env, null, 'fortune',
    );
    if (ai) {
      ai = normalizeFortuneLucky(ai, saju, year, responseLang);
      if (isCacheableKarmaResult('fortune', ai)) {
        await writeKarmaConsistencyCache(env, 'fortune', fortuneCacheKey, ai);
      }
    }
  }
  if (!ai) return json({ error: incompleteAiResponseMessage(responseLang) }, 502);
  const out = responseLang === 'en' ? translateSajuToEn(saju) : saju;
  return json({ year, saju_summary: out.summary, ilgan: out.ilgan, ilganEn: out.ilganEn, ilganOhang: out.ilganOhang, fortune: ai }, 200, { 'X-Karma-Cache': cacheStatus });
}

async function handleDaily(request, env) {
  const { birth_date, birth_time, gender, lang, yajasi, target_date, birth_location } = await request.json();
  const responseLang = normalizeKarmaTextAnalysisLang(lang);
  if (!birth_date) return json({ error: getKarmaTextAnalysisMessage(responseLang, 'birthDateRequired') }, 400);

  const normalizedBirthDate = normalizeKarmaBirthDateKey(birth_date);
  const normalizedBirthTime = normalizeKarmaBirthTimeKey(birth_time);
  const saju = calculateSaju(normalizedBirthDate, normalizedBirthTime, gender || '', yajasi || false, birth_location || '');
  let todayStr;
  if (target_date && /^\d{4}-\d{2}-\d{2}$/.test(target_date)) {
    todayStr = target_date;
  } else {
    todayStr = karmaTodayKst();
  }

  if (!env?.AI?.complete) return json({ error: getKarmaTextAnalysisMessage(responseLang, 'aiUnavailable') }, 503);

  const luckyBaseline = calculateDailyLucky(saju, todayStr, responseLang);
  const dailyCacheKey = await buildKarmaConsistencyCacheKey('daily', {
    birthDate: normalizedBirthDate,
    birthTime: normalizedBirthTime,
    gender: normalizeKarmaGenderKey(gender),
    yajasi: Boolean(yajasi),
    birthLocation: normalizeKarmaLocationKey(birth_location),
    targetDate: todayStr,
    lang: responseLang,
  });
  let cacheStatus = 'HIT';
  let ai = await readKarmaConsistencyCache(env, dailyCacheKey, 'daily');
  if (!isCacheableKarmaResult('daily', ai)) {
    cacheStatus = 'MISS';
    ai = await callKarmaTextAi(
      buildDailyPrompt(saju, gender, todayStr, responseLang, normalizedBirthDate, luckyBaseline),
      'daily', env, null, 'daily',
    );
    if (ai) {
      ai = normalizeDailyLucky(ai, saju, todayStr, responseLang);
      if (isCacheableKarmaResult('daily', ai)) {
        await writeKarmaConsistencyCache(env, 'daily', dailyCacheKey, ai);
      }
    }
  }
  if (!ai) return json({ error: incompleteAiResponseMessage(responseLang) }, 502);
  const out = responseLang === 'en' ? translateSajuToEn(saju) : saju;
  return json({ date: todayStr, saju_summary: out.summary, ilgan: out.ilgan, ilganEn: out.ilganEn, ilganOhang: out.ilganOhang, daily: ai }, 200, { 'X-Karma-Cache': cacheStatus });
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

async function handleMatchDetail(idA, idB, env, lang) {
  const responseLang = normalizeKarmaTextAnalysisLang(lang);
  const [userA, userB] = await Promise.all([
    env.DB.prepare(`SELECT ${SELECT_PROFILE} FROM lm_profiles WHERE user_id = ?`).bind(idA).first(),
    env.DB.prepare(`SELECT ${SELECT_PROFILE} FROM lm_profiles WHERE user_id = ?`).bind(idB).first(),
  ]);
  if (!userA || !userB) return json({ error: '프로필을 찾을 수 없습니다' }, 404);

  const sajuA = calculateSaju(userA.birth_date, userA.birth_time || '', userA.gender || '');
  const sajuB = calculateSaju(userB.birth_date, userB.birth_time || '', userB.gender || '');
  const score = ohangCompatibility(sajuA, sajuB);
  const grade = getGrade(score);
  const relations = getOhangRelations(sajuA.ilganOhang, sajuB.ilganOhang);

  const outA = responseLang === 'en' ? translateSajuToEn(sajuA) : sajuA;
  const outB = responseLang === 'en' ? translateSajuToEn(sajuB) : sajuB;
  const baseResult = {
    user_a: { user_id: idA, nickname: userA.nickname, age: calcAge(userA.birth_date), gender: userA.gender, ohang: responseLang === 'en' ? (OHANG_EN[sajuA.ilganOhang]||sajuA.ilganOhang) : sajuA.ilganOhang },
    user_b: { user_id: idB, nickname: userB.nickname, age: calcAge(userB.birth_date), gender: userB.gender, ohang: responseLang === 'en' ? (OHANG_EN[sajuB.ilganOhang]||sajuB.ilganOhang) : sajuB.ilganOhang },
    score, grade, saju_a: outA, saju_b: outB,
    relations: responseLang === 'en' ? {
      sangsaeng: relations.sangsaeng.map(r => r.replace(/[목화토금수]/g, m => OHANG_EN[m]||m)),
      sanggeuk: relations.sanggeuk.map(r => r.replace(/[목화토금수]/g, m => OHANG_EN[m]||m)),
      same: relations.same,
    } : relations,
  };

  if (!env?.AI?.complete) return json({ ...baseResult, ai: null });

  const birthDateA = normalizeKarmaBirthDateKey(userA.birth_date);
  const birthTimeA = normalizeKarmaBirthTimeKey(userA.birth_time);
  const birthDateB = normalizeKarmaBirthDateKey(userB.birth_date);
  const birthTimeB = normalizeKarmaBirthTimeKey(userB.birth_time);
  const categoryScores = calculateCompatCategoryScores(sajuA, sajuB, birthDateA, birthDateB);
  const matchCacheKey = await buildKarmaConsistencyCacheKey('match-detail', {
    personA: {
      birthDate: birthDateA,
      birthTime: birthTimeA,
      gender: normalizeKarmaGenderKey(userA.gender),
    },
    personB: {
      birthDate: birthDateB,
      birthTime: birthTimeB,
      gender: normalizeKarmaGenderKey(userB.gender),
    },
    categoryScores,
    lang: responseLang,
  });
  let cacheStatus = 'HIT';
  let ai = await readKarmaConsistencyCache(env, matchCacheKey, 'match-detail');
  if (!isCacheableKarmaResult('match-detail', ai)) {
    cacheStatus = 'MISS';
    try {
      ai = await callKarmaTextAi(
        buildCompatPrompt(sajuA, sajuB, score, grade, userA.gender, userB.gender, responseLang, birthDateA, birthDateB, categoryScores),
        'match-detail', env, null, 'compat',
      );
      if (ai) {
        ai = normalizeCompatAiScores(ai, categoryScores);
        if (isCacheableKarmaResult('match-detail', ai)) {
          await writeKarmaConsistencyCache(env, 'match-detail', matchCacheKey, ai);
        }
      }
    } catch (error) {
      if (!(error instanceof KarmaAiServiceError)) throw error;
    }
  }
  return json({ ...baseResult, ai }, 200, ai ? { 'X-Karma-Cache': cacheStatus } : {});
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

function isIgnorableClientErrorLog(message, source, stack, page) {
  const text = [message, source, stack, page].filter(Boolean).join('\n');
  return /webkit-masked-url:\/\/hidden|(?:chrome|moz|safari-web)-extension:\/\//i.test(text);
}

async function handlePostErrorLog(request, env) {
  const { message, source, line, col, stack, page, userAgent } = await request.json();

  if (isIgnorableClientErrorLog(message, source, stack, page)) {
    return json({ ok: true, ignored: true });
  }

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
  if (env?.DB) {
    try {
      await ensureKarmaImageAnalysesTable(env.DB);
      await env.DB.prepare(
        'DELETE FROM karma_image_analyses WHERE r2_key = ?'
      ).bind(String(key)).run();
      await ensureKarmaAnalysesTable(env.DB);
      await env.DB.prepare(
        'DELETE FROM karma_analyses WHERE r2_key = ?'
      ).bind(String(key)).run();
    } catch (error) {
      console.error('[KarmaAnalysis] D1 delete failed:', error?.message || error);
    }
  }
  return json({ ok: true, deleted: key });
}

// ============================================================
// Share Result (KV)
// ============================================================

const SHARE_TTL_SECONDS = 60 * 60 * 24 * 365; // 1년
const SHARE_ALLOWED_TYPES = new Set(['saju', 'fortune', 'daily', 'tarot', 'face', 'palm', 'compat']);
const SHARE_MAX_BYTES = 100 * 1024; // 100 KB per share

async function handleShareSave(request, env) {
  if (!env.KARMA_SHARE) return json({ error: 'KV not configured' }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const { type, lang, input, result } = body || {};
  if (!type || !SHARE_ALLOWED_TYPES.has(type)) return json({ error: 'Invalid type' }, 400);
  if (!result) return json({ error: 'Missing result' }, 400);

  const payload = JSON.stringify({
    type,
    lang: normalizeKarmaTextAnalysisLang(lang),
    input: input || null,
    result,
    createdAt: new Date().toISOString(),
  });
  if (payload.length > SHARE_MAX_BYTES) return json({ error: 'Payload too large' }, 413);

  const id = crypto.randomUUID();
  await env.KARMA_SHARE.put(id, payload, { expirationTtl: SHARE_TTL_SECONDS });
  return json({ id });
}

async function handleShareGet(id, env) {
  if (!env.KARMA_SHARE) return json({ error: 'KV not configured' }, 500);
  if (!id) return json({ error: 'Missing id' }, 400);
  const data = await env.KARMA_SHARE.get(id);
  if (!data) return json({ error: 'Not found or expired' }, 404);
  return new Response(data, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (isLegacyAccountApi(path)) {
      return json({
        error: 'legacy_account_disabled',
        message: '통합 계정 전환이 끝날 때까지 기존 매칭 계정 기능은 비활성화되어 있습니다.',
      }, 410);
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
        return handleLoggedKarmaAnalysis(request, env, ctx, 'saju', handleSajuAnalysis);
      }
      if (path === '/api/compat-quick' && method === 'POST') {
        return handleLoggedKarmaAnalysis(request, env, ctx, 'compat', handleCompatQuick);
      }
      if (path === '/api/fortune' && method === 'POST') {
        return handleLoggedKarmaAnalysis(request, env, ctx, 'fortune', handleFortune);
      }
      if (path === '/api/daily' && method === 'POST') {
        return handleLoggedKarmaAnalysis(request, env, ctx, 'daily', handleDaily);
      }
      if (path === '/api/quick-saju' && method === 'POST') {
        return handleLoggedKarmaAnalysis(request, env, ctx, 'compat', handleQuickSaju, 'LOCAL');
      }
      if (path === '/api/tarot' && method === 'POST') {
        return handleLoggedKarmaAnalysis(request, env, ctx, 'tarot', handleTarotReading);
      }
      if (path === '/api/face-reading' && method === 'POST') {
        return handleLoggedKarmaAnalysis(request, env, ctx, 'face', handleFaceReading);
      }
      if (path === '/api/palm-reading' && method === 'POST') {
        return handleLoggedKarmaAnalysis(request, env, ctx, 'palm', handlePalmReading);
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
          return handleMatchDetail(params.id_a, params.id_b, env, url.searchParams.get('lang'));
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
        const authError = getKarmaAdminAuthError(request, env);
        if (authError) return authError;
        return handleGetErrorLog(env);
      }

      // ---- Share Routes ----
      if (path === '/api/share/save' && method === 'POST') {
        return handleShareSave(request, env);
      }
      {
        const params = matchPath('/api/share/:id', path);
        if (params && method === 'GET') {
          return handleShareGet(params.id, env);
        }
      }

      // ---- R2 Routes ----
      if (path === '/api/r2/list' && method === 'GET') {
        const authError = getKarmaAdminAuthError(request, env);
        if (authError) return authError;
        return handleR2List(url, env);
      }
      if (path === '/api/r2/image' && method === 'GET') {
        const authError = getKarmaAdminAuthError(request, env);
        if (authError) return authError;
        return handleR2Get(url, env);
      }
      if (path === '/api/r2/delete' && method === 'DELETE') {
        const authError = getKarmaAdminAuthError(request, env);
        if (authError) return authError;
        return handleR2Delete(request, env);
      }

      // ---- 404 ----
      return json({ error: 'Not Found' }, 404);

    } catch (e) {
      console.error('Worker error:', e.message || e, e.stack || '');
      const logPromise = logErrorToCentral('karma-server', e.message || String(e), e.stack || '', url.pathname);
      if (ctx?.waitUntil) ctx.waitUntil(logPromise);
      else await logPromise;
      return json({ error: 'Internal Server Error' }, 500);
    }
  },
};

async function logErrorToCentral(appId, message, stack, url) {
  try {
    await fetch('https://chatbot-api.yama5993.workers.dev/error-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, message: (message || '').substring(0, 500), stack: (stack || '').substring(0, 2000), url: (url || '').substring(0, 500) }),
    });
  } catch (_) {}
}
