// Karma Worker — Single-file vanilla Cloudflare Worker
// Karma API Worker (vanilla JS, no framework)

// ============================================================
// CORS & Response Helpers
// ============================================================

const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';
const CF_ACCOUNT_ID = 'f5ced3498c8b7674581b5c9987f31585';
const CF_GATEWAY_NAME = 'archer-gateway';
const GEMINI_URL = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_NAME}/google-ai-studio/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// ============================================================
// Gemini Context Caching
// ============================================================
let _cacheTableReady = false;
let _perfStatsTableReady = false;

async function createGeminiCache(apiKey, staticContent, model, ttl = '3600s') {
  try {
    const res = await fetch(`${GEMINI_API_BASE}/cachedContents?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${model}`,
        systemInstruction: { parts: [{ text: staticContent }] },
        contents: [],
        ttl
      })
    });
    if (!res.ok) {
      console.error('[GeminiCache] Create failed:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json();
    return data.name;
  } catch (e) {
    console.error('[GeminiCache] Create error:', e.message);
    return null;
  }
}

async function updateGeminiCacheTTL(apiKey, cacheName, ttl = '3600s') {
  try {
    const res = await fetch(`${GEMINI_API_BASE}/${cacheName}?key=${apiKey}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl })
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function getOrCreateCache(env, cacheKey, staticContent, model, apiKey) {
  if (!env?.DB) return null;
  if (!_cacheTableReady) {
    try {
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS gemini_cache (
          cache_key TEXT PRIMARY KEY,
          cache_name TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL
        )
      `).run();
      _cacheTableReady = true;
    } catch (e) {
      console.error('[GeminiCache] Table create failed:', e.message);
      return null;
    }
  }
  const existing = await env.DB.prepare(
    'SELECT cache_name, expires_at FROM gemini_cache WHERE cache_key = ?'
  ).bind(cacheKey).first();
  if (existing) {
    const expiresAt = new Date(existing.expires_at + 'Z');
    if (expiresAt > new Date()) {
      updateGeminiCacheTTL(apiKey, existing.cache_name).then(ok => {
        if (ok && env.DB) {
          env.DB.prepare(
            "UPDATE gemini_cache SET expires_at = datetime('now', '+1 hour') WHERE cache_key = ?"
          ).bind(cacheKey).run().catch(() => {});
        }
      });
      return existing.cache_name;
    }
    await env.DB.prepare('DELETE FROM gemini_cache WHERE cache_key = ?').bind(cacheKey).run();
  }
  const cacheName = await createGeminiCache(apiKey, staticContent, model);
  if (cacheName) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO gemini_cache (cache_key, cache_name, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))"
    ).bind(cacheKey, cacheName).run();
    return cacheName;
  }
  return null;
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
            cache_key TEXT,
            cache_hit INTEGER,
            prompt_tokens INTEGER,
            cached_tokens INTEGER,
            output_tokens INTEGER,
            thought_tokens INTEGER,
            sys_chars INTEGER,
            hist_chars INTEGER,
            used_key_idx INTEGER,
            elapsed_ms INTEGER
          )
        `).run();
        await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_perf_stats_ts_app ON perf_stats(ts, app)').run();
        _perfStatsTableReady = true;
      } catch (e) {
        console.error('[PerfStats] Table create failed:', e.message);
        return;
      }
    }
    try {
      await env.DB.prepare(
        'INSERT INTO perf_stats (app, cache_key, cache_hit, prompt_tokens, cached_tokens, output_tokens, thought_tokens, sys_chars, hist_chars, used_key_idx, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        row.app, row.cache_key, row.cache_hit,
        row.prompt_tokens, row.cached_tokens, row.output_tokens, row.thought_tokens,
        row.sys_chars, row.hist_chars, row.used_key_idx, row.elapsed_ms
      ).run();
    } catch (e) {
      console.warn('[PerfStats] insert error:', e.message);
    }
  };
  if (ctx?.waitUntil) ctx.waitUntil(doWrite());
  else doWrite().catch(() => {});
}

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

// 유료키 우선 → 무료키는 폴백 (응답 속도 우선, 캐싱/가드 적용 후)
function getGeminiKeys(env) {
  return [
    env.GEMINI_API_KEY,
    env.GOLF_GEMINI_API_KEY_FREE,
    env.LATIN_GEMINI_API_KEY_FREE,
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

async function callGemini(apiKeys, prompt, _caller, _env, _ctx) {
  const endpoint = _caller || 'unknown';
  const _perfStart = Date.now();
  // prompt가 { system, user } 객체이면 분리, 아니면 기존 방식
  const isStructured = typeof prompt === 'object' && prompt.system && prompt.user;
  const promptText = isStructured ? prompt.user : prompt;
  const promptPreview = promptText.slice(0, 100);
  const cacheKey = isStructured ? `karma:${_caller}:${(prompt.lang || 'ko')}` : null;
  const _sysSize = isStructured ? (prompt.system || '').length : 0;
  const _contentsSize = promptText.length;

  // 캐싱 시도
  let cachedContentName = null;
  if (isStructured && _env?.DB && apiKeys.length) {
    try {
      cachedContentName = await getOrCreateCache(_env, cacheKey, prompt.system, GEMINI_MODEL, apiKeys[0]);
    } catch (e) {
      console.warn('[GeminiCache] Error:', e.message);
    }
  }

  const payload = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: { temperature: 0.5, thinkingConfig: { thinkingLevel: "high" } },
  };
  if (cachedContentName) {
    payload.cachedContent = cachedContentName;
  } else if (isStructured) {
    payload.systemInstruction = { parts: [{ text: prompt.system }] };
  }
  const body = JSON.stringify(payload);
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
        const _parsed = JSON.parse(jsonMatch[0]);
        const _um = data.usageMetadata || {};
        logPerfStats(_env, _ctx, {
          app: `karma:${endpoint}`,
          cache_key: cacheKey,
          cache_hit: cachedContentName ? 1 : 0,
          prompt_tokens: _um.promptTokenCount || 0,
          cached_tokens: _um.cachedContentTokenCount || 0,
          output_tokens: _um.candidatesTokenCount || 0,
          thought_tokens: _um.thoughtsTokenCount || 0,
          sys_chars: _sysSize,
          hist_chars: _contentsSize,
          used_key_idx: i,
          elapsed_ms: Date.now() - _perfStart,
        });
        return _parsed;
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
  const isEn = lang === 'en';
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
    const system = `You are a 30-year-veteran tarot reader with zero tolerance for sugar-coating. People paid money to hear the truth, not get a pep talk. If the cards warn, you warn — bluntly.

**LANGUAGE: You MUST respond entirely in English. Every string in the JSON output — including card position names, interpretations, overall, advice, and keywords — must be in English. Any Korean text in the user input is internal reference data only; translate its meaning into English.**

