// Finds the likely full-size image(s) on a linked "viewer" page.
// The HTML is parsed with DOMParser, which never runs scripts or loads anything.

const LinkPage = (() => {
  const IMG_EXT = /\.(jpe?g|jfif|png|gif|webp|avif|bmp)(\?|#|$)/i;
  const MAX_CANDIDATES = 12;

  // Same parser as the page scanner: "a.jpg 1x, b.jpg 2x" -> [{url, size}]
  function parseSrcset(s) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /[\s,]/.test(s[i])) i++;
      const start = i;
      while (i < s.length && !/\s/.test(s[i])) i++;
      let url = s.slice(start, i);
      let desc = '';
      if (url.endsWith(',')) {
        url = url.replace(/,+$/, '');
      } else {
        const d = i;
        while (i < s.length && s[i] !== ',') i++;
        desc = s.slice(d, i).trim();
      }
      if (url) out.push({ url, size: parseFloat(desc) || 1 });
    }
    return out;
  }

  /**
   * Returns candidates in priority order:
   *   meta  - og:image / twitter:image / image_src (usually the main picture)
   *   link  - links to image files ("View original", "Download full size")
   *   img   - the largest srcset/src of each <img>, biggest declared size first
   */
  function extract(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let base = pageUrl;
    const baseEl = doc.querySelector('base[href]');
    if (baseEl) {
      try {
        base = new URL(baseEl.getAttribute('href'), pageUrl).href;
      } catch {}
    }
    const seen = new Set();
    const out = [];
    const add = (raw, kind) => {
      if (!raw) return;
      let url;
      try {
        url = new URL(raw.trim(), base).href;
      } catch {
        return;
      }
      if (!/^https?:/i.test(url) || seen.has(url)) return;
      seen.add(url);
      out.push({ url, kind });
    };

    for (const m of doc.querySelectorAll('meta[property], meta[name]')) {
      const p = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
      if (/^(og:image(:secure_url|:url)?|twitter:image(:src)?)$/.test(p)) add(m.getAttribute('content'), 'meta');
    }
    for (const l of doc.querySelectorAll('link[rel~="image_src"]')) add(l.getAttribute('href'), 'meta');

    for (const a of doc.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href');
      if (IMG_EXT.test(h)) add(h, 'link');
    }

    const imgs = [];
    for (const img of doc.querySelectorAll('img')) {
      const w = parseInt(img.getAttribute('width'), 10) || 0;
      const h = parseInt(img.getAttribute('height'), 10) || 0;
      if ((w && w < 100) || (h && h < 100)) continue; // icons, avatars
      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
      let best = null;
      if (srcset) {
        const c = parseSrcset(srcset).sort((x, y) => y.size - x.size);
        if (c.length) best = c[0].url;
      }
      best = best || img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src');
      if (best && !best.startsWith('data:')) imgs.push({ url: best, area: w * h });
    }
    imgs.sort((x, y) => y.area - x.area);
    imgs.forEach((i) => add(i.url, 'img'));

    return out.slice(0, MAX_CANDIDATES);
  }

  return { extract };
})();

if (typeof module !== 'undefined') module.exports = LinkPage;
