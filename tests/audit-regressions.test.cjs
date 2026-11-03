'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.join(__dirname, '..');

function functionSource(file, name) {
  const source = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
  let start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const rest = source.slice(start);
  const indent = source.slice(source.lastIndexOf('\n', start) + 1, start);
  const end = rest.indexOf('\n' + indent + '}');
  assert.ok(end >= 0);
  return rest.slice(0, end + indent.length + 2);
}

for (const suffix of ['', '-en']) {
  test(`chart renderers${suffix} escape shared values and reject nonnumeric scores`, () => {
    const elements=new Map();
    const context={window:{},ILGAN_INFO:{},OHANG_EMOJI:{},OHANG_COLORS:{},OHANG_EXCESS:{},OHANG_LACK:{},
      document:{getElementById(id){if(!elements.has(id))elements.set(id,{style:{},innerHTML:'',scrollIntoView(){}});return elements.get(id);}},
      _L:(ko,en)=>en,esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
      ohangEmoji:()=>'',renderPillars:()=>'',setTimeout(){} };
    vm.runInNewContext(functionSource(`saju${suffix}.html`,'renderResult'),context);
    context.renderResult({ilgan:'x',ilganOhang:'x',pillars:[],ohangCount:{'<svg onload=alert(1)>':4,Wood:'<svg onload=alert(1)>'}});
    assert.doesNotMatch(elements.get('ohangBars').innerHTML,/<svg/);
    vm.runInNewContext(functionSource(`compat${suffix}.html`,'renderResult'),context);
    context.renderResult({saju_a:{},saju_b:{},relations:{sangsaeng:[],sanggeuk:[]},ai:{categories:{personality:{score:'0" onmouseover="alert(1)'}}}});
    assert.doesNotMatch(elements.get('catGrid').innerHTML,/onmouseover=/);
  });
  for (const kind of ['discover','matches','match']) {
    test(`${kind}${suffix} releases its loading overlay after an API failure`, async () => {
      const elements=new Map();const alerts=[];
      const context={API_BASE:'https://example.test',userId:'audit',idA:'a',idB:'b',alert:m=>alerts.push(m),
        document:{getElementById(id){if(!elements.has(id))elements.set(id,{style:{display:id==='loading'?'flex':'none'}});return elements.get(id);}},
        fetch:async()=>new Response(JSON.stringify({error:'legacy_account_disabled'}),{status:410})};
      const name=kind==='match'?'loadMatch':'loadMatches';
      vm.runInNewContext(functionSource(`${kind}${suffix}.html`,name),context);
      await context[name]();
      assert.equal(context.document.getElementById('loading').style.display,'none');
      assert.equal(context.document.getElementById('content').style.display,'none');
      assert.equal(alerts.length,1);
    });
  }
  for (const kind of ['daily', 'fortune']) {
    test(`${kind}${suffix} clears lucky values when the next reading omits them`, () => {
      const elements = new Map();
      const document = { getElementById(id) {
        if (!elements.has(id)) elements.set(id, { style: {}, innerHTML: '', scrollIntoView() {} });
        return elements.get(id);
      } };
      const name = kind === 'daily' ? 'renderDaily' : 'renderFortune';
      const context = { document, _L: (ko, en) => en, esc: String };
      vm.runInNewContext(functionSource(`${kind}${suffix}.html`, name), context);
      context[name]({ [kind]: { lucky: { color: 'blue', number: 7 } } });
      assert.match(document.getElementById(`${kind}Lucky`).innerHTML, /blue/);
      context[name]({ [kind]: { overall: 'New reading', year_summary: 'New reading' } });
      assert.equal(document.getElementById(`${kind}Lucky`).innerHTML, '');
    });
  }
  test(`tarot${suffix} starts only one reading after a stable three-card selection`, () => {
    const timers = new Map(); let timerId = 0; let starts = 0;
    const cards = Array.from({length:4}, (_,id)=>({id}));
    const el = { classList: { add() {}, remove() {} } };
    const context = { selectedCards: [], phase: 'selecting', readingTimer: null,
      gsap: {fromTo(){}}, updateCards(){}, updateSelectedInfo(){},
      setTimeout(fn){timers.set(++timerId,fn);return timerId;},
      clearTimeout(id){timers.delete(id);}, startReading(){starts++;} };
    vm.runInNewContext(functionSource(`tarot${suffix}.html`,'toggleCard'),context);
    cards.slice(0,3).forEach(c=>context.toggleCard(el,c));
    context.toggleCard(el,cards[2]);
    for(const fn of timers.values())fn();
    assert.equal(starts,0,'deselection cancels the queued reading');
    timers.clear();
    context.toggleCard(el,cards[2]);
    context.toggleCard(el,cards[2]);
    context.toggleCard(el,cards[3]);
    for(const fn of timers.values())fn();
    assert.equal(starts,1,'reselection must not queue duplicate requests');
  });
  test(`tarot${suffix} uses trusted card identities when restoring a public share`, () => {
    const wrap={innerHTML:'',classList:{add(){}}};
    const context={phase:'reading',MAJOR_ARCANA:[{id:0,name:'The Fool',nameKo:'바보'}],
      document:{querySelector:()=>({style:{}}),getElementById:id=>id==='tarotResult'?wrap:null},
      _L:(ko,en)=>en,lang:()=>suffix?'en':'ko',getCardImageUrl:id=>'/images/tarot/ar'+String(id).padStart(2,'0')+'.webp',
      esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),window:{scrollTo(){}}};
    vm.runInNewContext(functionSource(`tarot${suffix}.html`,'showResult'),context);
    context.showResult({cards:[{id:0,name:'<svg onload=alert(1)>',nameKo:'<svg onload=alert(1)>',interpretation:'safe'},{id:'0" onerror="alert(1)',name:'bad'}],keywords:[]});
    assert.doesNotMatch(wrap.innerHTML,/<svg|onerror=/);
    assert.match(wrap.innerHTML,/ar00.webp/);
    assert.match(wrap.innerHTML,suffix?/The Fool/:/바보/);
  });
}