## Interpretation Rules
1. **Direction is binding**: Upright = that energy is flowing correctly. Reversed = it's **blocked, distorted, or excessive**. Reversed = warning sign. Do not soften it.
2. **Minimal imagery**: One sentence max on visuals, then land immediately on "what this means for your actual life."
3. **Narrative arc**: Past → Present → Future is ONE story of cause and consequence. Name which past choice created the current problem, and which current behavior will detonate in the future.
4. **Plain, blunt language**: No mystical filler ("the universe", "energy flows", "reversed energy"). State facts.
5. **No hedging**: Ban "might", "could possibly", "may come to". Replace with "this will happen unless you change X."
6. **Break taboos**: If the question is about love, call out cheating risk, a partner pulling away, or that they're with the wrong person. If money, say "don't make this investment" when the cards say so. If health, say "see a doctor." Don't water it down.
7. **Reversed = direct warning**: When reversed, name what's broken and what they'll lose if they don't fix it this week.
8. **Banned phrases**: "The universe is telling you...", "The card speaks of...", "Energy flows/is blocked", "stay positive", "trust the process" — never.

## Response — JSON only
{
  "cards": [
    {"position": "Past", "interpretation": "(3-4 sentences. What happened and how it made you what you are today. Name the specific past choice that caused the current problem.)"},
    {"position": "Present", "interpretation": "(3-4 sentences. What you're currently missing, avoiding, or refusing to face. Say it plainly.)"},
    {"position": "Future", "interpretation": "(3-4 sentences. Where this is heading if nothing changes. State it as fact, not possibility.)"}
  ],
  "overall": "(3-4 sentences. Tie past→present→future into one clear story. Include at least one uncomfortable truth the querent needs to accept.)",
  "advice": "(3-4 sentences. Action THIS WEEK. No platitudes. Direct commands: 'Have the conversation with X', 'Stop doing Y right now', 'Don't sign that paper until Z.')",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"]
}`;

    const user = `## Querent's Question
${hasQuestion ? question : 'General life reading — no specific question'}

## Cards Drawn (Past → Present → Future)
${cardDescs}
${hasQuestion ? `\nIMPORTANT: Every interpretation must relate back to "${question}". Don't give a generic reading.` : '\nCover love, career, and personal growth themes.'}`;

    return { system, user, lang: 'en' };
  }

  const system = `당신은 30년 경력의 타로 직설가입니다. 듣기 좋은 점괘 금지. 카드가 경고하면 경고 그대로 전달하세요.
위로해달라고 온 사람한테 위로만 해주면 돈 받을 자격 없습니다. 카드가 뽑힌 대로, **지금 뭐가 잘못 돌아가고 있는지** 직설적으로 말해주세요.

## 해석 규칙
1. **방향 반영**: 정방향 = 그 카드 의미대로 흐름. 역방향 = **막혔거나 어긋났거나 과잉**. 역방향은 경고 사인 — 얼버무리지 마세요.
2. **카드 그림 설명 최소**: 한 문장이면 충분. 바로 "그래서 당신 인생에서 이게 무슨 뜻"으로 꽂으세요.
3. **서사 연결**: 과거가 현재를 만들었고 현재가 미래로 이어집니다. 과거의 실수가 지금 어떤 대가로 돌아왔는지, 지금 행동이 미래에 어떤 결과로 터질지 연결
4. **쉬운 말로**: 신비주의 표현 전면 금지. "에너지", "우주가", "역방향 에너지" 금지. 일상 말로 단정하세요.
5. **직설 모드**: "이런 일이 일어날 수도 있습니다" 금지 → "이 상황은 ~때문에 벌어졌고 지금 이대로 가면 ~하게 된다"로 단정
6. **금기 깨기**: 질문이 연애면 "지금 만나는 사람 바람 피울 리스크 있다"까지 솔직하게. 돈이면 "지금 하려는 투자 말려라" 수준. 건강이면 "병원 가라"까지.
7. **역방향 = 직설 경고**: 역방향 나오면 그 영역에서 무엇이 망가졌는지, 지금 안 고치면 무엇을 잃을지 단정적으로
8. **금지 표현**: "우주가...", "카드가 말하기를...", "에너지가 흐른다/막혀있다", "긍정적 마인드" 등

## 응답 — JSON만
{
  "cards": [
    {"position": "과거", "interpretation": "(3~4문장. 그동안 무슨 일이 있었고 그게 지금 당신을 어떻게 만들었는지 직설적으로. 과거의 선택이 지금의 문제로 이어진 지점 명시)"},
    {"position": "현재", "interpretation": "(3~4문장. 지금 당신이 뭘 잘못 보고 있는지, 뭘 외면하고 있는지, 뭐가 실제로 진행 중인지 솔직하게)"},
    {"position": "미래", "interpretation": "(3~4문장. 지금 이대로 가면 어떻게 되는지 단정. '~할 수 있다' 금지. '이 상태 유지하면 ~이 터진다' 식)"}
  ],
  "overall": "(3~4문장. 과거→현재→미래 한 흐름으로. 이 사람이 지금 당장 받아들여야 할 불편한 진실 한 가지는 반드시 포함)",
  "advice": "(3~4문장. 이번 주에 즉시 실행할 구체 행동. 격언 금지. '~하는 사람에게 ~라고 말해라', '~을 지금 그만둬라' 식 단정형 지시)",
  "keywords": ["키워드1", "키워드2", "키워드3", "키워드4", "키워드5"]
}`;

  const user = `## 질문자의 질문
${hasQuestion ? question : '특별한 질문 없이 전체 운세를 봅니다'}

## 뽑힌 카드 (과거 → 현재 → 미래)
${cardDescs}
${hasQuestion ? `\n중요: 모든 해석은 "${question}"이라는 질문과 연결되어야 합니다. 뜬구름 잡는 해석은 하지 마세요.` : '\n연애, 직업, 개인적 성장 주제를 골고루 다뤄주세요.'}`;

  return { system, user, lang: 'ko' };
}

async function handleTarotReading(request, env) {
  try {
    const body = await request.json();
    const { cards: selectedCards, question, lang } = body;

    if (!selectedCards || !Array.isArray(selectedCards) || selectedCards.length !== 3) {
      return json({ error: 'cards must be an array of 3 card objects' }, 400);
    }

    // 카드 정보 매핑
    const cards = selectedCards.map(c => {
      const card = TAROT_MAJOR_ARCANA.find(t => t.id === c.id);
      if (!card) return null;
      return { ...card, reversed: !!c.reversed };
    }).filter(Boolean);

    if (cards.length !== 3) {
      return json({ error: 'Invalid card IDs' }, 400);
    }

    const apiKeys = getGeminiKeys(env);
    if (!apiKeys.length) {
      return json({ error: 'AI service unavailable' }, 503);
    }

    const prompt = buildTarotPrompt(cards, question || '', lang || 'ko');
    const ai = await callGemini(apiKeys, prompt, 'tarot', env);

    if (!ai) {
      return json({ error: 'AI interpretation failed' }, 500);
    }

    return json({
      cards: cards.map((c, i) => ({
        id: c.id,
        name: c.name,
        nameKo: c.nameKo,
        reversed: c.reversed,
        keywords: c.reversed ? c.rev : c.up,
        interpretation: ai.cards?.[i]?.interpretation || '',
      })),
      overall: ai.overall || '',
      advice: ai.advice || '',
      keywords: ai.keywords || [],
    });
  } catch (e) {
    return json({ error: e.message || 'Server error' }, 500);
  }
}

async function callGeminiVision(apiKeys, prompt, imageBase64, mimeType, _env) {
  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
      ],
    }],
    generationConfig: { temperature: 0.5, thinkingConfig: { thinkingLevel: "high" } },
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

  const prompt = `당신은 40년 경력의 관상학 직설가입니다. 덕담 관상 금지. 얼굴에 드러난 것을 그대로 읽어주세요.
