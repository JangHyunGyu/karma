// Karma 공통 컴포넌트

// ===== API 설정 =====
const API_BASE = 'https://karma-api.yama5993.workers.dev';

// ===== 프론트엔드 에러 자동 수집 =====
window.onerror = function(message, source, line, col, error) {
  try {
    navigator.sendBeacon(API_BASE + '/api/error-log', JSON.stringify({
      message: String(message),
      source: source,
      line: line,
      col: col,
      stack: error?.stack || '',
      page: location.pathname,
      userAgent: navigator.userAgent,
    }));
  } catch {}
};
window.addEventListener('unhandledrejection', function(e) {
  try {
    navigator.sendBeacon(API_BASE + '/api/error-log', JSON.stringify({
      message: 'Unhandled Promise: ' + String(e.reason),
      source: '',
      line: 0,
      col: 0,
      stack: e.reason?.stack || '',
      page: location.pathname,
      userAgent: navigator.userAgent,
    }));
  } catch {}
});

// ===== 언어 헬퍼 =====
function _L(ko, en) { return (document.documentElement.lang || 'ko') === 'en' ? en : ko; }

// ===== localStorage =====
const STORAGE_KEY = 'karma_input';

function saveInputs() {
  const data = {};
  const y = document.getElementById('birthYear');
  const m = document.getElementById('birthMonth');
  const d = document.getElementById('birthDay');
  if (y) data.year = y.value;
  if (m) data.month = m.value;
  if (d) data.day = d.value;
  const g = document.getElementById('gender');
  const t = document.getElementById('birthTime');
  if (g) data.gender = g.value;
  if (t) data.birthTime = t.value;
  data.calendarType = _calendarType;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function restoreInputs() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (data.year) setComboValue('birthYear', data.year);
    if (data.month) setComboValue('birthMonth', data.month);
    if (data.day) setComboValue('birthDay', data.day);
    if (data.gender) setComboValue('gender', data.gender);
    if (data.birthTime) setComboValue('birthTime', data.birthTime);
    if (data.calendarType === 'lunar') {
      const lunarBtn = document.querySelector('.cal-btn[data-cal="lunar"]');
      if (lunarBtn) setCalendarType(lunarBtn, 'lunar');
    }
  } catch {}
}

function setComboValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = value;
  // 커스텀 콤보 트리거도 업데이트
  const combo = el.closest('.combo');
  if (combo) {
    const trigger = combo.querySelector('.combo-trigger span:first-child');
    const opt = combo.querySelector(`.combo-option[data-value="${value}"]`);
    if (trigger && opt) {
      trigger.textContent = opt.textContent;
      combo.querySelectorAll('.combo-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    }
  }
}

function getBirthDate() {
  const y = document.getElementById('birthYear')?.value;
  const mVal = document.getElementById('birthMonth')?.value;
  const d = document.getElementById('birthDay')?.value;
  if (!y || !mVal || !d) return '';
  if (_calendarType === 'lunar' && typeof lunarToSolar === 'function') {
    const isLeap = mVal.startsWith('leap_');
    const m = isLeap ? parseInt(mVal.replace('leap_', '')) : parseInt(mVal);
    const solar = lunarToSolar(+y, m, +d, isLeap);
    if (!solar) { alert(_L('유효하지 않은 음력 날짜입니다', 'Invalid lunar date')); return ''; }
    return `${solar.year}-${String(solar.month).padStart(2,'0')}-${String(solar.day).padStart(2,'0')}`;
  }
  return `${y}-${String(mVal).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

// ===== 커스텀 콤보박스 =====
function createCombo(selectEl) {
  if (!selectEl || selectEl.dataset.comboInit) return;
  selectEl.dataset.comboInit = '1';

  const combo = document.createElement('div');
  combo.className = 'combo';

  const options = Array.from(selectEl.options);
  const selectedOpt = options.find(o => o.selected) || options[0];

  // 트리거
  const trigger = document.createElement('div');
  trigger.className = 'combo-trigger';
  const _initLang = document.documentElement.lang || 'ko';
  const _initText = selectedOpt ? (selectedOpt.dataset[_initLang] || selectedOpt.textContent) : '';
  trigger.innerHTML = `<span>${_initText}</span><span class="combo-arrow">▾</span>`;

  // 드롭다운
  const dropdown = document.createElement('div');
  dropdown.className = 'combo-dropdown';
  const _lang = () => document.documentElement.lang || 'ko';
  const _optText = (el) => (el.dataset[_lang()] || el.dataset.ko || el.textContent);
  options.forEach(opt => {
    const div = document.createElement('div');
    div.className = 'combo-option' + (opt.selected ? ' selected' : '');
    if (opt.dataset.ko) div.dataset.ko = opt.dataset.ko;
    if (opt.dataset.en) div.dataset.en = opt.dataset.en;
    div.textContent = _optText(opt);
    div.dataset.value = opt.value;
    div.addEventListener('click', (e) => {
      e.stopPropagation();
      selectEl.value = opt.value;
      trigger.querySelector('span:first-child').textContent = _optText(div);
      dropdown.querySelectorAll('.combo-option').forEach(o => o.classList.remove('selected'));
      div.classList.add('selected');
      combo.classList.remove('open');
      selectEl.dispatchEvent(new Event('change'));
    });
    dropdown.appendChild(div);
  });

  // 드롭다운 위치 계산 (fixed 기반)
  function positionDropdown() {
    const rect = trigger.getBoundingClientRect();
    dropdown.style.left = rect.left + 'px';
    dropdown.style.width = rect.width + 'px';
    // 아래 공간이 부족하면 위로 열기
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    if (spaceBelow < 220 && rect.top > spaceBelow) {
      dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
      dropdown.style.top = 'auto';
      dropdown.style.maxHeight = Math.min(220, rect.top - 8) + 'px';
    } else {
      dropdown.style.top = (rect.bottom + 4) + 'px';
      dropdown.style.bottom = 'auto';
      dropdown.style.maxHeight = Math.min(220, spaceBelow) + 'px';
    }
  }

  // 토글
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    // 다른 콤보 닫기 + 부모 카드 클래스 제거
    document.querySelectorAll('.combo.open').forEach(c => {
      if (c !== combo) {
        c.classList.remove('open');
        const card = c.closest('.card');
        if (card) card.classList.remove('combo-active');
      }
    });
    combo.classList.toggle('open');
    // 부모 카드에 z-index 클래스 토글
    const parentCard = combo.closest('.card');
    if (parentCard) {
      if (combo.classList.contains('open')) {
        parentCard.classList.add('combo-active');
      } else {
        parentCard.classList.remove('combo-active');
      }
    }
    // fixed 위치 계산
    if (combo.classList.contains('open')) {
      positionDropdown();
      const sel = dropdown.querySelector('.selected');
      if (sel) {
        dropdown.scrollTop = sel.offsetTop - dropdown.offsetHeight / 2 + sel.offsetHeight / 2;
      }
    }
  });

  selectEl.style.display = 'none';

  const parent = selectEl.parentNode;
  parent.insertBefore(combo, selectEl);
  combo.appendChild(selectEl);
  combo.appendChild(trigger);
  combo.appendChild(dropdown);

  return combo;
}

// ===== 생년월일 셀렉트 =====
function createDateSelects(containerId, defY, defM, defD) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const thisYear = new Date().getFullYear();
  defY = defY || 1995; defM = defM || 1; defD = defD || 1;

  // 양력/음력 토글
  let html = '<div class="calendar-toggle">';
  html += '<button type="button" class="cal-btn active" data-cal="solar" data-ko="양력" data-en="Solar" onclick="setCalendarType(this,\'solar\')">' + _L('양력','Solar') + '</button>';
  html += '<button type="button" class="cal-btn" data-cal="lunar" data-ko="음력" data-en="Lunar" onclick="setCalendarType(this,\'lunar\')">' + _L('음력','Lunar') + '</button>';
  html += '</div>';
  // 년
  html += '<div class="date-select-group"><label data-ko="년" data-en="Year">' + _L('년','Year') + '</label><select id="birthYear" onchange="updateMonths();updateDays();saveInputs()">';
  for (let y = thisYear - 5; y >= thisYear - 100; y--) html += `<option value="${y}" ${y==defY?'selected':''}>${y}</option>`;
  html += '</select></div>';
  // 월
  html += '<div class="date-select-group"><label data-ko="월" data-en="Month">' + _L('월','Month') + '</label><select id="birthMonth" onchange="updateDays();saveInputs()">';
  for (let m = 1; m <= 12; m++) html += `<option value="${m}" ${m==defM?'selected':''}>${m}</option>`;
  html += '</select></div>';
  // 일
  html += '<div class="date-select-group"><label data-ko="일" data-en="Day">' + _L('일','Day') + '</label><select id="birthDay" onchange="saveInputs()">';
  const days = new Date(defY, defM, 0).getDate();
  for (let d = 1; d <= days; d++) html += `<option value="${d}" ${d==defD?'selected':''}>${d}</option>`;
  html += '</select></div>';

  container.innerHTML = html;

  // 커스텀 콤보로 변환
  container.querySelectorAll('select').forEach(s => createCombo(s));
}

// 양력/음력 토글
let _calendarType = 'solar';

function setCalendarType(btn, type) {
  _calendarType = type;
  const wrap = btn.closest('.calendar-toggle');
  wrap.querySelectorAll('.cal-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  // 라벨 업데이트
  const card = btn.closest('.card');
  if (card) {
    const label = card.querySelector('label[data-ko]');
    if (label) {
      label.setAttribute('data-ko', type === 'lunar' ? '생년월일 (음력)' : '생년월일 (양력)');
      label.setAttribute('data-en', type === 'lunar' ? 'Date of Birth (Lunar)' : 'Date of Birth (Solar)');
      label.textContent = _L(
        type === 'lunar' ? '생년월일 (음력)' : '생년월일 (양력)',
        type === 'lunar' ? 'Date of Birth (Lunar)' : 'Date of Birth (Solar)'
      );
    }
  }
  updateMonths();
  updateDays();
  saveInputs();
}

// 음력일 때 윤달을 월 드롭다운에 자동 추가
function updateMonths() {
  const monthSelect = document.getElementById('birthMonth');
  if (!monthSelect) return;
  const curVal = monthSelect.value;
  const y = parseInt(document.getElementById('birthYear')?.value || 2000);

  monthSelect.innerHTML = '';
  for (let m = 1; m <= 12; m++) {
    const opt = document.createElement('option');
    opt.value = String(m);
    opt.textContent = m;
    monthSelect.appendChild(opt);
    // 음력이고 이 달에 윤달이 있으면 추가
    if (_calendarType === 'lunar' && typeof hasLeapMonth === 'function' && hasLeapMonth(y, m)) {
      const leapOpt = document.createElement('option');
      leapOpt.value = 'leap_' + m;
      leapOpt.textContent = _L('윤' + m, 'Leap ' + m);
      monthSelect.appendChild(leapOpt);
    }
  }
  // 이전 선택 복원
  if (monthSelect.querySelector(`option[value="${curVal}"]`)) {
    monthSelect.value = curVal;
  } else {
    monthSelect.value = monthSelect.options[0]?.value || '1';
  }

  // 커스텀 콤보 드롭다운 재생성
  const combo = monthSelect.closest('.combo');
  if (combo) {
    const dropdown = combo.querySelector('.combo-dropdown');
    const trigger = combo.querySelector('.combo-trigger span:first-child');
    dropdown.innerHTML = '';
    Array.from(monthSelect.options).forEach(opt => {
      const div = document.createElement('div');
      div.className = 'combo-option' + (opt.value === monthSelect.value ? ' selected' : '');
      div.textContent = opt.textContent;
      div.dataset.value = opt.value;
      div.addEventListener('click', (e) => {
        e.stopPropagation();
        monthSelect.value = opt.value;
        trigger.textContent = opt.textContent;
        dropdown.querySelectorAll('.combo-option').forEach(o => o.classList.remove('selected'));
        div.classList.add('selected');
        combo.classList.remove('open');
        updateDays();
        saveInputs();
      });
      dropdown.appendChild(div);
    });
    const selOpt = monthSelect.options[monthSelect.selectedIndex];
    if (trigger && selOpt) trigger.textContent = selOpt.textContent;
  }
}

function updateDays() {
  const y = parseInt(document.getElementById('birthYear')?.value || 2000);
  const m = parseInt(document.getElementById('birthMonth')?.value || 1);
  const dayCombo = document.getElementById('birthDay')?.closest('.combo');
  const daySelect = document.getElementById('birthDay');
  if (!daySelect) return;

  const curDay = parseInt(daySelect.value) || 1;
  // 음력이면 음력 일수 사용 (기본 30일)
  const daysInMonth = (_calendarType === 'lunar') ? 30 : new Date(y, m, 0).getDate();
  const newDay = Math.min(curDay, daysInMonth);

  // select 옵션 재생성
  daySelect.innerHTML = '';
  for (let d = 1; d <= daysInMonth; d++) {
    const opt = document.createElement('option');
    opt.value = d; opt.textContent = _L(d + '일', d);
    if (d === newDay) opt.selected = true;
    daySelect.appendChild(opt);
  }

  // 커스텀 콤보 드롭다운 재생성
  if (dayCombo) {
    const dropdown = dayCombo.querySelector('.combo-dropdown');
    const trigger = dayCombo.querySelector('.combo-trigger span:first-child');
    dropdown.innerHTML = '';
    for (let d = 1; d <= daysInMonth; d++) {
      const div = document.createElement('div');
      div.className = 'combo-option' + (d === newDay ? ' selected' : '');
      div.textContent = _L(d + '일', d);
      div.dataset.value = d;
      div.addEventListener('click', (e) => {
        e.stopPropagation();
        daySelect.value = d;
        trigger.textContent = _L(d + '일', d);
        dropdown.querySelectorAll('.combo-option').forEach(o => o.classList.remove('selected'));
        div.classList.add('selected');
        dayCombo.classList.remove('open');
        saveInputs();
      });
      dropdown.appendChild(div);
    }
    trigger.textContent = _L(newDay + '일', newDay);
  }
}

// ===== 콤보 언어 전환 =====
function updateComboLang(lang) {
  document.querySelectorAll('.combo-option[data-ko][data-en]').forEach(opt => {
    opt.textContent = opt.dataset[lang] || opt.dataset.ko;
  });
  // 트리거(선택된 값)도 업데이트
  document.querySelectorAll('.combo').forEach(combo => {
    const selected = combo.querySelector('.combo-option.selected');
    const trigger = combo.querySelector('.combo-trigger span:first-child');
    if (selected && trigger && selected.dataset[lang]) {
      trigger.textContent = selected.dataset[lang];
    }
  });
}

// ===== 전체 select 자동 커스텀화 =====
function initAllCombos() {
  document.querySelectorAll('select:not([data-combo-init])').forEach(s => {
    if (!s.closest('.combo') && !s.closest('.date-selects') && !s.classList.contains('lang-select') && !s.closest('.lang-select-wrap')) {
      createCombo(s);
    }
  });
}

// 외부 클릭 시 닫기
document.addEventListener('click', () => {
  document.querySelectorAll('.combo.open').forEach(c => {
    c.classList.remove('open');
    const card = c.closest('.card');
    if (card) card.classList.remove('combo-active');
  });
});

// 스크롤 시 드롭다운 닫기 (드롭다운 내부 스크롤은 제외)
window.addEventListener('scroll', (e) => {
  if (e.target.closest && e.target.closest('.combo-dropdown')) return;
  document.querySelectorAll('.combo.open').forEach(c => {
    c.classList.remove('open');
    const card = c.closest('.card');
    if (card) card.classList.remove('combo-active');
  });
}, true);

// ===== 마침표 줄바꿈 =====
function formatSentences(el) {
  if (!el || !el.textContent.trim()) return;
  el.innerHTML = el.textContent
    .replace(/\. /g, '.<br>')
    .replace(/다\. /g, '다.<br>')
    .replace(/요\. /g, '요.<br>');
}

// AI 결과 텍스트에 마침표 줄바꿈 자동 적용
function applyLineBreaks() {
  document.querySelectorAll('#result p, #fortuneResult p, [id^="fortune"] p, [id^="ai"] p, #daeunAccordionContent p').forEach(p => {
    if (p.dataset.formatted) return;
    const text = p.textContent;
    if (text && text.length > 30) {
      p.innerHTML = text.replace(/다\.\s*/g, '다.<br>').replace(/요\.\s*/g, '요.<br>').replace(/니다\.<br>/g, '니다.<br><br>');
      p.dataset.formatted = '1';
    }
  });
}

// MutationObserver로 동적 콘텐츠 감지 (디바운스 적용)
let _lineBreakTimer = null;
const _lineBreakObserver = new MutationObserver(() => {
  if (_lineBreakTimer) clearTimeout(_lineBreakTimer);
  _lineBreakTimer = setTimeout(applyLineBreaks, 200);
});
document.addEventListener('DOMContentLoaded', () => {
  _lineBreakObserver.observe(document.body, { childList: true, subtree: true });
});
window.addEventListener('beforeunload', () => {
  _lineBreakObserver.disconnect();
});

// 초기화
document.addEventListener('DOMContentLoaded', () => {
  initAllCombos();
  restoreInputs();
});
