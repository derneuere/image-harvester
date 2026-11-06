'use strict';
/* global PHash, Zip, pageScan, pageAutoScroll, pageStopScroll, pageFetch */

const $ = (id) => document.getElementById(id);

const TYPES = ['jpg', 'png', 'webp', 'avif', 'gif', 'svg', 'ico', 'bmp'];
const MIME = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif',
  gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
};
// Tie-breaker when two copies have the same pixels and file size.
const FORMAT_RANK = { png: 5, bmp: 5, webp: 3, avif: 3, jpg: 2, gif: 1, ico: 0, svg: 0 };
const DEFAULTS = {
  minW: 100, minH: 100, minKB: 0, maxKB: 0, shape: 'any',
  types: Object.fromEntries(TYPES.map((t) => [t, true])),
  urlInclude: '', urlExclude: '',
  dedup: true, threshold: 6, showDupes: false, sort: 'page',
};
const CONCURRENCY = 6;        // parallel fetches
const DECODE_CONCURRENCY = 2; // full-size decodes held in memory at once
const THUMB = 240;            // thumbnail size (longest side, px)
const MAX_ITEMS = 5000;
const REFERER_RULE_ID = 1;

const state = {
  windowId: null,
  tabId: null,
  pageUrl: '',
  host: '',
  title: '',
  decoding: 0,
  decodeWaiters: [],
  gen: 0,             // bumps on every tab switch; stale async work checks it
  items: new Map(),    // url -> item
  order: 0,
  queue: [],
  active: 0,
  deselected: new Set(),
  cards: new Map(),
  settings: structuredClone(DEFAULTS),
  scanning: false,
  scrolling: false,
  scanError: '',
  busy: '',
  flash: null,
  view: null,
};
const pendingRevokes = new Map(); // downloadId -> object URL

// ---------------------------------------------------------------- startup

init();

async function init() {
  try {
    const stored = (await chrome.storage.local.get('settings')).settings;
    if (stored) {
      state.settings = { ...DEFAULTS, ...stored, types: { ...DEFAULTS.types, ...(stored.types || {}) } };
    }
  } catch {}
  bindControls();

  const win = await chrome.windows.getCurrent();
  state.windowId = win.id;
  const [tab] = await chrome.tabs.query({ active: true, windowId: state.windowId });
  if (tab) switchTab(tab);
  else render();

  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    if (windowId !== state.windowId) return;
    try {
      switchTab(await chrome.tabs.get(tabId));
    } catch {}
  });

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (tabId !== state.tabId) return;
    if (info.title) {
      state.title = info.title;
      $('pageTitle').textContent = info.title;
    }
    if (info.url && info.url !== state.pageUrl) switchTab(tab);
    else if (info.status === 'complete') scan();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'net-image' && msg.tabId === state.tabId) addItems([msg.entry]);
  });

  chrome.downloads.onChanged.addListener((d) => {
    if (d.state && d.state.current !== 'in_progress' && pendingRevokes.has(d.id)) {
      URL.revokeObjectURL(pendingRevokes.get(d.id));
      pendingRevokes.delete(d.id);
    }
  });
}

// ---------------------------------------------------------------- tabs & scanning

function switchTab(tab) {
  if (state.scrolling && state.tabId != null) {
    chrome.scripting.executeScript({ target: { tabId: state.tabId }, func: pageStopScroll }).catch(() => {});
  }
  resetItems();
  state.tabId = tab.id;
  state.pageUrl = tab.url || '';
  try {
    state.host = new URL(state.pageUrl).hostname;
  } catch {
    state.host = '';
  }
  state.title = tab.title || '';
  $('pageTitle').textContent = tab.title || state.pageUrl || 'Untitled';
  $('pageHost').textContent = state.host;
  setRefererRule();
  scan();
}

function resetItems() {
  state.gen++;
  for (const it of state.items.values()) if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
  state.items.clear();
  state.queue.length = 0;
  state.cards.clear();
  state.deselected.clear();
  state.order = 0;
  state.scanError = '';
  state.scrolling = false;
  state.flash = null;
  $('grid').replaceChildren();
  updateScrollButton();
  render();
}

