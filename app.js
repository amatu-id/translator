/* Amatu Translator — terjemahan suara langsung (amatu-id.github.io/translator).
   Suara → teks: Web Speech API (kata muncul seketika), atau perekam sendiri + Whisper di Cloudflare (mode Auto dan
   browser tanpa Web Speech). Teks → terjemahan: Google lebih dulu (instan), lalu AI Gemma 4 / SEA-LION yang paham
   konteks percakapan menggantinya dengan kalimat yang natural (edge fn amatu-translate → Worker amatu-ai).
   Riwayat: localStorage translator.* — /amatu.js menyinkronkannya ke akun Portal AMATU. */
(() => {
  'use strict';

  // ---------- dasar ----------
  const $ = (s, r = document) => r.querySelector(s);
  const EDGE = 'https://ieyqxmzztoxgpvwexbkj.supabase.co/functions/v1/amatu-translate';
  const GKEY = 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520';   // Chrome's public translate key (translate-pa)
  const UA = navigator.userAgent;
  const IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const ANDROID = /Android/i.test(UA);
  const PHONE = IOS || ANDROID;
  const SRC = window.SpeechRecognition || window.webkitSpeechRecognition;
  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tmo = (ms) => {
    if (AbortSignal.timeout) return AbortSignal.timeout(ms);
    const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const uid = () => now().toString(36) + Math.random().toString(36).slice(2, 7);
  const ic = (n, c) => `<svg class="i${c ? ' ' + c : ''}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const base = (c) => String(c || '').toLowerCase().split('-')[0];
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s.,!?;:'"“”‘’。，、！？]+/g, ' ').trim();

  // ---------- bahasa ----------
  const LANGS = window.TR_LANGS.map(([k, g, n, nn, e, sr, w]) => ({ k, g, n, nn, e, sr, w }));
  const LM = new Map(LANGS.map((l) => [l.k, l]));
  const L = (k) => LM.get(k) || LM.get('en');
  const byG = (g) => LM.get(g) || LANGS.find((l) => l.g === g) || LANGS.find((l) => base(l.g) === base(g)) || null;
  const short = (l) => l.nn.replace(/^Bahasa\s+/i, '').replace(/\s*[（(].*$/, '') || l.n;
  // languages Whisper tends to report for each other (Indonesian speech often comes back as Malay)
  const NEAR = { id: 'ms jw su', ms: 'id', jw: 'id su', su: 'id jw', zh: 'yue', yue: 'zh', no: 'nn da sv', da: 'no sv', sv: 'no da', hr: 'sr bs', sr: 'hr bs', bs: 'hr sr', ru: 'uk be', uk: 'ru', be: 'ru', es: 'gl ca pt', pt: 'gl es', gl: 'pt es', ca: 'es', hi: 'ur', ur: 'hi', tl: 'ceb', af: 'nl', nl: 'af', cs: 'sk', sk: 'cs', fa: 'tg', tg: 'fa' };
  const near = (w, target) => !!(w && target && (NEAR[target] || '').split(' ').includes(w));
  const srBad = new Set();   // speech locales this browser's Web Speech refused
  const canHear = (l) => !!((SRC && l.sr && !srBad.has(l.sr)) || (l.w && tok()));

  // ---------- penyimpanan ----------
  const S = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : (JSON.parse(v) ?? d); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { toast('Penyimpanan penuh — hapus sebagian riwayat'); return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { } },
  };
  const KC = 'translator.cfg', KI = 'translator.idx', KS = (id) => 'translator.s.' + id;
  const cfg = Object.assign({ a: 'id', b: 'en', speak: true, rate: 1, fs: 1, recent: ['id', 'en'] }, S.get(KC, {}));
  if (!LM.has(cfg.a)) cfg.a = 'id';
  if (!LM.has(cfg.b) || cfg.b === cfg.a) cfg.b = cfg.a === 'en' ? 'id' : 'en';
  const saveCfg = () => S.set(KC, cfg);
  const loadIdx = () => (S.get(KI, []) || []).filter((m) => m && m.id);
  let idx = loadIdx();
  let cur = null;   // { id, a, b, c, u, items: [{ id, s, sk, tk, x, q, y, ai, at, by, st }] }

  function newSession() { cur = { id: uid(), a: cfg.a, b: cfg.b, c: now(), u: now(), items: [] }; }
  function openSession(id) {
    const s = S.get(KS(id), null);
    if (!s || !Array.isArray(s.items)) return false;
    cur = { id, a: s.a || cfg.a, b: s.b || cfg.b, c: s.c || now(), u: s.u || now(), items: s.items.map((it) => Object.assign({}, it, { st: 0 })) };
    return true;
  }
  let saveT = 0, dirty = false, dirtyAt = 0;
  const textCache = new Map();
  // every save is synced to the account by /amatu.js, so a live conversation saves at most every few seconds
  function save() {
    if (!dirty) dirtyAt = now();
    dirty = true;
    clearTimeout(saveT);
    saveT = setTimeout(flush, Math.max(0, Math.min(mode ? 4000 : 1200, dirtyAt + 8000 - now())));
  }
  function flush() {
    clearTimeout(saveT);
    if (!dirty || !cur) return;
    dirty = false;
    if (!cur.items.length) { dropSession(cur.id); return; }
    cur.u = now();
    const items = cur.items.map(({ id, s, sk, tk, x, q, y, ai, at, by }) => ({ id, s, sk, tk, x, q, y, ai, at, by }));
    S.set(KS(cur.id), { a: cur.a, b: cur.b, c: cur.c, u: cur.u, items });
    textCache.delete(cur.id);
    const meta = { id: cur.id, t: cur.items[0].x.slice(0, 90), a: cur.a, b: cur.b, c: cur.c, u: cur.u, n: cur.items.length };
    const old = idx.filter((m) => m.id !== cur.id);
    idx = [meta, ...old].slice(0, 300);
    old.slice(299).forEach((m) => S.del(KS(m.id)));
    S.set(KI, idx);
    renderHist();
  }
  function dropSession(id) {
    S.del(KS(id));
    textCache.delete(id);
    if (idx.some((m) => m.id === id)) { idx = idx.filter((m) => m.id !== id); S.set(KI, idx); }
    renderHist();
  }

  // ---------- terjemahan: Google (instan) ----------
  let gDown = 0;
  async function gtx(text, sl, tl, signal) {
    const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&dj=1&ie=UTF-8&oe=UTF-8&sl=' + encodeURIComponent(sl) + '&tl=' + encodeURIComponent(tl);
    const long = text.length > 1500;
    const r = await fetch(long ? u : u + '&q=' + encodeURIComponent(text), long ? { method: 'POST', body: new URLSearchParams({ q: text }), signal } : { signal });
    if (!r.ok) throw new Error('g' + r.status);
    const d = await r.json();
    return { t: (d.sentences || []).map((s) => s.trans || '').join('').trim(), src: d.src || sl };
  }
  const unent = (s) => String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  async function gpa(text, sl, tl, signal) {   // second Google door, used while the first one answers 429
    const lines = text.split('\n');
    const r = await fetch('https://translate-pa.googleapis.com/v1/translateHtml', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json+protobuf', 'X-Goog-API-Key': GKEY },
      body: JSON.stringify([[lines.map((l) => esc(l) || ' '), sl, tl], 'wt_lib']),
    });
    if (!r.ok) throw new Error('p' + r.status);
    const d = await r.json();
    return { t: lines.map((l, i) => (l.trim() ? unent((d[0] || [])[i]) : '')).join('\n').trim(), src: ((d[1] || [])[0]) || sl };
  }
  async function quick(text, sl, tl, signal) {
    if (now() > gDown) {
      try { return await gtx(text, sl, tl, signal); } catch (e) { if (e.name === 'AbortError') throw e; gDown = now() + 60e3; }
    }
    return gpa(text, sl, tl, signal);
  }

  // ---------- AI (Cloudflare Workers AI lewat edge function, perlu login portal) ----------
  let aiOff = 0, aiWarned = 0;
  function tok() { try { const s = window.AMATU && window.AMATU.sess && window.AMATU.sess(); return (s && s.t) || ''; } catch { return ''; } }
  const aiOn = () => !!tok() && now() > aiOff;
  async function edge(path, body, ms) {
    try {
      const r = await fetch(`${EDGE}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-amatu': tok() }, body: JSON.stringify(body), signal: tmo(ms) });
      const j = await r.json().catch(() => ({ error: 'ai' }));
      if (j.error === 'kuota') { const d = new Date(); d.setUTCHours(24, 2, 0, 0); aiOff = +d; }   // free daily allocation resets 00:00 UTC
      else if (j.error === 'auth') aiOff = now() + 5 * 60e3;
      else if (j.error === 'cepat') aiOff = now() + 15e3;
      return j || { error: 'ai' };
    } catch (e) {
      return { error: e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'lambat' : 'net' };
    }
  }
  function ctxOf(it) {
    const i = cur.items.indexOf(it), out = [];
    for (let k = Math.max(0, i - 6); k < i; k++) { const x = cur.items[k]; out.push({ me: x.s === it.s, n: L(x.sk).e, x: x.x.slice(0, 300) }); }
    return out;
  }
  async function refine(it) {
    if (!aiOn()) return null;
    const S_ = L(it.sk), T = L(it.tk);
    const j = await edge('tr', { text: it.x, sl: S_.g, tl: T.g, sn: S_.e, tn: T.e, draft: it.q || '', ctx: ctxOf(it) }, 16000);
    return (j && j.text) || null;
  }

  // ---------- satu baris percakapan ----------
  let sayQ = Promise.resolve(), sayGen = 0;
  function addLine(o) {
    if (!cur) newSession();
    const it = { id: uid(), s: o.s, sk: o.sk, tk: o.tk, x: o.x, q: o.q || '', y: o.q || '', ai: 0, at: now(), by: o.by || 'mic', st: 1 };
    cur.items.push(it);
    paintLine(it, true);
    paintStatus();
    save();
    const ses = cur;
    const done = (async () => {
      if (!it.q) {
        try { const r = await quick(it.x, L(it.sk).g, L(it.tk).g); it.q = it.y = r.t; } catch { }
        paintLine(it);
      }
      const t = await refine(it);
      if (t) { it.y = t; it.ai = 1; }
      it.st = 0;
      paintLine(it);
      if (ses === cur) save(); else { const keep = cur; cur = ses; dirty = true; flush(); cur = keep; }
      if (!it.y) toast('Terjemahan gagal — periksa koneksi internet');
      return it;
    })();
    if (o.say || (cfg.speak && o.by !== 'key')) {
      const gen = sayGen;
      sayQ = sayQ.then(async () => {
        await Promise.race([done, sleep(3500)]);   // the natural version usually lands within ~1.5 s
        // never talk over someone who already started speaking: wait for their pause (max 8 s)
        for (let k = 0; k < 40 && gen === sayGen && (phTalk || live.x); k++) await sleep(200);
        if (gen === sayGen && it.y && cur && cur.items.includes(it)) await speakLine(it, 'y');
      });
    }
    return it;
  }

  // ---------- tampilan percakapan ----------
  const conv = $('#conv'), cw = $('#cw');
  const hm = (t) => new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  function when(t) {
    const d = new Date(t), today = new Date(); today.setHours(0, 0, 0, 0);
    if (t >= +today) return hm(t);
    if (t >= +today - 864e5) return 'Kemarin ' + hm(t);
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' }) + ' ' + hm(t);
  }
  const nearBottom = () => conv.scrollHeight - conv.scrollTop - conv.clientHeight < 120;
  function scrollEnd(force) { if (force || nearBottom()) requestAnimationFrame(() => { conv.scrollTop = conv.scrollHeight; }); }
  let saying = null;   // { id, w } line being read aloud
  function lineHtml(it) {
    const S_ = L(it.sk), T = L(it.tk), play = saying && saying.id === it.id;
    return `<div class="msg ${it.s}${it.st ? ' pend' : ''}" data-id="${it.id}">` +
      `<div class="bub"><div class="src" dir="auto" lang="${esc(S_.g)}">${esc(it.x)}</div>` +
      `<div class="tr" dir="auto" lang="${esc(T.g)}">${it.y ? esc(it.y) : '<span class="dots"><i></i><i></i><i></i></span>'}</div></div>` +
      `<div class="act"><button class="ab${play ? ' on' : ''}" data-a="play" title="${play ? 'Berhenti' : 'Putar suara'}">${ic(play ? 'stop' : 'vol')}</button>` +
      `<button class="ab" data-a="copy" title="Salin terjemahan">${ic('copy')}</button>` +
      `<button class="ab" data-a="more" title="Lainnya">${ic('more')}</button></div></div>`;
  }
  function emptyHtml() {
    const A = L(cfg.a), B = L(cfg.b);
    return `<div class="empty"><div class="em">${ic('chat')}</div><h2>Terjemahan langsung</h2>` +
      `<p>Tekan <b>Auto</b> lalu bicara — bahasa ${esc(A.n)} atau ${esc(B.n)} dikenali sendiri dan langsung diterjemahkan.` +
      `<br>Bisa juga tekan tombol bahasa sesuai siapa yang bicara, atau ketik di kolom bawah.</p></div>`;
  }
  function render() {
    live.el = null; ph = null;
    const items = cur ? cur.items : [];
    let h = '', last = 0;
    for (const it of items) { if (it.at - last > 10 * 60e3) h += `<div class="tm">${when(it.at)}</div>`; last = it.at; h += lineHtml(it); }
    cw.innerHTML = h || emptyHtml();
    scrollEnd(true);
  }
  function emptyOff() { const e = cw.querySelector('.empty'); if (e) e.remove(); }
  function paintLine(it, add) {
    if (!cur || !cur.items.includes(it)) return;
    const el = cw.querySelector(`.msg[data-id="${it.id}"]`);
    const stick = add || nearBottom();
    if (el) el.outerHTML = lineHtml(it);
    else {
      emptyOff();
      const i = cur.items.indexOf(it), prev = cur.items[i - 1];
      const html = (!prev || it.at - prev.at > 10 * 60e3 ? `<div class="tm">${when(it.at)}</div>` : '') + lineHtml(it);
      const anchor = (live.el && live.el.parentNode && live.el) || (ph && ph.parentNode && ph) || null;
      if (anchor) anchor.insertAdjacentHTML('beforebegin', html); else cw.insertAdjacentHTML('beforeend', html);
    }
    if (stick) scrollEnd(true);
  }
  const lineOf = (el) => { const m = el && el.closest('.msg[data-id]'); return m && cur ? cur.items.find((x) => x.id === m.dataset.id) : null; };

  // the words of a speaker appearing while they talk (Web Speech), with a running quick translation
  const live = { el: null, s: '', x: '', q: '', qx: '', ctl: null, t: 0, last: 0 };
  function liveSet(s, x) {
    x = x.replace(/\s+/g, ' ').trim();
    if (!x) return;
    if (!live.el || live.s !== s || !live.el.parentNode) {
      liveDrop();
      live.s = s;
      live.el = document.createElement('div');
      live.el.className = 'msg live ' + s;
      live.el.innerHTML = '<div class="bub"><div class="src" dir="auto"></div><div class="tr" dir="auto"></div></div>';
      emptyOff();
      cw.appendChild(live.el);
    }
    live.x = x;
    live.el.querySelector('.src').textContent = x;
    scrollEnd(true);
    // translate at most every 0.6 s while the words keep coming, plus once when they stop
    clearTimeout(live.t);
    const wait = Math.max(0, 600 - (now() - live.last));
    live.t = setTimeout(liveTr, wait);
  }
  async function liveTr() {
    if (!live.el || !live.x || live.qx === live.x) return;
    live.last = now();
    const x = live.x, s = live.s, sk = s === 'a' ? cfg.a : cfg.b, tk = s === 'a' ? cfg.b : cfg.a;
    if (live.ctl) live.ctl.abort();
    const ctl = live.ctl = new AbortController();
    try {
      const r = await quick(x, L(sk).g, L(tk).g, ctl.signal);
      if (live.ctl === ctl && live.el) { live.q = r.t; live.qx = x; live.el.querySelector('.tr').textContent = r.t; scrollEnd(); }
    } catch { }
  }
  function liveDrop() {
    clearTimeout(live.t);
    if (live.ctl) live.ctl.abort();
    if (live.el) live.el.remove();
    live.el = null; live.ctl = null; live.x = ''; live.q = ''; live.qx = '';
  }

  // placeholder while the recorder hears someone (wave) or Whisper is still writing it down (dots)
  let ph = null, phTalk = false, phSide = '', pending = 0;
  function phPaint() {
    const kind = phTalk ? 'talk' : pending ? 'proc' : '';
    if (!kind) { if (ph) ph.remove(); ph = null; return; }
    if (!ph || !ph.parentNode) { ph = document.createElement('div'); emptyOff(); cw.appendChild(ph); }
    const cls = 'ph ' + (phSide === 'o' ? 'c' : phSide) + ' ' + kind;
    if (ph.className !== cls) {
      ph.className = cls;
      ph.innerHTML = kind === 'talk' ? '<div class="wv"><i></i><i></i><i></i><i></i><i></i></div>' : '<span class="dots"><i></i><i></i><i></i></span>';
    }
    scrollEnd(true);
  }

  // ---------- suara keluar (bacakan) ----------
  const synth = window.speechSynthesis || null;
  let voices = [];
  const loadVoices = () => { try { voices = synth ? synth.getVoices() : []; } catch { voices = []; } };
  if (synth) { loadVoices(); try { synth.addEventListener('voiceschanged', loadVoices); } catch { synth.onvoiceschanged = loadVoices; } }
  // macOS / iOS novelty voices sound like toys; never pick them
  const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|junior|organ|superstar|trinoids|whisper|wobble|zarvox|fred|ralph|kathy|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;
  const vlang = (v) => String(v.lang || '').replace('_', '-').toLowerCase().replace(/^in-/, 'id-').replace(/^iw-/, 'he-');
  function voiceFor(l) {
    if (!synth || !l.sr) return null;
    if (!voices.length) loadVoices();
    const want = l.sr.toLowerCase(), b = base(want);
    const ok = (v) => !NOVELTY.test(v.name);
    let c = voices.filter((v) => ok(v) && vlang(v) === want);
    if (!c.length) {
      const alt = { 'yue-hant-hk': 'zh-hk', 'fil-ph': 'fil', 'jv-id': 'jv', 'su-id': 'su', 'nb-no': 'no' }[want];
      if (alt) c = voices.filter((v) => ok(v) && (vlang(v) === alt || vlang(v).startsWith(alt + '-')));
    }
    if (!c.length && b !== 'yue') c = voices.filter((v) => ok(v) && base(vlang(v)) === (b === 'fil' ? 'fil' : b) && vlang(v) !== 'zh-hk');
    if (!c.length) return null;
    const sc = (v) => (/natural|neural|premium|enhanced|siri/i.test(v.name) ? 4 : 0) + (/google/i.test(v.name) ? 2 : 0) + (vlang(v) === want ? 2 : 0) + (v.localService ? 1 : 0);
    return c.slice().sort((x, y) => sc(y) - sc(x))[0];
  }
  function chunks(t, n) {
    const out = [];
    let s = String(t).replace(/\s+/g, ' ').trim();
    while (s.length > n) {
      const at = (re) => { let m, best = -1; re.lastIndex = 0; while ((m = re.exec(s)) && m.index < n) best = m.index + m[0].length; return best; };
      let cut = at(/[.!?。！？]\s*/g);
      if (cut < n * 0.4) cut = at(/[,;:，、；]\s*/g);
      if (cut < n * 0.3) cut = at(/\s+/g);
      if (cut < 1) cut = n;
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s) out.push(s);
    return out;
  }
  const au = new Audio();
  au.preload = 'auto';
  function speakSynth(text, v, gen) {
    return new Promise((res) => {
      const parts = chunks(text, 180);
      let i = 0, guard = 0, fin = false;
      const end = (ok) => { if (fin) return; fin = true; clearTimeout(guard); res(ok); };
      const next = () => {
        clearTimeout(guard);
        if (gen !== sayGen) return end(true);
        if (i >= parts.length) return end(true);
        const u = new SpeechSynthesisUtterance(parts[i++]);
        u.voice = v; u.lang = v.lang; u.rate = cfg.rate;
        u.onend = next;
        u.onerror = (e) => end(e.error === 'interrupted' || e.error === 'canceled');
        guard = setTimeout(next, 5000 + u.text.length * 120 / cfg.rate);   // Chrome sometimes never ends a network voice
        synth.speak(u);
      };
      try { if (synth.speaking || synth.pending) synth.cancel(); } catch { }
      next();
    });
  }
  function speakNet(text, l, gen) {   // Google's voice when the device has none for this language
    return new Promise((res) => {
      const parts = chunks(text, 190), code = /-/.test(l.k) ? l.k : l.g;
      let i = 0;
      const done = (ok) => { au.onended = au.onerror = null; res(ok); };
      const next = () => {
        if (gen !== sayGen || i >= parts.length) return done(true);
        au.src = 'https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=' + encodeURIComponent(code) + '&q=' + encodeURIComponent(parts[i++]);
        au.defaultPlaybackRate = au.playbackRate = cfg.rate;
        au.onended = next;
        au.onerror = () => done(false);
        const p = au.play();
        if (p && p.catch) p.catch(() => done(false));
      };
      next();
    });
  }
  function stopSound() {
    sayGen++;
    try { if (synth && (synth.speaking || synth.pending)) synth.cancel(); } catch { }
    try { au.pause(); au.onended = au.onerror = null; } catch { }
  }
  async function speak(text, l) {
    stopSound();
    const gen = sayGen, v = voiceFor(l);
    let ok = false;
    if (v) ok = await speakSynth(text, v, gen);
    if (!ok && gen === sayGen) ok = await speakNet(text, l, gen);
    return ok && gen === sayGen;
  }
  async function speakLine(it, w) {
    const text = w === 'x' ? it.x : it.y;
    if (!text) return;
    unlock();
    saying = { id: it.id, w };
    paintLine(it);
    await micHold(true);
    let ok = true;
    try { ok = await speak(text, L(w === 'x' ? it.sk : it.tk)); } catch { ok = false; }
    if (saying && saying.id === it.id) saying = null;
    paintLine(it);
    await micHold(false);
    if (!ok && !saying && sayGenWas(it)) toast('Suara bahasa ini belum tersedia di perangkat ini');
  }
  const failSeen = new Set();
  function sayGenWas(it) { const k = it.tk + it.id; if (failSeen.has(k)) return false; failSeen.add(k); return true; }
  // phones only play sound after a tap: prime both voices on the first one
  let unlocked = false;
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    try { if (synth) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); } } catch { }
    try { au.src = SILENT; const p = au.play(); if (p && p.catch) p.catch(() => { }); } catch { }
  }
  const SILENT = (() => {
    const n = 800, v = new DataView(new ArrayBuffer(44 + n * 2)), u = new Uint8Array(v.buffer);
    const tag = (o, t) => { for (let i = 0; i < 4; i++) u[o + i] = t.charCodeAt(i); };
    tag(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, n * 2, true);
    let b = ''; for (let i = 0; i < u.length; i++) b += String.fromCharCode(u[i]);
    return 'data:audio/wav;base64,' + btoa(b);
  })();

  // ---------- suara masuk ----------
  let mode = '';   // '' | 'a' | 'b' (one language, chosen by the button) | 'o' (Auto: Whisper decides)
  let eng = '';    // 'sr' = Web Speech, 'ear' = own recorder + Whisper
  let rec = null, recHold = false, recFails = 0, recT0 = 0;

  function heard(s, text, by) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    text = text[0].toLocaleUpperCase() + text.slice(1);
    const q = live.x && live.qx === live.x && norm(live.x) === norm(text) ? live.q : '';
    liveDrop();
    const sk = s === 'a' ? cfg.a : cfg.b, tk = s === 'a' ? cfg.b : cfg.a;
    addLine({ s, sk, tk, x: text, q, by });
  }

  function srStart(s) {
    const l = L(s === 'a' ? cfg.a : cfg.b);
    const r = rec = new SRC();
    r.lang = l.sr;
    r.interimResults = true;
    r.continuous = !ANDROID;   // Android's continuous mode repeats results; it restarts after each sentence instead
    r.maxAlternatives = 1;
    eng = 'sr';
    let got = false, mute = 0;   // results this activation / sessions in a row that heard nothing
    let since = 0, forcing = false;   // when the current unfinished sentence started
    const toEar = () => { srBad.add(l.sr); rec = null; try { r.abort(); } catch { } earStart(s); };
    r.onstart = () => { recT0 = now(); paintMics(); };
    r.onresult = (e) => {
      if (r !== rec) return;
      got = true; mute = 0;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i], t = (res[0] && res[0].transcript) || '';
        if (res.isFinal) { heard(s, t, 'mic'); since = 0; }
        else interim += t;
      }
      if (interim.trim()) {
        liveSet(s, interim);
        if (!since) since = now();
        // someone talking on and on (or a noisy room) never gets a final result: stopping makes the
        // recognizer hand over what it has; onend starts it again at once
        if (!forcing && (now() - since > 12000 || interim.length > 220)) { forcing = true; try { r.stop(); } catch { } }
      }
      recFails = 0;
    };
    r.onerror = (e) => {
      if (r !== rec) return;
      const er = e.error;
      if (er === 'aborted') return;
      if (er === 'no-speech') {
        // a recognizer that never hears anything (seen: it listened to another input than the page's mic)
        if (!got && ++mute >= 3 && l.w && aiOn()) toEar();
        return;
      }
      if (er === 'audio-capture') { stopAll(); return toast('Mikrofon tidak ditemukan'); }
      if (er === 'not-allowed' && !IOS) { stopAll(); return toast('Izinkan akses mikrofon untuk situs ini'); }
      // network / service-not-allowed / language-not-supported / iPhone with Siri off → own recorder + Whisper
      if (l.w && aiOn()) toEar();
      else { srBad.add(l.sr); rec = null; try { r.abort(); } catch { } stopAll(); toast('Pengenalan suara tidak tersedia di browser ini — silakan ketik'); }
    };
    r.onend = () => {
      if (r !== rec) return;
      if (live.x) heard(s, live.x, 'mic');   // phones may end without turning the last words final
      since = 0;
      const forced = forcing;
      forcing = false;
      if (mode !== s || eng !== 'sr' || recHold) return;
      if (forced) { try { r.start(); } catch { } return; }
      const fast = now() - recT0 < 1500;
      recFails = fast ? recFails + 1 : 0;
      if (recFails > 6) {   // keeps dying at once: switch to the recorder
        srBad.add(l.sr); rec = null;
        if (l.w && aiOn()) return earStart(s);
        stopAll(); return toast('Mikrofon berhenti — ketuk lagi untuk lanjut');
      }
      setTimeout(() => { if (rec === r && mode === s && !recHold) { try { r.start(); } catch { } } }, fast ? 300 * recFails : 80);
    };
    try { r.start(); } catch { setTimeout(() => { try { r.start(); } catch { } }, 300); }
  }

  // own recorder: mic → 16 kHz → voice activity detection → one WAV per utterance → Whisper
  const Ear = (() => {
    const RATE = 16000, FR = 320;                                      // 20 ms frames
    const PRE = 15, START = 3, END_SIL = 32, MIN_VOICE = 12, MAX = 1100; // 300 ms pre-roll, 640 ms pause ends it, max 22 s
    const WORKLET = "class T extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.n=0}process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===2048){this.port.postMessage(this.b.slice(0));this.n=0}}}return true}}registerProcessor('tr-tap',T)";
    let ctx = null, stream = null, src = null, node = null, sink = null, wl = false;
    let on = false, mute = false, h = {};
    let carry = 0, sum = 0, cnt = 0, fb = new Float32Array(FR), fn = 0;
    let floor = -58, talking = false, pre = [], utt = [], voiced = 0, sil = 0, hot = 0, lvAt = 0;
    function reset() { talking = false; pre = []; utt = []; voiced = 0; sil = 0; hot = 0; carry = 0; sum = 0; cnt = 0; fn = 0; }
    function feed(x) {
      if (!on || mute) return;
      const r = ctx.sampleRate / RATE;
      for (let i = 0; i < x.length; i++) {
        sum += x[i]; cnt++; carry += 1;
        if (carry >= r) {
          carry -= r; fb[fn++] = sum / cnt; sum = 0; cnt = 0;
          if (fn === FR) { frame(fb); fb = new Float32Array(FR); fn = 0; }
        }
      }
    }
    function frame(f) {
      let e = 0;
      for (let i = 0; i < f.length; i++) e += f[i] * f[i];
      const db = 10 * Math.log10(e / f.length + 1e-12);
      if (!talking) floor = Math.max(-75, Math.min(-32, floor + (db - floor) * (db < floor ? 0.25 : 0.004)));
      const loud = db > Math.max(floor + (talking ? 7 : 11), -56);
      const t = now();
      if (t - lvAt > 50) { lvAt = t; h.level && h.level(Math.max(0, Math.min(1, (db - floor - 4) / 26))); }
      if (!talking) {
        pre.push(f);
        if (pre.length > PRE) pre.shift();
        hot = loud ? hot + 1 : Math.max(0, hot - 1);
        if (hot >= START) { talking = true; utt = pre; pre = []; voiced = hot; sil = 0; h.state && h.state('talk'); }
      } else {
        utt.push(f);
        if (loud) { voiced++; sil = 0; } else sil++;
        if (sil >= END_SIL) finish(false);
        else if (utt.length >= MAX) finish(true);
      }
    }
    function finish(cut) {
      const frames = utt.slice(0, utt.length - Math.max(0, sil - 10)), ok = voiced >= MIN_VOICE;
      utt = []; voiced = 0; sil = 0; hot = 0;
      talking = cut;   // a 22 s cut keeps listening to the same speaker
      if (!cut) h.state && h.state('idle');
      if (ok && frames.length) {
        const pcm = new Float32Array(frames.length * FR);
        frames.forEach((fr, i) => pcm.set(fr, i * FR));
        h.utter && h.utter(pcm);
      }
    }
    async function open() {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      if (ctx.state !== 'running') { try { await ctx.resume(); } catch { } }
      src = ctx.createMediaStreamSource(stream);
      if (ctx.audioWorklet && window.AudioWorkletNode) {
        if (!wl) { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))); wl = true; }
        node = new AudioWorkletNode(ctx, 'tr-tap');
        node.port.onmessage = (e) => feed(e.data);
      } else {
        node = ctx.createScriptProcessor(2048, 1, 1);
        node.onaudioprocess = (e) => feed(e.inputBuffer.getChannelData(0));
      }
      sink = ctx.createGain();
      sink.gain.value = 0;
      src.connect(node); node.connect(sink); sink.connect(ctx.destination);
    }
    function close() {
      try { if (src) src.disconnect(); if (node) node.disconnect(); if (sink) sink.disconnect(); } catch { }
      if (node && node.port) node.port.onmessage = null;
      src = node = sink = null;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    return {
      get on() { return on; },
      async start(handlers) { h = handlers || {}; reset(); await open(); on = true; mute = false; },
      stop(keep) {   // keep = send what the speaker said before the tap
        if (keep && talking && voiced >= MIN_VOICE) { sil = 0; finish(false); }
        on = false; reset(); close();
        if (ctx && ctx.state === 'running' && !IOS) ctx.suspend().catch(() => { });
      },
      // while a translation is read aloud: ignore the mic; an iPhone also has to let go of it, else the
      // voice comes out of the earpiece
      async hold(v) {
        if (!on) return;
        if (v && talking && voiced >= MIN_VOICE) { sil = 0; finish(false); }   // send what was said so far
        mute = v; reset();
        if (!IOS) return;
        if (v) close();
        else {
          try { await open(); } catch { on = false; h.state && h.state('lost'); }
        }
      },
    };
  })();

  function wav64(f) {
    let peak = 0;
    for (let i = 0; i < f.length; i++) { const a = Math.abs(f[i]); if (a > peak) peak = a; }
    const g = peak > 0 && peak < 0.5 ? Math.min(8, 0.7 / peak) : 1;
    const n = f.length, v = new DataView(new ArrayBuffer(44 + n * 2)), u = new Uint8Array(v.buffer);
    const tag = (o, t) => { for (let i = 0; i < 4; i++) u[o + i] = t.charCodeAt(i); };
    tag(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, f[i] * g)); v.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true); }
    let b = '';
    for (let i = 0; i < u.length; i += 0x8000) b += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(b);
  }

  let earQ = Promise.resolve(), sttWarn = 0;
  function earStart(s) {
    eng = 'ear';
    phSide = s;
    paintMics();
    Ear.start({
      state: (st) => {
        if (st === 'talk') { phTalk = true; phPaint(); }
        else if (st === 'idle') { phTalk = false; phPaint(); }
        else if (st === 'lost') { stopAll(); toast('Mikrofon terlepas — ketuk lagi untuk lanjut'); }
      },
      level: (v) => { const b = micEl(mode); if (b) b.style.setProperty('--lv', v.toFixed(2)); if (ph) ph.style.setProperty('--lv', v.toFixed(2)); },
      utter: (pcm) => onUtter(s, pcm),
    }).catch((e) => {
      if (mode === s) stopAll();
      toast(e && e.name === 'NotAllowedError' ? 'Izinkan akses mikrofon untuk situs ini' : 'Mikrofon tidak bisa dibuka');
    });
  }
  function onUtter(s, pcm) {
    pending++; phPaint(); paintStatus();
    const audio = wav64(pcm), fixed = s !== 'o';
    const job = async () => {
      const body = { audio };
      if (fixed) body.lang = L(s === 'a' ? cfg.a : cfg.b).w;
      const r = await edge('stt', body, 45000);
      if (r.error) {
        if (now() - sttWarn > 20e3) {
          sttWarn = now();
          toast(r.error === 'kuota' ? 'Kuota AI hari ini habis — pakai tombol bahasa (pukul 07.00 pulih)' : r.error === 'auth' ? 'Masuk ke Portal AMATU dulu untuk mode suara ini' : 'Suara tidak terkirim — periksa koneksi');
        }
        if (r.error === 'kuota' || r.error === 'auth') stopAll();
        return;
      }
      let side = s, text = r.text || '';
      if (!fixed && text) {
        side = await pickSide(r.lang, text);
        const want = L(side === 'a' ? cfg.a : cfg.b).w;
        if (want && r.lang !== want && !near(r.lang, want)) {   // Whisper heard a third language: listen again as the chosen one
          const r2 = await edge('stt', { audio, lang: want }, 45000);
          if (r2.text) text = r2.text;
        }
      }
      if (text) heard(side, text, fixed ? 'mic' : 'auto');
    };
    earQ = earQ.then(job, job).catch(() => { }).then(() => { pending--; phPaint(); paintStatus(); });
  }
  async function pickSide(wl, text) {
    const A = L(cfg.a), B = L(cfg.b);
    if (wl && wl === A.w) return 'a';
    if (wl && wl === B.w) return 'b';
    if (near(wl, A.w)) return 'a';
    if (near(wl, B.w)) return 'b';
    try {
      const r = await quick(text, 'auto', A.g === 'en' ? 'id' : 'en');
      if (base(r.src) === base(A.g)) return 'a';
      if (base(r.src) === base(B.g)) return 'b';
    } catch { }
    const last = cur && cur.items[cur.items.length - 1];   // two people take turns
    return last ? (last.s === 'a' ? 'b' : 'a') : 'a';
  }

  async function micHold(v) {
    if (!mode) return;
    if (eng === 'sr' && rec) {
      recHold = v;
      if (v) { try { rec.abort(); } catch { } liveDrop(); }
      else { await sleep(250); if (rec && mode && !recHold) { try { rec.start(); } catch { } } }
    } else if (eng === 'ear') await Ear.hold(v);
    paintStatus();
  }

  async function toggle(m) {
    unlock();
    if (mode === m) { stopAll(true); return; }
    stopAll(true);
    stopSound();
    if (!cur) newSession();
    mode = m;
    if (m === 'o') {
      if (!aiOn()) {
        mode = ''; paintMics();
        return toast(tok() ? 'Mode Auto sedang tidak tersedia — pakai tombol bahasa' : 'Mode Auto perlu masuk ke Portal AMATU');
      }
      earStart('o');
      return paintMics();
    }
    const l = L(m === 'a' ? cfg.a : cfg.b);
    if (SRC && l.sr && !srBad.has(l.sr)) { srStart(m); return paintMics(); }
    if (l.w && aiOn()) { earStart(m); return paintMics(); }
    mode = ''; paintMics();
    toast(`${l.n} belum bisa lewat suara di browser ini — silakan ketik`);
  }
  function stopAll(keep) {
    const was = mode, e = eng;
    mode = ''; eng = ''; recHold = false;
    if (rec) { const r = rec; rec = null; try { r.abort(); } catch { } }
    if (live.x && was && was !== 'o') heard(was, live.x, 'mic'); else liveDrop();
    if (e === 'ear') Ear.stop(keep);
    phTalk = false; phPaint();
    const b = micEl(was); if (b) b.style.removeProperty('--lv');
    paintMics();
    if (dirty) save();
  }

  // ---------- tombol & status ----------
  const micEl = (m) => (m === 'a' ? $('#ma') : m === 'b' ? $('#mb') : m === 'o' ? $('#mo') : null);
  function paintMics() {
    const A = L(cfg.a), B = L(cfg.b);
    $('#ma .ml').textContent = short(A);
    $('#mb .ml').textContent = short(B);
    $('#ma').title = `Bicara dalam ${A.n}`;
    $('#mb').title = `Bicara dalam ${B.n}`;
    $('#ma').classList.toggle('dim', !canHear(A));
    $('#mb').classList.toggle('dim', !canHear(B));
    for (const m of ['a', 'b', 'o']) {
      const el = micEl(m);
      el.classList.toggle('on', mode === m);
      el.classList.toggle('sr', mode === m && eng === 'sr');
      el.setAttribute('aria-pressed', mode === m ? 'true' : 'false');
    }
    paintStatus();
  }
  function paintStatus() {
    let t = '';
    if (saying) t = 'Membacakan terjemahan…';
    else if (pending && !phTalk) t = 'Menerjemahkan…';
    else if (mode === 'o') t = `Mendengarkan ${L(cfg.a).n} & ${L(cfg.b).n} — bicara saja`;
    else if (mode) t = `Mendengarkan ${L(mode === 'a' ? cfg.a : cfg.b).n}… ketuk lagi untuk berhenti`;
    else if (!cur || !cur.items.length) t = 'Ketuk Auto atau tombol bahasa, lalu bicara';
    $('#st').textContent = t;
  }
  function paintLangs() {
    $('#la span').textContent = L(cfg.a).n;
    $('#lb span').textContent = L(cfg.b).n;
    paintMics();
    if (cur && !cur.items.length) render();
  }
  function paintSpk() {
    $('#bSpk').classList.toggle('off', !cfg.speak);
    $('#bSpk use').setAttribute('href', cfg.speak ? '#i-vol' : '#i-voloff');
    $('#bSpk').title = cfg.speak ? 'Bacakan otomatis: aktif' : 'Bacakan otomatis: mati';
  }
  const applyFs = () => document.documentElement.style.setProperty('--fs', String(cfg.fs || 1));

  let toastT = 0;
  function toast(m) {
    const t = $('#toast');
    t.textContent = m;
    t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('on'), 2800);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { }
      ta.remove();
    }
    toast('Disalin');
  }

  // ---------- sheet, menu, konfirmasi ----------
  const sheet = $('#sheet'), card = $('#sheet .card');
  let sheetClose = null;
  function openSheet(html, cls, onClose) {
    card.className = 'card' + (cls ? ' ' + cls : '');
    card.innerHTML = html;
    sheet.hidden = false;
    sheetClose = onClose || null;
  }
  function closeSheet() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    card.innerHTML = '';
    const f = sheetClose; sheetClose = null;
    if (f) f();
  }
  sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('[data-close]')) closeSheet(); });
  function confirmBox(title, text, ok, okLabel) {
    openSheet(`<div class="cf"><h3>${esc(title)}</h3><p>${esc(text)}</p><div class="row"><button class="btn" data-close>Batal</button><button class="btn dng" id="cfOk">${esc(okLabel || 'Hapus')}</button></div></div>`, 'small');
    $('#cfOk').onclick = () => { closeSheet(); ok(); };
  }
  const pop = $('#pop');
  function menu(btn, items) {
    pop.innerHTML = items.map(([i, t, , dng], k) => `<button data-k="${k}"${dng ? ' class="dng"' : ''}>${ic(i)}<span>${esc(t)}</span></button>`).join('');
    pop.hidden = false;
    const r = btn.getBoundingClientRect(), w = pop.offsetWidth, hgt = pop.offsetHeight;
    let x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    let y = r.bottom + 6;
    if (y + hgt > innerHeight - 8) y = r.top - hgt - 6;
    pop.style.left = x + 'px';
    pop.style.top = Math.max(8, y) + 'px';
    pop.onclick = (e) => { const b = e.target.closest('button[data-k]'); if (!b) return; pop.hidden = true; items[+b.dataset.k][2](); };
  }
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true; }, true);

  // ---------- pemilih bahasa ----------
  function pickLang(side) {
    const curK = side === 'a' ? cfg.a : cfg.b;
    openSheet(`<div class="sh-h"><div class="sh-t">${side === 'a' ? 'Bahasa pertama' : 'Bahasa kedua'}</div><button class="ib" data-close title="Tutup">${ic('x')}</button></div>` +
      `<label class="srch">${ic('search', 'sm')}<input id="lq" type="search" placeholder="Cari bahasa" autocomplete="off" enterkeyhint="search"></label><div class="ll" id="ll"></div>`, 'tall');
    const q = $('#lq'), ll = $('#ll');
    const row = (l) => `<button class="lr${l.k === curK ? ' on' : ''}" data-k="${l.k}"><span class="lt"><span class="ln">${esc(l.n)}</span><span class="lnn">${esc(l.nn)}</span></span>` +
      `${canHear(l) ? ic('mic', 'sm') : ''}${l.k === curK ? ic('check', 'sm ck') : ''}</button>`;
    const draw = () => {
      const s = q.value.trim().toLowerCase();
      const hit = (l) => !s || [l.n, l.nn, l.e, l.k].some((x) => x.toLowerCase().includes(s));
      let h = '';
      const recent = s ? [] : [...new Set(cfg.recent)].filter((k) => LM.has(k)).slice(0, 6).map(L);
      if (recent.length) h += '<div class="hg">Terakhir dipakai</div>' + recent.map(row).join('');
      const all = LANGS.filter(hit).sort((x, y) => x.n.localeCompare(y.n, 'id'));
      h += (recent.length ? '<div class="hg">Semua bahasa</div>' : '') + (all.length ? all.map(row).join('') : '<div class="hx">Bahasa tidak ditemukan</div>');
      ll.innerHTML = h;
    };
    draw();
    q.addEventListener('input', draw);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const b = ll.querySelector('.lr'); if (b) b.click(); } });
    ll.addEventListener('click', (e) => { const b = e.target.closest('.lr'); if (!b) return; setLang(side, b.dataset.k); closeSheet(); });
    if (!PHONE) setTimeout(() => q.focus(), 60);
  }
  function setLang(side, k) {
    if (mode) stopAll(true);
    const other = side === 'a' ? cfg.b : cfg.a;
    if (k === other) [cfg.a, cfg.b] = [cfg.b, cfg.a];
    else cfg[side] = k;
    cfg.recent = [k, ...cfg.recent.filter((x) => x !== k)].slice(0, 8);
    saveCfg();
    if (cur) { cur.a = cfg.a; cur.b = cfg.b; if (cur.items.length) save(); }
    paintLangs();
  }

  // ---------- pengaturan ----------
  function openSettings() {
    const seg = [[0.9, 'Kecil'], [1, 'Sedang'], [1.15, 'Besar']];
    openSheet(`<div class="sh-h"><div class="sh-t">Pengaturan</div><button class="ib" data-close title="Tutup">${ic('x')}</button></div><div class="opts">` +
      `<div class="opt"><div class="ot"><b>Bacakan terjemahan otomatis</b><small>Setiap kalimat dari mikrofon langsung dibacakan dalam bahasa tujuan.</small></div><button class="sw${cfg.speak ? ' on' : ''}" id="oSpk" aria-label="Bacakan otomatis"></button></div>` +
      `<div class="opt"><div class="ot"><b>Kecepatan suara</b></div><input type="range" id="oRate" min="0.6" max="1.4" step="0.1" value="${cfg.rate}"><span class="rv" id="oRv">${cfg.rate.toFixed(1)}×</span></div>` +
      `<div class="opt"><div class="ot"><b>Ukuran teks</b></div><div class="seg" id="oFs">${seg.map(([v, t]) => `<button data-v="${v}" class="${Math.abs(cfg.fs - v) < 0.01 ? 'on' : ''}">${t}</button>`).join('')}</div></div>` +
      `<div class="opt"><div class="ot"><b>Percakapan ini</b><small>Salin atau unduh semua kalimat beserta terjemahannya.</small></div><button class="ab" id="oCopy" title="Salin">${ic('copy')}</button><button class="ab" id="oDl" title="Unduh .txt">${ic('down')}</button></div>` +
      `<div class="opt"><div class="ot"><b>Riwayat</b><small>${idx.length} percakapan tersimpan di akun Anda.</small></div><button class="btn" id="oDel">Hapus semua</button></div>` +
      '</div>');
    $('#oSpk').onclick = (e) => { cfg.speak = !cfg.speak; e.currentTarget.classList.toggle('on', cfg.speak); saveCfg(); paintSpk(); };
    $('#oRate').oninput = (e) => { cfg.rate = Math.round(+e.target.value * 10) / 10; $('#oRv').textContent = cfg.rate.toFixed(1) + '×'; saveCfg(); };
    $('#oRate').onchange = () => { const it = cur && [...cur.items].reverse().find((x) => x.y); if (it) speakLine(it, 'y'); };
    $('#oFs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; cfg.fs = +b.dataset.v; saveCfg(); applyFs(); [...$('#oFs').children].forEach((x) => x.classList.toggle('on', x === b)); };
    $('#oCopy').onclick = () => { const t = transcript(); if (t) copy(t); else toast('Percakapan masih kosong'); };
    $('#oDl').onclick = download;
    $('#oDel').onclick = () => { closeSheet(); clearAll(); };
  }
  function transcript(s) {
    s = s || cur;
    if (!s || !s.items.length) return '';
    const head = `Amatu Translator — ${L(s.a).n} ⇄ ${L(s.b).n} — ${new Date(s.c).toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'short' })}`;
    return head + '\n\n' + s.items.map((it) => `[${hm(it.at)}] ${L(it.sk).n}: ${it.x}\n${L(it.tk).n}: ${it.y || '—'}`).join('\n\n') + '\n';
  }
  function download() {
    const t = transcript();
    if (!t) return toast('Percakapan masih kosong');
    const a = document.createElement('a');
    const d = new Date(cur.c), p = (n) => String(n).padStart(2, '0');
    a.href = URL.createObjectURL(new Blob([t], { type: 'text/plain;charset=utf-8' }));
    a.download = `terjemahan-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- riwayat ----------
  const hist = $('#hist'), scrim = $('#scrim');
  function openHist() { hist.classList.add('open'); scrim.classList.add('on'); renderHist(); }
  function closeHist() { hist.classList.remove('open'); scrim.classList.remove('on'); }
  function sessionText(id) {
    if (!textCache.has(id)) {
      const s = S.get(KS(id), null);
      textCache.set(id, s && Array.isArray(s.items) ? s.items.map((it) => it.x + '\n' + (it.y || '')).join('\n').toLowerCase() : '');
    }
    return textCache.get(id);
  }
  function group(t) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (t >= +today) return 'Hari ini';
    if (t >= +today - 864e5) return 'Kemarin';
    if (t >= +today - 6 * 864e5) return '7 hari terakhir';
    return new Date(t).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
  }
  function renderHist() {
    const box = $('#hl');
    if (!box) return;
    const q = $('#hq').value.trim().toLowerCase();
    const list = q ? idx.filter((m) => (m.t || '').toLowerCase().includes(q) || sessionText(m.id).includes(q)) : idx;
    if (!list.length) {
      box.innerHTML = `<div class="hx">${q ? 'Tidak ada yang cocok.' : 'Belum ada riwayat.<br>Setiap percakapan tersimpan otomatis di sini.'}</div>`;
      $('#hAll').hidden = !idx.length;
      return;
    }
    let h = '', g0 = '';
    for (const m of list) {
      const g = group(m.u);
      if (g !== g0) { h += `<div class="hg">${g}</div>`; g0 = g; }
      const day = new Date(m.u), td = new Date(); td.setHours(0, 0, 0, 0);
      const t = m.u >= +td - 864e5 ? hm(m.u) : day.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
      h += `<div class="hr${cur && cur.id === m.id ? ' on' : ''}" data-id="${esc(m.id)}"><button class="ho"><div class="ht">${esc(m.t || 'Percakapan')}</div>` +
        `<div class="hm">${esc(L(m.a).n)} ⇄ ${esc(L(m.b).n)} · ${m.n} kalimat · ${t}</div></button>` +
        `<button class="ab" data-a="del" title="Hapus percakapan">${ic('trash')}</button></div>`;
    }
    box.innerHTML = h;
    $('#hAll').hidden = false;
  }
  function openFromHist(id) {
    if (cur && cur.id === id) { closeHist(); return; }
    if (mode) stopAll(true);
    stopSound();
    flush();
    if (!openSession(id)) { toast('Percakapan ini tidak bisa dibuka'); dropSession(id); return; }
    // continue in the languages of that conversation
    if (LM.has(cur.a) && LM.has(cur.b) && cur.a !== cur.b) { cfg.a = cur.a; cfg.b = cur.b; saveCfg(); }
    paintLangs();
    render();
    renderHist();
    paintStatus();
    closeHist();
  }
  function startNew() {
    if (mode) stopAll(true);
    stopSound();
    flush();
    newSession();
    render();
    renderHist();
    paintStatus();
    closeHist();
  }
  function delSession(id) {
    const m = idx.find((x) => x.id === id);
    confirmBox('Hapus percakapan ini?', `"${(m && m.t) || 'Percakapan'}" akan dihapus dari riwayat di semua perangkat.`, () => {
      dropSession(id);
      if (cur && cur.id === id) { if (mode) stopAll(); newSession(); render(); paintStatus(); }
      toast('Percakapan dihapus');
    });
  }
  function clearAll() {
    if (!idx.length) return toast('Riwayat sudah kosong');
    confirmBox('Hapus semua riwayat?', `${idx.length} percakapan akan dihapus dari semua perangkat. Ini tidak bisa dibatalkan.`, () => {
      if (mode) stopAll();
      for (const m of idx) S.del(KS(m.id));
      idx = []; S.set(KI, idx); textCache.clear();
      newSession(); render(); renderHist(); paintStatus();
      toast('Riwayat dihapus');
    }, 'Hapus semua');
  }

  // ---------- aksi di gelembung ----------
  function delLine(it) {
    const i = cur.items.indexOf(it);
    if (i < 0) return;
    cur.items.splice(i, 1);
    render();
    dirty = true; flush();
    if (!cur.items.length) paintStatus();
  }
  function flip(it) {   // the language was guessed wrong: treat the text as the other side's language
    it.s = it.s === 'a' ? 'b' : 'a';
    it.sk = it.s === 'a' ? cfg.a : cfg.b;
    it.tk = it.s === 'a' ? cfg.b : cfg.a;
    it.q = it.y = ''; it.ai = 0; it.st = 1;
    paintLine(it);
    (async () => {
      try { const r = await quick(it.x, L(it.sk).g, L(it.tk).g); it.q = it.y = r.t; } catch { }
      paintLine(it);
      const t = await refine(it);
      if (t) { it.y = t; it.ai = 1; }
      it.st = 0; paintLine(it); save();
    })();
  }
  cw.addEventListener('click', (e) => {
    const b = e.target.closest('.ab[data-a]');
    if (!b) return;
    const it = lineOf(b);
    if (!it) return;
    const a = b.dataset.a;
    if (a === 'play') {
      if (saying && saying.id === it.id) { stopSound(); return; }
      speakLine(it, 'y');
    } else if (a === 'copy') copy(it.y || it.x);
    else if (a === 'more') {
      menu(b, [
        ['vol', `Bacakan teks asli (${L(it.sk).n})`, () => speakLine(it, 'x')],
        ['copy', 'Salin teks asli', () => copy(it.x)],
        ['copy', 'Salin keduanya', () => copy(it.x + '\n' + (it.y || ''))],
        ['swap', 'Salah bahasa? Balik arah', () => flip(it)],
        ['trash', 'Hapus kalimat ini', () => delLine(it), true],
      ]);
    }
  });

  // ---------- mengetik ----------
  const tx = $('#tx'), typ = $('#typ'), dock = $('#dock');
  function autosize() {
    tx.style.height = 'auto';
    tx.style.height = Math.min(tx.scrollHeight, 132) + 'px';
    tx.style.overflowY = tx.scrollHeight > 132 ? 'auto' : 'hidden';
  }
  tx.addEventListener('input', () => { autosize(); typ.classList.toggle('has', !!tx.value.trim()); });
  tx.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(false); }
  });
  typ.addEventListener('submit', (e) => { e.preventDefault(); send(false); });
  $('#bSay').addEventListener('click', () => send(true));
  tx.addEventListener('focus', () => { if (PHONE && innerHeight < 720) dock.classList.add('typing'); fitVV(); });
  tx.addEventListener('blur', () => { setTimeout(() => { dock.classList.remove('typing'); fitVV(); }, 120); });
  async function send(say) {
    const x = tx.value.trim();
    if (!x) return;
    unlock();
    if (mode) stopAll(true);
    tx.value = ''; autosize(); typ.classList.remove('has');
    if (!cur) newSession();
    const A = L(cfg.a), B = L(cfg.b);
    // whoever's language Google sees in it; anything that isn't the second language counts as the first person
    let r = null;
    try { r = await quick(x, 'auto', B.g); } catch { }
    const src = (r && r.src) || A.g;
    const isB = base(src) === base(B.g) || (base(src) !== base(A.g) && near(base(src), B.w) && !near(base(src), A.w));
    if (isB) addLine({ s: 'b', sk: cfg.b, tk: cfg.a, x, by: 'key', say });
    else {
      const third = base(src) !== base(A.g) && byG(src);
      addLine({ s: 'a', sk: third ? third.k : cfg.a, tk: cfg.b, x, q: (r && r.t) || '', by: 'key', say });
    }
  }

  // iPhone keyboard: keep the dock above it
  const vv = window.visualViewport;
  function fitVV() {
    const app = $('#app');
    if (!vv || !IOS || document.activeElement !== tx) { app.style.height = ''; app.style.transform = ''; return; }
    app.style.height = vv.height + 'px';
    app.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
    scrollEnd(true);
  }
  if (vv && IOS) { vv.addEventListener('resize', fitVV); vv.addEventListener('scroll', fitVV); }

  // ---------- kabel ----------
  $('#ma').addEventListener('click', () => toggle('a'));
  $('#mb').addEventListener('click', () => toggle('b'));
  $('#mo').addEventListener('click', () => toggle('o'));
  $('#la').addEventListener('click', () => pickLang('a'));
  $('#lb').addEventListener('click', () => pickLang('b'));
  $('#swap').addEventListener('click', (e) => {
    if (mode) stopAll(true);
    [cfg.a, cfg.b] = [cfg.b, cfg.a];
    saveCfg();
    if (cur) { cur.a = cfg.a; cur.b = cfg.b; }
    e.currentTarget.classList.toggle('spin');
    paintLangs();
  });
  $('#bSpk').addEventListener('click', () => { cfg.speak = !cfg.speak; saveCfg(); paintSpk(); toast(cfg.speak ? 'Terjemahan dibacakan otomatis' : 'Bacakan otomatis dimatikan'); if (!cfg.speak) stopSound(); });
  $('#bSet').addEventListener('click', openSettings);
  $('#bNew').addEventListener('click', startNew);
  $('#hNew').addEventListener('click', startNew);
  $('#bHist').addEventListener('click', openHist);
  $('#hClose').addEventListener('click', closeHist);
  scrim.addEventListener('click', closeHist);
  $('#hAll').addEventListener('click', clearAll);
  $('#hq').addEventListener('input', renderHist);
  $('#hl').addEventListener('click', (e) => {
    const row = e.target.closest('.hr');
    if (!row) return;
    if (e.target.closest('[data-a="del"]')) delSession(row.dataset.id);
    else openFromHist(row.dataset.id);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!pop.hidden) pop.hidden = true;
      else if (!sheet.hidden) closeSheet();
      else if (hist.classList.contains('open')) closeHist();
      else if (saying) stopSound();
      else if (mode) stopAll(true);
    }
  });

  // another device (through /amatu.js) or another tab changed the history
  window.addEventListener('storage', (e) => {
    if (!e.key || !e.key.startsWith('translator.')) return;
    if (e.key === KI) { idx = loadIdx(); renderHist(); }
    else if (e.key === KC) {
      if (mode) return;
      const c = S.get(KC, {});
      for (const k of ['a', 'b', 'speak', 'rate', 'fs', 'recent']) if (c[k] != null) cfg[k] = c[k];
      if (!LM.has(cfg.a)) cfg.a = 'id';
      if (!LM.has(cfg.b) || cfg.b === cfg.a) cfg.b = cfg.a === 'en' ? 'id' : 'en';
      paintLangs(); paintSpk(); applyFs();
    } else if (cur && e.key === KS(cur.id) && !mode && !dirty && !pending) {
      textCache.delete(cur.id);
      const s = S.get(KS(cur.id), null);
      if (s && Array.isArray(s.items) && !cur.items.some((it) => it.st)) { cur.items = s.items.map((it) => Object.assign({}, it, { st: 0 })); render(); }
    } else if (e.key.startsWith('translator.s.')) textCache.delete(e.key.slice(13));
  });
  window.addEventListener('pagehide', () => flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    flush();
    if (PHONE && mode) stopAll(true);   // phones cut the mic of a page in the background anyway
  });

  // ---------- mulai ----------
  applyFs();
  paintSpk();
  const last = idx[0];
  if (!(last && now() - last.u < 30 * 60e3 && openSession(last.id))) newSession();
  else if (LM.has(cur.a) && LM.has(cur.b) && cur.a !== cur.b) { cfg.a = cur.a; cfg.b = cur.b; }
  paintLangs();
  render();
  renderHist();
  // debug hook (read-only state)
  window.TRANSLATOR = { get cfg() { return cfg; }, get cur() { return cur; }, get mode() { return mode; }, get eng() { return eng; }, aiOn, voiceFor: (k) => voiceFor(L(k)) };
})();