관상은 칭찬 대잔치가 아닙니다. 박복한 상·고집 센 상·재물 흘리는 상 같은 불편한 진단도 있는 그대로 하세요.

중요: 먼저 사진에 사람의 얼굴이 있는지 확인하세요. 얼굴이 없거나 사람이 아닌 사진이면 반드시 다음 JSON만 반환:
{"error": "얼굴 사진이 아닙니다. 사람의 정면 얼굴이 보이는 사진을 업로드해주세요."}

얼굴이 확인되면 관상 감정 진행.
${gender ? `성별: ${gender}` : ''}${age ? `, 나이대: ${age}` : ''}

## 직설 모드 원칙
- 점수가 낮은 부위는 낮은 점수를 매기고, 왜 낮은지 솔직하게 (예: "이마가 좁고 굴곡이 있어 초년 부모덕 박함, 혼자 개척해야 하는 상")
- 얼굴에 드러나는 성격 결함 직설 (고집, 의심 많음, 질투, 속물적, 감정 기복)
- 재물 흐름·관재·건강 이슈를 얼굴 신호로 직접 연결 (법령선 흐림 → 40대 직업 변동, 눈 밑 어두움 → 신장·생식기 약함 등)
- **닮은 유명인**은 외모 긍정뿐 아니라 이미지·커리어 궤적까지 참고해서 (예: "○○○ 닮음, 다만 그 사람처럼 중년에 구설수 조심")

## 분석 항목
1. 이마(천정) - 지혜, 초년운, 부모덕
2. 눈(눈매) - 성격 민낯, 대인관계, 의심·질투 여부
3. 코(준두) - 재물운, 자존심, 돈 모이는지 새는지
4. 입(입술) - 언변, 식복, 말로 손해 보는지
5. 턱/광대 - 의지력, 중년~말년운, 말년 고독 여부
6. 전체 인상 - 종합 관상