// Many image hosts block hotlinking by checking the Referer header. Our fetches
// come from the extension, so pretend they come from the page being scanned.
async function setRefererRule() {
  let origin = '';
  try {
    const u = new URL(state.pageUrl);
    if (/^https?:$/.test(u.protocol)) origin = u.origin + '/';
  } catch {}
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [REFERER_RULE_ID],
      addRules: origin ? [{
        id: REFERER_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'referer', operation: 'set', value: origin }],
        },
        condition: {
          initiatorDomains: [chrome.runtime.id],
          tabIds: [chrome.tabs.TAB_ID_NONE],
          resourceTypes: ['xmlhttprequest'],
        },
      }] : [],
    });
  } catch (e) {
    console.warn('Referer rule not set:', e);
  }
}

function canScan() {
  return /^(https?|file):/i.test(state.pageUrl) && !/^https:\/\/chromewebstore\.google\.com/i.test(state.pageUrl);
}

async function scan() {
  if (state.tabId == null) return;
  const tabId = state.tabId;
  const gen = state.gen;
  if (!canScan()) {
    state.scanError = "Chrome doesn't let extensions read this kind of page (browser pages, the Web Store).";
    render();
    return;
  }
  state.scanning = true;
  render();
  try {
    const net = await chrome.runtime.sendMessage({ type: 'get-net-images', tabId });
    if (gen !== state.gen) return;
    addItems(net || []);

    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: pageScan,
    });
    if (gen !== state.gen) return;
    for (const r of results || []) if (r && r.result) addItems(r.result.images);
    state.scanError = '';
  } catch (e) {
    if (gen !== state.gen) return;
    state.scanError = /file:/.test(state.pageUrl)
      ? 'To scan local files, turn on "Allow access to file URLs" for this extension in chrome://extensions.'
      : 'Could not scan this page: ' + (e.message || e);
  } finally {
    if (gen === state.gen) {
      state.scanning = false;
      render();
    }
  }
}

async function autoScroll() {
  if (state.tabId == null || !canScan()) return;
  if (state.scrolling) {
    chrome.scripting.executeScript({ target: { tabId: state.tabId }, func: pageStopScroll }).catch(() => {});
    return;
  }
  const gen = state.gen;
  state.scrolling = true;
  updateScrollButton();
  try {
    await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: pageAutoScroll,
      args: [90000],
    });
  } catch (e) {
    showFlash('Auto-scroll failed: ' + (e.message || e), true);
  }
  if (gen !== state.gen) return;
  state.scrolling = false;
  updateScrollButton();
  scan();
}

function updateScrollButton() {
  const b = $('btnScroll');
  b.textContent = state.scrolling ? 'Stop' : 'Auto-scroll';
  b.classList.toggle('active', state.scrolling);
}

// ---------------------------------------------------------------- fetching & hashing

function addItems(entries) {
  let added = false;
  for (const e of entries) {
    if (!e || !e.url) continue;
    // Inline data: URLs can be megabytes long; key them by a short hash instead,
    // and drop the string itself once the image has been processed.
    let key = e.url;
    let dataUrl = e.dataUrl;
    if (key.startsWith('data:')) {
      dataUrl = key;
      key = 'inline:' + fnv1a(key) + '-' + key.length;
    }
    if (state.items.has(key)) continue;
    if (state.items.size >= MAX_ITEMS) break;
    const item = {
      url: key,
      dataUrl,
      source: e.source,
      order: state.order++,
      status: 'pending',
    };
    state.items.set(key, item);
    state.queue.push(item);
    added = true;
  }
  if (added) {
    pump();
    scheduleRender();
  }
}

function pump() {
  while (state.active < CONCURRENCY && state.queue.length) {
    const item = state.queue.shift();
    state.active++;
    processItem(item).finally(() => {
      state.active--;
      pump();
    });
  }
}

const isCurrent = (item) => state.items.get(item.url) === item;

