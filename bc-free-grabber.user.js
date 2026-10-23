// ==UserScript==
// @name         BC Free Grabber
// @namespace    bc-free-grabber
// @version      4.0.0
// @description  Bandcamp: request free releases by email, queue a whole label page, read download links from Gmail via Apps Script, pick a format and auto-download, with a download history you can verify and re-run.
// @match        https://*/*
// @match        https://*.bandcamp.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window) return;

  const isBC =
    location.hostname.endsWith('bandcamp.com') ||
    document.getElementById('pagedata') ||
    document.querySelector('script[data-tralbum]') ||
    document.querySelector('meta[name="generator"][content*="Bandcamp" i]') ||
    document.querySelector('[src*="bcbits.com"], [href*="bcbits.com"]') ||
    document.querySelector('.music-grid, #music-grid, .buyItem, #trackInfo');
  if (!isBC) return;

  // ---------- settings and state (shared across all Bandcamp sites) ----------
  const DEF = { email: '', zip: '', format: 'mp3-v0', autoDownload: true, autoConfirm: true, autoResume: true, gasUrl: '', gasToken: '' };
  const cfg = {};
  for (const k in DEF) cfg[k] = GM_getValue(k, DEF[k]);
  const save = (k, v) => { cfg[k] = v; GM_setValue(k, v); };
  const getJob = () => GM_getValue('job', null);
  const setJob = (j) => GM_setValue('job', j);
  const getDl = () => GM_getValue('dljob', null);
  const setDl = (j) => GM_setValue('dljob', j);
  const norm = (u) => { const a = new URL(u, location.href); return a.origin + a.pathname; };
  const linkKey = (u) => {
    try { const a = new URL(u, location.href); return (a.searchParams.get('id') || a.search) + ':' + (a.searchParams.get('type') || ''); }
    catch (e) { return String(u); }
  };
  const gasReady = () => !!(cfg.gasUrl && cfg.gasToken);

  // ---------- download history ----------
  // key -> { key, url, name, status: 'started' | 'confirmed' | 'failed', t }
  //   started   = the Download button was clicked, but the file is not verified yet
  //   confirmed = you checked that the file really is on disk
  //   failed    = the Download button never appeared (will be retried automatically)
  // Links with status 'started' or 'confirmed' are skipped when collecting from mail.
  const HIST_MAX = 1000;
  const getLog = () => GM_getValue('dlLog', {}) || {};
  const setLog = (L) => {
    const vals = Object.values(L);
    if (vals.length > HIST_MAX) {
      vals.sort((a, b) => b.t - a.t);
      L = {};
      vals.slice(0, HIST_MAX).forEach((e) => { L[e.key] = e; });
    }
    GM_setValue('dlLog', L);
  };
  // migrate the history format of older versions
  (function migrate() {
    const old = GM_getValue('doneLinks', null);
    if (!Array.isArray(old)) return;
    const L = getLog();
    old.forEach((k) => { if (!L[k]) L[k] = { key: k, url: '', name: '(imported)', status: 'confirmed', t: 0 }; });
    setLog(L);
    GM_setValue('doneLinks', null);
  })();
  const getDone = () => new Set(Object.values(getLog()).filter((e) => e.status !== 'failed').map((e) => e.key));
  const pageName = () => {
    const e = document.querySelector('.download-title .title, .download-title, h1, .title');
    return ((e && txt(e)) || document.title || 'unknown').slice(0, 90);
  };
  function recordDl(status) {
    const L = getLog(), k = linkKey(location.href);
    // With "auto-confirm" on, a started download is treated as confirmed (fully automatic mode)
    if (status === 'started' && cfg.autoConfirm) status = 'confirmed';
    L[k] = { key: k, url: location.href, name: pageName(), status, t: Date.now() };
    setLog(L);
  }

  const FORMATS = [
    ['mp3-v0', 'MP3 V0'], ['mp3-320', 'MP3 320'], ['flac', 'FLAC'], ['aac-hi', 'AAC'],
    ['vorbis', 'Ogg Vorbis'], ['alac', 'ALAC'], ['wav', 'WAV'], ['aiff-lossless', 'AIFF']
  ];

  // ---------- utilities ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const txt = (el) => (el.innerText || el.textContent || el.value || '').trim().replace(/\s+/g, ' ');
  async function waitFor(fn, ms = 10000, step = 300) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step); }
    return null;
  }
  function setVal(el, v) {
    el.focus();
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    d.set.call(el, v);
    ['input', 'keydown', 'keyup', 'change', 'blur'].forEach((e) => el.dispatchEvent(new Event(e, { bubbles: true })));
  }
  const CLICK_SEL = 'a, button, input[type=submit], [role=button]';
  const clickables = () => [...document.querySelectorAll(CLICK_SEL)];
  const findByText = (re) => clickables().find((e) => visible(e) && re.test(txt(e)));
  const GIFT = /gift/i;

  const path = location.pathname;
  const kind = path.startsWith('/download') ? 'download'
             : /^\/(album|track)\//.test(path) ? 'item' : 'list';

  // ---------- UI ----------
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:0;bottom:0;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    *{box-sizing:border-box;font-family:system-ui,sans-serif}
    .fab{position:fixed;right:14px;bottom:18px;width:56px;height:56px;border-radius:50%;border:0;
      background:#1da0c3;color:#fff;font-weight:700;font-size:16px;box-shadow:0 4px 14px rgba(0,0,0,.45)}
    .panel{position:fixed;right:8px;bottom:84px;width:min(94vw,420px);max-height:72vh;overflow:auto;
      background:#16181d;color:#eee;border-radius:14px;padding:14px;box-shadow:0 8px 28px rgba(0,0,0,.6)}
    .panel[hidden]{display:none}
    .hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
    .x{background:none;border:0;color:#aaa;font-size:20px;padding:6px 10px}
    label{display:block;font-size:13px;color:#aab;margin:10px 0 0}
    input[type=email],input[type=text],select{display:block;width:100%;height:46px;margin-top:4px;padding:0 10px;
      font-size:16px;background:#22252c;color:#fff;border:1px solid #394049;border-radius:10px}
    .chk{display:flex;gap:10px;align-items:center;font-size:14px;color:#ddd}
    .chk input{width:22px;height:22px}
    details{margin-top:12px;background:#1d2027;border-radius:10px;padding:8px 10px}
    summary{font-size:14px;color:#9cd;padding:6px 0}
    .btn{display:block;width:100%;height:48px;margin-top:10px;border:0;border-radius:10px;
      background:#1da0c3;color:#fff;font-size:16px;font-weight:600}
    .btn.sec{background:#394049}
    .btn.danger{background:#a33}
    .btn.small{height:40px;font-size:14px}
    .st{font-size:14px;padding:8px 10px;background:#22252c;border-radius:8px;color:#cde}
    .hist{max-height:200px;overflow:auto;margin-top:6px}
    .hrow{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:#ccd;margin:6px 0}
    .hrow input{width:18px;height:18px;flex:none}
    .hint{font-size:12px;color:#889;margin:6px 0 0}
    pre{white-space:pre-wrap;font-size:12px;color:#9ab;margin:10px 0 0;max-height:150px;overflow:auto}
  </style>
  <button class="fab" id="fab">BC</button>
  <div class="panel" id="panel" hidden>
    <div class="hd"><b>BC Free Grabber</b><button class="x" id="x">✕</button></div>
    <div class="st" id="st"></div>
    <label>Email (where Bandcamp sends the links)<input id="email" type="email" inputmode="email" autocomplete="email"></label>
    <label>ZIP / postal code (if Bandcamp asks)<input id="zip" type="text"></label>
    <label>Format<select id="fmt"></select></label>
    <label class="chk"><input id="auto" type="checkbox">Auto-download on the download page</label>
    <label class="chk"><input id="autoconf" type="checkbox">Treat started downloads as done (no manual confirmation)</label>
    <label class="chk"><input id="autoresume" type="checkbox">Auto-resume an interrupted queue</label>
    <details id="mailbox"><summary>Mailbox: Apps Script</summary>
      <label>Apps Script URL (…/exec)<input id="gasurl" type="text" autocomplete="off"></label>
      <label>Token<input id="gastoken" type="text" autocomplete="off"></label>
    </details>
    <details id="history"><summary>Download history</summary>
      <div class="hint">? = download started, file not verified · ✓ = confirmed · ✗ = failed. Check your Downloads folder, then re-download anything that is missing.</div>
      <div class="hist" id="hist"></div>
      <button class="btn sec small" id="selunc">Select unconfirmed</button>
      <button class="btn small" id="redl">Re-download checked</button>
      <button class="btn sec small" id="confirm">Mark checked as confirmed</button>
      <button class="btn danger small" id="reset">Reset history…</button>
    </details>
    <div id="acts"></div>
    <pre id="log"></pre>
  </div>`;
  document.documentElement.appendChild(host);
  const $ = (id) => root.getElementById(id);
  const panel = $('panel');
  ['keydown', 'keyup', 'keypress'].forEach((e) => panel.addEventListener(e, (ev) => ev.stopPropagation()));
  $('fab').onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) renderHistory(); };
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('BC: show menu', () => { panel.hidden = false; });
  $('x').onclick = () => { panel.hidden = true; };
  $('email').value = cfg.email; $('zip').value = cfg.zip; $('auto').checked = cfg.autoDownload;
  $('gasurl').value = cfg.gasUrl; $('gastoken').value = cfg.gasToken;
  $('fmt').innerHTML = FORMATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  $('fmt').value = cfg.format;
  $('email').oninput = (e) => save('email', e.target.value.trim());
  $('zip').oninput = (e) => save('zip', e.target.value.trim());
  $('fmt').onchange = (e) => save('format', e.target.value);
  $('auto').onchange = (e) => save('autoDownload', e.target.checked);
  $('autoconf').checked = cfg.autoConfirm;
  $('autoconf').onchange = (e) => save('autoConfirm', e.target.checked);
  $('autoresume').checked = cfg.autoResume;
  $('autoresume').onchange = (e) => save('autoResume', e.target.checked);
  $('gasurl').oninput = (e) => save('gasUrl', e.target.value.trim());
  $('gastoken').oninput = (e) => save('gasToken', e.target.value.trim());

  const setStatus = (s) => { $('st').textContent = s; };
  const log = (s) => { $('log').textContent += s + '\n'; $('log').scrollTop = 1e9; };
  const addBtn = (label, fn, sec) => {
    const b = document.createElement('button');
    b.className = 'btn' + (sec ? ' sec' : ''); b.textContent = label; b.onclick = fn;
    $('acts').appendChild(b); return b;
  };

  // ---------- history UI ----------
  function renderHistory() {
    const box = $('hist');
    box.innerHTML = '';
    const list = Object.values(getLog()).sort((a, b) => b.t - a.t).slice(0, 60);
    if (!list.length) { box.textContent = 'History is empty.'; return; }
    for (const e of list) {
      const row = document.createElement('label');
      row.className = 'hrow';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.dataset.key = e.key; cb.disabled = !e.url; // imported entries have no URL to re-open
      const s = document.createElement('span');
      const mark = e.status === 'confirmed' ? '✓ ' : e.status === 'failed' ? '✗ ' : '? ';
      s.textContent = mark + e.name + (e.t ? ' · ' + new Date(e.t).toLocaleString() : '');
      row.append(cb, s);
      box.appendChild(row);
    }
  }
  const checkedKeys = () => [...root.querySelectorAll('#hist input:checked')].map((c) => c.dataset.key);

  $('selunc').onclick = () => {
    const L = getLog();
    root.querySelectorAll('#hist input').forEach((c) => {
      const e = L[c.dataset.key];
      c.checked = !!e && e.status !== 'confirmed' && !c.disabled;
    });
  };
  $('confirm').onclick = () => {
    const keys = checkedKeys(), L = getLog();
    keys.forEach((k) => { if (L[k]) L[k].status = 'confirmed'; });
    setLog(L);
    renderHistory();
    setStatus(keys.length ? `Marked as confirmed: ${keys.length}` : 'Nothing checked');
  };
  $('redl').onclick = () => {
    const L = getLog();
    const urls = checkedKeys().map((k) => L[k] && L[k].url).filter(Boolean);
    if (!urls.length) { setStatus('Check at least one entry first'); return; }
    setDl({ running: true, current: urls[0], queue: urls.slice(1), returnUrl: location.href, total: urls.length, done: 0, fail: 0 });
    setStatus(`Re-downloading ${urls.length} item(s)…`);
    location.href = urls[0];
  };
  // Reset requires three separate confirmations; the last one needs typing a word
  $('reset').onclick = () => {
    const n = Object.keys(getLog()).length;
    if (!confirm(`[1/3] Reset the download history?\n\nThis forgets ${n} link(s). Links already in your mailbox will be downloaded AGAIN.`)) return setStatus('Reset cancelled');
    if (!confirm('[2/3] Are you really sure?\n\nThis cannot be undone.')) return setStatus('Reset cancelled');
    const word = prompt('[3/3] Final confirmation.\n\nType RESET (capital letters) to erase the history:');
    if (word !== 'RESET') return setStatus('Reset cancelled');
    GM_setValue('dlLog', {});
    GM_setValue('doneLinks', null);
    GM_setValue('pendingRetry', null);
    setDl(null);
    renderHistory();
    setStatus('History has been reset');
  };

  // ---------- release page: request the link by email ----------
  function findBuyBtn() {
    return document.querySelector('.buyItem.digital .download-link.buy-link, .buyItem .download-link.buy-link') ||
      findByText(/^(buy digital (album|track)|free download|download)\b/i);
  }

  // "£0 GBP or more" -> 0 (free), "£7 GBP or more" -> 7 (paid)
  function freeInfo() {
    const btn = findBuyBtn();
    if (!btn) return { btn: null, free: false, why: 'no digital download button' };
    const box = btn.closest('.buyItem') || btn.parentElement || document.body;
    const t = txt(box);
    const m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:[A-Z]{3})?\s*or more/i);
    let min = null;
    if (m) min = parseFloat(m[1].replace(',', '.'));
    else if (/name your price|free download/i.test(t + ' ' + txt(btn))) min = 0;
    if (min === 0) return { btn, free: true, min };
    return { btn, free: false, why: min === null ? 'price not detected' : `minimum price ${min}` };
  }

  const SUCCESS = /check your email|sent you an email|we.ve sent|has been sent|link has been sent|email sent|sent a link/i;

  // The buyer's email field (NOT the gift recipient field)
  function emailField() {
    const bad = (i) => /recipient|friend|gift/i.test((i.id || '') + (i.name || '') + (i.placeholder || '') + (i.className || ''));
    const a = document.querySelector('#fan_email_address');
    if (a && visible(a) && !bad(a)) return a;
    return [...document.querySelectorAll('input[type=email], input[placeholder*="email" i]')]
      .find((i) => visible(i) && !bad(i));
  }
  const priceField = () => [...document.querySelectorAll('#userPrice, input[name="userPrice"]')].find(visible);

  // The "send link" button next to the email field; gift buttons are excluded
  function findSend(em) {
    const okExact = (e) => visible(e) && /send link/i.test(txt(e)) && !GIFT.test(txt(e));
    const okLoose = (e) => visible(e) && /^(send|send me the link|submit)$/i.test(txt(e)) && !GIFT.test(txt(e));
    for (const ok of [okExact, okLoose]) {
      let el = em;
      for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
        const c = [...el.querySelectorAll(CLICK_SEL)].find(ok);
        if (c) return c;
      }
      const g = clickables().find(ok);
      if (g) return g;
    }
    return null;
  }

  async function requestFree() {
    if (!cfg.email) return { ok: false, reason: 'email is not set' };
    await waitFor(() => freeInfo().btn, 6000);
    const info = freeInfo();
    if (!info.free) return { ok: false, skip: true, reason: info.why };

    let clickedBuy = false, priceDone = false, linkClicked = false, sent = false, sentAt = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      if (sent) {
        if (SUCCESS.test(document.body.innerText)) return { ok: true };
        if (Date.now() - sentAt > 2500 && !emailField()) return { ok: true, unsure: true };
        if (Date.now() - sentAt > 15000) return { ok: false, reason: 'no confirmation of sending' };
      } else {
        const em = emailField();
        if (em) {
          setVal(em, cfg.email);
          const zip = [...document.querySelectorAll('#fan_email_postalcode, input[placeholder*="zip" i], input[placeholder*="postal" i]')].find(visible);
          if (zip && cfg.zip) setVal(zip, cfg.zip);
          await sleep(500);
          if (em.value !== cfg.email) { setVal(em, cfg.email); await sleep(300); }
          const b = findSend(em);
          if (b) { b.click(); sent = true; sentAt = Date.now(); log('Clicked: "' + txt(b) + '"'); }
          else log('"Send link" button not found');
        } else {
          const price = priceField();
          if (price && !priceDone) { setVal(price, '0'); priceDone = true; log('Entered price 0'); await sleep(500); }
          const dl = findByText(/download to your computer/i);
          if (dl && !linkClicked) { dl.click(); linkClicked = true; log('Clicked "download to your computer"'); }
          else if (!price && !dl && !clickedBuy) { info.btn.click(); clickedBuy = true; log('Clicked "' + txt(info.btn) + '"'); }
        }
      }
      await sleep(700);
    }
    return { ok: false, reason: 'timeout' };
  }

  // ---------- download page ----------
  const FORMAT_RE = /^(MP3 V0|MP3 320|FLAC|AAC|Ogg Vorbis|ALAC|WAV|AIFF)/i;
  const leafish = (e) => e.children.length <= 1;

  // Fallback: the format dropdown is not a <select>
  async function pickFormatCustom(label) {
    const low = label.toLowerCase();
    const cands = () => [...document.querySelectorAll('body *')]
      .filter((e) => visible(e) && leafish(e) && txt(e).length < 40 && FORMAT_RE.test(txt(e)));
    let c = cands();
    if (!c.length) return false;
    if (c.length === 1 && txt(c[0]).toLowerCase().startsWith(low)) return true; // already selected
    const trigger = c[0];
    trigger.click();
    await sleep(600);
    c = cands().filter((e) => e !== trigger && txt(e).toLowerCase().startsWith(low));
    if (!c.length) { trigger.click(); return false; }
    c[c.length - 1].click();
    return true;
  }

  const customCands = () => [...document.querySelectorAll('body *')]
    .filter((e) => visible(e) && leafish(e) && txt(e).length < 40 && FORMAT_RE.test(txt(e)));
  const getFormatSelect = () => [...document.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => /mp3|flac|wav|aac|vorbis/i.test(o.value + ' ' + o.text)));

  // "Preparing…" appears in the same spot where "Download" shows up later
  const isPreparing = () => [...document.querySelectorAll('a, button, [role=button], div, span, p')]
    .some((e) => visible(e) && e.children.length <= 2 && txt(e).length < 60 && /prepar/i.test(txt(e)));

  const findDownloadLink = () => [...document.querySelectorAll('a, button, [role=button], .item-button')].find((x) =>
    visible(x) && !/prepar/i.test(txt(x)) &&
    (/^\s*download\s*$/i.test(txt(x)) ||
     (x.tagName === 'A' && txt(x).length < 30 && /download/i.test(txt(x)) && /popplers|bcbits|\/download\//i.test(x.href || ''))));

  // Returns 'same' (already the right format), 'changed' (switched) or false (failed)
  async function applyFormat(label) {
    const low = label.toLowerCase();
    const sel = getFormatSelect();
    if (sel) {
      const opt = [...sel.options].find((o) => o.value === cfg.format) ||
                  [...sel.options].find((o) => o.text.trim().toLowerCase().startsWith(low));
      if (!opt) { log('Requested format is not in the list, keeping the current one'); return 'same'; }
      if (sel.value === opt.value) return 'same';
      sel.value = opt.value;
      ['input', 'change'].forEach((n) => sel.dispatchEvent(new Event(n, { bubbles: true })));
      await sleep(600);
      return sel.value === opt.value ? 'changed' : false;
    }
    const c = customCands();
    if (c.length === 1 && txt(c[0]).toLowerCase().startsWith(low)) return 'same';
    const ok = await pickFormatCustom(label);
    if (!ok) return false;
    await sleep(800);
    return customCands().some((e) => txt(e).toLowerCase().startsWith(low)) ? 'changed' : false;
  }

  async function doDownload() {
    const label = (FORMATS.find((f) => f[0] === cfg.format) || [])[1] || '';

    // 1) Wait for the format dropdown first (up to 60 s)
    setStatus('Waiting for the format dropdown…');
    const ctrl = await waitFor(() => getFormatSelect() || customCands().length, 60000, 500);
    if (!ctrl) log('The format dropdown never appeared, downloading as is');

    // 2) Pick the format and make sure it was applied (up to 3 attempts)
    let state = 'same';
    if (ctrl) {
      setStatus('Selecting format: ' + label);
      state = false;
      for (let i = 0; i < 3 && !state; i++) {
        state = await applyFormat(label);
        if (!state) { log('Format was not applied, retrying (' + (i + 1) + '/3)'); await sleep(1500); }
      }
      if (!state) { log('Could not select the format. Press "Diagnostics" and send the text.'); state = 'same'; }
      else log('Format: ' + label + (state === 'changed' ? ' (switched)' : ' (already selected)'));
    }

    // 3) After switching, the page shows "Preparing…" — wait until it appears
    if (state === 'changed') {
      setStatus('Waiting for preparation to start…');
      await waitFor(isPreparing, 8000, 300);
    }

    // 4) Wait until "Preparing…" turns into the Download button (up to 3 minutes)
    const t0 = Date.now();
    let link = null, hits = 0;
    while (Date.now() - t0 < 180000) {
      const prep = isPreparing();
      const l = prep ? null : findDownloadLink();
      hits = l ? hits + 1 : 0;
      if (hits >= 2) { link = l; break; } // button stable for 2 checks in a row
      setStatus((prep ? 'Preparing… ' : 'Waiting for the Download button… ') + Math.round((Date.now() - t0) / 1000) + ' s');
      await sleep(prep ? 1000 : 700);
    }
    if (!link) { setStatus('Download button did not appear'); log('Gave up waiting for the Download button'); recordDl('failed'); return false; }
    link.click();
    recordDl('started');
    setStatus('Download started (not verified yet) ✓');
    return true;
  }

  // ---------- diagnostics ----------
  function dump() {
    const L = ['URL: ' + location.href];
    document.querySelectorAll('select').forEach((s) => L.push(
      'SELECT id=' + s.id + ' class=' + s.className + (visible(s) ? '' : ' [hidden]') + ' opts=' +
      [...s.options].map((o) => o.value + '=' + o.text.trim()).join('|')));
    clickables().filter(visible).slice(0, 70).forEach((e) => L.push(
      e.tagName + ' #' + e.id + ' .' + String(e.className || '').slice(0, 40) + ' "' + txt(e).slice(0, 40) + '"' +
      (e.href ? ' -> ' + e.href.slice(0, 70) : '')));
    document.querySelectorAll('input').forEach((i) => visible(i) && L.push(
      'INPUT type=' + i.type + ' id=' + i.id + ' name=' + i.name + ' placeholder=' + i.placeholder));
    const out = L.join('\n');
    $('log').textContent = out + '\n';
    try { GM_setClipboard(out); setStatus('Diagnostics copied to clipboard ✓'); }
    catch (e) { setStatus('Diagnostics shown below — copy manually'); }
  }

  // ---------- Gmail via Apps Script ----------
  const gmFetch = (url) => new Promise((res, rej) => GM_xmlhttpRequest({
    method: 'GET', url, timeout: 30000,
    onload: res, onerror: () => rej(new Error('network error')), ontimeout: () => rej(new Error('timeout'))
  }));

  async function fetchMailLinks(sinceMs) {
    const u = cfg.gasUrl + (cfg.gasUrl.includes('?') ? '&' : '?') +
      't=' + encodeURIComponent(cfg.gasToken) + '&since=' + (sinceMs || Date.now() - 3 * 864e5);
    const r = await gmFetch(u);
    let j;
    try { j = JSON.parse(r.responseText); }
    catch (e) { throw new Error('response is not JSON — the web app must be deployed with access "Anyone"'); }
    if (j.error) throw new Error(j.error === 'forbidden' ? 'wrong token' : j.error);
    const seen = new Set(), out = [];
    for (const l of j.links || []) {
      const k = linkKey(l.url);
      if (!seen.has(k)) { seen.add(k); out.push(l); }
    }
    return out;
  }

  function needGas() {
    setStatus('Set the Apps Script URL and token first');
    $('mailbox').open = true;
    panel.hidden = false;
  }

  async function checkMail() {
    if (!gasReady()) return needGas();
    setStatus('Checking mailbox…');
    try {
      const done = getDone();
      const links = await fetchMailLinks();
      const fresh = links.filter((l) => !done.has(linkKey(l.url)));
      setStatus(`Links in mailbox: ${links.length}, new: ${fresh.length}`);
    } catch (e) { setStatus('Mailbox error: ' + e.message); }
  }

  function maybeRetry() {
    const p = GM_getValue('pendingRetry', null);
    if (!p) return false;
    GM_setValue('pendingRetry', null);
    if (Date.now() - p.t > 30 * 60000) return false;
    startJob(p.urls, { retried: true });
    return true;
  }

  function pageItemKey() {
    try {
      const el = document.querySelector('script[data-tralbum]');
      if (el) {
        const t = JSON.parse(el.getAttribute('data-tralbum'));
        const raw = String(t.item_type || (t.current && t.current.type) || 'album').toLowerCase();
        const type = (raw === 't' || raw === 'track') ? 'track' : 'album';
        if (t.id) return t.id + ':' + type;
      }
    } catch (e) {}
    try {
      const m = JSON.parse(document.querySelector('meta[name="bc-page-properties"]').content);
      if (m.item_id) return m.item_id + ':' + (m.item_type === 't' ? 'track' : 'album');
    } catch (e) {}
    return null;
  }

  function evaluateLinks(all, opts) {
    const done = getDone();
    const reqs = opts.requested || [];
    const fresh = all.filter((l) => !done.has(linkKey(l.url)));
    const have = new Set(all.map((l) => linkKey(l.url)));
    const missing = reqs.filter((r) => !have.has(r.key));
    const enough = reqs.length ? missing.length === 0 : fresh.length >= (opts.expected || 0);
    return { fresh, missing, enough };
  }

  // Some emails did not arrive: retry the request once (only if the id scheme matched at least once)
  function schedulePendingRetry(missing, opts) {
    const reqs = opts.requested || [];
    if (!reqs.length || !missing.length || opts.retried) return;
    if (reqs.length - missing.length > 0) {
      GM_setValue('pendingRetry', { t: Date.now(), urls: missing.map((r) => r.url), requested: missing });
      log(`Emails missing: ${missing.length}. Will re-request after downloading.`);
    } else log('Could not match emails to releases — retry disabled.');
  }

  async function finishCollect(ev, opts, returnUrl) {
    schedulePendingRetry(ev.missing, opts);
    if (!ev.fresh.length) {
      setStatus('No new links in the mailbox');
      maybeRetry();
      return;
    }
    const urls = ev.fresh.map((l) => l.url);
    setDl({ running: true, current: urls[0], queue: urls.slice(1), returnUrl, total: urls.length, done: 0, fail: 0 });
    setStatus(`Found ${urls.length} link(s). Starting downloads…`);
    await sleep(800);
    location.href = urls[0];
  }

  async function collectAndDownload(opts) {
    opts = opts || {};
    if (!gasReady()) return needGas();
    panel.hidden = false;
    const t0 = Date.now();
    let ev;
    while (true) {
      setStatus('Looking for emails…');
      let all;
      try { all = await fetchMailLinks(opts.since); }
      catch (e) { setStatus('Mailbox error: ' + e.message); return; }
      ev = evaluateLinks(all, opts);
      if (!opts.expected || ev.enough) break;
      if (Date.now() - t0 > 240000) break;
      setStatus(`Emails ${opts.requested && opts.requested.length ? opts.requested.length - ev.missing.length : ev.fresh.length}/${opts.expected}, waiting…`);
      await sleep(15000);
    }
    await finishCollect(ev, opts, location.href);
  }

  function stopDl() { const j = getDl(); if (j) { j.running = false; setDl(j); } setStatus('Downloading stopped'); }

  // ---------- resilience: heartbeat, resume after the tab was killed / replaced by an error page ----------
  // While a step is running, a heartbeat timestamp is refreshed every few seconds. If a queue is marked
  // "running" but the heartbeat is stale, nobody is working on it (the tab was closed or replaced by a
  // browser error page) and the next page load picks it up again.
  const STALE_MS = 25000;
  let busy = false;
  const beat = () => GM_setValue('hb', Date.now());
  const heartbeatAge = () => Date.now() - GM_getValue('hb', 0);
  async function withBeat(fn) {
    if (busy) return;
    busy = true; beat();
    const iv = setInterval(beat, 4000);
    try { await fn(); } finally { clearInterval(iv); busy = false; }
  }

  async function runDlStep(dj) {
    return withBeat(async () => {
      panel.hidden = false;
      const key = linkKey(location.href);
      setStatus(`Downloading ${Math.min(dj.done + 1, dj.total)}/${dj.total}…`);
      const ok = await doDownload();
      let j = getDl();
      if (!j || !j.running) return;
      // Count each item once, even if this page is re-opened after an interruption
      if (j.counted !== key) { j.done++; if (!ok) j.fail++; j.counted = key; }
      setDl(j);
      await sleep(ok ? 12000 : 2000); // give the browser time to start the file download
      j = getDl();
      if (!j || !j.running) return;
      if (j.queue.length) { j.current = j.queue.shift(); j.counted = null; setDl(j); beat(); location.href = j.current; }
      else { j.running = false; j.current = null; j.finishedAt = Date.now(); setDl(j); beat(); location.href = j.returnUrl; }
    });
  }

  // ---------- label queue ----------
  function scanLinks() {
    const set = new Set();
    document.querySelectorAll('.music-grid a, #music-grid a, ol.editable-grid a, .featured-item a').forEach((a) => {
      if (/\/(album|track)\//.test(a.href)) set.add(a.origin + a.pathname);
    });
    return [...set];
  }

  function renderJob(job) {
    if (!job || !job.stats || !job.stats.total) return;
    const s = job.stats;
    setStatus(`${job.running ? 'Requests in progress' : 'Requests finished'}: ${s.done}/${s.total} · sent ${s.ok} · skipped ${s.skip} · failed ${s.fail}`);
    if (job.results && !job.running) {
      $('log').textContent = job.results.slice(-20)
        .map((r) => `${r.s === 'ok' ? '✓' : r.s === 'skip' ? '–' : '✗'} ${r.n}${r.r ? ' (' + r.r + ')' : ''}`).join('\n') + '\n';
    }
  }

  function startJob(urls, o) {
    if (!cfg.email) { setStatus('Set your email first'); panel.hidden = false; return; }
    setJob({
      running: true, current: urls[0], queue: urls.slice(1), returnUrl: location.href, startedAt: Date.now() - 60000,
      retried: !!(o && o.retried), requested: [],
      stats: { total: urls.length, done: 0, ok: 0, skip: 0, fail: 0 }, results: []
    });
    location.href = urls[0];
  }
  function stopJob() { const j = getJob(); if (!j) return; j.running = false; setJob(j); setStatus('Queue stopped'); }

  async function runJobStep(job) {
    return withBeat(async () => {
      panel.hidden = false;
      renderJob(job);
      const pageKey = norm(location.href);
      if (job.counted === pageKey) {
        // This item was already processed before the page was interrupted: don't request it twice
        log('Already processed, continuing the queue…');
      } else {
        setStatus(`Processing ${job.stats.done + 1}/${job.stats.total}…`);
        let res;
        try {
          res = await Promise.race([requestFree(), sleep(60000).then(() => ({ ok: false, reason: 'timeout' }))]);
        } catch (e) { res = { ok: false, reason: String(e) }; }

        const j0 = getJob();
        if (!j0 || !j0.running) return;
        j0.stats.done++;
        const st = res.ok ? 'ok' : res.skip ? 'skip' : 'fail';
        j0.stats[st]++;
        j0.results.push({ n: decodeURIComponent(location.pathname.split('/').pop()), s: st, r: res.reason || (res.unsure ? 'unconfirmed' : '') });
        if (res.ok) { const key = pageItemKey(); if (key) (j0.requested = j0.requested || []).push({ key, url: pageKey }); }
        j0.counted = pageKey;
        setJob(j0);
        renderJob(j0);
      }

      await sleep(3000 + Math.random() * 3000);
      const j = getJob();
      if (!j || !j.running) return;
      if (j.queue.length) { j.current = j.queue.shift(); j.counted = null; setJob(j); beat(); location.href = j.current; }
      else {
        j.running = false; j.current = null; j.counted = null;
        j.collect = j.stats.ok > 0; // after the queue, fetch the emails automatically
        setJob(j);
        beat();
        location.href = j.returnUrl;
      }
    });
  }

  // Pick up the interrupted work if this page is the one the queue is waiting on
  function resumeWork() {
    const d = getDl(), jb = getJob();
    if (kind === 'download' && d && d.running && d.current && linkKey(d.current) === linkKey(location.href)) runDlStep(d);
    else if (kind === 'item' && jb && jb.running && jb.current && norm(jb.current) === norm(location.href)) runJobStep(jb);
  }

  // A queue is "running" but this is not its page and nobody is working on it → jump back to it
  function watchOrphan() {
    if (!cfg.autoResume || busy) return;
    const d = getDl(), jb = getJob();
    const onDl = kind === 'download' && d && d.current && linkKey(d.current) === linkKey(location.href);
    const onItem = kind === 'item' && jb && jb.current && norm(jb.current) === norm(location.href);
    let which = null, target = null;
    if (d && d.running && d.current && !onDl) { which = 'dl'; target = d.current; }
    else if (jb && jb.running && jb.current && !onItem) { which = 'job'; target = jb.current; }
    if (!target || heartbeatAge() < STALE_MS) return;
    panel.hidden = false;
    setStatus((which === 'dl' ? 'Download queue' : 'Request queue') + ' was interrupted. Resuming in 5 s… (press "Stop all queues" to cancel)');
    addBtn('Stop all queues', () => { stopDl(); stopJob(); setStatus('All queues stopped'); }, true);
    setTimeout(() => {
      const cur = which === 'dl' ? getDl() : getJob();
      if (cur && cur.running && cur.current === target && heartbeatAge() >= STALE_MS) location.href = target;
    }, 5000);
  }

  // ---------- build the menu ----------
  const job = getJob();
  const dj = getDl();
  setTimeout(() => addBtn('Diagnostics (copy)', dump, true), 0);
  const mailButtons = () => {
    addBtn('Check mailbox', checkMail, true);
    addBtn('Fetch from mailbox and download', () => collectAndDownload({}));
    if (dj && dj.running) addBtn('Stop downloading', stopDl, true);
  };
  const dlSummary = () => {
    if (dj && dj.total && !dj.running && dj.finishedAt && Date.now() - dj.finishedAt < 10 * 60000) {
      setStatus(`Downloading finished: ${dj.done - dj.fail}/${dj.total} started (failed: ${dj.fail}). Check your Downloads folder and open "Download history" to re-download anything missing.`);
      $('history').open = true;
      panel.hidden = false;
    }
  };
  if (!gasReady()) $('mailbox').open = true;
  renderHistory();

  if (kind === 'download') {
    setStatus('Download page');
    const onDlJob = dj && dj.running && dj.current && linkKey(dj.current) === linkKey(location.href);
    addBtn('Pick format and download', doDownload);
    mailButtons();
    if (!onDlJob && cfg.autoDownload && !getDone().has(linkKey(location.href))) setTimeout(doDownload, 1200);
  } else if (kind === 'item') {
    const info = freeInfo();
    setStatus(info.free ? 'Release is free ✓ (price from 0)' : 'Skipping: ' + info.why);
    addBtn('Request link by email', async () => {
      setStatus('Working…');
      const r = await requestFree();
      setStatus(r.ok ? (r.unsure ? 'Sent (unconfirmed) — check your mailbox' : 'Link sent to your email ✓') : 'Failed: ' + r.reason);
    });
    if (job && job.running) addBtn('Stop queue', stopJob, true);
    mailButtons();
  } else {
    const urls = scanLinks();
    setStatus(urls.length ? `Releases found: ${urls.length}` : 'No releases found on this page');
    if (urls.length) addBtn(`Request all free releases (${urls.length})`, () => startJob(urls));
    if (job && job.running) addBtn('Stop queue', stopJob, true);
    mailButtons();
    if (job && job.stats && job.stats.total) { renderJob(job); if (!job.running) panel.hidden = false; }
    dlSummary();
    if (job && !job.running && job.collect) {
      job.collect = false; setJob(job);
      collectAndDownload({ since: job.startedAt, expected: job.stats.ok, requested: job.requested || [], retried: !!job.retried });
    } else if (!(dj && dj.running) && !(job && job.running)) {
      maybeRetry();
    }
  }

  // Resume interrupted work (also when the page is restored from the back/forward cache, where the script does not re-run)
  resumeWork();
  watchOrphan();
  window.addEventListener('pageshow', (e) => { if (e.persisted) { resumeWork(); watchOrphan(); } });
})();
