// 内联层：`{bz…}` 临时伴奏（主旋律上方小字号行）与 `{dsb…}` 并排块。
import type { ScoreLine } from "../../../pu/ast";
import type { JianpuGrid } from "../metrics";
import type { PlacedItem, PlacedLayer, PlacedSplit } from "./model";
import { type BeatCtx, SPLIT_BRACE_W, computeUnderlines, layoutVoiceLine } from "./voice";
import { splitRise } from "./vertical";
import { placeMarks } from "./marks";

/** 内联层：`{bz}` 是上方小字号行，`{dsb}` 是与主旋律并排的一块（见 PlacedLayer）。 */
export function placeLayers(
  voice: ScoreLine,
  items: PlacedItem[],
  m: JianpuGrid,
  ctx: BeatCtx = {},
): PlacedLayer[] {
  const out: PlacedLayer[] = [];
  voice.elements.forEach((el, srcIndex) => {
    if (el.kind !== "inline-layer") return;
    // 起点对齐主旋律里紧随其后的那个符号
    const hostAt = items.findIndex((it) => it.srcIndex >= srcIndex);
    const host = hostAt >= 0 ? items[hostAt] : items[items.length - 1];
    const originX = host ? host.x : 0;
    const inner: ScoreLine = {
      voice: voice.voice,
      elements: el.elements,
      marks: el.marks,
      lyrics: [],
      raw: el.code,
      source: el.source,
    };
    const laid = layoutVoiceLine(inner, m, { meter: ctx.meter });

    if (el.role !== "voice" || hostAt < 0) {
      // `{bz}`：上方另排一小行，按 layerScale 缩小
      for (const it of laid.items) {
        it.x = originX + it.x * m.style.size.cue;
        it.advance *= m.style.size.cue;
        it.syllables = [];
      }
      out.push({ layer: el, items: laid.items, underlines: computeUnderlines(inner, laid.items, m, laid.groups) });
      return;
    }

    // `{dsb}`：并排块。括起的内容排在上行，主旋律从 host 起**等时长**的一段排在下行，
    // 两行同字号、按拍位对齐（原版里两行结构本就一致）。
    const split = splitRise(m);
    let total = 0;
    for (const it of laid.items) total += it.beats;
    let acc = 0;
    let lastAt = hostAt;
    for (let i = hostAt; i < items.length; i++) {
      lastAt = i;
      acc += items[i]!.beats;
      if (acc >= total - 1e-6) break;
    }
    // 段末紧跟的小节线也算这一段的（`{dsb … |}` 多半以小节线收尾，两行要对到同一条上）
    while (lastAt + 1 < items.length && items[lastAt + 1]!.element.kind === "barline") {
      lastAt += 1;
    }
    // 主旋律这一段的拍位 → x
    const cols: Array<{ beat: number; bar: boolean; x: number }> = [];
    let at = 0;
    for (let i = hostAt; i <= lastAt; i++) {
      const it = items[i]!;
      cols.push({ beat: at, bar: it.element.kind === "barline", x: it.x });
      at += it.beats;
    }
    let beatAt = 0;
    laid.items.forEach((it) => {
      const bar = it.element.kind === "barline";
      const hit =
        cols.find((c) => c.bar === bar && Math.abs(c.beat - beatAt) < 1e-6) ??
        cols.find((c) => Math.abs(c.beat - beatAt) < 1e-6);
      if (hit) it.x = hit.x;
      else {
        // 拍位对不上（两行写法不同）就按比例落在区间里
        const span = cols[cols.length - 1]!.x - cols[0]!.x;
        it.x = cols[0]!.x + (total > 0 ? (beatAt / total) * span : 0);
      }
      it.syllables = [];
      beatAt += it.beats;
    });
    // 并排段之后只剩小节线的话，那就是一直排到行末：末尾那几条线也跟着下行走
    let tailHasNote = false;
    for (let i = lastAt + 1; i < items.length; i++) {
      if (items[i]!.element.kind !== "barline") {
        tailHasNote = true;
        break;
      }
    }
    const endAt = tailHasNote ? lastAt : items.length - 1;
    // 主旋律这一段下移
    for (let i = hostAt; i <= endAt; i++) items[i]!.dy = split;
    const underlines = computeUnderlines(inner, laid.items, m, laid.groups);
    for (const u of underlines) u.dy = -split;
    const marks = placeMarks(inner, laid.items, m);
    const placed: PlacedSplit = {
      dy: -split,
      line: inner,
      marks,
      braceTop: -split - m.ink.noteHeight * 0.64,
      braceBottom: split + m.ink.noteHeight * 0.64,
    };
    // 花括号画在并排段与单行段的交界上，开口朝着并排的两行；一直排到行末就只有左边那个
    if (hostAt > 0) placed.braceLeftX = items[hostAt]!.x - m.ink.noteHeight * 1.55;
    if (tailHasNote) {
      // 右花括号收在并排段最后一个音符之后、那条小节线**之前**。间距与左括号对称：
      // 离相邻音符 1.07、离小节线 0.48 个墨迹高（《太阳出来喜洋洋》里多处一致）
      let noteEnd = lastAt;
      while (noteEnd > hostAt && items[noteEnd]!.element.kind === "barline") noteEnd -= 1;
      placed.braceRightX = items[noteEnd]!.x + m.ink.noteHeight * 1.07;
      // 后面紧跟小节线时以线为准往回让：括号右缘离线 0.48 个墨迹高（列宽按内容排，末音到线的距离不是定值）
      const bar = items[noteEnd + 1];
      if (bar?.element.kind === "barline") {
        placed.braceRightX = Math.min(placed.braceRightX, bar.x - m.ink.noteHeight * 0.48 - SPLIT_BRACE_W);
      }
    }
    out.push({ layer: el, items: laid.items, underlines, split: placed });
  });
  return out;
}
