'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const files = ['assets/js/browser-check.js', 'js/browser-check.js',
  'cat-tower/js/browser-check.js', 'solo-leveling/js/browser-check.js', 'slimevolley/js/browser-check.js']
  .filter(file => fs.existsSync(path.join(root, file)));
assert.ok(files.length, 'At least one deployed browser check must be tested');
const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Version/4.0 Chrome/130.0 Mobile Safari/537.36';
const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const apps = ['KAKAOTALK 26.1', 'Instagram 400', 'NAVER(inapp; search; 13.0)', 'BAND/18.0',
  'FBAN/FBIOS;FBAV/500', 'Line/15.0', 'Twitter for iPhone/10.0', 'musical_ly_2026000000'];
let cases = 0;
function environment(code, options = {}) {
  const elements = [];
  function element(tag) {
    const e = { tagName: tag, style: {}, children: [], attributes: {}, handlers: {}, textContent: '',
      setAttribute(k, v) { this.attributes[k] = v; },
      appendChild(child) { child.parent = this; this.children.push(child); return child; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      remove() { this.removed = true; this.parent.children = this.parent.children.filter(child => child !== this); },
      focus() {}, select() {}, setSelectionRange() {} };
    elements.push(e); return e;
  }
  const body = element('body');
  const original = element('main');
  body.appendChild(original);
  const ready = {};
  const document = { body: options.loading ? null : body, documentElement: { lang: options.lang || 'ko' },
    readyState: options.loading ? 'loading' : 'complete',
    createElement: element, getElementById: id => elements.find(e => e.id === id && !e.removed),
    addEventListener(name, fn) { ready[name] = fn; }, execCommand() { return false; } };
  const start = options.url || 'https://example.com/game?room=abc&name=%ED%95%9C%EA%B8%80#join';
  let href = start;
  const navigations = [];
  const location = { protocol: new URL(start).protocol, get href() { return href; }, set href(value) {
    navigations.push(value); if (options.blockNavigation) throw new Error('blocked'); href = value;
  } };
  const storage = options.storage || new Map();
  const sessionStorage = { getItem(k) { if (options.blockStorage) throw new Error('denied'); return storage.get(k); },
    setItem(k, v) { if (options.blockStorage) throw new Error('denied'); storage.set(k, v); } };
  const navigator = { userAgent: options.ua || android + ' Instagram 400', platform: options.platform || 'Linux armv8',
    maxTouchPoints: options.touch || 0, sendBeacon() {} };
  if (options.clipboard) navigator.clipboard = { writeText: options.clipboard };
  const window = { addEventListener() {} };
  const context = vm.createContext({ window, navigator, document, location, sessionStorage, URL, console });
  vm.runInContext(code, context);
  return { window, document, body, original, elements, navigations, context, storage,
    panel: () => document.getElementById('inapp-browser-guide'),
    ready() { document.body = body; document.readyState = 'complete'; ready.DOMContentLoaded?.(); } };
}
function check(fn) { fn(); cases++; }
(async () => {
  for (const file of files) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    for (const token of apps) for (const base of [android, ios]) check(() => {
      const env = environment(code, { ua: base + ' ' + token });
      assert.ok(env.panel(), `${file}: ${token} on ${base}`);
      assert.ok(env.body.children.includes(env.original), 'Preserve the existing application');
      assert.equal(env.navigations.length, base === android || token.startsWith('Line/') ? 1 : 0);
      assert.ok(!env.window.__CAT_TOWER_EXTERNAL_BROWSER_REQUIRED, 'Do not prevent game boot when the guide is dismissible');
    });
    for (const ua of [android, ios + ' Version/18.0 Safari/604.1',
      'Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537.36 Instagram',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605.1.15 KAKAOTALK',
      android + ' kakaotalk-scrap', android + ' Googlebot']) check(() => {
      const env = environment(code, { ua }); assert.equal(env.panel(), undefined); assert.equal(env.navigations.length, 0);
    });
    check(() => {
      const env = environment(code, { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605 Instagram 400', platform: 'MacIntel', touch: 5 });
      assert.ok(env.panel(), 'iPad desktop UA is still an iOS in-app browser'); assert.equal(env.navigations.length, 0);
    });
    check(() => {
      const env = environment(code, { loading: true, blockNavigation: true });
      assert.equal(env.panel(), undefined); env.ready(); assert.ok(env.panel());
      assert.ok(env.body.children.includes(env.original));
      vm.runInContext(code, env.context);
      assert.equal(env.elements.filter(e => e.id === 'inapp-browser-guide').length, 1);
    });
    check(() => {
      const env = environment(code, { blockStorage: true, blockNavigation: true });
      assert.ok(env.panel()); assert.equal(env.navigations.length, 1);
      const link = env.elements.find(e => e.tagName === 'a');
      const [data, extras] = link.href.split('#Intent;');
      assert.equal(data.replace('intent:', 'https:'), 'https://example.com/game?room=abc&name=%ED%95%9C%EA%B8%80#join');
      assert.ok(extras.includes('package=com.android.chrome;'));
      const fallback = new URL(decodeURIComponent(extras.split('S.browser_fallback_url=')[1].split(';')[0]));
      assert.equal(fallback.searchParams.get('room'), 'abc'); assert.equal(fallback.hash, '#join');
      const retry = environment(code, { url: fallback.href, blockStorage: true });
      assert.ok(retry.panel()); assert.equal(retry.navigations.length, 0, 'Fallback must never trigger another automatic attempt');
      link.handlers.click(); assert.match(env.elements.find(e => e.attributes.role === 'status').textContent, /새 창/);
    });
    check(() => {
      const env = environment(code, { url: 'http://localhost:3001/game?room=abc#join' });
      assert.match(env.navigations[0], /^intent:\/\/localhost:3001\/game\?room=abc#join#Intent;scheme=http;/);
      const retry = environment(code, { storage: env.storage, url: 'http://localhost:3001/game?room=abc#join' });
      assert.equal(retry.navigations.length, 0); assert.ok(retry.elements.some(e => e.tagName === 'a'));
    });
    check(() => {
      const env = environment(code, { ua: ios + ' Line/15.0', url: 'https://example.com/game?room=abc#join' });
      const url = new URL(env.navigations[0]); assert.equal(url.searchParams.get('openExternalBrowser'), '1');
      assert.equal(url.searchParams.get('room'), 'abc'); assert.equal(url.hash, '#join');
      const retry = environment(code, { ua: ios + ' Line/15.0', url: url.href, blockStorage: true });
      assert.equal(retry.navigations.length, 0); assert.ok(retry.panel());
    });
    for (const lang of ['ko', 'en', 'ja', 'jp', 'es', 'fr', 'de', 'pt', 'en-US', 'unknown']) check(() => {
      const env = environment(code, { lang });
      assert.ok(env.panel());
      assert.ok(env.elements.every(e => !/\{app\}|\{browser\}/.test(e.textContent)));
      const buttons = env.elements.filter(e => e.tagName === 'button');
      buttons[buttons.length - 1].handlers.click(); assert.equal(env.panel(), undefined);
      assert.ok(env.body.children.includes(env.original));
    });
    check(() => {
      const env = environment(code); env.elements.find(e => e.tagName === 'button').handlers.click();
      assert.equal(env.elements.find(e => e.tagName === 'textarea').style.display, 'block');
      assert.match(env.elements.find(e => e.attributes.role === 'status').textContent, /길게/);
    });
    for (const reject of [false, true]) {
      let copied;
      const env = environment(code, { clipboard(value) { copied = value; return reject ? Promise.reject(new Error('denied')) : Promise.resolve(); } });
      env.elements.find(e => e.tagName === 'button').handlers.click(); await Promise.resolve(); await Promise.resolve();
      assert.equal(copied, 'https://example.com/game?room=abc&name=%ED%95%9C%EA%B8%80#join');
      assert.match(env.elements.find(e => e.attributes.role === 'status').textContent, reject ? /길게/ : /복사했습니다/);
      cases++;
    }
    console.log(`PASS ${file}`);
  }
  console.log(`Browser handoff: ${cases} cases passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
