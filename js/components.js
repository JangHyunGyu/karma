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

// ===== 브라우저 언어 기반 자동 리다이렉트 (첫 방문 시) =====
(function() {
    if (localStorage.getItem('karma_lang')) return;
    var pageLang = (document.documentElement.lang || 'ko').substring(0, 2);
    var browserLang = (navigator.language || navigator.userLanguage || 'ko').substring(0, 2);
    var isKo = browserLang === 'ko';
    if (pageLang === 'ko' && !isKo) {
        var enLink = document.querySelector('link[hreflang="en"]');
        if (enLink) { localStorage.setItem('karma_lang', 'en'); location.replace(enLink.href); return; }
    } else if (pageLang === 'en' && isKo) {
        var koLink = document.querySelector('link[hreflang="ko"]');
        if (koLink) { localStorage.setItem('karma_lang', 'ko'); location.replace(koLink.href); return; }
    }
    localStorage.setItem('karma_lang', pageLang);
})();

// ===== 언어 전환 (hreflang 기반 페이지 리다이렉트) =====
function changeLang(lang) {
  localStorage.setItem('karma_lang', lang);
  var link = document.querySelector('link[hreflang="' + lang + '"]');
  if (link) { location.href = link.href; return; }
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-ko][data-en]').forEach(function(el) { el.textContent = el.dataset[lang]; });
  if (typeof updateComboLang === 'function') updateComboLang(lang);
}

// ===== 언어 헬퍼 =====
function _L(ko, en) { return (document.documentElement.lang || 'ko') === 'en' ? en : ko; }

// ===== 야자시 토글 활성/비활성 =====
function updateYajasiState(timeSelectId, yajasiWrapperId) {
  const timeEl = document.getElementById(timeSelectId);
  const wrap = document.getElementById(yajasiWrapperId);
  if (!timeEl || !wrap) return;
  const isJasi = timeEl.value === '00:00';
  wrap.style.opacity = isJasi ? '1' : '0.3';
  // pointer-events는 항상 auto (overlay가 클릭을 받아야 하므로)
  wrap.style.pointerEvents = 'auto';
  if (!isJasi) {
    const toggle = wrap.querySelector('input[type="checkbox"]');
    if (toggle && toggle.checked) {
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
    }
  }
  // 비활성 상태에서 클릭 시 안내 팝업 (overlay)
  if (!wrap._yajasiOverlay) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;inset:0;cursor:pointer;z-index:10';
    overlay.addEventListener('click', () => showYajasiHint());
    wrap.style.position = 'relative';
    wrap.appendChild(overlay);
    wrap._yajasiOverlay = overlay;
  }
  wrap._yajasiOverlay.style.display = isJasi ? 'none' : 'block';
}

