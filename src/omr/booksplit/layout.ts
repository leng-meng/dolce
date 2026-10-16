// 歌本切分 · 单页版面：连通块 → 横向「带」（一行字 / 一行谱及其弧线、八度点），标出页脚、标题候选与谱行。
// 只看几何，不跑 OCR；页脚与标题候选的真假由 `scan.ts` 再拿 OCR 定。
import type { Binary, Component, Rect } from "../../omrkit/types";
import { connectedComponents } from "../../omrkit/ccl";
import { median, quantile } from "../../omrkit/geom";

/** 页面上的一条横向带。 */
export interface Band {
  y0: number;
  /** 不含：带占 [y0, y1)。 */
  y1: number;
  x0: number;
  x1: number;
  /** 方正且高 ≥ TITLE_H × 字高的块数（标题大字）。 */
  tall: number;
  /** 竖细长、高 ≥ BAR_H × 字高的块数（小节线）。 */
  bars: number;
  /** 全是扁块（弧线、减时线）。 */
  flat: boolean;
  /** 方正块（字）的中位高；没有为 0。 */
  sqH: number;
  /** 大字块的中位高；没有为 0。 */
  bigH: number;
  /** 带内各块的包围盒（扫描完即清空省内存）。 */
  boxes: Rect[];
}

export interface PageLayout {
  w: number;
  h: number;
  /** 本页正文字高（数字、歌词字的中位高）。 */
  charH: number;
  /** 本页字行（非谱行、非大字行）的字高：各字行方正块中位高的 0.9 分位。有的本子一页里某首的歌词字比别的大，
   *  标题要比最大的那种字行还大才算。 */
  textH: number;
  bands: Band[];
  /** 纸色（背景像素的中位 RGB）。 */
  paper: [number, number, number];
}

/** 标题大字：方正块高 ≥ 字高 × 此值。 */
export const TITLE_H = 1.22;
/** 小节线：竖细块高 ≥ 字高 × 此值。 */
const BAR_H = 1.15;
/** 上下两块间隙 ≤ 字高 × 此值就并进同一带（谱行与其弧线、八度点隔得很近）。 */
const MERGE_GAP = 0.12;

/** 二值图 + 原图 → 版面。`rgba` 只用来取纸色。 */
export function analyzePage(bin: Binary, rgba: Uint8ClampedArray): PageLayout {
  const { w, h } = bin;
  const comps = connectedComponents(bin, 4).filter((c) => !touchesEdge(c.bbox, w, h));
  const charH = estimateCharH(comps, h);
  const sig = comps.filter((c) => significant(c.bbox, charH));
  const bands = buildBands(sig, charH);
  const textHs = bands.filter((b) => !b.bars && !b.flat && b.sqH > 0 && b.tall < 2).map((b) => b.sqH);
  const textH = Math.max(charH, textHs.length ? quantile(textHs, 0.9) : 0);
  return { w, h, charH, textH, bands, paper: paperColor(bin, rgba) };
}

function touchesEdge(b: Rect, w: number, h: number): boolean {
  return b.x <= 0 || b.y <= 0 || b.x + b.w >= w || b.y + b.h >= h;
}

/** 正文字高：页高 0.8%–4% 之间、宽高比不离谱的块的中位高（汉字偏旁拆散也大体落在一个字高附近）。 */
function estimateCharH(comps: Component[], h: number): number {
  const hs = comps
    .filter((c) => c.bbox.h >= h * 0.008 && c.bbox.h <= h * 0.04 && c.bbox.w >= c.bbox.h * 0.5 && c.bbox.w <= c.bbox.h * 2)
    .map((c) => c.bbox.h);
  return median(hs, h * 0.018);
}

/** 不是斑点：高或宽有字高的三成（细竖的小节线、扁长的减时线与弧线都算）。 */
function significant(b: Rect, charH: number): boolean {
  return Math.max(b.w, b.h) >= charH * 0.3 && Math.min(b.w, b.h) >= 2;
}

const isTall = (b: Rect, charH: number) => b.h >= charH * TITLE_H && b.w >= b.h * 0.4 && b.w <= b.h * 2.5;
const isBar = (b: Rect, charH: number) => b.h >= charH * BAR_H && b.w <= b.h * 0.12;

