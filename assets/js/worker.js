// Karma Worker — Single-file vanilla Cloudflare Worker
// Karma API Worker (vanilla JS, no framework)

// ============================================================
// CORS & Response Helpers
// ============================================================

const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const CF_ACCOUNT_ID = 'f5ced3498c8b7674581b5c9987f31585';
const CF_GATEWAY_NAME = 'archer-gateway';
const GEMINI_URL = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_NAME}/google-ai-studio/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// ============================================================
// Gemini Context Caching
// ============================================================
let _cacheTableReady = false;
let _perfStatsTableReady = false;

function stableHash(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getGeminiCacheScope(apiKey) {
  return stableHash(apiKey);
}

async function createGeminiCache(apiKey, staticContent, model, ttl = '600s') {
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

async function updateGeminiCacheTTL(apiKey, cacheName, ttl = '600s') {
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
            "UPDATE gemini_cache SET expires_at = datetime('now', '+10 minutes') WHERE cache_key = ?"
          ).bind(cacheKey).run().catch(() => {});
        }
      });
      return { name: existing.cache_name, hit: true };
    }
    await env.DB.prepare('DELETE FROM gemini_cache WHERE cache_key = ?').bind(cacheKey).run();
  }
  const cacheName = await createGeminiCache(apiKey, staticContent, model);
  if (cacheName) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO gemini_cache (cache_key, cache_name, expires_at) VALUES (?, ?, datetime('now', '+10 minutes'))"
    ).bind(cacheKey, cacheName).run();
    return { name: cacheName, hit: false };
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
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
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

  // 일간 하나만 보던 기존 점수에서 일지와 전체 원국 합·충까지 반영한다.
  if (SANGSAENG[oh1] === oh2 || SANGSAENG[oh2] === oh1) score += 10;
  if (SANGGEUK[oh1] === oh2 || SANGGEUK[oh2] === oh1) score -= 8;
  if (oh1 === oh2) score += 4;

  const dayA = saju1.pillars.find(p => p.name === '일주');
  const dayB = saju2.pillars.find(p => p.name === '일주');
  if (dayA && dayB) {
    const dayRel = analyzeSajuRelations([dayA], [dayB]);
    score += Math.min(8, dayRel.ganHap.length * 4);
    score += Math.min(10, dayRel.jiHap.length * 10);
    score -= Math.min(10, dayRel.jiChung.length * 10);
    if (dayA.ji === dayB.ji) score += 3;
  }

  const wholeRel = analyzeSajuRelations(saju1.pillars, saju2.pillars);
  score += Math.min(8, wholeRel.ganHap.length * 2);
  score += Math.min(12, wholeRel.jiHap.length * 3);
  score -= Math.min(15, wholeRel.jiChung.length * 3);

  for (const key of Object.keys(OHANG)) {
    if (saju1.ohangCount[key] === 0 && saju2.ohangCount[key] >= 2) score += 3;
    if (saju2.ohangCount[key] === 0 && saju1.ohangCount[key] >= 2) score += 3;
  }

  // 전통 명리 관계를 요약한 휴리스틱이므로 과도한 0/100 확정값은 피한다.
  return Math.max(20, Math.min(95, Math.round(score)));
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
  const staticPromptHash = isStructured ? stableHash(prompt.system || '') : '';
  const cacheKey = isStructured ? `karma:${_caller}:${(prompt.lang || 'ko')}:sys${staticPromptHash}` : null;
  const _sysSize = isStructured ? (prompt.system || '').length : 0;
  const _contentsSize = promptText.length;

  // 캐싱 시도
  const errors = [];
  for (let i = 0; i < apiKeys.length; i++) {
    const isLast = i === apiKeys.length - 1;
    try {
      let cachedContentName = null;
      let cacheHit = false;
      let scopedCacheKey = cacheKey;

      if (isStructured && _env?.DB) {
        try {
          scopedCacheKey = `${cacheKey}:kh${getGeminiCacheScope(apiKeys[i])}`;
          const cacheResult = await getOrCreateCache(_env, scopedCacheKey, prompt.system, GEMINI_MODEL, apiKeys[i]);
          if (cacheResult?.name) {
            cachedContentName = cacheResult.name;
            cacheHit = !!cacheResult.hit;
          }
        } catch (e) {
          console.warn('[GeminiCache] Error:', e.message);
        }
      }

      const payload = {
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 16384,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingLevel: "high" },
        },
      };
      if (cachedContentName) {
        payload.cachedContent = cachedContentName;
      } else if (isStructured) {
        payload.systemInstruction = { parts: [{ text: prompt.system }] };
      }
      const body = JSON.stringify(payload);
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
      const candidate = data.candidates?.[0] || {};
      const finishReason = candidate.finishReason || 'N/A';
      const parts = candidate.content?.parts || [];
      const allText = parts.filter(p => !p.thought).map(p => p.text || '').join('');
      if (!allText) {
        errors.push(`key${i+1}: empty response (finishReason: ${finishReason})`);
        if (!isLast) continue;
        await logApiError(_env, `[${endpoint}] Gemini 빈 응답`, errors.join('\n'), { endpoint, promptPreview, keyCount: apiKeys.length });
        return null;
      }
      const normalizedText = allText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const jsonMatch = normalizedText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        errors.push(`key${i+1}: JSON not found (finishReason: ${finishReason})`);
        if (!isLast) continue;
        await logApiError(_env, `[${endpoint}] Gemini JSON 미발견`, `${errors.join('\n')}\n응답: ${allText.slice(0, 300)}`, { endpoint, promptPreview, keyCount: apiKeys.length });
        return null;
      }
      try {
        const _parsed = JSON.parse(jsonMatch[0]);
        const _um = data.usageMetadata || {};
        logPerfStats(_env, _ctx, {
          app: `karma:${endpoint}`,
          cache_key: scopedCacheKey,
          cache_hit: cacheHit ? 1 : 0,
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
        errors.push(`key${i+1}: ${e2.message} (finishReason: ${finishReason})`);
        if (!isLast) continue;
        await logApiError(
          _env,
          `[${endpoint}] Gemini JSON 파싱 실패`,
          `${errors.join('\n')}\n응답: ${jsonMatch[0].slice(0, 300)}`,
          { endpoint, promptPreview, keyCount: apiKeys.length }
        );
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
- Treat the exact three-card order, direction, and question as this reading's fingerprint. A different card, reversed state, or question must change the core conflict, advice, and keywords.
- The first sentence of overall must name at least two drawn cards and explain their cause-effect link. Do not start with a generic life theme.
- If there is no question, choose one dominant real-life arena from this exact card combination; do not cover love, career, and personal growth with equal generic weight.
- Keywords must come from this exact spread, not a reusable tarot keyword list.

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
- 뽑힌 3장의 카드명, 순서, 정/역방향, 질문을 이번 리딩의 지문으로 삼으세요. 카드 한 장, 방향 하나, 질문 하나가 달라지면 핵심 갈등·조언·키워드도 달라져야 합니다.
- overall 첫 문장은 반드시 뽑힌 카드 2장 이상을 직접 언급하고, 그 카드들이 어떤 원인→결과 흐름을 만드는지로 시작하세요. 일반적인 인생 주제로 시작하지 마세요.
- 질문이 없는 경우에도 카드 조합에서 가장 강한 현실 영역 하나를 골라 깊게 파세요. 연애·직업·성장을 같은 비중의 무난한 설명으로 나열하지 마세요.
- keywords는 이번 카드 조합에서 나온 단어만 고르세요. 재사용 가능한 타로 공통 키워드 목록처럼 만들지 마세요.

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
    generationConfig: { temperature: 0.6, thinkingConfig: { thinkingLevel: "high" } },
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
1. 사진 품질: 정면성, 초점, 조명, 얼굴 가림, 표정 과장, 필터/보정 여부를 먼저 판정. 품질이 낮으면 해당 부위 점수를 낮추고 "사진상 확인 어려움"이라고 명시.
2. 삼정: 상정(이마, 대략 30세 전후까지), 중정(눈썹~코·광대, 대략 40대까지), 하정(인중~턱, 50대 이후)을 나누어 균형을 봅니다. 세 구간 중 유난히 짧거나 긴 곳, 눌린 곳, 안정된 곳을 summary에 반영하세요.
3. 이마/부모궁/관록궁: 이마의 높이·폭·윤택함·굴곡·흉터/잡티·헤어라인 가림 여부를 봅니다. 전통적으로 초년운, 부모 도움, 학습력, 관록/사회적 상승 기반과 연결하지만, 머리카락에 가려지면 추정하지 마세요.
4. 눈/눈썹: 관상에서 눈은 가장 큰 비중을 둡니다. 눈빛 선명도, 눈꼬리 방향, 눈 사이 거리, 눈두덩이 여유, 좌우 높낮이, 눈썹 농도·끊김·간격을 관찰하세요. 눈 사이가 넓으면 여유/포용, 좁으면 예민함/근심 경향처럼 전통 해석으로만 설명하세요.
5. 눈 형태 분류: 삼백안/사백안, 돌출눈, 짝눈, 눈썹과 눈이 가까운 압안, 물기 있는 도화안 같은 분류는 사진상 명확할 때만 "그런 인상"으로 언급하세요. 폭력성, 범죄성, 정신질환, 음란성 같은 낙인 표현은 금지.
6. 코/재백궁: 산근(미간 아래 코뿌리), 콧대, 준두(코끝), 난대·정위(콧방울), 정면 콧구멍 노출 여부를 봅니다. 전통적으로 재물 관리, 자존심, 현실 감각과 연결하되 실제 부자/가난 확정처럼 쓰지 마세요.
7. 입/인중: 입 크기, 입꼬리, 입술 두께와 색감, 인중 길이·선명도·흉터 여부를 봅니다. 전통적으로 언변, 식복, 관계 표현, 자식/후배 복으로 해석하되, 치아 개수처럼 사진에서 보이지 않는 정보는 언급하지 마세요.
8. 턱/광대/하정: 턱의 길이·폭·안정감, 광대 돌출과 균형, 하관의 힘을 봅니다. 전통적으로 의지력, 중년 이후 기반, 관계 지속력과 연결하세요.
9. 귀/점/피부/머리카락: 사진에 보이는 경우만 참고하세요. 귀는 초년 기반, 점은 위치별 전통 해석, 피부는 윤택함·탁함·피로감, 머리카락은 정돈감 정도로만 다루세요. 얼굴 점이나 피부색으로 불행·사망·질병을 단정하지 마세요.
10. 물형/동물형 관상은 전체 인상을 설명하는 보조 비유로만 사용하세요. 특정 동물형을 이유로 인격·운명을 확정하지 마세요.
11. 관찰→전통 해석→현실 조언 순서로 쓰세요. 관찰 근거 없이 성격이나 운세만 말하면 실패입니다.
12. 건강은 의학적 진단처럼 쓰지 말고, 얼굴에 보이는 피로감·긴장감·생활관리 주의 정도로만 표현하세요. 특정 질병 확정, 수명, 발병 나이 단정은 금지.
13. 얼굴 사진으로 실존 인물을 식별하거나 닮은 유명인을 추정하지 마세요. celebrity_resemblance는 항상 빈 문자열로 두세요.`;
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

async function handleFaceReading(request, env) {
  const { image, mimeType, gender, age, lang } = await request.json();
  if (!image) return json({ error: '이미지가 필요합니다' }, 400);

  const apiKeys = getGeminiKeys(env);
  if (!apiKeys.length) return json({ error: 'AI 서비스를 사용할 수 없습니다' }, 503);

  // R2에 이미지 저장 (비동기, 분석 결과에 영향 없음)
  const r2Key = await saveImageToR2(env, image, mimeType || 'image/jpeg', 'face');

  const prompt = `당신은 사진에서 관찰 가능한 얼굴 특징과 전통 관상 해석을 명확히 구분하는 관상 해설가입니다. 관상은 오락·자기성찰용 전통 해석이며 실제 성격, 능력, 건강, 재산, 가족관계, 미래를 판정하지 않습니다.

중요: 먼저 사진에 사람의 얼굴이 있는지 확인하세요. 얼굴이 없거나 사람이 아닌 사진이면 반드시 다음 JSON만 반환:
{"error": "얼굴 사진이 아닙니다. 사람의 정면 얼굴이 보이는 사진을 업로드해주세요."}

얼굴이 확인되면 관상 감정 진행.
${gender ? `성별: ${gender}` : ''}${age ? `, 나이대: ${age}` : ''}

${faceExpertRubric()}

## 사진별 차별화 필수
- 먼저 사진에서 실제로 보이는 특징을 관찰하고, 그 특징을 모든 해석의 근거로 사용하세요.
- \`visual_evidence\`에는 사진에서 확인한 구체 관찰값을 8개 이상 넣으세요. 예: 이마 노출/폭, 눈매 방향, 눈썹 간격, 콧대와 코끝, 입술 두께, 턱선, 광대, 얼굴형, 좌우 비대칭, 조명/가림 여부.
- 각 \`categories.desc\`의 첫 문장은 반드시 해당 부위의 실제 관찰 특징으로 시작하세요. 관찰 없이 성격·운세부터 말하지 마세요.
- 사진에서 잘 안 보이는 부위는 지어내지 말고 "사진상 확인 어려움"이라고 쓰고 점수를 50~65 사이로 낮추세요.
- 점수는 사진별로 45~95 범위에서 분산하세요. 모든 항목을 75~85점으로 몰지 마세요.
- 아래 예시 문구를 그대로 베끼지 마세요. 실제 사진 특징이 다르면 요약·점수도 달라져야 합니다.
- summary, fortune, advice는 각각 \`visual_evidence\`의 실제 관찰값 1개 이상과 연결하세요. 관찰값과 연결되지 않는 운세 문장은 삭제하거나 더 구체화하세요.
- overall_score와 categories 점수는 보이는 특징에서 나온 결론이어야 합니다. 사진이 정상이라는 이유만으로 A등급/80점대에 몰지 마세요.

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
6. 전체 인상 - 종합 관상

반드시 아래 JSON 형식으로만 응답:
{
  "overall_score": 85,
  "overall_grade": "A",
  "quality_assessment": "(사진 품질, 정면성, 가림/조명/보정 여부. 분석 한계가 있으면 명시)",
  "visual_evidence": ["(사진에서 확인한 구체 특징 1)", "(사진에서 확인한 구체 특징 2)", "(최소 8개)"],
  "summary": "(한줄 요약. 가장 뚜렷한 관찰 2개와 전통적 상징을 구분해 설명. 실제 인생사 단정 금지)",
  "categories": [
    {"name": "이마 (천정)", "score": 80, "desc": "(2~3문장. 실제 형태 관찰 후 전통적인 초년·학습 상징을 조건부로 설명)"},
    {"name": "눈 (눈매)", "score": 85, "desc": "(2~3문장. 실제 형태 관찰 후 전통적인 관계 표현 상징을 조건부로 설명)"},
    {"name": "코 (준두)", "score": 75, "desc": "(2~3문장. 실제 형태 관찰 후 전통적인 현실감각·재물관리 상징을 조건부로 설명)"},
    {"name": "입 (입술)", "score": 90, "desc": "(2~3문장. 실제 형태 관찰 후 전통적인 의사표현 상징을 조건부로 설명)"},
    {"name": "턱/광대", "score": 80, "desc": "(2~3문장. 실제 형태 관찰 후 전통적인 지속력 상징을 조건부로 설명)"},
    {"name": "전체 인상", "score": 85, "desc": "(2~3문장. 관찰 가능한 균형을 요약하고 전통 해석과 현실 확인 질문을 분리)"}
  ],
  "fortune": {
    "wealth": "(코·하관 관찰을 근거로 전통 관상에서 말하는 재물 관리 상징과 현실적인 예산 점검 질문 3~4문장. 부·손실·시기 예측 금지)",
    "career": "(이마·눈·하관 관찰을 근거로 전통 관상에서 말하는 업무 표현 경향과 현실 점검 질문 3~4문장. 능력·직업 적합성 단정 금지)",
    "love": "(눈·입·하관 관찰을 근거로 전통 관상에서 말하는 관계 표현 상징과 대화 질문 3~4문장. 실제 성격·관계 결과 단정 금지)",
    "health": "(건강운 3~4문장. 사진상 보이는 피로감·긴장감·생활관리 주의 중심. 특정 질환 확정이나 발병 나이 단정 금지)"
  },
  "advice": "(관상 기반 조언 3~4문장. 격언 금지. '이 상은 ~을 반드시 피하라, ~부터 ~을 준비해라' 식 구체 지시)",
  "celebrity_resemblance": ""
}` + langInstruction(lang);

  const result = await callGeminiVision(apiKeys, prompt, image, mimeType || 'image/jpeg', env);
  if (!result) return json({ error: 'AI 분석에 실패했습니다. 얼굴이 잘 보이는 정면 사진을 사용해주세요.' }, 500);
  if (result._apiError) return json({ error: result._apiError }, 500);
  if (result.error) return json({ error: result.error }, 400);
  return json({ ...result, r2_key: r2Key });
}

async function handlePalmReading(request, env) {
  const { image, mimeType, hand, dominant, gender, lang } = await request.json();
  if (!image) return json({ error: '이미지가 필요합니다' }, 400);

  const apiKeys = getGeminiKeys(env);
  if (!apiKeys.length) return json({ error: 'AI 서비스를 사용할 수 없습니다' }, 503);

  const r2Key = await saveImageToR2(env, image, mimeType || 'image/jpeg', 'palm');
  const handContext = buildPalmHandContext(hand, dominant, lang);

  const prompt = `당신은 사진에서 관찰 가능한 손바닥 특징과 전통 수상학 해석을 명확히 구분하는 손금 해설가입니다. 손금은 오락·자기성찰용 전통 해석이며 실제 성격, 건강, 수명, 재산, 관계, 미래 사건을 판정하지 않습니다.

중요: 먼저 사진에 사람의 손바닥이 있는지 확인하세요. 손바닥이 없거나 손금이 보이지 않는 사진이면 반드시 다음 JSON만 반환:
{"error": "손바닥 사진이 아닙니다. 손금이 잘 보이도록 손을 펴서 촬영한 사진을 업로드해주세요."}

손바닥이 확인되면 손금 감정 진행.
${handContext}${gender ? `\n성별: ${gender}` : ''}

${palmExpertRubric()}

## 사진별 차별화 필수
- 먼저 사진에서 실제로 보이는 손바닥 특징을 관찰하고, 그 특징을 모든 해석의 근거로 사용하세요.
- \`visual_evidence\`에는 사진에서 확인한 구체 관찰값을 8개 이상 넣으세요. 예: 손바닥 폭, 손가락 길이/벌어짐, 엄지 각도, 생명선 깊이/끊김, 두뇌선 기울기, 감정선 위치, 운명선 선명도, 태양선 유무, 결혼선 가시성, 굳은살/흉터/조명/흐림 여부.
- 각 \`lines.desc\`의 첫 문장은 반드시 해당 손금의 실제 관찰 특징으로 시작하세요. 관찰 없이 운세부터 말하지 마세요.
- 보이지 않는 선은 지어내지 말고 \`length\`를 "확인 어려움"으로 두고 점수를 45~60 사이로 낮추세요.
- 점수는 사진별로 45~95 범위에서 분산하세요. 모든 항목을 75~85점으로 몰지 마세요.
- 주 사용 손과 촬영한 손이 같으면 후천운, 다르면 선천운 기준을 반드시 반영하세요.
- 아래 예시 문구를 그대로 베끼지 마세요. 실제 손금 특징이 다르면 요약·점수·조언도 달라져야 합니다.
- summary 첫 문장은 손 형태 또는 가장 뚜렷한 손금 1개와, 가장 약하거나 확인 어려운 손금 1개를 함께 언급해 이 손만의 대비를 만드세요.
- fortune의 wealth/career/love/health는 각각 관련 손금명 또는 손 형태 관찰값을 하나 이상 근거로 삼으세요. 근거 없이 일반 운세처럼 말하지 마세요.
- overall_score와 각 lines 점수는 관찰된 선명도·끊김·가시성에서 나와야 합니다. 손바닥 사진이 정상이라는 이유만으로 A등급/80점대에 몰지 마세요.

## 직설 모드 원칙
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

반드시 아래 JSON 형식으로만 응답:
{
  "overall_score": 82,
  "overall_grade": "A",
  "quality_assessment": "(사진 품질, 손바닥 전체 노출, 초점, 조명, 손금 선명도, 분석 한계)",
  "visual_evidence": ["(사진에서 확인한 구체 특징 1)", "(사진에서 확인한 구체 특징 2)", "(최소 8개)"],
  "summary": "(한줄 요약. 가장 뚜렷한 선 1개와 약하거나 확인 어려운 선 1개의 실제 관찰 및 전통적 상징. 사건·연령 예측 금지)",
  "lines": [
    {"name": "생명선", "score": 85, "length": "길다/보통/짧다/확인 어려움", "desc": "(2~3문장. 생명선의 실제 깊이·연속성·호 형태 관찰부터 시작. 활력·회복력 중심, 질병/사고 단정 금지)"},
    {"name": "두뇌선", "score": 78, "length": "길다/보통/짧다/확인 어려움", "desc": "(2~3문장. 실제 선의 시작·길이·기울기 관찰 후 전통적인 사고 방식 상징을 조건부로 설명. 정신건강 추정 금지)"},
    {"name": "감정선", "score": 88, "length": "길다/보통/짧다/확인 어려움", "desc": "(2~3문장. 감정선의 위치·곡선·끊김 관찰부터 시작. 연애 패턴과 상처 처리 방식 중심으로 설명)"},
    {"name": "운명선", "score": 75, "length": "뚜렷/보통/희미/확인 어려움", "desc": "(2~3문장. 중앙 세로선의 선명도 관찰부터 시작. 직업 안정성·전환이 잦은 경향으로 설명)"},
    {"name": "태양선", "score": 70, "length": "있음/희미/없음/확인 어려움", "desc": "(2~3문장. 실제 가시성 관찰 후 전통적인 성취 표현 상징을 조건부로 설명. 성공 예측 금지)"},
    {"name": "결혼선", "score": 80, "length": "1개/2개/여러개/확인 어려움", "desc": "(2~3문장. 새끼손가락 아래 측면이 보이는 경우만 해석. 안 보이면 확인 어렵다고 명시)"}
  ],
  "hand_shape": {"type": "물형/불형/흙형/금형/나무형", "desc": "(손 형태로 본 성격 민낯 2~3문장)"},
  "fortune": {
    "wealth": "(재물 관련 선의 관찰과 전통적 돈 관리 상징, 현실 예산 점검 질문 3~4문장. 부·손실·시기 예측 금지)",
    "career": "(운명선·두뇌선 관찰과 전통적 업무 방식 상징, 현실 점검 질문 3~4문장. 직업 적합성·성공 단정 금지)",
    "love": "(연애/결혼운 3~4문장. 감정선·결혼선 가시성에 근거해 관계 방식, 맞는 상대 유형, 갈등 주의점을 경향으로 설명)",
    "health": "(건강운 3~4문장. 손의 긴장도·선명도·생활 리듬 기반 주의. 특정 질병 확정, 사고 시기 단정 금지. 필요 시 일반적 검진 권장)"
  },
  "advice": "(손금 기반 조언 3~4문장. 격언 금지. 관찰된 손금 특징에 연결해 이번 달/올해 실천할 행동을 구체적으로)"
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

function langInstruction(lang) {
  if (lang === 'en') return '\n\nIMPORTANT: You MUST respond entirely in English. All text values in the JSON must be in English. Keep Korean Saju terms (like 갑, 을, 목, 화 etc.) but add English translations in parentheses.';
  return '';
}

function buildSajuPrompt(saju, gender, lang, birthDate) {
  const ilganInfo = CHEONGAN_INFO[saju.ilgan] || {};
  const { excess, lack, dominant, sparse } = getOhangAnalysis(saju.ohangCount);
  const yinYang = ilganInfo.yin ? '음(陰)' : '양(陽)';
  const genderText = gender === 'male' ? '남성' : gender === 'female' ? '여성' : '';
  const rel = analyzeInternalRelations(saju.pillars);
  const evidence = buildSajuEvidence(saju);
  const activeDaeun = formatActiveDaeun(saju, birthDate, new Date());

  const system = `당신은 사주 원국의 계산값을 근거로 설명하는 명리 해설가입니다. 좋은 말이나 나쁜 말을 만들기보다 입력된 원국이 다른 이유를 정확히 구분하세요.

## 정확성 원칙
- 입력에 없는 과거 사건, 가족사, 질병, 이혼, 파산, 범죄, 수명과 미래 사건을 사실처럼 만들지 마세요.
- 현재 계산기는 겉으로 드러난 천간·지지 오행 수, 합·충, 대운을 제공합니다. 지장간·월령 가중치·12운성 전체가 없으므로 신강/신약, 용신, 희신을 확정하지 마세요.
- 성격·연애·직업·대운은 전통 명리 관점의 경향으로 설명하고, 의료·법률·재무 결론은 내리지 마세요.
- 시주가 없으면 hour는 빈 문자열로 두고 자녀운·말년을 추정하지 마세요.
- 각 핵심 문단에는 반드시 [근거: 실제 입력값]을 한 번 이상 표시하세요. 근거가 없으면 쓰지 마세요.

## 오행 상생/상극 기본 원리
${OHANG_RELATIONS}

## 개인화 필수 (누구나 비슷한 사주 풀이면 실패)
- 해석의 출발점은 원국 지문, 일간 역할별 오행 수, 우세·희소 오행, 내부 합/충, 현재 대운입니다. 성별이나 일반 사주 상식만으로 결론을 만들지 마세요.
- pillar_reading, personality, love_style, career, daeun_reading, advice는 각각 최소 하나 이상의 입력 근거(특정 주柱, 일간, 과다/부족 오행, 합/충, 대운 구간)를 직접 반영해야 합니다.
- strengths와 cautions는 같은 말을 긍정/부정으로 바꾼 목록이 아니어야 합니다. 서로 다른 근거에서 나온 강점 3개와 위험 3개를 골라야 합니다.
- 단순히 0개/4개 이상일 때만 차이를 찾지 마세요. 매번 제공된 우세·희소 오행과 십성 역할 수를 비교해 이 원국만의 대비를 잡으세요.
- 첫 문단은 원국 지문의 특정 두 신호가 함께 만드는 경향으로 시작하세요. 다른 사주에 그대로 붙일 수 있는 문장은 삭제하세요.

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

function buildFortunePrompt(saju, gender, year, lang, birthDate) {
  const ilganInfo = CHEONGAN_INFO[saju.ilgan] || {};
  const genderText = gender === 'male' ? '남성' : gender === 'female' ? '여성' : '';
  const { excess, lack, dominant, sparse } = getOhangAnalysis(saju.ohangCount);
  const evidence = buildSajuEvidence(saju);
  const activeDaeun = formatActiveDaeun(saju, birthDate, `${year}-07-01`);
  const monthlySignals = buildMonthlySignals(saju, year);
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

## 개인화 필수 (가장 중요 — 누구나 비슷한 결과가 나오면 실패다)
- 세운(올해 천간·지지)은 모든 사람이 똑같이 공유하는 값이다. 세운의 오행만 설명하는 도입부는 절대 금지(예: "올해는 ○(○) 기운이 강한 해라..." 금지).
- 해석의 출발점은 항상 **이 사람의 원국**(일간, 역할별 표면 수, 최다·최저 오행, 내부 합충)이다. 세운은 방아쇠이며 현재 대운을 함께 고려하라.
- 일간·오행 구성이 다른 두 사람은 같은 해라도 결론이 확연히 달라야 한다. 같은 세운이 어떤 역할을 늘리는지 원국 지문과 비교하라.
- year_summary 첫 문장은 반드시 원국의 특정 신호와 세운 또는 현재 대운의 관계를 직접 언급하며 시작하라.
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
- 관계 키: 일간관계=${relDesc.length ? relDesc.join('/') : '없음'}; 일지관계=${branchRelDesc.length ? branchRelDesc.join('/') : '없음'}; 합충=${yearRel.ganHap.concat(yearRel.jiHap, yearRel.jiChung).join('/') || '없음'}`;

  return { system, user, lang };
}

function buildDailyPrompt(saju, gender, todayStr, lang, birthDate) {
  const ilganInfo = CHEONGAN_INFO[saju.ilgan] || {};
  const genderText = gender === 'male' ? '남성' : gender === 'female' ? '여성' : '';
  const { excess, lack, dominant, sparse } = getOhangAnalysis(saju.ohangCount);
  const evidence = buildSajuEvidence(saju);
  const activeDaeun = formatActiveDaeun(saju, birthDate, todayStr);
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

## 개인화 필수 (가장 중요 — 누구나 비슷한 결과가 나오면 실패다)
- 오늘의 일진(천간·지지)은 모든 사람이 똑같이 공유하는 값이다. 일진의 오행만 설명하는 도입부는 절대 금지(예: "오늘은 ○(○) 기운이 강한 날이라..." 금지).
- 해석의 출발점은 항상 **이 사람의 원국**(일간, 역할별 표면 수, 최다·최저 오행, 합충)과 현재 대운이다. 일진이 이 지문을 어떻게 건드리는지로 풀어라.
- 일간·오행 구성이 다른 두 사람은 같은 날이라도 결론이 확연히 달라야 한다. 오행 과다/부족이 다르면 조심할 영역·시간대·조언이 달라진다.
- overall 첫 문장은 반드시 원국의 특정 신호와 오늘 일진 또는 현재 대운의 관계를 언급하며 시작하라.
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
- 관계 키: 일간관계=${relDesc.length ? relDesc.join('/') : '없음'}; 일지관계=${branchRelDesc.length ? branchRelDesc.join('/') : '없음'}; 합충=${dailyRel.ganHap.concat(dailyRel.jiHap, dailyRel.jiChung).join('/') || '없음'}`;

  return { system, user, lang };
}

function buildCompatPrompt(sajuA, sajuB, score, grade, genderA, genderB, lang, birthDateA, birthDateB) {
  const genderTextA = genderA === 'male' ? '남성' : genderA === 'female' ? '여성' : '';
  const genderTextB = genderB === 'male' ? '남성' : genderB === 'female' ? '여성' : '';
  const ilganA = CHEONGAN_INFO[sajuA.ilgan] || {};
  const ilganB = CHEONGAN_INFO[sajuB.ilgan] || {};
  const { excess: excessA, lack: lackA } = getOhangAnalysis(sajuA.ohangCount);
  const { excess: excessB, lack: lackB } = getOhangAnalysis(sajuB.ohangCount);
  const evidenceA = buildSajuEvidence(sajuA);
  const evidenceB = buildSajuEvidence(sajuB);
  const today = new Date();
  const activeDaeunA = formatActiveDaeun(sajuA, birthDateA, today);
  const activeDaeunB = formatActiveDaeun(sajuB, birthDateB, today);

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

## 조합별 차별화 필수
- summary 첫 문장은 반드시 A와 B의 정확한 일간/오행 관계 또는 가장 큰 합·충 하나를 직접 언급하며 시작하세요. "잘 맞지만 노력 필요" 같은 관계 공통문으로 시작하면 실패입니다.
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
  const { birth_date, birth_time, gender, lang, yajasi, birth_location } = await request.json();
  if (!birth_date) return json({ error: '생년월일은 필수입니다' }, 400);

  const saju = calculateSaju(birth_date, birth_time || '', gender || '', !!yajasi, birth_location || '');

  const apiKeys = getGeminiKeys(env);
  const ai = apiKeys.length ? await callGemini(apiKeys, buildSajuPrompt(saju, gender, lang, birth_date), 'saju', env) : null;

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
  const ai = apiKeys.length ? await callGemini(apiKeys, buildCompatPrompt(sajuA, sajuB, score, grade, personA.gender, personB.gender, lang, personA.birth_date, personB.birth_date), 'compat', env) : null;

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
  const { birth_date, birth_time, gender, year: reqYear, lang, yajasi, birth_location } = await request.json();
  if (!birth_date) return json({ error: '생년월일은 필수입니다' }, 400);

  const saju = calculateSaju(birth_date, birth_time || '', gender || '', !!yajasi, birth_location || '');
  const year = reqYear || new Date().getFullYear();

  const apiKeys = getGeminiKeys(env);
  if (!apiKeys.length) return json({ error: 'AI 서비스를 사용할 수 없습니다' }, 503);

  const ai = await callGemini(apiKeys, buildFortunePrompt(saju, gender, year, lang, birth_date), 'fortune', env);
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

  const ai = await callGemini(apiKeys, buildDailyPrompt(saju, gender, todayStr, lang, birth_date), 'daily', env);
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

  const sajuA = calculateSaju(userA.birth_date, userA.birth_time || '', userA.gender || '');
  const sajuB = calculateSaju(userB.birth_date, userB.birth_time || '', userB.gender || '');
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

  const ai = await callGemini(apiKeys, buildCompatPrompt(sajuA, sajuB, score, grade, userA.gender, userB.gender, lang, userA.birth_date, userB.birth_date), 'match-detail', env);
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
