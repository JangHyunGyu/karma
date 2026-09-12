/* In-app browser handoff. Keep this standalone file synchronized across sites. */
(function () {
    'use strict';
    if (window.__archerInAppBrowser) return;
    var ua = navigator.userAgent || '';
    var isAndroid = /Android/i.test(ua);
    var isIOS = /iPhone|iPad|iPod/i.test(ua) ||
        (/Macintosh|MacIntel/i.test(ua + navigator.platform) && navigator.maxTouchPoints > 1);
    if ((!isAndroid && !isIOS) || /bot|crawl|spider|scrap|preview/i.test(ua)) return;

    // Match app tokens, never referrers or ordinary Chrome/Safari/WebView tokens.
    var apps = [
        ['kakao', 'KakaoTalk', /KAKAOTALK/i],
        ['instagram', 'Instagram', /Instagram/i],
        ['band', 'BAND', /\bBAND[\/; ]/i],
        ['naver', 'NAVER', /NAVER\(/i],
        ['line', 'LINE', /\bLine\//i],
        ['facebook', 'Facebook', /FBAN|FBAV|FB_IAB|FB4A|FBIOS/i],
        ['x', 'X', /Twitter(?:Android| for iPhone| for iPad|[\/; ])/i],
        ['tiktok', 'TikTok', /TikTok|musical_ly|BytedanceWebview|trill_/i]
    ];
    var app = apps.filter(function (entry) { return entry[2].test(ua); })[0];
    if (!app || !/^https?:$/.test(location.protocol)) return;
    window.__archerInAppBrowser = app[0];

    var current = new URL(location.href);
    var fromFallback = current.searchParams.get('__iab_fallback') === '1';
    var lineAttempted = current.searchParams.get('openExternalBrowser') === '1';
    current.searchParams.delete('__iab_fallback');
    var targetUrl = current.href;
    var fallback = new URL(targetUrl);
    fallback.searchParams.set('__iab_fallback', '1');
    var externalUrl = '';
    if (app[0] === 'line') {
        // Official LINE option (ordinary web URLs, not LIFF URLs).
        var lineUrl = new URL(targetUrl);
        lineUrl.searchParams.set('openExternalBrowser', '1');
        externalUrl = lineUrl.href;
    } else if (isAndroid) {
        // Preserve the original scheme, query and fragment, including room links.
        externalUrl = 'intent://' + targetUrl.slice(current.protocol.length + 2) +
            '#Intent;scheme=' + current.protocol.slice(0, -1) +
            ';package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(fallback.href) + ';end';
    }

    var messages = {
        ko: {
            title: '외부 브라우저에서 열기',
            intro: '{app} 앱 안에서 보고 있습니다. 원활하게 이용하려면 외부 브라우저로 열어 주세요.',
            guide: '앱의 더보기(⋯) 또는 공유 메뉴에서 외부 브라우저로 열기를 선택해 주세요. 해당 메뉴가 없으면 링크를 복사해 {browser} 주소창에 붙여 넣어 주세요.',
            open: '{browser}에서 열기', copy: '링크 복사', stay: '여기서 계속하기',
            copied: '링크를 복사했습니다. {browser} 주소창에 붙여 넣어 주세요.',
            manual: '아래 주소를 길게 눌러 복사한 뒤 {browser} 주소창에 붙여 넣어 주세요.',
            pending: '새 창이 열리지 않으면 앱 메뉴에서 외부 브라우저로 열기를 선택해 주세요.',
            browser: '브라우저'
        },
        en: {
            title: 'Open in your browser',
            intro: 'You are viewing this page inside {app}. Open it in an external browser for a smoother experience.',
            guide: 'Choose Open in browser from the app’s More (⋯) or Share menu. If that option is missing, copy the link and paste it into the {browser} address bar.',
            open: 'Open in {browser}', copy: 'Copy link', stay: 'Continue here',
            copied: 'Link copied. Paste it into the {browser} address bar.',
            manual: 'Press and hold the address below to copy it, then paste it into {browser}.',
            pending: 'If no new window opens, choose Open in browser from the app menu.', browser: 'browser'
        },
        ja: {
            title: '外部ブラウザで開く', intro: '{app}内で表示しています。快適に利用するには外部ブラウザで開いてください。',
            guide: 'アプリのその他（⋯）または共有メニューから外部ブラウザで開く項目を選んでください。項目がない場合はリンクをコピーして{browser}のアドレスバーに貼り付けてください。',
            open: '{browser}で開く', copy: 'リンクをコピー', stay: 'ここで続ける', copied: 'リンクをコピーしました。{browser}のアドレスバーに貼り付けてください。',
            manual: '下のアドレスを長押ししてコピーし、{browser}に貼り付けてください。', pending: '新しい画面が開かない場合は、アプリのメニューから外部ブラウザで開いてください。', browser: 'ブラウザ'
        },
        es: {
            title: 'Abrir en otro navegador', intro: 'Estás viendo esta página dentro de {app}. Ábrela en otro navegador para una mejor experiencia.',
            guide: 'Elige Abrir en el navegador en el menú Más (⋯) o Compartir de la app. Si no aparece, copia el enlace y pégalo en la barra de direcciones de {browser}.',
            open: 'Abrir en {browser}', copy: 'Copiar enlace', stay: 'Continuar aquí', copied: 'Enlace copiado. Pégalo en la barra de direcciones de {browser}.',
            manual: 'Mantén pulsada la dirección de abajo para copiarla y pégala en {browser}.', pending: 'Si no se abre otra ventana, usa Abrir en el navegador en el menú de la app.', browser: 'navegador'
        },
        fr: {
            title: 'Ouvrir dans un navigateur', intro: 'Cette page est affichée dans {app}. Ouvrez-la dans un navigateur externe pour plus de confort.',
            guide: 'Choisissez Ouvrir dans le navigateur dans le menu Plus (⋯) ou Partager de l’application. Si cette option manque, copiez le lien dans la barre d’adresse de {browser}.',
            open: 'Ouvrir dans {browser}', copy: 'Copier le lien', stay: 'Continuer ici', copied: 'Lien copié. Collez-le dans la barre d’adresse de {browser}.',
            manual: 'Appuyez longuement sur l’adresse ci-dessous pour la copier, puis collez-la dans {browser}.', pending: 'Si aucune fenêtre ne s’ouvre, utilisez Ouvrir dans le navigateur dans le menu de l’application.', browser: 'votre navigateur'
        },
        de: {
            title: 'Im externen Browser öffnen', intro: 'Diese Seite wird in {app} angezeigt. Öffne sie für eine bessere Nutzung in einem externen Browser.',
            guide: 'Wähle im Menü Mehr (⋯) oder Teilen der App die Option zum Öffnen im Browser. Falls sie fehlt, kopiere den Link in die Adressleiste von {browser}.',
            open: 'In {browser} öffnen', copy: 'Link kopieren', stay: 'Hier fortfahren', copied: 'Link kopiert. Füge ihn in die Adressleiste von {browser} ein.',
            manual: 'Halte die Adresse unten gedrückt, um sie zu kopieren, und füge sie in {browser} ein.', pending: 'Falls sich kein neues Fenster öffnet, wähle im App-Menü die Option zum Öffnen im Browser.', browser: 'deinem Browser'
        },
        pt: {
            title: 'Abrir em outro navegador', intro: 'Você está vendo esta página dentro do {app}. Abra-a em outro navegador para uma experiência melhor.',
            guide: 'Selecione Abrir no navegador no menu Mais (⋯) ou Compartilhar do aplicativo. Se essa opção não aparecer, copie o link e cole na barra de endereços do {browser}.',
            open: 'Abrir no {browser}', copy: 'Copiar link', stay: 'Continuar aqui', copied: 'Link copiado. Cole na barra de endereços do {browser}.',
            manual: 'Pressione e segure o endereço abaixo para copiar e cole no {browser}.', pending: 'Se nenhuma janela abrir, selecione Abrir no navegador no menu do aplicativo.', browser: 'navegador'
        }
    };

    function showGuide() {
        if (!document.body || document.getElementById('inapp-browser-guide')) return;
        var lang = (document.documentElement.lang || 'ko').toLowerCase().split('-')[0];
        if (lang === 'jp') lang = 'ja';
        var text = messages[lang] || messages.en;
        var browserName = app[0] === 'line' ? text.browser : (isAndroid ? 'Chrome' : 'Safari');
        function label(key) { return text[key].replace(/\{app\}/g, app[1]).replace(/\{browser\}/g, browserName); }
        var panel = document.createElement('section');
        panel.id = 'inapp-browser-guide';
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-labelledby', 'inapp-browser-title');
        panel.style.cssText = 'position:fixed;z-index:2147483647;left:12px;right:12px;bottom:12px;bottom:max(12px,env(safe-area-inset-bottom));max-width:480px;max-height:85vh;overflow:auto;margin:0 auto;padding:20px;box-sizing:border-box;background:#151923;color:#f8fafc;border:1px solid #667085;border-radius:16px;box-shadow:0 8px 40px #0008;font:15px/1.6 system-ui,sans-serif;text-align:left;';
        function append(tag, key) {
            var element = document.createElement(tag);
            element.textContent = label(key);
            element.style.cssText = 'margin:0 0 12px;font:inherit;color:inherit;';
            panel.appendChild(element);
            return element;
        }
        var title = append('h2', 'title');
        title.id = 'inapp-browser-title';
        title.style.fontSize = '20px';
        title.style.fontWeight = '700';
        append('p', 'intro');
        append('p', 'guide');
        var controls = document.createElement('div');
        controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
        panel.appendChild(controls);
        function control(tag, key) {
            var element = document.createElement(tag);
            element.textContent = label(key);
            element.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;flex:1 1 130px;min-height:44px;padding:10px 14px;box-sizing:border-box;border:1px solid #667085;border-radius:8px;background:#252c3b;color:#fff;font:600 14px/1.4 system-ui,sans-serif;text-decoration:none;text-align:center;cursor:pointer;';
            if (tag === 'button') element.type = 'button';
            controls.appendChild(element);
            return element;
        }
        var status = document.createElement('p');
        status.setAttribute('role', 'status');
        status.style.cssText = 'margin:12px 0 0;font:inherit;color:inherit;';
        if (externalUrl) {
            var open = control('a', 'open');
            open.href = externalUrl;
            open.style.background = '#345bc7';
            open.addEventListener('click', function () { status.textContent = label('pending'); });
        }
        var copy = control('button', 'copy');
        var address = document.createElement('textarea');
        address.value = targetUrl;
        address.readOnly = true;
        address.setAttribute('aria-label', label('copy'));
        address.style.cssText = 'display:none;width:100%;box-sizing:border-box;margin:12px 0 0;min-height:64px;background:#fff;color:#111;font:14px/1.4 system-ui,sans-serif;';
        function manualCopy() {
            address.style.display = 'block';
            address.focus();
            address.select();
            address.setSelectionRange(0, address.value.length);
            var copied = false;
            try { copied = document.execCommand('copy'); } catch (_) {}
            status.textContent = label(copied ? 'copied' : 'manual');
        }
        copy.addEventListener('click', function () {
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(targetUrl).then(function () {
                        status.textContent = label('copied');
                    }, manualCopy);
                } else { manualCopy(); }
            } catch (_) { manualCopy(); }
        });
        var stay = control('button', 'stay');
        stay.addEventListener('click', function () { panel.remove(); });
        panel.appendChild(status);
        panel.appendChild(address);
        document.body.appendChild(panel);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showGuide, { once: true });
    else showGuide();

    // Try once per tab/path; keep a usable page and manual actions if the app blocks it.
    if (externalUrl && !fromFallback && !(app[0] === 'line' && lineAttempted)) {
        var key = 'archer:external-browser:' + app[0] + ':' + current.pathname;
        var attempted = false;
        try {
            attempted = sessionStorage.getItem(key) === '1';
            sessionStorage.setItem(key, '1');
        } catch (_) {}
        if (!attempted) {
            try { location.href = externalUrl; } catch (_) {}
        }
    }
})();


// 글로벌 에러 핸들러 — 프론트엔드 에러를 중앙 D1에 기록
(function() {
    var ERROR_ENDPOINT = 'https://chatbot-api.yama5993.workers.dev/error-logs';
    var lang = (document.documentElement.lang || 'ko').substring(0, 2);
    var APP_ID = lang === 'ko' ? 'karma' : 'karma-' + lang;
    var _lastError = '';
    var _errorCount = 0;

    window.__karmaErrorReporterInstalled = true;

    function _hasExternalScriptMarker(value) {
        return /webkit-masked-url:\/\/hidden|(?:chrome|moz|safari-web)-extension:\/\//i.test(String(value || ''));
    }

    function _shouldIgnoreError(message, stack, url) {
        if (_hasExternalScriptMarker(stack) || _hasExternalScriptMarker(url)) return true;
        return false;
    }

    function _sendError(message, stack, url) {
        if (_shouldIgnoreError(message, stack, url)) return;
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
