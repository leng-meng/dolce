// 歌本切分 · Node 侧写出：按摆放从源图原分辨率裁片、贴到纸色画布上，写 JPEG。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import type { RgbaImage } from "../../omrkit/decode";
import type { Layout, PageSource } from "./types";

/** 只留最近用到的几页源图（一首最多跨几页，顺序写出时命中率很高）。 */
class PageCache {
  private m = new Map<number, Promise<RgbaImage>>();
  constructor(private src: PageSource, private keep = 4) {}
  get(i: number): Promise<RgbaImage> {
    let p = this.m.get(i);
    if (p) { this.m.delete(i); this.m.set(i, p); return p; }
    p = this.src.page(i);
    this.m.set(i, p);
    while (this.m.size > this.keep) this.m.delete(this.m.keys().next().value!);
    return p;
  }
}

async function renderLayout(cache: PageCache, l: Layout, quality: number): Promise<Buffer> {
  const inputs: OverlayOptions[] = [];
  for (const part of l.parts) {
    const img = await cache.get(part.page);
    // 裁到画布与源图内
    const x0 = Math.max(part.src.x, part.src.x - part.dx, 0), y0 = Math.max(part.src.y, part.src.y - part.dy, 0);
    const x1 = Math.min(part.src.x + part.src.w, img.width, l.width - part.dx + part.src.x);
    const y1 = Math.min(part.src.y + part.src.h, img.height, l.height - part.dy + part.src.y);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) continue;
    const buf = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      const s = ((y0 + y) * img.width + x0) * 4;
      buf.set(img.data.subarray(s, s + w * 4), y * w * 4);
    }
    inputs.push({ input: buf, raw: { width: w, height: h, channels: 4 }, left: part.dx + (x0 - part.src.x), top: part.dy + (y0 - part.src.y) });
  }
  const [r, g, b] = l.paper;
  for (const e of l.erase) {
    const x = Math.max(0, Math.round(e.x)), y = Math.max(0, Math.round(e.y));
    const w = Math.min(l.width, Math.round(e.x + e.w)) - x, h = Math.min(l.height, Math.round(e.y + e.h)) - y;
    if (w <= 0 || h <= 0) continue;
    inputs.push({ input: { create: { width: w, height: h, channels: 3, background: { r, g, b } } }, left: x, top: y });
  }
  return sharp({ create: { width: l.width, height: l.height, channels: 3, background: { r, g, b } } })
    .composite(inputs).jpeg({ quality }).toBuffer();
}

/** 按 layouts 逐首写出 `<names[k]>.jpg`。 */
export async function writeSongs(
  src: PageSource, layouts: readonly Layout[], names: readonly string[], outDir: string,
  opts: { quality?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const cache = new PageCache(src);
  const out: string[] = [];
  for (let k = 0; k < layouts.length; k++) {
    const path = join(outDir, names[k] + ".jpg");
    await writeFile(path, await renderLayout(cache, layouts[k], opts.quality ?? 92));
    out.push(path);
    opts.onProgress?.(k + 1, layouts.length);
  }
  return out;
}
