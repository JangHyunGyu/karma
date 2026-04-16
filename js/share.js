// Karma 결과 공유 (카카오톡) 헬퍼
// 사용법:
//   1) 페이지에서 KarmaShare.init({ type, pageBase, getPayload, onLoadShared })
//      - type: 'saju'|'fortune'|'daily'|'tarot'|'face'|'palm'|'compat'
//      - pageBase: 공유 URL의 기본 경로 (예: '/saju' 또는 '/saju-en')
//      - getPayload(): { input, result } 반환 (현재 분석 결과)
//      - onLoadShared({ input, result }): 저장된 결과로 화면 복원
//   2) 공유 버튼 클릭 시 KarmaShare.shareKakao(title, description)
//   3) 페이지 로드 시 자동으로 ?id=xxx 감지해서 onLoadShared 호출
(function () {
  const API_BASE = 'https://karma-api.yama5993.workers.dev';
  const KAKAO_SDK_URL = 'https://t1.kakaocdn.net/kakao_js_sdk/2.7.1/kakao.min.js';
  const KAKAO_APP_KEY = '6f68bee4af57f64f3a5aa093b1f87433';
  const DEFAULT_OG_IMAGE = 'https://karma.archerlab.dev/images/og-karma.png';

  let _config = null;

  function ensureKakaoSdk() {
    return new Promise((resolve, reject) => {
      if (typeof Kakao !== 'undefined') {
        if (!Kakao.isInitialized()) Kakao.init(KAKAO_APP_KEY);
        return resolve();
      }
      const s = document.createElement('script');
      s.src = KAKAO_SDK_URL;
      s.onload = () => {
        try {
          if (!Kakao.isInitialized()) Kakao.init(KAKAO_APP_KEY);
          resolve();
        } catch (e) { reject(e); }
      };
      s.onerror = () => reject(new Error('Failed to load Kakao SDK'));
      document.head.appendChild(s);
    });
  }

  async function saveResult({ type, lang, input, result }) {
    const resp = await fetch(`${API_BASE}/api/share/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, lang, input, result }),
    });
    if (!resp.ok) throw new Error(`Save failed: ${resp.status}`);
    const data = await resp.json();
    return data.id;
  }

  async function fetchResult(id) {
    const resp = await fetch(`${API_BASE}/api/share/${encodeURIComponent(id)}`);
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
    return resp.json();
  }

  function buildShareUrl(id) {
    if (!_config) throw new Error('KarmaShare not initialized');
    const origin = window.location.origin;
    const base = _config.pageBase || window.location.pathname;
    return `${origin}${base}?id=${encodeURIComponent(id)}`;
  }

  function isMobile() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) { return false; }
  }

  async function shareKakao(title, description, imageUrl) {
    if (!_config) { alert('공유 설정 오류'); return; }
    const btn = document.activeElement;
    if (btn && btn.tagName === 'BUTTON') btn.disabled = true;
    try {
      const payload = _config.getPayload();
      if (!payload || !payload.result) {
        alert(_config.lang === 'en' ? 'No result to share yet.' : '공유할 결과가 없습니다.');
        return;
      }
      const id = await saveResult({
        type: _config.type,
        lang: _config.lang,
        input: payload.input,
        result: payload.result,
      });
      const shareUrl = buildShareUrl(id);
      const isEn = _config.lang === 'en';

      if (!isMobile()) {
        const ok = await copyToClipboard(shareUrl);
        const msg = ok
          ? (isEn ? 'Link copied to clipboard!\nPaste it in KakaoTalk to share.\n\n' + shareUrl
                  : '링크가 복사되었습니다!\n카카오톡에 붙여넣어 공유하세요.\n\n' + shareUrl)
          : (isEn ? 'Share this link:\n\n' + shareUrl
                  : '아래 링크를 복사해 공유하세요:\n\n' + shareUrl);
        alert(msg);
        return;
      }

      await ensureKakaoSdk();
      Kakao.Share.sendDefault({
        objectType: 'feed',
        content: {
          title: title || (isEn ? 'Karma AI Analysis' : '카르마 AI 분석 결과'),
          description: description || (isEn ? 'View my AI analysis result' : '내 AI 분석 결과를 확인해보세요'),
          imageUrl: imageUrl || DEFAULT_OG_IMAGE,
          imageWidth: 1200,
          imageHeight: 630,
          link: { mobileWebUrl: shareUrl, webUrl: shareUrl },
        },
        buttons: [{
          title: isEn ? 'View Result' : '결과 보기',
          link: { mobileWebUrl: shareUrl, webUrl: shareUrl },
        }],
      });
    } catch (err) {
      console.error('shareKakao error:', err);
      alert((_config && _config.lang === 'en' ? 'Share failed: ' : '공유 실패: ') + err.message);
    } finally {
      if (btn && btn.tagName === 'BUTTON') btn.disabled = false;
    }
  }

  async function handleSharedIdFromUrl() {
    if (!_config || !_config.onLoadShared) return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    if (!id) return;
    try {
      const data = await fetchResult(id);
      if (!data) {
        const msg = _config.lang === 'en'
          ? 'This shared link has expired or was not found.'
          : '공유된 결과를 찾을 수 없거나 만료되었습니다.';
        alert(msg);
        return;
      }
      if (data.type !== _config.type) return;
      _config.onLoadShared({ input: data.input, result: data.result, lang: data.lang });
    } catch (err) {
      console.error('Load shared result error:', err);
    }
  }

  function init(config) {
    if (!config || !config.type) throw new Error('KarmaShare.init: type required');
    _config = {
      type: config.type,
      lang: config.lang === 'en' ? 'en' : 'ko',
      pageBase: config.pageBase || window.location.pathname,
      getPayload: typeof config.getPayload === 'function' ? config.getPayload : () => ({ input: null, result: null }),
      onLoadShared: typeof config.onLoadShared === 'function' ? config.onLoadShared : null,
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', handleSharedIdFromUrl);
    } else {
      handleSharedIdFromUrl();
    }
  }

  window.KarmaShare = { init, shareKakao };
})();
