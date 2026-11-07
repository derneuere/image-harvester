// Perceptual hash (pHash), the same method as Python's `imagehash.phash`
// (used by LibrePhotos): shrink to 32x32 grayscale, take the 2D DCT, keep the
// 8x8 lowest frequencies, and set one bit per coefficient above the median.
// Similar-looking images (resized, re-compressed, other format) get hashes
// that differ in only a few of the 64 bits.

const PHash = (() => {
  const N = 32; // working size
  const L = 8;  // low-frequency block size -> 64 bits

  const COS = new Float64Array(L * N);
  for (let u = 0; u < L; u++) {
    for (let x = 0; x < N; x++) {
      COS[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
    }
  }

  /** gray: N*N luminance values, row-major. Returns [hi, lo] uint32 halves. */
  function fromGray(gray) {
    const rows = new Float64Array(N * L); // DCT along each row
    for (let y = 0; y < N; y++) {
      for (let u = 0; u < L; u++) {
        let s = 0;
        for (let x = 0; x < N; x++) s += COS[u * N + x] * gray[y * N + x];
        rows[y * L + u] = s;
      }
    }
    const F = new Float64Array(L * L); // then down each column
    for (let v = 0; v < L; v++) {
      for (let u = 0; u < L; u++) {
        let s = 0;
        for (let y = 0; y < N; y++) s += COS[v * N + y] * rows[y * L + u];
        F[v * L + u] = s;
      }
    }
    const sorted = Array.from(F).sort((a, b) => a - b);
    const median = (sorted[31] + sorted[32]) / 2;
    let hi = 0;
    let lo = 0;
    for (let i = 0; i < 64; i++) {
      if (F[i] > median) {
        if (i < 32) hi |= 1 << (31 - i);
        else lo |= 1 << (63 - i);
      }
    }
    return [hi >>> 0, lo >>> 0];
  }

  /**
   * Hash a loaded <img> / ImageBitmap / canvas. Transparent areas count as white.
   * crop: optional {sx, sy, sw, sh} source rectangle to hash only part of the image.
   */
  function fromImage(img, crop) {
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(N, N)
      : Object.assign(document.createElement('canvas'), { width: N, height: N });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, N, N);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (crop) ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, N, N);
    else ctx.drawImage(img, 0, 0, N, N);
    const { data } = ctx.getImageData(0, 0, N, N);
    const gray = new Float64Array(N * N);
    for (let i = 0; i < N * N; i++) {
      // Same weights as PIL's "L" mode (ITU-R 601)
      gray[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
    }
    return fromGray(gray);
  }

  function popcount(x) {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }

  /** Number of differing bits (0 = identical, 64 = opposite). */
  function distance(a, b) {
    return popcount(a[0] ^ b[0]) + popcount(a[1] ^ b[1]);
  }

  function toHex(h) {
    return h[0].toString(16).padStart(8, '0') + h[1].toString(16).padStart(8, '0');
  }

  /** Centered crop of a w×h image to the given aspect ratio (width / height). */
  function centerCrop(w, h, aspect) {
    if (w / h > aspect) {
      const sw = h * aspect;
      return { sx: (w - sw) / 2, sy: 0, sw, sh: h };
    }
    const sh = w / aspect;
    return { sx: 0, sy: (h - sh) / 2, sw: w, sh };
  }

  return { fromGray, fromImage, distance, toHex, centerCrop, SIZE: N };
})();

if (typeof module !== 'undefined') module.exports = PHash;