test('language navigation retains the shared result identifier and fragment', () => {
  const context = {URL, safeLocalStorageSet(){}, location:{search:'?id=shared-result',hash:'#result'},
    document:{querySelector(){return {href:'https://karma.archerlab.dev/saju-en'};}}};
  vm.runInNewContext(functionSource('js/components.js','changeLang'),context);
  context.changeLang('en');
  assert.equal(context.location.href,'https://karma.archerlab.dev/saju-en?id=shared-result#result');
});

test('automatic line breaks keep result text escaped instead of activating HTML', () => {
  const text='A sufficiently long reading. <img src=x onerror=alert(1)> & details.';
  const element={textContent:text,innerHTML:'',dataset:{}};
  const context={document:{querySelectorAll:()=>[element]}};
  const source=fs.readFileSync(path.join(root,'js/components.js'),'utf8');
  if(source.includes('function escapeKarmaHtml('))vm.runInNewContext(functionSource('js/components.js','escapeKarmaHtml'),context);
  vm.runInNewContext(functionSource('js/components.js','formatSentences'),context);
  vm.runInNewContext(functionSource('js/components.js','applyLineBreaks'),context);
  context.formatSentences(element);
  assert.doesNotMatch(element.innerHTML,/<img/);
  assert.match(element.innerHTML,/&lt;img/);
  assert.match(element.innerHTML,/<br>/);
  context.applyLineBreaks();
  assert.doesNotMatch(element.innerHTML,/<img/);
  assert.match(element.innerHTML,/&amp; details/);
});