function showYajasiHint() {
  if (document.getElementById('yajasiHintModal')) return;
  const modal = document.createElement('div');
  modal.id = 'yajasiHintModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;justify-content:center;align-items:center;padding:20px;animation:fadeIn 0.2s';
  modal.innerHTML = `
    <div style="background:linear-gradient(135deg,#1a1a2e,#16213e);border:1px solid rgba(201,160,68,0.3);border-radius:16px;padding:28px 24px;max-width:340px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.5)">
      <div style="font-size:2.2rem;margin-bottom:12px">🌙</div>
      <div style="font-size:1rem;font-weight:700;color:#ffd93d;margin-bottom:12px">${_L('야자시/조자시','Night/Morning Ja-si')}</div>
      <p style="font-size:0.82rem;color:#ccc;line-height:1.7;margin-bottom:8px">${_L(
        '태어난 시가 <b style="color:#ffd93d">자시(23:30~01:30)</b>인 분만 해당되는 옵션입니다.',
        'This option only applies to those born during <b style="color:#ffd93d">Ja-si (23:30~01:30)</b>.'
      )}</p>
      <div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:12px;margin-bottom:16px;text-align:left">
        <div style="font-size:0.75rem;color:#c9a044;font-weight:600;margin-bottom:6px">${_L('야자시란?','What is Night Ja-si?')}</div>
        <p style="font-size:0.78rem;color:#aaa;line-height:1.6;margin:0">${_L(
          '밤 11시 30분~새벽 1시 30분 사이에 태어난 분의 사주를 더 정확하게 계산하는 옵션입니다. 켜면 자정(0시)을 기준으로 날짜를 나눠서 일주를 계산합니다. 해당 시간대가 아니면 결과에 영향이 없습니다.',
          'An option for more accurate calculation for those born between 11:30 PM and 1:30 AM. When enabled, the date is split at midnight for day pillar calculation. No effect if born outside this time range.'
        )}</p>
      </div>
      <button onclick="document.getElementById('yajasiHintModal').remove()" style="background:linear-gradient(135deg,#c9a044,#b8860b);color:#fff;border:none;padding:10px 32px;border-radius:8px;font-size:0.85rem;font-weight:600;cursor:pointer">${_L('확인','OK')}</button>
    </div>`;
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

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
  const loc = document.getElementById('birthLocation');
  if (g) data.gender = g.value;
  if (t) data.birthTime = t.value;
  if (loc) data.birthLocation = loc.value;
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
    if (data.birthLocation) setComboValue('birthLocation', data.birthLocation);
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
  const _now = new Date();
  const thisYear = _now.getFullYear();
  defY = defY || thisYear; defM = defM || (_now.getMonth() + 1); defD = defD || _now.getDate();

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
      leapOpt.dataset.ko = '윤' + m;
      leapOpt.dataset.en = 'Leap ' + m;
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
      if (opt.dataset.ko) div.dataset.ko = opt.dataset.ko;
      if (opt.dataset.en) div.dataset.en = opt.dataset.en;
      div.textContent = (opt.dataset[document.documentElement.lang] || opt.textContent);
      div.dataset.value = opt.value;
      div.addEventListener('click', (e) => {
        e.stopPropagation();
        monthSelect.value = opt.value;
        trigger.textContent = (opt.dataset[document.documentElement.lang] || opt.textContent);
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
    opt.value = d;
    opt.dataset.ko = d + '일';
    opt.dataset.en = String(d);
    opt.textContent = _L(d + '일', d);
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
      div.dataset.ko = d + '일';
      div.dataset.en = String(d);
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

// ===== 출생 지역 (타임존 기반) =====
const LOCATION_OPTIONS = [
  { value: 'utc+12',   utc: '+12',   ko: '뉴질랜드, 피지',                                         en: 'New Zealand, Fiji' },
  { value: 'utc+11',   utc: '+11',   ko: '솔로몬제도, 뉴칼레도니아',                                en: 'Solomon Islands, New Caledonia' },
  { value: 'utc+10',   utc: '+10',   ko: '호주 동부 (시드니), 괌, 파푸아뉴기니',                    en: 'Australia East (Sydney), Guam, Papua New Guinea' },
  { value: 'utc+9.5',  utc: '+9:30', ko: '호주 중부 (애들레이드)',                                  en: 'Australia Central (Adelaide)' },
  { value: 'utc+9',    utc: '+9',    ko: '한국, 일본, 동티모르, 팔라우',                            en: 'Korea, Japan, East Timor, Palau' },
  { value: 'utc+8',    utc: '+8',    ko: '중국, 대만, 홍콩, 싱가포르, 필리핀, 말레이시아, 몽골',    en: 'China, Taiwan, Hong Kong, Singapore, Philippines, Malaysia, Mongolia' },
  { value: 'utc+7',    utc: '+7',    ko: '베트남, 태국, 캄보디아, 라오스, 인도네시아 서부 (자카르타)', en: 'Vietnam, Thailand, Cambodia, Laos, Indonesia West (Jakarta)' },
  { value: 'utc+6.5',  utc: '+6:30', ko: '미얀마 (양곤)',                                          en: 'Myanmar (Yangon)' },
  { value: 'utc+6',    utc: '+6',    ko: '방글라데시, 카자흐스탄 (알마티), 부탄',                   en: 'Bangladesh, Kazakhstan (Almaty), Bhutan' },
  { value: 'utc+5.75', utc: '+5:45', ko: '네팔 (카트만두)',                                        en: 'Nepal (Kathmandu)' },
  { value: 'utc+5.5',  utc: '+5:30', ko: '인도, 스리랑카',                                        en: 'India, Sri Lanka' },
  { value: 'utc+5',    utc: '+5',    ko: '파키스탄, 우즈베키스탄, 타지키스탄, 투르크메니스탄',       en: 'Pakistan, Uzbekistan, Tajikistan, Turkmenistan' },
  { value: 'utc+4',    utc: '+4',    ko: 'UAE (두바이), 오만, 조지아, 아르메니아, 아제르바이잔',     en: 'UAE (Dubai), Oman, Georgia, Armenia, Azerbaijan' },
  { value: 'utc+3.5',  utc: '+3:30', ko: '이란 (테헤란)',                                          en: 'Iran (Tehran)' },
  { value: 'utc+3',    utc: '+3',    ko: '러시아 (모스크바), 튀르키예, 사우디, 케냐, 이라크',        en: 'Russia (Moscow), Türkiye, Saudi Arabia, Kenya, Iraq' },
  { value: 'utc+2',    utc: '+2',    ko: '이집트, 남아공, 이스라엘, 그리스, 핀란드, 우크라이나',     en: 'Egypt, South Africa, Israel, Greece, Finland, Ukraine' },
  { value: 'utc+1',    utc: '+1',    ko: '독일, 프랑스, 이탈리아, 스페인, 네덜란드, 스웨덴, 폴란드, 나이지리아', en: 'Germany, France, Italy, Spain, Netherlands, Sweden, Poland, Nigeria' },
  { value: 'utc+0',    utc: '+0',    ko: '영국, 포르투갈, 아이슬란드, 가나, 모로코',                en: 'UK, Portugal, Iceland, Ghana, Morocco' },
  { value: 'utc-3',    utc: '-3',    ko: '브라질 동부 (상파울루), 아르헨티나, 칠레',                en: 'Brazil East (São Paulo), Argentina, Chile' },
  { value: 'utc-4',    utc: '-4',    ko: '캐나다 대서양, 베네수엘라, 볼리비아, 파라과이',           en: 'Canada Atlantic, Venezuela, Bolivia, Paraguay' },
  { value: 'utc-5',    utc: '-5',    ko: '미국·캐나다 동부 (뉴욕, 토론토), 콜롬비아, 페루, 쿠바',   en: 'US·Canada East (New York, Toronto), Colombia, Peru, Cuba' },
  { value: 'utc-6',    utc: '-6',    ko: '미국·캐나다 중부 (시카고), 멕시코시티',                   en: 'US·Canada Central (Chicago), Mexico City' },
  { value: 'utc-7',    utc: '-7',    ko: '미국·캐나다 산악 (덴버, 캘거리)',                         en: 'US·Canada Mountain (Denver, Calgary)' },
  { value: 'utc-8',    utc: '-8',    ko: '미국·캐나다 서부 (LA, 밴쿠버)',                           en: 'US·Canada West (LA, Vancouver)' },
  { value: 'utc-9',    utc: '-9',    ko: '미국 알래스카',                                          en: 'US Alaska' },
  { value: 'utc-10',   utc: '-10',   ko: '미국 하와이, 쿡제도',                                    en: 'US Hawaii, Cook Islands' },
];

function createLocationSelect(containerId, selectId, onChangeFn) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const lang = document.documentElement.lang || 'ko';
  const label = document.createElement('label');
  label.style.fontSize = '0.85rem';
  label.dataset.ko = '태어난 지역';
  label.dataset.en = 'Birth Location';
  label.textContent = lang === 'en' ? 'Birth Location' : '태어난 지역';

  const select = document.createElement('select');
  select.id = selectId || 'birthLocation';
  select.addEventListener('change', () => { if (onChangeFn) onChangeFn(); else if (typeof saveInputs === 'function') saveInputs(); });

  // 브라우저 타임존 → UTC 오프셋 감지 → 가장 가까운 항목 자동 선택
  const browserOffsetMin = -(new Date().getTimezoneOffset()); // 분 단위 (KST = +540)
  const browserOffsetHr = browserOffsetMin / 60;
  let defaultValue = 'utc+9';
  let bestDiff = Infinity;
  LOCATION_OPTIONS.forEach(loc => {
    const parts = loc.utc.replace('+', '').split(':');
    const locOffset = parseFloat(parts[0]) + (parts[1] ? parseInt(parts[1]) / 60 : 0);
    const diff = Math.abs(locOffset - browserOffsetHr);
    if (diff < bestDiff) { bestDiff = diff; defaultValue = loc.value; }
  });

  LOCATION_OPTIONS.forEach(loc => {
    const opt = document.createElement('option');
    opt.value = loc.value;
    const koText = `${loc.ko} (UTC${loc.utc})`;
    const enText = `${loc.en} (UTC${loc.utc})`;
    opt.dataset.ko = koText;
    opt.dataset.en = enText;
    opt.textContent = lang === 'en' ? enText : koText;
    if (loc.value === defaultValue) opt.selected = true;
    select.appendChild(opt);
  });

  const labelWrap = document.createElement('div');
  labelWrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px';
  const tip = document.createElement('span');
  tip.style.cssText = 'font-size:0.7rem;color:#666;cursor:pointer;border:1px solid rgba(255,255,255,0.1);padding:2px 8px;border-radius:10px';
  tip.dataset.ko = '이게 뭐예요?';
  tip.dataset.en = "What's this?";
  tip.textContent = lang === 'en' ? "What's this?" : '이게 뭐예요?';
  const tipBox = document.createElement('div');
  tipBox.style.cssText = 'display:none;font-size:0.72rem;color:#999;background:rgba(255,255,255,0.05);padding:10px;border-radius:4px;margin-bottom:8px;line-height:1.6';
  tipBox.dataset.ko = '사주는 태어난 순간의 천체 위치를 기준으로 합니다. 같은 시각이라도 나라마다 시간대(타임존)가 다르기 때문에, 해외 출생자는 태어난 지역을 선택해야 정확한 사주를 볼 수 있습니다. 내가 태어난 나라나 지역이 없으면 같은 UTC 시간대의 다른 지역을 선택하세요.';
  tipBox.dataset.en = 'Saju is based on the celestial positions at the moment of birth. Since time zones differ by country, selecting your birth location ensures accurate calculation. If your birth country or region is not listed, choose another region with the same UTC offset.';
  tipBox.textContent = lang === 'en' ? tipBox.dataset.en : tipBox.dataset.ko;
  tip.addEventListener('click', () => { tipBox.style.display = tipBox.style.display === 'none' ? 'block' : 'none'; });
  labelWrap.appendChild(label);
  labelWrap.appendChild(tip);
  container.appendChild(labelWrap);
  container.appendChild(tipBox);
  container.appendChild(select);
  createCombo(select);
}

// ===== 공유용 폼 입력 augment / restore =====
// 공유 저장 시 양력/음력 + 원본 연월일을 포함시키기 위한 헬퍼
function augmentShareInput(base) {
  return {
    ...base,
    calendar_type: (typeof _calendarType !== 'undefined') ? _calendarType : 'solar',
    _y: document.getElementById('birthYear')?.value,
    _m: document.getElementById('birthMonth')?.value,
    _d: document.getElementById('birthDay')?.value,
  };
}

// 공유 링크 열람 시 공유자 폼 값으로 복원 (콤보 UI 반영 포함)
function restoreShareInput(input) {
  if (!input) return;
  try {
    const cal = input.calendar_type;
    if (cal === 'lunar') {
      const lunarBtn = document.querySelector('.cal-btn[data-cal="lunar"]');
      if (lunarBtn && typeof setCalendarType === 'function') setCalendarType(lunarBtn, 'lunar');
    }
    const y = input._y || (input.birth_date ? String(parseInt(input.birth_date.split('-')[0], 10)) : null);
    if (y && typeof setComboValue === 'function') setComboValue('birthYear', y);
    if (typeof updateMonths === 'function') updateMonths();
    const m = input._m || (input.birth_date ? String(parseInt(input.birth_date.split('-')[1], 10)) : null);
    if (m && typeof setComboValue === 'function') setComboValue('birthMonth', m);
    if (typeof updateDays === 'function') updateDays();
    const d = input._d || (input.birth_date ? String(parseInt(input.birth_date.split('-')[2], 10)) : null);
    if (d && typeof setComboValue === 'function') setComboValue('birthDay', d);
    if (input.birth_time && typeof setComboValue === 'function') setComboValue('birthTime', input.birth_time);
    if (input.gender && typeof setComboValue === 'function') setComboValue('gender', input.gender);
    const yt = document.getElementById('yajasiToggle');
    if (yt) {
      yt.checked = !!input.yajasi;
      yt.dispatchEvent(new Event('change'));
    }
    if (input.birth_location) {
      const bl = document.getElementById('birthLocation');
      if (bl) bl.value = input.birth_location;
    }
  } catch (_) {}
}

// 초기화
document.addEventListener('DOMContentLoaded', () => {
  initAllCombos();
  const isSharedLink = new URLSearchParams(window.location.search).has('id');
  if (document.getElementById('locationWrap')) createLocationSelect('locationWrap');
  if (document.getElementById('locationWrapA')) {
    createLocationSelect('locationWrapA', 'birthLocationA', typeof saveCompatInputs === 'function' ? saveCompatInputs : null);
    createLocationSelect('locationWrapB', 'birthLocationB', typeof saveCompatInputs === 'function' ? saveCompatInputs : null);
    if (!isSharedLink && typeof restoreCompatInputs === 'function') restoreCompatInputs();
  }
  if (!isSharedLink) restoreInputs();
  // 야자시 초기 상태 설정
  if (document.getElementById('yajasiWrap')) updateYajasiState('birthTime', 'yajasiWrap');
  if (document.getElementById('yajasiWrapA')) updateYajasiState('timeA', 'yajasiWrapA');
  if (document.getElementById('yajasiWrapB')) updateYajasiState('timeB', 'yajasiWrapB');
});
