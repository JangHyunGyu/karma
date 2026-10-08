'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { daysInCalendarMonth, getLunarYearInfo } = require('../js/lunar.js');

test('birth date months use real lunar and solar lengths', () => {
  const info = getLunarYearInfo(2049);
  const shortMonth = info.months.findIndex(days => days === 29) + 1;
  assert.ok(shortMonth > 0);
  assert.equal(daysInCalendarMonth('lunar', 2049, String(shortMonth)), 29);
  assert.equal(daysInCalendarMonth('solar', 2023, '2'), 28);
  assert.equal(daysInCalendarMonth('solar', 2024, 2), 29);
  assert.equal(daysInCalendarMonth('solar', 2026, 'nope'), 31);

  let leapYear = 0;
  for (let year = 1920; year <= 2050; year += 1) {
    const yearInfo = getLunarYearInfo(year);
    if (yearInfo.leapMonth && yearInfo.leapMonthDays === 29) {
      leapYear = year;
      break;
    }
  }
  assert.ok(leapYear);
  const leapInfo = getLunarYearInfo(leapYear);
  assert.equal(daysInCalendarMonth('lunar', leapYear, `leap_${leapInfo.leapMonth}`), 29);
  assert.equal(daysInCalendarMonth('lunar', leapYear, String(leapInfo.leapMonth)), leapInfo.months[leapInfo.leapMonth - 1]);
});