// Memory notes:
// - The original file is kept only as a Blob. Chrome stores Blob data outside
//   the page's JS heap and can move it to disk when memory is tight.
// - The grid shows small WebP thumbnails, never full-size images.
// - Full-size decodes happen at most DECODE_CONCURRENCY at a time and are freed
//   right after hashing and making the thumbnail.
async function processItem(item) {
  let thumbUrl = null;
  try {
    const raw = await fetchBlob(item);
    if (!isCurrent(item)) return;
    if (!raw.size) throw new Error('empty response');
    const head = new Uint8Array(await raw.slice(0, 256).arrayBuffer());
    const type = sniffType(head, raw.type, item.url);
    if (!type) throw new Error('not an image (' + (raw.type || 'unknown type') + ')');

    const blob = raw.slice(0, raw.size, MIME[type]); // fix the MIME type without copying
    delete item.dataUrl;
    const crc = await crcOfBlob(blob);
    const pic = await withDecodeSlot(() => analyze(blob, type));
    thumbUrl = pic.thumbUrl;
    if (!isCurrent(item)) return;

    Object.assign(item, {
      status: 'ok',
      blob,
      thumbUrl,
      type,
      bytes: blob.size,
      width: pic.width,
      height: pic.height,
      logAspect: Math.log(pic.width / pic.height),
      hash: pic.hash,
      crc,
      exact: blob.size + ':' + crc, // same size + same CRC = same file
    });
    thumbUrl = null; // now owned by the item
  } catch (e) {
    item.status = 'error';
    item.error = String((e && e.message) || e);
  } finally {
    delete item.dataUrl;
    if (thumbUrl) URL.revokeObjectURL(thumbUrl);
  }
  scheduleRender();
}

async function withDecodeSlot(fn) {
  while (state.decoding >= DECODE_CONCURRENCY) {
    await new Promise((r) => state.decodeWaiters.push(r));
  }
  state.decoding++;
  try {
    return await fn();
  } finally {
    state.decoding--;
    const next = state.decodeWaiters.shift();
    if (next) next();
  }
}

/** Decodes once, returns size, pHash and a thumbnail URL, then frees the decode. */
async function analyze(blob, type) {
  let src;
  let width;
  let height;
  if (type === 'svg') {
    const url = URL.createObjectURL(blob);
    try {
      src = await loadImage(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    width = src.naturalWidth || 300;
    height = src.naturalHeight || 150;
  } else {
    try {
      src = await createImageBitmap(blob);
    } catch {
      throw new Error("browser can't decode this image");
    }
    width = src.width;
    height = src.height;
  }

  try {
    if (!width || !height) throw new Error('image has no size');
    const hash = PHash.fromImage(src);

    // Small files and SVGs are their own thumbnail.
    if (type === 'svg' || (Math.max(width, height) <= THUMB && blob.size < 64 * 1024)) {
      return { width, height, hash, thumbUrl: URL.createObjectURL(blob) };
    }
    const scale = Math.min(1, THUMB / Math.max(width, height));
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(height * scale));
    const canvas = new OffscreenCanvas(tw, th);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, tw, th);
    const thumb = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    return { width, height, hash, thumbUrl: URL.createObjectURL(thumb) };
  } finally {
    if (src.close) src.close(); // release the full-size ImageBitmap now
  }
}

/** CRC32 of a Blob, read in chunks so the whole file never sits in the JS heap. */
async function crcOfBlob(blob) {
  const reader = blob.stream().getReader();
  let crc = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return crc;
    crc = Zip.crc32(value, crc);
  }
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