function worker() {
  const context = { console:{log(){},warn(){},error(){}},crypto:webcrypto,TextEncoder,Uint8Array,Response,Request,URL,atob,btoa,setTimeout,clearTimeout,
    fetch:async()=>new Response('{}') };
  vm.runInNewContext(fs.readFileSync(path.join(root,'assets/js/worker.js'),'utf8').replace('export default {','globalThis.worker = {'),context);
  return context.worker;
}

test('malformed analysis requests return 400 without invoking AI', async () => {
  const api=worker(); let calls=0;
  const env={AI:{complete:async()=>{calls++;throw new Error('Unexpected AI call');},analyze:async()=>{calls++;throw new Error('Unexpected AI call');}}};
  for(const route of ['saju','daily','fortune','compat-quick','quick-saju','tarot','face-reading','palm-reading']) {
    for(const body of ['{broken','null','[]','42']) {
      const response=await api.fetch(new Request('https://karma-api.example/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','Accept-Language':'en'},body}),env,{});
      assert.equal(response.status,400,route+' '+body);
      assert.doesNotMatch((await response.json()).error,/SyntaxError|TypeError|Cannot |[가-힣]/);
    }
  }
  assert.equal(calls,0);
});

test('tarot rejects duplicate and null cards before invoking AI', async () => {
  const api=worker();let calls=0;
  for(const cards of [[{id:0},{id:0},{id:1}],[null,{id:1},{id:2}]]) {
    const response=await api.fetch(new Request('https://karma-api.example/api/tarot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cards,lang:'en'})}),{AI:{complete:async()=>{calls++;throw new Error('Unexpected AI call');}}},{});
    assert.equal(response.status,400);
  }
  assert.equal(calls,0);
});

test('impossible dates and invalid birth times are rejected before calculation or AI', async () => {
  const api=worker();let calls=0;
  const badInputs=[
    ['saju',{birth_date:'2025-02-29'}],['saju',{birth_date:123}],
    ['fortune',{birth_date:'2000-01-01',birth_time:'25:00'}],
    ['fortune',{birth_date:'2000-01-01',year:'invalid'}],
    ['daily',{birth_date:'2000-01-01',target_date:'2026-04-31'}],
    ['compat-quick',{personA:{birth_date:'2000-02-30'},personB:{birth_date:'2000-01-01'}}],
    ['quick-saju',{birth_a:'2000-01-01',birth_b:'2000-13-01'}]
  ];
  for(const [route,input] of badInputs) {
    const response=await api.fetch(new Request('https://karma-api.example/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,lang:'en'})}),{AI:{complete:async()=>{calls++;throw new Error('Unexpected AI call');}}},{});
    assert.equal(response.status,400,route+' '+JSON.stringify(input));
  }
  assert.equal(calls,0);
  const response=await api.fetch(new Request('https://karma-api.example/api/quick-saju',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({birth_a:'2000-02-29',time_a:'00:00',birth_b:'1990-01-01',time_b:''})}),{},{});
  assert.equal(response.status,200,'valid leap-day and unknown birth time remain supported');
});

test('public builds exclude internal documentation at every depth', () => {
  const os=require('node:os');const {execFileSync}=require('node:child_process');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'karma-public-build-'));
  try {
    for(const rel of ['scripts/build-public.cjs','docs/qa/internal.json','images/ui/NOTES.md','AGENTS.md','index.html','images/card.webp']) {
      const file=path.join(temp,rel);fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.writeFileSync(file,rel==='scripts/build-public.cjs'?fs.readFileSync(path.join(root,rel)):'fixture');
    }
    execFileSync(process.execPath,[path.join(temp,'scripts/build-public.cjs')]);
    for(const rel of ['docs','images/ui/NOTES.md','AGENTS.md','scripts'])assert.equal(fs.existsSync(path.join(temp,'dist',rel)),false,rel);
    for(const rel of ['index.html','images/card.webp'])assert.equal(fs.readFileSync(path.join(temp,'dist',rel),'utf8'),'fixture');
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
