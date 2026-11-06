// Functions injected into web pages with chrome.scripting.executeScript.
// Each one must be fully self-contained: it is serialized and run in the page,
// so it cannot use anything defined outside its own body.

/** Finds every image URL referenced by the page. */
async function pageScan() {
  const found = new Map();
  const IMG_EXT = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|svg|ico)(\?|#|$)/i;
  const LAZY_ATTRS = [
    'data-src', 'data-srcset', 'data-original', 'data-lazy', 'data-lazy-src',
    'data-lazy-srcset', 'data-url', 'data-full', 'data-full-src', 'data-large',
    'data-large-src', 'data-hi-res', 'data-highres', 'data-zoom-image', 'data-bg',
    'data-background', 'data-image', 'data-orig-file', 'data-large-file',
  ];

  const add = (raw, source, base) => {
    if (!raw || typeof raw !== 'string') return;
    raw = raw.trim();
    if (!raw || raw.startsWith('#')) return;
    let url;
    try {
      url = new URL(raw, base || document.baseURI).href;
    } catch {
      return;
    }
    if (!/^(https?:|data:image\/|blob:)/i.test(url)) return;
    if (!found.has(url)) found.set(url, { url, source });
  };

  // srcset="a.jpg 1x, b.jpg 2x" (URLs may contain commas, e.g. CDN params)
  const parseSrcset = (s) => {
    const urls = [];
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /[\s,]/.test(s[i])) i++;
      const start = i;
      while (i < s.length && !/\s/.test(s[i])) i++;
      let u = s.slice(start, i);
      if (u.endsWith(',')) {
        u = u.replace(/,+$/, '');
      } else {
        while (i < s.length && s[i] !== ',') i++; // skip the descriptor
      }
      if (u) urls.push(u);
    }
    return urls;
  };

  const cssUrls = (v) => {
    const out = [];
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    let m;
    while ((m = re.exec(v))) out.push(m[2]);
    return out;
  };

  const addCss = (value, source, base) => {
    if (value && value !== 'none' && value.includes('url(')) {
      for (const u of cssUrls(value)) add(u, source, base);
    }
  };

  // Collect all elements, including inside open shadow roots.
  const roots = [document];
  const elements = [];
  for (let r = 0; r < roots.length; r++) {
    for (const el of roots[r].querySelectorAll('*')) {
      elements.push(el);
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }

  let canvases = 0;
  for (const el of elements) {
    const tag = el.localName;
    if (tag === 'img') {
      add(el.currentSrc, 'img');
      add(el.getAttribute('src'), 'img');
      if (el.srcset) parseSrcset(el.srcset).forEach((u) => add(u, 'srcset'));
    } else if (tag === 'source') {
      if (el.srcset) parseSrcset(el.srcset).forEach((u) => add(u, 'srcset'));
    } else if (tag === 'video') {
      add(el.getAttribute('poster'), 'poster');
    } else if (tag === 'input' && el.type === 'image') {
      add(el.getAttribute('src'), 'img');
    } else if (tag === 'a') {
      // Gallery thumbnails often link to the full-size file.
      const h = el.getAttribute('href');
      if (h && IMG_EXT.test(h)) add(h, 'link');
    } else if (tag === 'link') {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      if (/icon|image_src/.test(rel) || (rel === 'preload' && el.getAttribute('as') === 'image')) {
        add(el.getAttribute('href'), 'link');
        const iss = el.getAttribute('imagesrcset');
        if (iss) parseSrcset(iss).forEach((u) => add(u, 'srcset'));
      }
    } else if (tag === 'meta') {
      const p = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
      if (/^(og:image|twitter:image)/.test(p)) add(el.getAttribute('content'), 'meta');
    } else if (tag === 'image') {
      add(el.getAttribute('href') || el.getAttribute('xlink:href'), 'svg-image');
    } else if (tag === 'svg' && !el.ownerSVGElement) {
      const rect = el.getBoundingClientRect();
      if (rect.width >= 16 && rect.height >= 16) {
        try {
          const clone = el.cloneNode(true);
          clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          if (!clone.getAttribute('width')) clone.setAttribute('width', Math.round(rect.width));
          if (!clone.getAttribute('height')) clone.setAttribute('height', Math.round(rect.height));
          const str = new XMLSerializer().serializeToString(clone);
          if (str.length < 500000) {
            add('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str), 'inline-svg');
          }
        } catch {}
      }
    } else if (tag === 'canvas' && canvases < 30 && el.width * el.height >= 10000) {
      try {
        add(el.toDataURL('image/png'), 'canvas');
        canvases++;
      } catch {} // tainted canvas
    }

    for (const a of LAZY_ATTRS) {
      const v = el.getAttribute(a);
      if (!v) continue;
      if (a.includes('srcset')) parseSrcset(v).forEach((u) => add(u, 'lazy'));
      else if (v.includes('url(')) addCss(v, 'lazy');
      else if (/^(https?:|\/|\.|data:image)/i.test(v) || IMG_EXT.test(v)) add(v, 'lazy');
    }

    const cs = getComputedStyle(el);
    addCss(cs.backgroundImage, 'css');
    addCss(cs.listStyleImage, 'css');
    addCss(cs.borderImageSource, 'css');
    addCss(cs.maskImage || cs.webkitMaskImage, 'css');
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      addCss(ps.backgroundImage, 'css');
      addCss(ps.content, 'css');
    }
  }

  // Images only referenced from stylesheets (hover states, sprites, etc.).
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin stylesheet
    }
    const base = sheet.href || document.baseURI;
    const walk = (list) => {
      for (const rule of list) {
        if (rule.style) {
          addCss(rule.style.backgroundImage, 'stylesheet', base);
          addCss(rule.style.listStyleImage, 'stylesheet', base);
          addCss(rule.style.borderImageSource, 'stylesheet', base);
        }
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    try {
      walk(rules);
    } catch {}
  }

  // blob: URLs only work inside the page, so turn them into data: URLs here.
  for (const [url, entry] of [...found]) {
    if (!url.startsWith('blob:')) continue;
    try {
      const blob = await (await fetch(url)).blob();
      if ((blob.type && !blob.type.startsWith('image/')) || blob.size > 30e6) {
        found.delete(url);
        continue;
      }
      entry.dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
    } catch {
      found.delete(url);
    }
  }

  return { pageUrl: location.href, images: [...found.values()] };
}

