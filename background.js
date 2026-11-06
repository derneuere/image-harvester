// Background service worker.
// Records every image the browser loads for each tab (like the Network tab),
// so the side panel can include images that never appear in the DOM.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error(e));

const MAX_PER_TAB = 5000;
const tabs = new Map();   // tabId -> Map<url, entry>
const loaded = new Set(); // tabIds whose stored list has been merged in
const dirty = new Set();
let saveTimer = null;

function mem(tabId) {
  let m = tabs.get(tabId);
  if (!m) {
    m = new Map();
    tabs.set(tabId, m);
  }
  return m;
}

// The service worker can be stopped at any time, so the lists are mirrored
// to session storage and merged back in when it wakes up.
async function ensureLoaded(tabId) {
  if (loaded.has(tabId)) return;
  loaded.add(tabId);
  const key = 'tab:' + tabId;
  const stored = (await chrome.storage.session.get(key))[key];
  const m = mem(tabId);
  for (const e of stored || []) if (!m.has(e.url)) m.set(e.url, e);
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const obj = {};
    for (const id of dirty) obj['tab:' + id] = [...mem(id).values()];
    dirty.clear();
    try {
      await chrome.storage.session.set(obj);
    } catch (e) {
      // Quota exceeded: the in-memory list still works while the worker lives.
    }
  }, 1000);
}

function resetTab(tabId) {
  tabs.set(tabId, new Map());
  loaded.add(tabId);
  dirty.add(tabId);
  scheduleSave();
}

function header(headers, name) {
  const h = headers && headers.find((h) => h.name.toLowerCase() === name);
  return h ? h.value : '';
}

// A new top-level page load starts a fresh list for that tab.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId >= 0 && d.frameId === 0) resetTab(d.tabId);
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.webRequest.onCompleted.addListener(
  (d) => {
    if (d.tabId < 0) return; // not from a tab (includes our own panel's fetches)
    if (d.statusCode && (d.statusCode < 200 || d.statusCode >= 400)) return;
    if (!/^https?:/i.test(d.url)) return;
    const ct = header(d.responseHeaders, 'content-type').toLowerCase();
    // Images fetched by scripts (XHR/fetch) count too, if the server says they are images.
    if (d.type !== 'image' && !ct.startsWith('image/')) return;

    const m = mem(d.tabId);
    if (m.has(d.url) || m.size >= MAX_PER_TAB) return;
    const entry = { url: d.url, source: 'network' };
    m.set(d.url, entry);
    dirty.add(d.tabId);
    scheduleSave();
    chrome.runtime
      .sendMessage({ type: 'net-image', tabId: d.tabId, entry })
      .catch(() => {}); // panel not open
  },
  { urls: ['<all_urls>'], types: ['image', 'xmlhttprequest', 'other'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  loaded.delete(tabId);
  chrome.storage.session.remove('tab:' + tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'get-net-images') {
    ensureLoaded(msg.tabId).then(() => sendResponse([...mem(msg.tabId).values()]));
    return true; // async response
  }
});