async function fetchBlob(item) {
  const src = item.dataUrl || item.url;
  if (src.startsWith('data:')) return (await fetch(src)).blob();

  try {
    const r = await fetch(src, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.blob();
  } catch (err) {
    // Fall back to fetching from inside the page (its own cookies and origin).
    if (state.tabId == null || !/^https?:/i.test(src)) throw err;
    const res = await chrome.scripting
      .executeScript({ target: { tabId: state.tabId }, func: pageFetch, args: [src] })
      .catch(() => null);
    const dataUrl = res && res[0] && res[0].result;
    if (!dataUrl) throw err;
    return (await fetch(dataUrl)).blob();
  }
}

// Decide the real format from the file's first bytes (servers often lie).
function sniffType(b, mime, url) {
  const at = (o, s) => b.length >= o + s.length && [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && at(1, 'PNG')) return 'png';
  if (at(0, 'GIF8')) return 'gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  if (at(4, 'ftyp')) {
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  if (at(0, 'BM')) return 'bmp';
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) return 'ico';
  const text = new TextDecoder().decode(b).replace(/^﻿/, '').trimStart().toLowerCase();
  if (text.startsWith('<svg') || ((text.startsWith('<?xml') || text.startsWith('<!--')) &&
      (/svg/.test(mime || '') || /\.svg(\?|#|$)/i.test(url) || text.includes('<svg')))) {
    return 'svg';
  }
  if (/svg/.test(mime || '') && text.startsWith('<')) return 'svg';
  return null;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("browser can't decode this image"));
    img.src = src;
  });
}

// ---------------------------------------------------------------- filtering & dedup

function makeMatcher(input) {
  const str = input.value.trim();
  input.classList.remove('invalid');
  if (!str) return null;
  const m = str.match(/^\/(.+)\/([a-z]*)$/);
  if (m) {
    try {
      const re = new RegExp(m[1], m[2] || 'i');
      return (u) => re.test(u);
    } catch {
      input.classList.add('invalid');
      return null;
    }
  }
  const terms = str.toLowerCase().split(/\s+/);
  return (u) => {
    const l = u.toLowerCase();
    return terms.some((t) => l.includes(t));
  };
}

function shapeOf(it) {
  const r = it.width / it.height;
  if (r > 1.1) return 'landscape';
  if (r < 1 / 1.1) return 'portrait';
  return 'square';
}

// Higher quality first: SVG (scalable) > more pixels > bigger file > better format.
function better(a, b) {
  if ((a.type === 'svg') !== (b.type === 'svg')) return a.type === 'svg' ? -1 : 1;
  const pa = a.width * a.height;
  const pb = b.width * b.height;
  if (pa !== pb) return pb - pa;
  if (a.bytes !== b.bytes) return b.bytes - a.bytes;
  return (FORMAT_RANK[b.type] || 0) - (FORMAT_RANK[a.type] || 0);
}

function computeView() {
  const s = state.settings;
  const all = [...state.items.values()];
  let pending = 0;
  const errors = [];
  const ok = [];
  for (const it of all) {
    if (it.status === 'ok') ok.push(it);
    else if (it.status === 'error') errors.push(it);
    else pending++;
  }

  const inc = makeMatcher($('urlInclude'));
  const exc = makeMatcher($('urlExclude'));
  const filtered = ok.filter((it) => {
    if (it.width < s.minW || it.height < s.minH) return false;
    const kb = it.bytes / 1024;
    if (s.minKB && kb < s.minKB) return false;
    if (s.maxKB && kb > s.maxKB) return false;
    if (!s.types[it.type]) return false;
    if (s.shape !== 'any' && shapeOf(it) !== s.shape) return false;
    const u = it.url.startsWith('inline:') ? 'data:' + it.source : it.url;
    if (inc && !inc(u)) return false;
    if (exc && exc(u)) return false;
    return true;
  });

  // Group duplicates with union-find.
  const n = filtered.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };

  if (s.dedup) {
    const byBytes = new Map();
    filtered.forEach((it, i) => {
      const j = byBytes.get(it.exact);
      if (j !== undefined) union(j, i);
      else byBytes.set(it.exact, i);
    });
    for (let i = 0; i < n; i++) {
      const a = filtered[i];
      for (let j = i + 1; j < n; j++) {
        const b = filtered[j];
        // Different aspect ratios are different pictures (e.g. a square crop).
        if (Math.abs(a.logAspect - b.logAspect) > 0.15) continue;
        if (PHash.distance(a.hash, b.hash) <= s.threshold) union(i, j);
      }
    }
  }

  const groups = new Map();
  filtered.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  });
  const kept = [];
  for (const g of groups.values()) {
    const first = Math.min(...g.map((x) => x.order));
    g.sort(better);
    kept.push({ item: g[0], dupes: g.slice(1), first });
  }
  if (s.sort === 'pixels') kept.sort((a, b) => b.item.width * b.item.height - a.item.width * a.item.height);
  else if (s.sort === 'bytes') kept.sort((a, b) => b.item.bytes - a.item.bytes);
  else kept.sort((a, b) => a.first - b.first);

  return { total: all.length, pending, errors, ok: ok.length, filtered: n, kept };
}

