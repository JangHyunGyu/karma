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

// ---------------------------------------------------------------------------
// 7. Exports (compatible with both module and concatenation patterns)
// ---------------------------------------------------------------------------

// If used as a module
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getExactSolarTerms,
    getExactSolarTerm,
    getSajuMonthExact,
    getSajuYearExact,
    JEOLGI_NAMES,
    JEOLGI_LONGITUDES,
    // Expose internals for testing
    _internal: {
      dateToJD,
      jdToDate,
      sunLongitudeHighAccuracy,
      findSunLongitudeJD,
      deltaT,
    }
  };
}
