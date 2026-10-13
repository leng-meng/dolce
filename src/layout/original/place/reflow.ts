// 窄纸整首重新断行：源里的行放不下时求新的行首。
import type { LyricLine, MusicElement, PuSong } from "../../../pu/ast";
import { contentWidth, type JianpuGrid } from "../metrics";
import { latinWordBreak } from "../../../engrave/syllable";
import { LATIN_SPACE_EM, LYRIC_MIN_GAP_EM, alignVoices } from "./spacing";
import type { LyricMeasure, PlacedItem } from "./model";
import { assignLyrics, layoutVoiceLine } from "./voice";

/**
 * **窄纸整首重新断行的断点**（原样档放不下时用，见 `compose/index.ts::layoutOriginalDocument`）。
 *
 * 原样文档照源里的行排（「原版」的意义），版心够宽时不动：每组按**歌词足额**（不压音符、不打歌词折扣）
 * 量出所需宽度，全都放得进版心就返回 null。有一组放不下（500 首那张 150×216mm 纸上，原版按 1000 宽长图写的行），
 * 就把全曲各小节的所需宽度串起来，只在小节线处断、求「各行余白平方和最小」——行长均匀、中间没有短行
 * （与简谱引擎 `layout.ts::reflowBreak` 同一个口径）。返回每首的新行首（行里第一个音的元素 id，首行不列）。
 *
 * 多声部各组的列是共享的（`alignVoices` 已按拍位对齐），量宽取主声部（第一个声部）的小节线位置。
 */
export function reflowLineStarts(
  songs: readonly PuSong[],
  idOf: ReadonlyMap<MusicElement, string | number>,
  m: JianpuGrid,
  measure: LyricMeasure,
): Array<Array<string | number>> | null {
  const width = contentWidth(m) - m.page.systemIndent - m.ink.noteHeight * 0.6;
  if (!(width > 0)) return null;
  let overflow = false;
  const perSong = songs.map((song) => {
    /** 全曲的小节：所需宽度 + 小节首音的 id */
    const bars: { w: number; first: string | number | null }[] = [];
    let open: { w: number; first: string | number | null } | null = null; // 跨组没收口的小节
    for (const page of song.pages) {
      for (const group of page.groups) {
        const laidOut = group.voices.map((voice) => layoutVoiceLine(voice, m, { meter: song.metadata.meters[0] }));
        if (laidOut.length > 1) alignVoices(laidOut);
        laidOut.forEach((l, vi) => {
          const voice = group.voices[vi]!;
          for (const it of l.items) it.syllables = new Array(voice.lyrics.length).fill(null);
          assignLyrics(l.items, voice.lyrics);
        });
        const X = fullLyricColumns(laidOut, group.voices.map((v) => v.lyrics), m, measure);
        const lead = laidOut[0];
        if (!lead) continue;
        const total = X(Math.max(...laidOut.map((l) => l.width), 1));
        if (total > width) overflow = true;
        let start = 0;
        let first: string | number | null = null;
        const flush = (end: number): void => {
          const w = Math.max(0, end - start);
          if (open) {
            open.w += w;
            if (open.first === null) open.first = first;
            bars.push(open);
            open = null;
          } else bars.push({ w, first });
          first = null;
        };
        for (const it of lead.items) {
          if (it.element.kind === "barline") {
            if (first !== null || open) flush(X(it.x));
            start = X(it.x);
            continue;
          }
          if (first === null && it.element.kind === "note") first = idOf.get(it.element) ?? null;
        }
        // 组尾没收口（小节中间换行）：留到下一组接着量
        const end = X(lead.width);
        if (end - start > 1e-6 || first !== null) open = { w: end - start, first };
      }
    }
    if (open) bars.push(open);
    return bars;
  });
  if (!overflow) return null;
  return perSong.map((bars) => {
    const n = bars.length;
    const best = new Array<number>(n + 1).fill(Infinity);
    const prev = new Array<number>(n + 1).fill(-1);
    best[0] = 0;
    for (let j = 1; j <= n; j++) {
      let w = 0;
      for (let i = j - 1; i >= 0; i--) {
        w += bars[i]!.w;
        if (w > width && i < j - 1) break; // 单个小节就超宽也得放
        if (best[i] === Infinity) continue;
        const c = best[i]! + Math.max(0, width - w) ** 2;
        if (c < best[j]!) {
          best[j] = c;
          prev[j] = i;
        }
      }
    }
    const cuts: number[] = [];
    for (let j = n; j > 0; j = prev[j]!) cuts.unshift(prev[j]!);
    return cuts.filter((i) => i > 0).map((i) => bars[i]!.first).filter((id): id is string | number => id !== null);
  });
}

/** 歌词足额时的列位置（`placeColumns` 的 s = 1、f = 1 那一解）：自然 x → 撑开后的 x。 */
function fullLyricColumns(
  lines: ReadonlyArray<{ items: PlacedItem[]; width: number }>,
  lyrics: ReadonlyArray<readonly LyricLine[]>,
  m: JianpuGrid,
  measure: LyricMeasure,
): (x: number) => number {
  const EPS = 0.01;
  const cols = [...new Set(lines.flatMap((l) => l.items.map((it) => it.x)))].sort((a, b) => a - b);
  const colsU: number[] = [];
  for (const x of cols) if (colsU.length === 0 || x - colsU[colsU.length - 1]! > EPS) colsU.push(x);
  if (!colsU.length) return (x) => x;
  const colOf = (x: number): number => {
    let lo = 0;
    let hi = colsU.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (colsU[mid]! <= x + EPS) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const gap = m.style.size.lyric * LYRIC_MIN_GAP_EM;
  const need = new Map<number, Array<{ from: number; d: number }>>();
  lines.forEach((l, vi) => {
    const verses = lyrics[vi]?.length ?? 0;
    for (let v = 0; v < verses; v++) {
      let prev: { col: number; right: number; text: string } | null = null;
      for (const it of l.items) {
        const syl = it.syllables[v];
        if (!syl) continue;
        const e = measure(syl);
        const col = colOf(it.x);
        if (prev && col > prev.col) {
          const d = prev.right + e.left + gap + (latinWordBreak(prev.text, syl.text) ? m.style.size.lyric * LATIN_SPACE_EM : 0);
          const list = need.get(col) ?? [];
          list.push({ from: prev.col, d });
          need.set(col, list);
        }
        prev = { col, right: e.right, text: syl.text };
      }
    }
  });
  const X = new Array<number>(colsU.length).fill(0);
  X[0] = colsU[0]!;
  for (let c = 1; c < colsU.length; c++) {
    let x = X[c - 1]! + (colsU[c]! - colsU[c - 1]!);
    for (const { from, d } of need.get(c) ?? []) x = Math.max(x, X[from]! + d);
    X[c] = x;
  }
  const last = colsU[colsU.length - 1]!;
  return (x) => (x > last + EPS ? X[X.length - 1]! + (x - last) : X[colOf(x)]! + (x - colsU[colOf(x)]!));
}
