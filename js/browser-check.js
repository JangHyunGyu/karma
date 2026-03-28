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