/** Scrolls the page (and its main inner scroller, if any) to trigger lazy loading. */
async function pageAutoScroll(maxMs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__ihStop = false;

  const targets = [document.scrollingElement || document.documentElement];
  let inner = null;
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollHeight > el.clientHeight + 200 && el.clientHeight > window.innerHeight * 0.4) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
          (!inner || el.scrollHeight > inner.scrollHeight)) {
        inner = el;
      }
    }
  }
  if (inner) targets.push(inner);

  const start = Date.now();
  for (const el of targets) {
    let stable = 0;
    let last = -1;
    while (Date.now() - start < maxMs && !window.__ihStop) {
      el.scrollBy(0, Math.max(200, el.clientHeight * 0.8));
      await sleep(400);
      const pos = el.scrollTop;
      const atBottom = pos + el.clientHeight >= el.scrollHeight - 5;
      // At the bottom, wait a little for infinite-scroll pages to load more.
      if (atBottom || pos === last) {
        if (++stable >= 4) break;
      } else {
        stable = 0;
      }
      last = pos;
    }
    el.scrollTo(0, 0);
  }
  return !window.__ihStop;
}

function pageStopScroll() {
  window.__ihStop = true;
}

/** Fallback: fetch an image from inside the page (uses the page's cookies and origin). */
async function pageFetch(url) {
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) return null;
    const blob = await r.blob();
    if (blob.size > 50e6) return null;
    return await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
