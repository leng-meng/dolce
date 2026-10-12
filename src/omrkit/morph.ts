// 二值图的标准形态学操作：面积开/闭运算、方形结构元的闭运算、椭圆结构元的开运算（连通块标记在 `ccl.ts`）。
//
// 墨 = 1、白 = 0。面积类操作只看连通块大小，不动形状；闭运算的结构元是 (2r+1)² 的方块，
// 用积分图做膨胀/腐蚀，与 r 无关地线性时间。
import type { Binary } from "./types";
import { components } from "./ccl";

/** **面积开运算**：抹掉面积小于 `min` 的墨块（8 连通）。 */
export function areaOpen(bin: Binary, min: number): void {
  for (const b of components(bin, 1, 8, (n) => n < min)) for (const i of b.px) bin.data[i] = 0;
}

/** **面积闭运算**：填上面积小于 `max`、被墨围住（不碰图边）的白块（4 连通）。 */
export function areaClose(bin: Binary, max: number): void {
  for (const b of components(bin, 0, 4, (n) => n < max)) if (!b.edge) for (const i of b.px) bin.data[i] = 1;
}

/** 0/1 图的积分图（整型精确）：建好之后原图再改不影响它。 */
export class Integral {
  private readonly s: Int32Array;
  private readonly W: number;
  constructor(private readonly bin: Binary) {
    const { w, h, data } = bin;
    const s = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let run = 0;
      const src = y * w;
      const cur = (y + 1) * (w + 1);
      const up = y * (w + 1);
      for (let x = 0; x < w; x++) {
        run += data[src + x];
        s[cur + x + 1] = s[up + x + 1] + run;
      }
    }
    this.s = s;
    this.W = w + 1;
  }
  /** 半开矩形 [x0,x1)×[y0,y1) 的墨点数（调用方保证在图内）。 */
  rect(x0: number, y0: number, x1: number, y1: number): number {
    const s = this.s;
    const W = this.W;
    return s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0];
  }
  /** 以 (x,y) 为中心、kw×kh 窗口的墨点数（越界按 0 计）。 */
  box(x: number, y: number, kw: number, kh: number): number {
    const { w, h } = this.bin;
    return this.rect(Math.max(0, x - (kw >> 1)), Math.max(0, y - (kh >> 1)), Math.min(w, x + (kw >> 1) + 1), Math.min(h, y + (kh >> 1) + 1));
  }
}

/** 方形结构元 (2r+1)² 的膨胀（`dilate`）或腐蚀，结果写回。 */
function boxMorph(bin: Binary, r: number, dilate: boolean): void {
  const { w, h, data } = bin;
  const ii = new Integral(bin);
  const full = (2 * r + 1) * (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = ii.rect(x0, y0, x1, y1);
      // 越界那部分按腐蚀不设防（图边的墨不因出界被蚀掉）
      const area = (x1 - x0) * (y1 - y0);
      data[y * w + x] = dilate ? (n > 0 ? 1 : 0) : n >= Math.min(full, area) ? 1 : 0;
    }
  }
}

/** **闭运算**（先膨胀后腐蚀），方形结构元 (2r+1)²：补上宽不过 2r 的白隙。 */
export function close(bin: Binary, r: number): void {
  if (r < 1) return;
  boxMorph(bin, r, true);
  boxMorph(bin, r, false);
}

/**
 * **开运算**（先腐蚀后膨胀），椭圆结构元，半轴 `rx`×`ry`（像素）：抹掉装不下这个椭圆的笔画——
 * 比椭圆细的谱线、符干、细弧都去掉，实心符头、符杠这类够粗的块原样留下。返回新图，不改原图。
 * 椭圆按行拆成横段，每段「全是墨 / 有墨」用积分图一次查出。
 */
export function ellipseOpen(bin: Binary, rx: number, ry: number): Binary {
  const { w, h, data } = bin;
  const rows: [number, number][] = [];
  for (let dy = -ry; dy <= ry; dy++) rows.push([dy, Math.floor(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / ((ry + 0.5) * (ry + 0.5)))))]);
  /** 第 y 行 [x0, x1]（闭区间，裁到图内）的墨点数。 */
  const run = (ii: Integral, y: number, x0: number, x1: number): number => ii.rect(Math.max(0, x0), y, Math.min(w, x1 + 1), y + 1);
  const src = new Integral(bin);
  const er = new Uint8Array(w * h);
  for (let y = ry; y < h - ry; y++)
    for (let x = rx; x < w - rx; x++) {
      if (!data[y * w + x]) continue;
      if (rows.every(([dy, k]) => run(src, y + dy, x - k, x + k) === 2 * k + 1)) er[y * w + x] = 1;
    }
  const eroded = new Integral({ w, h, data: er });
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (rows.some(([dy, k]) => y - dy >= 0 && y - dy < h && run(eroded, y - dy, x - k, x + k) > 0)) out[y * w + x] = 1;
  return { w, h, data: out };
}