function buildBands(comps: Component[], charH: number): Band[] {
  const sorted = [...comps].sort((a, b) => a.bbox.y - b.bbox.y);
  const gap = Math.max(2, charH * MERGE_GAP);
  const groups: Component[][] = [];
  let bottom = -Infinity;
  for (const c of sorted) {
    if (!groups.length || c.bbox.y > bottom + gap) { groups.push([c]); bottom = c.bbox.y + c.bbox.h; }
    else { groups[groups.length - 1].push(c); bottom = Math.max(bottom, c.bbox.y + c.bbox.h); }
  }
  return groups.flatMap((g) => splitTitle(g, charH)).map((g) => {
    let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity, tall = 0, bars = 0, flat = true;
    const sq: number[] = [], big: number[] = [];
    for (const { bbox: b } of g) {
      y0 = Math.min(y0, b.y); y1 = Math.max(y1, b.y + b.h);
      x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + b.w);
      if (isTall(b, charH)) { tall++; big.push(b.h); }
      if (isBar(b, charH)) bars++;
      if (!(b.w >= b.h * 1.8 && b.h < charH * 0.7)) flat = false;
      if (b.h >= charH * 0.6 && b.w >= b.h * 0.6 && b.w <= b.h * 1.6) sq.push(b.h);
    }
    return { y0, y1, x0, x1, tall, bars, flat, sqH: median(sq, 0), bigH: median(big, 0), boxes: g.map((c) => c.bbox) };
  });
}

/**
 * 标题行与下面的谱行粘成一带（谱行上的升降号、弧线顶到了标题行底）时，在标题大字的底边处切开。
 * 只看最上面一排大字，且小节线的中心全在它底边之下才切，免得把谱行里「和：」这类大字当标题行切出去。
 */
function splitTitle(g: Component[], charH: number): Component[][] {
  const tall = g.filter((c) => isTall(c.bbox, charH));
  const bars = g.filter((c) => isBar(c.bbox, charH));
  if (tall.length < 2 || !bars.length) return [g];
  // 只看最上面一排大字（谱行里连着减时线的数字也够「大」，不能算进标题行）
  const top0 = Math.min(...tall.map((c) => c.bbox.y));
  const row = tall.filter((c) => c.bbox.y <= top0 + charH * 0.6);
  if (row.length < 2) return [g];
  const ty1 = Math.max(...row.map((c) => c.bbox.y + c.bbox.h));
  if (Math.min(...bars.map((c) => c.cy)) < ty1) return [g]; // 小节线顶可能挨上标题底，按中心比
  const top = g.filter((c) => c.cy <= ty1), rest = g.filter((c) => c.cy > ty1);
  return top.length && rest.length ? [top, rest] : [g];
}

/** 纸色：背景像素（隔点抽样）各通道中位数。 */
function paperColor(bin: Binary, rgba: Uint8ClampedArray): [number, number, number] {
  const r: number[] = [], g: number[] = [], b: number[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt((bin.w * bin.h) / 40000)));
  for (let y = 0; y < bin.h; y += step) {
    for (let x = 0; x < bin.w; x += step) {
      const i = y * bin.w + x;
      if (bin.data[i]) continue;
      r.push(rgba[i * 4]); g.push(rgba[i * 4 + 1]); b.push(rgba[i * 4 + 2]);
    }
  }
  return [Math.round(median(r, 255)), Math.round(median(g, 255)), Math.round(median(b, 255))];
}

/** 页脚候选：最下一带，落在页面下 18%、窄（< 页宽 25%）、不高（≤ 1.6 字高）、没有小节线。 */
export function footerCandidate(p: PageLayout): Band | null {
  const b = p.bands[p.bands.length - 1];
  if (!b) return null;
  if (b.y0 < p.h * 0.82 || b.x1 - b.x0 > p.w * 0.25 || b.y1 - b.y0 > p.charH * 1.6 || b.bars) return null;
  return b;
}

/**
 * 标题候选：有 ≥ 2 个大字、不是谱行（标题带里小节线极少）、不太高（字行粘上谱行的那种带里
 * 连着减时线的数字也够「大」，双减时线还会被 OCR 读成「=」冒充调号）。字是否比本页字行大由 OCR 那步再看。
 */
export function isTitleCandidate(b: Band, p: PageLayout): boolean {
  // 没有小节线的带可以高些：标题旁的作者、出处常排两行
  return b.tall >= 2 && b.bars <= 1 && b.y1 - b.y0 <= p.charH * (b.bars ? 3 : 4.5);
}

/** 谱行：有小节线。 */
export function isMusicBand(b: Band): boolean {
  return b.bars >= 1 && b.tall < 2;
}