반드시 아래 JSON 형식으로만 응답:
{
  "overall_score": 85,
  "overall_grade": "A",
  "summary": "(한줄 요약. 덕담 금지. 예: '초년 고생 후 중년부터 재물 모이는 상, 단 배우자복은 약함')",
  "categories": [
    {"name": "이마 (천정)", "score": 80, "desc": "(2~3문장. 초년운·부모덕·학업운. 박복하면 박복하다고 직설)"},
    {"name": "눈 (눈매)", "score": 85, "desc": "(2~3문장. 성격 민낯·의심 많은지·감정 기복·대인관계 패턴)"},
    {"name": "코 (준두)", "score": 75, "desc": "(2~3문장. 재물운·자존심·돈 새는 상인지 직설)"},
    {"name": "입 (입술)", "score": 90, "desc": "(2~3문장. 언변·식복·말로 싸움 많이 일으키는지)"},
    {"name": "턱/광대", "score": 80, "desc": "(2~3문장. 말년운·의지력·고독 가능성)"},
    {"name": "전체 인상", "score": 85, "desc": "(2~3문장. 종합. 인덕·관재·건강 리스크 직설)"}
  ],
  "fortune": {
    "wealth": "(재물운 3~4문장. 평생 얼마나 모을지, 어느 시기 날릴 위험 있는지 직설)",
    "career": "(직업/사업운 3~4문장. 적성과 **절대 하면 안 되는 분야** 함께. 창업해서 망할지 월급쟁이가 맞는지)",
    "love": "(연애/결혼운 3~4문장. 결혼 적령기, 이혼 가능성, 바람기 있는 상인지, 배우자와 궁합 잘 안 맞을 경향 직설)",
    "health": "(건강운 3~4문장. 얼굴에 드러난 약한 장기·질환 경향 직접 언급. 몇 살쯤 큰 건강 이슈 올 가능성까지)"
  },
  "advice": "(관상 기반 조언 3~4문장. 격언 금지. '이 상은 ~을 반드시 피하라, ~부터 ~을 준비해라' 식 구체 지시)",
  "celebrity_resemblance": "(닮은 유명인 1~2명. 외모+커리어 패턴 참고해서 이 사람이 참고할 만한 부분과 피해야 할 부분 모두)"
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

  const prompt = `당신은 40년 경력의 수상학 직설가입니다. 손금에 새겨진 것을 있는 그대로 읽어주세요. 좋게 포장하지 마세요.
손금은 확률·경향을 드러내는 지도입니다. 끊긴 선·흐린 선·흉터까지 솔직하게 해석하고, 그게 실제 인생에서 무슨 사건으로 나타날지 단정하세요.

중요: 먼저 사진에 사람의 손바닥이 있는지 확인하세요. 손바닥이 없거나 손금이 보이지 않는 사진이면 반드시 다음 JSON만 반환:
{"error": "손바닥 사진이 아닙니다. 손금이 잘 보이도록 손을 펴서 촬영한 사진을 업로드해주세요."}

손바닥이 확인되면 손금 감정 진행.
${hand ? `촬영한 손: ${hand}` : ''}${gender ? `, 성별: ${gender}` : ''}

## 직설 모드 원칙
- **끊긴 선·흐린 선·섬(島)·흉터**는 그에 해당하는 인생 사건으로 번역 (생명선 끊김 → 큰 병/사고 시기, 감정선 섬 → 상처 깊은 이별, 운명선 흐림 → 직업 방황)
- 결혼선 여러 개 → 이혼·재혼·불륜 가능성 직설
- 건강 관련 약한 부위 직접 언급 (간·심혈관·생식기·정신건강 등)
- 재물선 약하면 "평생 돈 새는 손금, 자영업 하면 망함" 수준으로 단정
- 점수 낮은 항목은 낮은 점수 + 직설적 설명. 평균 올리려 억지로 75+ 매기지 말 것

## 주요 손금 분석
1. 생명선 - 건강·활력·큰 병 올 시기
2. 두뇌선 - 사고방식·판단력·감정 컨트롤
3. 감정선 - 연애 패턴·상처·집착 성향
4. 운명선 - 직업 안정성·방황 시기
5. 태양선 - 명예·성공 가능성 (없으면 없는 대로)
6. 결혼선 - 결혼·이혼·재혼·불륜 가능성
7. 손 형태 - 성격 민낯

반드시 아래 JSON 형식으로만 응답:
{
  "overall_score": 82,
  "overall_grade": "A",
  "summary": "(한줄 요약. 덕담 금지. 예: '초중년 고생선 뚜렷, 40대 중반 큰 전환점 있는 손')",
  "lines": [
    {"name": "생명선", "score": 85, "length": "길다/보통/짧다", "desc": "(2~3문장. 건강 전반 + 큰 병·사고 올 가능성 시기. 끊김·섬 있으면 직설)"},
    {"name": "두뇌선", "score": 78, "length": "길다/보통/짧다", "desc": "(2~3문장. 판단력·감정 기복·우울 경향까지)"},
    {"name": "감정선", "score": 88, "length": "길다/보통/짧다", "desc": "(2~3문장. 연애 패턴·상처 입는 방식·집착 or 냉정 성향. 끊김·섬 있으면 큰 이별 가능성 직설)"},
    {"name": "운명선", "score": 75, "length": "뚜렷/보통/희미", "desc": "(2~3문장. 직업 안정성. 희미하면 '평생 방황하는 손' 수준으로 직설)"},
    {"name": "태양선", "score": 70, "length": "있음/희미/없음", "desc": "(2~3문장. 성공·명예 가능성. 없으면 없다고 솔직하게)"},
    {"name": "결혼선", "score": 80, "length": "1개/2개/여러개", "desc": "(2~3문장. 결혼 시기·이혼 리스크·재혼·바람기 있는 손인지 직설)"}
  ],
  "hand_shape": {"type": "물형/불형/흙형/금형/나무형", "desc": "(손 형태로 본 성격 민낯 2~3문장)"},
  "fortune": {
    "wealth": "(재물운 3~4문장. 평생 돈 모이는 손인지 새는 손인지, 큰 손실 올 시기)",
    "career": "(직업운 3~4문장. 월급쟁이형인지 사업형인지 + **절대 하면 안 되는 방향** 명시)",
    "love": "(연애/결혼운 3~4문장. 결혼 몇 번 할 가능성, 이혼·재혼 리스크, 배우자 만나는 시기 직설)",
    "health": "(건강운 3~4문장. 약한 장기 직접 지목, 큰 병 올 가능성 연령대, 정기검진 받아야 할 부위까지)"
  },
  "advice": "(손금 기반 조언 3~4문장. 격언 금지. '이 손금은 ~시기에 ~을 반드시 피해라, 안 피하면 ~이 터진다' 식 단정형 지시)"
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
  const rel = analyzeInternalRelations(saju.pillars);

  const system = `당신은 40년 경력의 사주명리학 직설가입니다. 위로·공감·포장 금지. 손님 비위 맞추지 말고 있는 그대로 후려치세요.
돈 받고 보는 진짜 사주는 "좋은 말"이 아니라 "아픈 말"입니다. 듣기 싫어도 맞는 말을 하세요.

## 절대 금지 표현 (이거 쓰면 해석 실패)
- "~할 수도 있습니다" / "~일 가능성이 있습니다" → 단정형으로 쓰세요
- "균형이 중요합니다" / "조화를 이루세요" → 구체적 행동 지시로 바꾸세요
- "노력하면 좋습니다" / "긍정적으로 생각하세요" → 뻔한 위로 금지
- "특별한 주의가 필요합니다" → 무엇을, 언제, 어떻게 조심해야 하는지 명시

## 오행 상생/상극 기본 원리
${OHANG_RELATIONS}

## 해석 지침 (직설 모드)
1. 성격 결함을 정확히 찌르세요. "고집 세다", "질투 많다", "돈 못 모은다", "감정 기복 심하다" 같은 표현 허용
2. 연애 실패 패턴을 구체적으로: 어떤 타입한테 당하기 쉬운지, 왜 항상 같은 이별을 반복하는지
3. 직업 적성은 물론 **안 맞는 직업**도 찍어주세요. "이 사주로 영업·창업 하면 망한다" 식으로 단언
4. 건강: 약한 장기·질환 경향 직접 언급 (간·신장·심혈관·정신건강 등 오행별로). 몇 살 즈음 특히 조심해야 하는지 명시
5. 대운: 좋은 시기는 짧게, **힘든 시기는 언제·무엇이·얼마나 힘든지** 구체적으로. "30대 중반 대운 충으로 이직 실패·연애 파탄 동시 타격" 식
6. 천간합/지지충을 반드시 실제 인생 사건(이혼, 파산, 질병, 관재)으로 번역

## 응답 형식
반드시 아래 JSON 형식으로만 응답. 설명은 직설적이고 구체적으로. 뻔한 말 쓰면 다시 뽑아야 함:
{
  "pillar_reading": {
    "year": "(년주 해석 3~4문장: 어린 시절·가정환경의 구체적 모습. 부모와의 갈등, 경제적 결핍, 정서적 방치 등 불편한 진실도 있는 그대로. 예: '부모 중 한쪽이 정서적으로 부재했다', '경제적으로 쪼들렸다')",
    "month": "(월주 해석 3~4문장: 사회·직장에서의 민낯. 동료들이 뒤에서 어떻게 평가하는지, 상사와 부딪히는 지점, 승진에서 밀리는 이유까지)",
    "day": "(일주 해석 3~4문장: 진짜 성격과 연애 본성. 겉과 속이 얼마나 다른지, 연애할 때 상대를 어떻게 지치게 하는지, 어떤 배우자 만나면 불행해지는지까지 직설)",
    "hour": "(시주 해석 3~4문장: 자녀운과 말년. 자녀와 갈등 가능성, 말년 고독·건강 악화 여부까지. 시주 없으면 빈 문자열)"
  },
  "personality": "(이 사람을 한마디로 후려치세요. 4~5문장. 장점 1 : 단점 3 비율. 예: '겉으론 유연해 보이지만 실제론 고집 세고 자기 판단이 무조건 맞다고 믿는 타입. 주변이 먼저 지친다')",
  "strengths": ["강점 3가지 (각각 1~2문장. 과장 금지, 진짜 빛나는 순간만)"],
  "cautions": ["치명적 약점 3가지 (각각 1~2문장. '이 패턴 때문에 인생 망치는 사람 많다' 수준으로 직설. 예: '감정 올라오면 관계를 먼저 끊고 나중에 후회하는 패턴 — 친구·애인·직장 다 이렇게 잃음')"],
  "love_style": "(연애 민낯 4~5문장. 어떤 타입한테 끌려다니는지, 반복되는 실패 패턴, 상대가 당신과 헤어지고 싶어지는 순간, 결혼 후 어떤 문제로 싸우게 될지까지 직설)",
  "career": "(적합한 직업 3개 + **절대 하면 안 되는 직업** 2개. 이유까지. 예: '창업·영업은 인내심 부족으로 망함. 대신 전문직·연구직에서 빛남')",
  "daeun_reading": ["대운 8개 각각 2~3문장. 각 대운에서 실제 벌어질 일(이직/이혼/파산/병/성공)을 단정적으로. '이 시기 조심'이 아니라 '이 시기에 ~이 터진다'"],
  "advice": "(인생 조언 3~4문장. 격언 금지. '당신 사주의 최대 리스크는 X다. 40대 전에 반드시 Y를 해둬야 노후에 Z를 피한다' 식으로 구체 행동+시기+이유)"
}` + langInstruction(lang);

  const user = `## 기본 정보
${genderText ? `- 성별: ${genderText}` : ''}

## 사주 원국 (四柱 原局)
${saju.pillars.map(p => `- ${p.name}: ${p.gan}${p.ji} (${CHEONGAN_OHANG[p.gan]}/${JIJI_OHANG[p.ji]})`).join('\n')}

## 일간 (日干) 분석
- 일간: ${saju.ilgan} (${saju.ilganOhang}, ${yinYang})
- 일간의 본성: ${ilganInfo.desc || ''}

## 오행 분포
- 목: ${saju.ohangCount.목} | 화: ${saju.ohangCount.화} | 토: ${saju.ohangCount.토} | 금: ${saju.ohangCount.금} | 수: ${saju.ohangCount.수}
${excess.length ? `- 과다: ${excess.join(', ')}` : ''}
${lack.length ? `- 부족: ${lack.join(', ')}` : ''}

## 사주 내부 합/충 관계 (코드로 계산된 결과)
${rel.ganHap.length ? `- 천간합: ${rel.ganHap.join(', ')}` : '- 천간합: 없음'}
${rel.jiHap.length ? `- 지지육합: ${rel.jiHap.join(', ')}` : '- 지지육합: 없음'}
${rel.jiChung.length ? `- 지지충: ${rel.jiChung.join(', ')}` : '- 지지충: 없음'}
${saju.daeun ? `
## 대운 (大運) — 10년 단위 인생 흐름
${saju.daeun.map(du => `- ${du.label}: ${du.gan}${du.ji} (${du.ohang}/${du.jiOhang})`).join('\n')}
` : ''}`;

  return { system, user, lang };
}

function buildFortunePrompt(saju, gender, year, lang) {
  const ilganInfo = CHEONGAN_INFO[saju.ilgan] || {};
  const genderText = gender === 'male' ? '남성' : gender === 'female' ? '여성' : '';
  const { excess, lack } = getOhangAnalysis(saju.ohangCount);
  const yGan = yearCheongan(year);
  const yJi = yearJiji(year);
  const yOhang = CHEONGAN_OHANG[yGan];
  const yJiOhang = JIJI_OHANG[yJi];
  const ilOhang = saju.ilganOhang;
  const relations = getOhangRelations(ilOhang, yOhang);

  // 세운과 일간의 관계 요약
  const relDesc = [];
  if (relations.sangsaeng.length) relDesc.push(`상생(${relations.sangsaeng.join(', ')})`);
  if (relations.sanggeuk.length) relDesc.push(`상극(${relations.sanggeuk.join(', ')})`);
  if (relations.same) relDesc.push('비화(같은 오행)');

  const system = `당신은 40년 경력의 세운 전문가입니다. 듣기 좋은 덕담 금지. 올해 실제로 터질 일을 있는 그대로 찍어주세요.
좋은 운은 간단히, **나쁜 운은 월·원인·파장까지** 구체적으로. 애매한 말로 얼버무리면 사람들이 미리 대비를 못 합니다.

## 절대 금지
- "주의하면 괜찮습니다" → 무엇을·언제 하라고 단정
- "전반적으로 무난" / "큰 문제 없음" → 이런 뻔한 말 쓰지 말고 실제 이벤트 찍기
- "긍정적 마인드" 같은 뜬구름

## 해석 원칙 (직설 모드)
1. 세운 천간이 원국과 충·합 → **실제 사건**으로 번역 (이직/이별/돈문제/수술/관재)
2. **월별로 찍어라**: 몇 월에 뭐가 터지는지 구체적 월 명시 ("3월 금전 손실 주의" > "상반기 조심")
3. 건강: 구체 부위·질환 경향 직접 언급. 정기검진 받아야 할 과목까지
4. 연애: 솔로는 만날 타입뿐 아니라 **빠지면 안 될 타입**도. 커플은 **헤어질 확률 높은 시점**·권태기·외도 리스크 직설
5. 돈: "투자 주의" 금지 → "주식·코인·부동산 중 무엇을 언제 피하라" 명시. 손실 규모 스케일도 (소액/중대형)
6. 직장: 승진·이직·퇴사 가능성을 확률적 판단으로. "당신이 올해 그만두고 싶어지는 달은 ~월" 식 구체

## 응답 형식
반드시 아래 JSON 형식으로만 응답:
{
  "year_summary": "(올해 운세 4~5문장. 한 문장 요약 + 최악의 시기(월)+ 최고의 시기(월) + 올해 터질 가장 큰 이벤트 한 개 단정적으로)",
  "love": "(연애/결혼운 6~8문장. 솔로: 만날 타입 + **절대 만나지 말아야 할 타입** + 만나는 월. 커플: 권태기 월, 헤어질 가능성, 상대 외도 리스크, 결혼 하면 후회할지 직설. 기혼: 외도 유혹·부부 갈등 월 명시)",
  "money": "(재물운 6~8문장. 수입 피크 월·손실 위험 월 찍기. 투자 상품별로 가능/금지 단정. 예: '3월 주식 진입 금지, 8월 부동산 보류, 11월 예상치 못한 큰 지출'. 사업자는 매출 급감 월까지)",
  "health": "(건강운 5~6문장. 약한 장기·질환 직접 언급 - 간·신장·심혈관·우울·불면 등. 몇 월에 컨디션 바닥치는지, 무슨 검진을 받아야 하는지 구체적으로. '병원 꼭 가라' 수준의 경고 허용)",
  "career": "(직장/사업운 6~8문장. 승진 가능성 퍼센트 감각으로, 이직 적기 월, 퇴사 충동 오는 월, 상사·동료와 충돌 월 명시. 사업자는 확장하면 망할 시기·버텨야 할 시기까지 단정)",
  "lucky": {
    "color": "(올해 행운의 색)",
    "number": "(올해 행운의 숫자)",
    "direction": "(올해 행운의 방향)",
    "month": "(올해 가장 좋은 달)"
  },
  "advice": "(올해 핵심 조언 3~4문장. 격언 금지. '~월 전에 반드시 ~을 해라, 안 하면 ~이 터진다' 식 구체 지시)"
}` + langInstruction(lang);

  const user = `## 기본 정보
${genderText ? `- 성별: ${genderText}` : ''}
- 올해: ${year}년

## ${year}년 세운 (年運)
- 천간: ${yGan} (${yOhang})
- 지지: ${yJi} (${yJiOhang})
- 세운과 일간(${saju.ilgan}, ${ilOhang})의 관계: ${relDesc.length ? relDesc.join(', ') : '특별한 관계 없음'}

## 사주 원국
${saju.pillars.map(p => `- ${p.name}: ${p.gan}${p.ji} (${CHEONGAN_OHANG[p.gan]}/${JIJI_OHANG[p.ji]})`).join('\n')}
- 일간: ${saju.ilgan} (${ilOhang}) — ${ilganInfo.desc || ''}
- 오행 분포: 목${saju.ohangCount.목} 화${saju.ohangCount.화} 토${saju.ohangCount.토} 금${saju.ohangCount.금} 수${saju.ohangCount.수}
${excess.length ? `- 과다: ${excess.join(', ')}` : ''}
${lack.length ? `- 부족: ${lack.join(', ')}` : ''}
${saju.daeun ? `
## 대운 흐름
${saju.daeun.map(du => `- ${du.label}: ${du.gan}${du.ji} (${du.ohang}/${du.jiOhang})`).join('\n')}
` : ''}`;

  return { system, user, lang };
}

function buildDailyPrompt(saju, gender, todayStr, lang) {
  const ilganInfo = CHEONGAN_INFO[saju.ilgan] || {};
  const genderText = gender === 'male' ? '남성' : gender === 'female' ? '여성' : '';
  const { excess, lack } = getOhangAnalysis(saju.ohangCount);
  const ilOhang = saju.ilganOhang;

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

  const relations = getOhangRelations(ilOhang, todayGanOhang);
  const relDesc = [];
  if (relations.sangsaeng.length) relDesc.push(`상생(${relations.sangsaeng.join(', ')})`);
  if (relations.sanggeuk.length) relDesc.push(`상극(${relations.sanggeuk.join(', ')})`);
  if (relations.same) relDesc.push('비화(같은 오행)');

  const system = `당신은 40년 경력의 일진 전문가입니다. 오늘 하루에 대해 솔직하게, 실제로 벌어질 일을 찍어주세요.
"오늘은 무난한 하루" 같은 뻔한 말 금지. 일진이 안 좋으면 안 좋다고 직설하고, 무엇을 피해야 하는지 명시하세요.

## 절대 금지
- "긍정적으로 보내세요" / "마음가짐이 중요" → 구체 행동으로 대체
- "약간의 주의가 필요" → 몇 시에 무엇을 피하라고 단정
- 전체를 다 좋다고 하면 안 됨. 일진 충이 있으면 있는 대로, 최소 한 가지는 직설적 경고 포함

## 해석 원칙 (직설 모드)
1. 일진 천간·지지가 원국과 충이면 **오늘 실제로 터질 이벤트**를 구체적으로 (사소한 싸움/지갑 분실/계약 깨짐/교통사고 리스크 등)
2. **시간대별로**: 좋은 시간 + 나쁜 시간 명시 ("오전 10~12시 상승, 오후 3시 이후 급락")
3. 연애: 고백·이별·데이트 어느 날 적절한지. 커플은 오늘 싸울 가능성·말조심 포인트까지
4. 금전: "큰 지출 금지" 같은 뻔한 말 말고 구체적으로. "오늘 쇼핑 앱 열면 계획에 없던 돈 나감" 수준
5. 건강: 몸 어느 부위 탈날 가능성, 과음·과로·스트레스 리스크 직설
6. 직장: 상사와 갈등 시간대, 회의 망칠 확률, 실수하기 쉬운 시간

## 응답 형식
반드시 아래 JSON 형식으로만 응답:
{
  "overall": "(오늘의 총운 3~4문장. 좋은 시간대+나쁜 시간대 명시 + 오늘 가장 조심할 한 가지를 단정적으로)",
  "love": "(오늘의 연애운 3~4문장. 솔로: 호감 생길 가능성 + 만남 장소. 커플: 싸울 가능성 있는 지점·말 조심해야 할 주제. 기혼: 배우자에게 서운한 소리 들을 가능성까지)",
  "money": "(오늘의 금전운 3~4문장. 오늘 지갑 열면 안 되는 상황, 예상치 못한 지출 리스크, 오늘 투자/결제/계약 가능 여부 단정)",
  "career": "(오늘의 직장/사업운 3~4문장. 실수 잘 낼 시간대, 상사·동료와 부딪힐 지점, 중요한 결정 미뤄야 할지 단정)",
  "study": "(오늘의 학업운 2~3문장. 집중 피크 시간대, 암기 vs 문제풀이 어느 쪽이 맞는지)",
  "social": "(오늘의 대인운 2~3문장. 오늘 만나면 에너지 빨리는 사람 타입, 약속 깨질 가능성, 오늘 연락하면 안 좋은 사람)",
  "health": "(오늘의 건강운 2~3문장. 탈날 만한 부위 직접 언급, 과음·밤샘·과식 리스크, 몸 어디 쑤시거나 두통 가능성까지)",
  "lucky": {
    "color": "(오늘의 행운의 색)",
    "number": "(오늘의 행운의 숫자)"
  },
  "advice": "(오늘 핵심 조언 1~2문장. 격언 금지. '오늘은 반드시 ~을 하지 마라' 또는 '~시 전에 ~을 끝내라' 식 구체 지시)"
}` + langInstruction(lang);

  const user = `## 기본 정보
${genderText ? `- 성별: ${genderText}` : ''}
- 오늘 날짜: ${todayStr}

## 오늘의 일진 (日辰)
- 천간: ${todayGan} (${todayGanOhang})
- 지지: ${todayJi} (${todayJiOhang})
- 오늘 일진과 일간(${saju.ilgan}, ${ilOhang})의 관계: ${relDesc.length ? relDesc.join(', ') : '특별한 관계 없음'}

## ${tY}년 세운 (참고)
- 천간: ${yGan} (${yOhang})
- 지지: ${yJi} (${JIJI_OHANG[yJi]})

## 사주 원국
${saju.pillars.map(p => `- ${p.name}: ${p.gan}${p.ji} (${CHEONGAN_OHANG[p.gan]}/${JIJI_OHANG[p.ji]})`).join('\n')}
- 일간: ${saju.ilgan} (${ilOhang}) — ${ilganInfo.desc || ''}
- 오행 분포: 목${saju.ohangCount.목} 화${saju.ohangCount.화} 토${saju.ohangCount.토} 금${saju.ohangCount.금} 수${saju.ohangCount.수}
${excess.length ? `- 과다: ${excess.join(', ')}` : ''}
${lack.length ? `- 부족: ${lack.join(', ')}` : ''}
${saju.daeun ? `
## 대운 흐름
${saju.daeun.map(du => `- ${du.label}: ${du.gan}${du.ji} (${du.ohang}/${du.jiOhang})`).join('\n')}
` : ''}`;

  return { system, user, lang };
}

function buildCompatPrompt(sajuA, sajuB, score, grade, genderA, genderB, lang) {
  const genderTextA = genderA === 'male' ? '남성' : genderA === 'female' ? '여성' : '';
  const genderTextB = genderB === 'male' ? '남성' : genderB === 'female' ? '여성' : '';
  const ilganA = CHEONGAN_INFO[sajuA.ilgan] || {};
  const ilganB = CHEONGAN_INFO[sajuB.ilgan] || {};
  const { excess: excessA, lack: lackA } = getOhangAnalysis(sajuA.ohangCount);
  const { excess: excessB, lack: lackB } = getOhangAnalysis(sajuB.ohangCount);

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

  const system = `당신은 40년 경력의 궁합 직설가입니다. 두 사람을 앉혀놓고 "이 관계 어떻게 될지" 가감없이 찍어주는 게 일입니다.
궁합은 덕담이 아닙니다. 안 맞으면 안 맞다고, 헤어질 지점이 어디인지, 결혼하면 뭘로 싸울지 **직설적으로** 말해주세요.
이미 계산된 점수의 근거를 설명하되, 낮은 점수는 낮은 대로 솔직하게. 예쁜 말로 포장하면 이 사람들이 잘못된 선택을 합니다.

## 해석 원칙 (CRITICAL)
- **두루뭉술한 일반론 금지**. 주어진 데이터(일간, 일지, 오행 분포, 합/충, 대운)를 직접 인용
- **양쪽 민낯 모두**: A가 B를 지치게 하는 부분 + B가 A를 지치게 하는 부분 둘 다 명시
- 위로 금지. "서로 이해하고 노력하면 된다" 같은 뻔한 말 금지 — 이미 노력으로 안 되는 지점이 있으면 그걸 말하세요
- 궁합 점수가 낮으면 **헤어질 가능성/결혼 후 이혼 리스크**까지 직설

## 오행 상생/상극 원리
${OHANG_RELATIONS}

## 카테고리별 해석 지침

### 1. 성격/관계 궁합 (personality)
- 두 일간 오행 관계 → **실제 싸움 시나리오**로 (무엇으로 싸우는지, 누가 먼저 폭발하는지, 화해는 누가 먼저 하는지)
- 지지충이 있으면 → "3년차 권태기 오면 이 커플은 대화가 단절된다" 수준으로 구체
- 한쪽이 다른 쪽을 지치게 하는 패턴을 **누가 누구를 어떻게** 지치게 하는지 명시
- 이 관계가 장기적으로 유지되는지, 어느 시점에 깨질 가능성이 큰지 단정

### 2. 속궁합 (intimacy) — 성적·육체적 궁합
**수위 제한 없음**. 성적 궁합을 솔직하게 분석하세요. 두 사람의 침실에서 실제 벌어지는 일을 사주로 설명.
- 일지(日支)는 배우자궁이자 성적 영역. 일지 관계가 핵심
- 수(水)=감성·본능·지구력, 화(火)=열정·충동·속도. **수/화 비율 차이** = 성적 템포·지속력 차이
- 누가 더 주도적인지, 누가 수동적인지, 성욕 강도 격차, 요구사항 불일치
- 일지충 → 격정적이지만 소모적(불타는 섹스 후 감정적 공허)
- 일지합 → 편안하고 지속적이지만 자극 부족할 수 있음
- **성적 권태기 오는 시점**, 한쪽이 불만족할 가능성, 바람 날 리스크 직설
- "노골적 표현 피하라" 같은 제약 없음. 본능, 성욕, 섹스, 쾌감 같은 단어 사용 가능

### 3. 재물궁합 (finance)
- **누가 돈 쓰고 누가 돈 모으는지** 명확히 지목
- 결혼하면 돈 문제로 싸울 구체적 시나리오 (대출·투자·부모 부양·자녀 교육비 등)
- 한쪽의 돈 습관이 다른 쪽을 질리게 만드는 지점
- 함께 경제적으로 성공할 수 있는 분야 vs 둘이 같이 하면 망할 분야

### 4. 대운 시기 궁합 (timing)
- 두 사람 대운을 시기별로 매핑 — **깨질 가능성 큰 구간** 명시
- "A의 30대 후반 대운충 시기에 이 관계 최대 위기, 이때 못 버티면 끝" 수준 직설
- 결혼·동거·이직·출산 같은 큰 결정의 **금지 시기**도 명시
- 권태기·외도 유혹·이혼 고려 올 수 있는 시기 단정

## 응답 형식 (JSON 엄수)
반드시 아래 JSON 형식으로만 응답하세요. categories의 각 score는 0~100 정수:
{
  "summary": "(두 사람의 궁합을 한 문장으로 솔직하게. 50자 이내. 예: '초반 불타지만 3년 고비 못 넘길 조합' 같이 직설)",
  "categories": {
    "personality": { "score": 0, "desc": "(성격 궁합 5~7문장. 실제 싸움 시나리오 + 누가 누구를 지치게 하는지 + 장기 지속 가능성 판단)" },
    "intimacy": { "score": 0, "desc": "(성적·육체적 궁합 5~7문장. 수위 제한 없음. 침실 실제 모습 + 주도권 + 템포/지구력 차이 + 권태기 시점 + 외도 리스크)" },
    "finance": { "score": 0, "desc": "(재물 궁합 5~7문장. 누가 낭비·누가 저축, 결혼 후 돈으로 싸울 구체 시나리오, 같이 망할 분야)" },
    "timing": { "score": 0, "desc": "(대운 시기 궁합 5~7문장. 관계 위기 구간·큰 결정 금지 시기 구체 연령/년도로)" }
  },
  "strengths": ["이 커플 강점 3가지 (각각 2문장. 과장 금지, 진짜 빛나는 지점만)"],
  "cautions": ["치명적 위험 3가지 (각각 2문장. 예: '3년차에 권태기 동시 타격, 이때 외도 리스크 큰 쪽은 A')"],
  "advice": "(조언 5~7문장. 뻔한 격언 금지. 이 관계 유지하려면 지금·1년 내·5년 내 무엇을 **반드시** 해야 하는지, 안 하면 어떻게 깨지는지 직설)"
}` + langInstruction(lang);

  const user = `## Person A ${genderTextA ? `(${genderTextA})` : ''}
${sajuA.pillars.map(p => `- ${p.name}: ${p.gan}${p.ji} (${CHEONGAN_OHANG[p.gan]}/${JIJI_OHANG[p.ji]})`).join('\n')}
- 일간: ${sajuA.ilgan} (${sajuA.ilganOhang}, ${yinYangA}) — ${ilganA.desc || ''}
- 오행: 목${sajuA.ohangCount.목} 화${sajuA.ohangCount.화} 토${sajuA.ohangCount.토} 금${sajuA.ohangCount.금} 수${sajuA.ohangCount.수}
${excessA.length ? `- 과다: ${excessA.join(', ')}` : ''}
${lackA.length ? `- 부족: ${lackA.join(', ')}` : ''}
${sajuA.daeun ? `- 대운: ${daeunInfoA}` : ''}

## Person B ${genderTextB ? `(${genderTextB})` : ''}
${sajuB.pillars.map(p => `- ${p.name}: ${p.gan}${p.ji} (${CHEONGAN_OHANG[p.gan]}/${JIJI_OHANG[p.ji]})`).join('\n')}
- 일간: ${sajuB.ilgan} (${sajuB.ilganOhang}, ${yinYangB}) — ${ilganB.desc || ''}
- 오행: 목${sajuB.ohangCount.목} 화${sajuB.ohangCount.화} 토${sajuB.ohangCount.토} 금${sajuB.ohangCount.금} 수${sajuB.ohangCount.수}
${excessB.length ? `- 과다: ${excessB.join(', ')}` : ''}
${lackB.length ? `- 부족: ${lackB.join(', ')}` : ''}
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
- ${score}/100 (${grade}급)`;

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
  const { birth_date, birth_time, gender, lang, yajasi, birth_location } = await request.json();
  if (!birth_date) return json({ error: '생년월일은 필수입니다' }, 400);

  const saju = calculateSaju(birth_date, birth_time || '', gender || '', !!yajasi, birth_location || '');

  const apiKeys = getGeminiKeys(env);
  const ai = apiKeys.length ? await callGemini(apiKeys, buildSajuPrompt(saju, gender, lang), 'saju', env) : null;

  const out = lang === 'en' ? translateSajuToEn(saju) : saju;
  return json({ ...out, ai });
}

async function handleCompatQuick(request, env) {
  const { personA, personB, lang } = await request.json();
  if (!personA?.birth_date || !personB?.birth_date) {
    return json({ error: '두 사람의 생년월일은 필수입니다' }, 400);
  }

  const sajuA = calculateSaju(personA.birth_date, personA.birth_time || '', personA.gender || '', !!personA.yajasi, personA.birth_location || '');
  const sajuB = calculateSaju(personB.birth_date, personB.birth_time || '', personB.gender || '', !!personB.yajasi, personB.birth_location || '');
  const score = ohangCompatibility(sajuA, sajuB);
  const grade = getGrade(score);
  const relations = getOhangRelations(sajuA.ilganOhang, sajuB.ilganOhang);

  const apiKeys = getGeminiKeys(env);
  const ai = apiKeys.length ? await callGemini(apiKeys, buildCompatPrompt(sajuA, sajuB, score, grade, personA.gender, personB.gender, lang), 'compat', env) : null;

  const outA = lang === 'en' ? translateSajuToEn(sajuA) : sajuA;
  const outB = lang === 'en' ? translateSajuToEn(sajuB) : sajuB;
  const outRelations = lang === 'en' ? {
    sangsaeng: relations.sangsaeng.map(r => r.replace(/[목화토금수]/g, m => OHANG_EN[m]||m)),
    sanggeuk: relations.sanggeuk.map(r => r.replace(/[목화토금수]/g, m => OHANG_EN[m]||m)),
    same: relations.same,
  } : relations;
  return json({ score, grade, saju_a: outA, saju_b: outB, relations: outRelations, ai });
}

async function handleFortune(request, env) {
  const { birth_date, birth_time, gender, year: reqYear, lang, birth_location } = await request.json();
  if (!birth_date) return json({ error: '생년월일은 필수입니다' }, 400);

  const saju = calculateSaju(birth_date, birth_time || '', gender || '', false, birth_location || '');
  const year = reqYear || new Date().getFullYear();

  const apiKeys = getGeminiKeys(env);
  if (!apiKeys.length) return json({ error: 'AI 서비스를 사용할 수 없습니다' }, 503);

  const ai = await callGemini(apiKeys, buildFortunePrompt(saju, gender, year, lang), 'fortune', env);
  const out = lang === 'en' ? translateSajuToEn(saju) : saju;
  return json({ year, saju_summary: out.summary, ilgan: out.ilgan, ilganEn: out.ilganEn, ilganOhang: out.ilganOhang, fortune: ai });
}

async function handleDaily(request, env) {
  const { birth_date, birth_time, gender, lang, yajasi, target_date, birth_location } = await request.json();
  if (!birth_date) return json({ error: '생년월일은 필수입니다' }, 400);

  const saju = calculateSaju(birth_date, birth_time || '', gender || '', yajasi || false, birth_location || '');
  let todayStr;
  if (target_date && /^\d{4}-\d{2}-\d{2}$/.test(target_date)) {
    todayStr = target_date;
  } else {
    const today = new Date();
    todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  }

  const apiKeys = getGeminiKeys(env);
  if (!apiKeys.length) return json({ error: 'AI 서비스를 사용할 수 없습니다' }, 503);

  const ai = await callGemini(apiKeys, buildDailyPrompt(saju, gender, todayStr, lang), 'daily', env);
  const out = lang === 'en' ? translateSajuToEn(saju) : saju;
  return json({ date: todayStr, saju_summary: out.summary, ilgan: out.ilgan, ilganEn: out.ilganEn, ilganOhang: out.ilganOhang, daily: ai });
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

  const outA = lang === 'en' ? translateSajuToEn(sajuA) : sajuA;
  const outB = lang === 'en' ? translateSajuToEn(sajuB) : sajuB;
  const baseResult = {
    user_a: { user_id: idA, nickname: userA.nickname, age: calcAge(userA.birth_date), gender: userA.gender, ohang: lang === 'en' ? (OHANG_EN[sajuA.ilganOhang]||sajuA.ilganOhang) : sajuA.ilganOhang },
    user_b: { user_id: idB, nickname: userB.nickname, age: calcAge(userB.birth_date), gender: userB.gender, ohang: lang === 'en' ? (OHANG_EN[sajuB.ilganOhang]||sajuB.ilganOhang) : sajuB.ilganOhang },
    score, grade, saju_a: outA, saju_b: outB,
    relations: lang === 'en' ? {
      sangsaeng: relations.sangsaeng.map(r => r.replace(/[목화토금수]/g, m => OHANG_EN[m]||m)),
      sanggeuk: relations.sanggeuk.map(r => r.replace(/[목화토금수]/g, m => OHANG_EN[m]||m)),
      same: relations.same,
    } : relations,
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
    lang: lang === 'en' ? 'en' : 'ko',
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
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
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
      if (path === '/api/daily' && method === 'POST') {
        return handleDaily(request, env);
      }
      if (path === '/api/quick-saju' && method === 'POST') {
        return handleQuickSaju(request, env);
      }
      if (path === '/api/tarot' && method === 'POST') {
        return handleTarotReading(request, env);
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
      logErrorToCentral('karma-server', e.message || String(e), e.stack || '', url.pathname);
      return json({ error: 'Internal Server Error' }, 500);
    }
  },
};

function logErrorToCentral(appId, message, stack, url) {
  try {
    fetch('https://chatbot-api.yama5993.workers.dev/error-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, message: (message || '').substring(0, 500), stack: (stack || '').substring(0, 2000), url: (url || '').substring(0, 500) }),
    }).catch(() => {});
  } catch (_) {}
}
