(function() {
    var ua = navigator.userAgent || "";
    var isKakao = /KAKAOTALK/i.test(ua);
    var isAndroid = /Android/i.test(ua);
    var isIOS = /iPhone|iPad|iPod/i.test(ua);
    var isDesktop = /Windows|Macintosh|MacIntel|Win32|Win64/i.test(ua + navigator.platform);

    if (isKakao && !isDesktop) {
        if (isAndroid) {
            location.href = 'intent://' + location.href.replace(/https?:\/\//i, '') + '#Intent;scheme=https;package=com.android.chrome;end';
            setTimeout(function() {
                if (!document.body) return;
                document.body.style.backgroundColor = '#0a0a1e';
                document.body.innerHTML = '<div style="position:fixed;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#c9a044;text-align:center;padding:20px"><div style="font-size:48px;margin-bottom:20px">🚀</div><p style="line-height:1.6;color:#e8e0d0"><b>Chrome 브라우저</b>로 이동했습니다.<br>새로 열린 창에서 이용해주세요.<br><br><span style="font-size:14px;color:#888">이 창은 닫으셔도 됩니다.</span></p></div>';
            }, 100);
        } else if (isIOS) {
            document.addEventListener('DOMContentLoaded', function() {
                var overlay = document.createElement('div');
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,10,30,0.95);z-index:9999;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#e8e0d0;text-align:center;font-size:16px;padding:20px';
                overlay.innerHTML = '<p style="line-height:1.8">이 페이지는 <b style="color:#c9a044">Safari</b> 브라우저에서<br>정상적으로 작동합니다.<br><br>우측 하단의 <b style="color:#c9a044">[ 공유 ]</b> 버튼을 누르고<br><b style="color:#c9a044">[Safari로 열기]</b>를 선택해주세요.</p><div style="font-size:50px;position:absolute;bottom:20px;right:20px;animation:bounce 1s infinite">↘</div>';
                var s = document.createElement('style');
                s.innerHTML = '@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}';
                document.head.appendChild(s);
                document.body.appendChild(overlay);
            });
        }
    }
})();

// 브라우저 언어 기반 자동 리다이렉트 (첫 방문 시)
(function() {
    if (localStorage.getItem('karma_lang')) return; // 사용자가 이미 언어 선택함
    var pageLang = (document.documentElement.lang || 'ko').substring(0, 2);
    var browserLang = (navigator.language || navigator.userLanguage || 'ko').substring(0, 2);
    var isKo = browserLang === 'ko';
    if (pageLang === 'ko' && !isKo) {
        // 한글 페이지에 영어 브라우저 → 영문 페이지로
        var enLink = document.querySelector('link[hreflang="en"]');
        if (enLink) { localStorage.setItem('karma_lang', 'en'); location.replace(enLink.href); return; }
    } else if (pageLang === 'en' && isKo) {
        // 영문 페이지에 한국어 브라우저 → 한글 페이지로
        var koLink = document.querySelector('link[hreflang="ko"]');
        if (koLink) { localStorage.setItem('karma_lang', 'ko'); location.replace(koLink.href); return; }
    }
    localStorage.setItem('karma_lang', pageLang);
})();

// 글로벌 에러 핸들러 — 프론트엔드 에러를 중앙 D1에 기록
(function() {
    var ERROR_ENDPOINT = 'https://chatbot-api.yama5993.workers.dev/error-logs';
    var lang = (document.documentElement.lang || 'ko').substring(0, 2);
    var APP_ID = lang === 'ko' ? 'karma' : 'karma-' + lang;
    var _lastError = '';
    var _errorCount = 0;

    function _sendError(message, stack, url) {
        var key = message + (url || '');
        if (key === _lastError) { _errorCount++; if (_errorCount > 3) return; }
        else { _lastError = key; _errorCount = 1; }
        try {
            navigator.sendBeacon(ERROR_ENDPOINT, JSON.stringify({
                appId: APP_ID, userId: '',
                message: (message || '').substring(0, 500),
                stack: (stack || '').substring(0, 2000),
                url: (url || '').substring(0, 500)
            }));
        } catch (_) {}
    }

    window.addEventListener('error', function(e) {
        _sendError(e.message, e.error?.stack || '', e.filename + ':' + e.lineno + ':' + e.colno);
    });
    window.addEventListener('unhandledrejection', function(e) {
        var reason = e.reason;
        _sendError(reason?.message || String(reason || 'Unhandled rejection'), reason?.stack || '', location.href);
    });
})();