function selectedItems() {
  if (!state.view) return [];
  return state.view.kept.map((g) => g.item).filter((it) => !state.deselected.has(it.url));
}

// ---------------------------------------------------------------- rendering

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, 120);
}

function render() {
  const v = computeView();
  state.view = v;
  const s = state.settings;

  // Status line
  const status = $('status');
  status.replaceChildren();
  const text = (t, cls) => {
    const span = document.createElement('span');
    span.textContent = t;
    if (cls) span.className = cls;
    status.append(span);
    return span;
  };
  if (state.busy) {
    text(state.busy, 'ok');
  } else if (state.flash) {
    text(state.flash.text, state.flash.error ? 'err' : 'ok');
  } else if (v.total) {
    const removed = v.filtered - v.kept.length;
    let t = `${v.total} found · ${v.filtered} pass filters`;
    if (s.dedup && removed) t += ` · ${removed} duplicate${removed === 1 ? '' : 's'} removed`;
    if (v.pending) t += ` · loading ${v.pending}…`;
    else if (state.scanning) t += ' · scanning…';
    text(t);
    if (v.errors.length) {
      text(' · ');
      const e = text(`${v.errors.length} failed`, 'err');
      e.title = v.errors.slice(0, 15).map((x) => `${shortUrl(x.url)}\n  ${x.error}`).join('\n') +
        (v.errors.length > 15 ? `\n…and ${v.errors.length - 15} more` : '');
    }
  } else if (state.scanning) {
    text('Scanning…');
  }

  // Grid
  const nodes = [];
  for (const g of v.kept) {
    nodes.push(card(g.item, g.dupes.length, false));
    if (s.showDupes && s.dedup) for (const d of g.dupes) nodes.push(card(d, 0, true));
  }
  $('grid').replaceChildren(...nodes);

  // Empty state
  let empty = '';
  if (state.scanError) empty = state.scanError;
  else if (!v.total && !state.scanning && state.tabId != null) empty = 'No images found yet. Try Auto-scroll, or Rescan after the page finishes loading.';
  else if (v.ok && !v.kept.length) empty = 'No images match the filters.';
  $('empty').textContent = empty;

  // Selection + buttons
  const sel = selectedItems();
  const bytes = sel.reduce((a, it) => a + it.bytes, 0);
  $('selInfo').textContent = sel.length
    ? `${sel.length} selected · ${fmtBytes(bytes)}`
    : 'Nothing selected';
  $('btnZip').disabled = !sel.length || !!state.busy;
  $('btnFiles').disabled = !sel.length || !!state.busy;
  $('btnRescan').disabled = state.tabId == null || !canScan();
  $('btnScroll').disabled = state.tabId == null || !canScan();
}

