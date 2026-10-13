// 窄纸整首重新断行：源里的行放不下时求新的行首。
import type { MusicElement, PuSong } from "../../../pu/ast";
import { contentWidth, type JianpuGrid } from "../metrics";
import { naturalColumns } from "./spacing";
import type { InkMeasurer, PlacedItem } from "./model";
import { assignLyrics, layoutVoiceLine } from "./voice";

/**
 * **窄纸整首重新断行的断点**（原样档放不下时用，见 `compose/index.ts::layoutOriginalDocument`）。
 *
 * 原样文档照源里的行排（「原版」的意义），版心够宽时不动：每组按**自然宽**（紧排 + 歌词避让，不两端对齐，
 * 与排版同一个 `spacing.ts`）量出所需宽度，全都放得进版心就返回 null。有一组放不下（500 首那张 150×216mm 纸上，原版按 1000 宽长图写的行），
 * 就把全曲各小节的所需宽度串起来，只在小节线处断、求「各行余白平方和最小」——行长均匀、中间没有短行
 * （与简谱引擎 `layout.ts::reflowBreak` 同一个口径）。返回每首的新行首（行里第一个音的元素 id，首行不列）。
 *
 * 多声部各组的列是共享的（同拍位归一列），量宽取主声部（第一个声部）的小节线位置。
 */
export function reflowLineStarts(
  songs: readonly PuSong[],
  idOf: ReadonlyMap<MusicElement, string | number>,
  m: JianpuGrid,
  ink: InkMeasurer,
): Array<Array<string | number>> | null {
  const width = contentWidth(m);
  if (!(width > 0)) return null;
  let overflow = false;
  const perSong = songs.map((song) => {
    /** 全曲的小节：所需宽度 + 小节首音的 id */
    const bars: { w: number; first: string | number | null }[] = [];
    let open: { w: number; first: string | number | null } | null = null; // 跨组没收口的小节
    for (const page of song.pages) {
      for (const group of page.groups) {
        const laidOut = group.voices.map((voice) => layoutVoiceLine(voice, m, { meter: song.metadata.meters[0] }));
        laidOut.forEach((l, vi) => {
          const voice = group.voices[vi]!;
          for (const it of l.items) it.syllables = new Array(voice.lyrics.length).fill(null);
          assignLyrics(l.items, voice.lyrics);
        });
        const nat = naturalColumns(laidOut, m, ink);
        const X = (it: PlacedItem): number => nat.xOf.get(it) ?? 0;
        const lead = laidOut[0];
        if (!lead) continue;
        if (nat.width > width) overflow = true;
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
            if (first !== null || open) flush(X(it));
            start = X(it);
            continue;
          }
          if (first === null && it.element.kind === "note") first = idOf.get(it.element) ?? null;
        }
        // 组尾没收口（小节中间换行）：留到下一组接着量
        const end = nat.width;
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
