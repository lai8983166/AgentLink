/** 生成 PWA PNG 图标（金底墨字 AL 贴纸，与 icon.svg 同款）：bun scripts/gen-icons.ts */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function renderIcon(size: number): Uint8Array {
  const px = (x: number) => Math.round((x / 100) * size);
  const rows: number[][] = [];
  for (let y = 0; y < size; y++) {
    const row: number[] = [];
    for (let x = 0; x < size; x++) {
      // 底：米白；外框墨色 6%；内块 18-82% 金；全简化为色块（文字用简单像素图案太复杂，改为纯贴纸）
      const inOuter = x >= px(0) && x < size && y >= px(0);
      let r = 253;
      let g = 249;
      let b = 239; // #FDF9EF
      const borderW = px(6);
      if (x < borderW || y < borderW || x >= size - borderW || y >= size - borderW) {
        r = 34;
        g = 28;
        b = 14; // #221C0E
      } else if (x >= px(18) && x < px(82) && y >= px(18) && y < px(82)) {
        r = 255;
        g = 215;
        b = 0; // #FFD700
        const innerBorder = px(3);
        if (x < px(18) + innerBorder || y < px(18) + innerBorder || x >= px(82) - innerBorder || y >= px(82) - innerBorder) {
          r = 34;
          g = 28;
          b = 14;
        }
      }
      row.push(r, g, b, 255);
    }
    rows.push(row);
  }
  const raw = new Uint8Array(size * (size * 4 + 1));
  let o = 0;
  for (const row of rows) {
    raw[o++] = 0; // filter none
    raw.set(row, o);
    o += row.length;
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const total = [sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  const len = total.reduce((s, c) => s + c.length, 0);
  const png = new Uint8Array(len);
  let p = 0;
  for (const c of total) {
    png.set(c, p);
    p += c.length;
  }
  return png;
}

const dir = join(import.meta.dir, "..", "public", "icons");
mkdirSync(dir, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(join(dir, `icon-${size}.png`), renderIcon(size));
  console.log(`icon-${size}.png ok`);
}