function card(it, dupeCount, isDupe) {
  const key = (isDupe ? 'd:' : 'k:') + it.url;
  let c = state.cards.get(key);
  if (!c) {
    c = document.createElement('div');
    c.className = 'card' + (isDupe ? ' dupe' : '');

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.src = it.thumbUrl;

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'sel';
    box.tabIndex = -1;

    const badge = document.createElement('span');
    badge.className = 'badge';

    const open = document.createElement('button');
    open.className = 'open';
    open.type = 'button';
    open.textContent = '↗';
    open.title = 'Open in a new tab';
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      if (/^https?:/i.test(it.url)) {
        chrome.tabs.create({ url: it.url });
      } else {
        const url = URL.createObjectURL(it.blob);
        chrome.tabs.create({ url });
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    });

    const meta = document.createElement('div');
    meta.className = 'meta';
    const dim = document.createElement('span');
    dim.textContent = `${it.width}×${it.height}`;
    const info = document.createElement('span');
    info.textContent = `${it.type.toUpperCase()} · ${fmtBytes(it.bytes)}`;
    meta.append(dim, info);

    c.append(img, box, badge, open, meta);
    c.title = `${shortUrl(it.url)}\nFound via: ${it.source}`;
    if (!isDupe) {
      c.addEventListener('click', () => {
        if (state.deselected.has(it.url)) state.deselected.delete(it.url);
        else state.deselected.add(it.url);
        render();
      });
    }
    c._box = box;
    c._badge = badge;
    state.cards.set(key, c);
  }
  if (isDupe) {
    c._badge.textContent = 'duplicate';
  } else {
    const off = state.deselected.has(it.url);
    c.classList.toggle('off', off);
    c._box.checked = !off;
    c._badge.textContent = dupeCount ? `+${dupeCount}` : '';
    c._badge.title = dupeCount ? `${dupeCount} smaller or identical cop${dupeCount === 1 ? 'y' : 'ies'} hidden` : '';
  }
  return c;
}

function showFlash(text, error = false) {
  state.flash = { text, error };
  render();
  clearTimeout(showFlash.timer);
  showFlash.timer = setTimeout(() => {
    state.flash = null;
    render();
  }, 5000);
}

