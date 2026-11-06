// Minimal ZIP writer. Files are stored without compression, which is fine for
// images: JPEG/PNG/WebP are already compressed. Builds the ZIP as a Blob made
// of the original image Blobs, so nothing is copied in memory.

const Zip = (() => {
  const TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c >>> 0;
  }

  /** Pass the previous result as `crc` to continue over the next chunk. */
  function crc32(bytes, crc = 0) {
    let c = (crc ^ 0xffffffff) >>> 0;
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  /**
   * files: [{ name, blob, crc?, size? }]  (crc/size are computed if missing)
   * Returns a Blob of type application/zip.
   */
  async function build(files, BlobCtor = Blob) {
    if (files.length > 0xffff) throw new Error('Too many files for one ZIP (max 65535)');
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const size = f.size ?? f.blob.size;
      const crc = f.crc ?? crc32(new Uint8Array(await f.blob.arrayBuffer()));
      const name = enc.encode(f.name);

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); // local file header
      lh.setUint16(4, 20, true);         // version needed
      lh.setUint16(6, 0x0800, true);     // flags: UTF-8 names
      lh.setUint16(8, 0, true);          // method: store
      lh.setUint16(10, time, true);
      lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      parts.push(lh, name, f.blob);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); // central directory header
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, time, true);
      ch.setUint16(14, date, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true);
      ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);    // other fields stay 0
      central.push(ch, name);

      offset += 30 + name.length + size;
      if (offset > 0xffffffff) throw new Error('ZIP would be larger than 4 GB; use "Save files" instead');
    }

    const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); // end of central directory
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);

    return new BlobCtor([...parts, ...central, end], { type: 'application/zip' });
  }

  return { build, crc32 };
})();

if (typeof module !== 'undefined') module.exports = Zip;