function setBusy(text) {
  state.busy = text || '';
  render();
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function shortUrl(u) {
  if (u.startsWith('inline:')) return 'inline image (data: URL)';
  return u.length > 200 ? u.slice(0, 200) + '…' : u;
}

// ---------------------------------------------------------------- downloading

function sanitize(name) {
  let s = name
    .replace(/[\x00-\x1f]+/g, '')
    .replace(/\s*[\\/:*?"<>|~]+\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/(\s-)+\s/g, ' - ')
    .replace(/^[\s-]+|[\s-]+$/g, '');
  s = s.replace(/^[.\s]+|[.\s]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  return s.slice(0, 80);
}

function fileNames(items) {
  const used = new Set();
  return items.map((it) => {
    let stem = '';
    if (/^https?:/i.test(it.url)) {
      try {
        const seg = new URL(it.url).pathname.split('/').filter(Boolean).pop() || '';
        stem = decodeURIComponent(seg);
      } catch {}
    }
    stem = sanitize(stem.replace(/\.[a-z0-9]{2,5}$/i, ''));
    if (!stem) stem = 'image-' + it.crc.toString(16).padStart(8, '0');
    let name = `${stem}.${it.type}`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${stem}-${i}.${it.type}`;
    used.add(name.toLowerCase());
    return name;
  });
}

// Downloads are named after the page title, falling back to the site name.
function folderName() {
  return sanitize(state.title) || sanitize(state.host.replace(/^www\./, '')) || 'images';
}

async function downloadZip() {
  const sel = selectedItems();
  if (!sel.length) return;
  setBusy('Building ZIP…');
  try {
    const names = fileNames(sel);
    const zip = await Zip.build(sel.map((it, i) => ({ name: names[i], blob: it.blob, crc: it.crc, size: it.bytes })));
    const url = URL.createObjectURL(zip);
    const id = await chrome.downloads.download({
      url,
      filename: `${folderName()}.zip`,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    pendingRevokes.set(id, url);
    setBusy('');
    showFlash(`Downloading ZIP with ${sel.length} image${sel.length === 1 ? '' : 's'} (${fmtBytes(zip.size)})`);
  } catch (e) {
    setBusy('');
    showFlash('ZIP failed: ' + (e.message || e), true);
  }
}

async function downloadFiles() {
  const sel = selectedItems();
  if (!sel.length) return;
  const names = fileNames(sel);
  const folder = folderName();
  let failed = 0;
  for (let i = 0; i < sel.length; i++) {
    setBusy(`Saving ${i + 1} / ${sel.length}…`);
    // Short-lived URL for this one download; revoked when it finishes.
    const url = URL.createObjectURL(sel[i].blob);
    try {
      const id = await chrome.downloads.download({
        url,
        filename: `${folder}/${names[i]}`,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      pendingRevokes.set(id, url);
    } catch {
      URL.revokeObjectURL(url);
      failed++;
    }
  }
  setBusy('');
  showFlash(failed
    ? `Saved ${sel.length - failed}, ${failed} failed`
    : `Saved ${sel.length} file${sel.length === 1 ? '' : 's'} to Downloads/${folder}`, !!failed);
}

// ---------------------------------------------------------------- controls

function thresholdText(t) {
  const word = t === 0 ? 'identical only' : t <= 4 ? 'strict' : t <= 8 ? 'balanced' : t <= 12 ? 'loose' : 'very loose';
  return `${t}/64 bits · ${word}`;
}

function saveSettings() {
  chrome.storage.local.set({ settings: state.settings }).catch(() => {});
  scheduleRender();
}

function syncControls() {
  const s = state.settings;
  for (const id of ['minW', 'minH', 'minKB']) $(id).value = s[id];
  $('maxKB').value = s.maxKB || '';
  $('shape').value = s.shape;
  $('urlInclude').value = s.urlInclude;
  $('urlExclude').value = s.urlExclude;
  $('dedup').checked = s.dedup;
  $('threshold').value = s.threshold;
  $('thresholdLabel').textContent = thresholdText(s.threshold);
  $('showDupes').checked = s.showDupes;
  $('sort').value = s.sort;
  for (const t of TYPES) $('type-' + t).checked = !!s.types[t];
  const off = !s.dedup;
  $('threshold').disabled = off;
  $('threshold').closest('.row').classList.toggle('disabled', off);
  $('showDupes').disabled = off;
  $('showDupes').closest('.check').classList.toggle('disabled', off);
}

function bindControls() {
  const s = () => state.settings;

  const types = $('types');
  for (const t of TYPES) {
    const label = document.createElement('label');
    label.className = 'chip';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'type-' + t;
    input.addEventListener('change', () => {
      s().types[t] = input.checked;
      saveSettings();
    });
    const span = document.createElement('span');
    span.textContent = t;
    label.append(input, span);
    types.append(label);
  }

  for (const id of ['minW', 'minH', 'minKB', 'maxKB']) {
    $(id).addEventListener('input', () => {
      s()[id] = Math.max(0, parseFloat($(id).value) || 0);
      saveSettings();
    });
  }
  for (const id of ['urlInclude', 'urlExclude']) {
    $(id).addEventListener('input', () => {
      s()[id] = $(id).value;
      saveSettings();
    });
  }
  for (const id of ['shape', 'sort']) {
    $(id).addEventListener('change', () => {
      s()[id] = $(id).value;
      saveSettings();
    });
  }
  $('dedup').addEventListener('change', () => {
    s().dedup = $('dedup').checked;
    syncControls();
    saveSettings();
  });
  $('showDupes').addEventListener('change', () => {
    s().showDupes = $('showDupes').checked;
    saveSettings();
  });
  $('threshold').addEventListener('input', () => {
    s().threshold = parseInt($('threshold').value, 10);
    $('thresholdLabel').textContent = thresholdText(s().threshold);
    saveSettings();
  });
  $('btnReset').addEventListener('click', (e) => {
    e.preventDefault(); // don't toggle the <details>
    state.settings = structuredClone(DEFAULTS);
    syncControls();
    saveSettings();
  });

  $('btnRescan').addEventListener('click', () => scan());
  $('btnScroll').addEventListener('click', () => autoScroll());
  $('selAll').addEventListener('click', () => {
    state.deselected.clear();
    render();
  });
  $('selNone').addEventListener('click', () => {
    for (const g of (state.view && state.view.kept) || []) state.deselected.add(g.item.url);
    render();
  });
  $('btnZip').addEventListener('click', downloadZip);
  $('btnFiles').addEventListener('click', downloadFiles);

  syncControls();
}
