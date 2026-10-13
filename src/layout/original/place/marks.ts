// 跨若干符号的记号（弧线 / 多连音 / 跳房子 / 渐强渐弱）换算成行内坐标，弧按嵌套定层。
import type { Mark, ScoreLine } from "../../../pu/ast";
import { jianpuSlurRise, noteMarkGap, type JianpuGrid } from "../metrics";
import { ARC_CHAIN_INSET_DIV, arcClearShift, jpArcY } from "../../../engrave/arc";
import type { PlacedItem, PlacedMark } from "./model";
import { annotationTop, chordLane, noteTextTop, stackTop, voltaLineTop } from "./vertical";

/** 把记号的元素下标区间换算成行内 x 区间。 */
export function placeMarks(voice: ScoreLine, items: PlacedItem[], m: JianpuGrid): PlacedMark[] {
  if (items.length === 0) return [];
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const at = (srcIndex: number, side: "start" | "end"): PlacedItem => {
    // 记号端点未必正落在占位符号上（例如 `(` 紧跟在 `~` 后），取最近的一个
    let best = side === "start" ? last : first;
    for (const it of items) {
      if (side === "start") {
        if (it.srcIndex >= srcIndex && it.srcIndex < best.srcIndex) best = it;
      } else if (it.srcIndex <= srcIndex && it.srcIndex > best.srcIndex) best = it;
    }
    if (side === "start" && best.srcIndex < srcIndex) best = first;
    return best;
  };
  const out: PlacedMark[] = [];
  for (const mark of voice.marks) {
    const openLeft = mark.continuationFromPrevious === true;
    const openRight = mark.continuationToNext === true;
    // 跨行的弧线/多连音**只画后半条**：印刷原版里行末那截敞口的弧不画，下一行才从行首
    // 起弧画到 `)`（《太阳出来喜洋洋》第 1→2 行的 `(6, - | 6,) (-` 就是这样）。
    // 跳房子相反，行末那截要接着画（房号不重复），所以只挡弧线。
    if (openRight && (mark.type === "slur" || mark.type === "tuplet")) continue;
    const a = openLeft ? first : at(mark.start, "start");
    const b = openRight ? last : at(mark.end, "end");
    const level = Math.max(1, mark.level);
    // 弧线/多连音的两端就落在音符的**墨迹中心**上（数字本来就是按墨迹居中排的），
    // 与 .jpwabc 的 addSlurTie 一致——不再往外扩半个音符宽。
    // 端点还挂着别的弧线时各自内缩 dx（= 字号/14），免得两条弧首尾顶在一起。
    const isArc = mark.type === "slur" || mark.type === "tuplet";
    const dx = isArc ? m.ink.noteHeight / 0.7 / ARC_CHAIN_INSET_DIV : 0;
    const chainedLeft = voice.marks.some((o) => o !== mark && o.end === mark.start);
    const chainedRight = voice.marks.some((o) => o !== mark && o.start === mark.end);
    // 渐强渐弱要**包住**起止音符（原版里楔尖就落在音符下方），所以往外扩半个字宽；
    // 跳房子同样往外扩；弧线相反，端点落在墨迹中心。
    const isWedge = mark.type === "crescendo" || mark.type === "decrescendo";
    const spread = isWedge ? m.ink.noteHeight * 0.55 : m.note.beamHalfSpan;
    const padLeft = isArc ? (chainedLeft ? dx : 0) : -spread;
    const padRight = isArc ? (chainedRight ? dx : 0) : -spread;
    // 跳房子的横线**贴着两侧的小节线**（原版：起点 = 前一条小节线 +2、终点 = 后一条
    // 小节线 -2，都按 1000 宽的版面量的），而不是贴房内首末音符。
    let vx0: number | null = null;
    let vx1: number | null = null;
    if (mark.type === "volta") {
      const gap = m.ink.noteHeight * 0.12;
      for (const it of items) {
        if (it.element.kind !== "barline") continue;
        if (it.x <= a.x) vx0 = it.x + gap;
        if (it.x >= b.x && vx1 === null) vx1 = it.x - gap;
      }
    }
    const placed: PlacedMark = {
      mark,
      x0: openLeft ? a.x - m.note.noteStep * 0.5 : (vx0 ?? a.x + padLeft),
      x1: openRight ? b.x + m.note.noteStep * 0.5 : (vx1 ?? b.x - padRight),
      level,
      openLeft,
      openRight,
      startEl: a.element,
      endEl: b.element,
    };
    if (mark.type === "slur" || mark.type === "tuplet") {
      // 简谱弧（engrave/arc.ts，三条简谱路同一条；多连音的两段弧也是弧）：只看起止两个音——两摞的墨迹顶
      // （终点算上临时记号）取高者，再往上一道叠层的空；源码里的 `+` 抬高级别照旧按 level 上移
      placed.y = jpArcY(stackTop(a.element, m, false), stackTop(b.element, m), m.ink.stack.gap)
        - (level - 1) * m.note.slurLevelStep;
    }
    // 只有**两端都**落在并排块的下行里，这个记号才跟着下移；跨过并排块的（比如
    // 从块前一直画到块后的跳房子）另行处理，见下面的「抬到上行之上」
    if (a.dy !== undefined && b.dy !== undefined) placed.dy = a.dy;
    out.push(placed);
  }
  // **弧套弧**（slur 罩着延音线、同一个音起的两条弧、罩着多连音的弧）：外弧按实际弧线判碰里面那些弧的弧顶
  // （engrave/arc.ts::arcClearShift），碰了才整条抬、高出一道空。从短的排起，外层才看得到里层定下的高度
  // （260《感恩的泪》`2⌒2 3 2` 两条弧原先同一个起点、贴在一起）
  const arcs = out.filter((p) => p.y !== undefined && isArcMark(p.mark));
  arcs.sort((p, q) => (p.mark.end - p.mark.start) - (q.mark.end - q.mark.start));
  const rise = jianpuSlurRise(m);
  for (const [i, outer] of arcs.entries()) {
    const inner = arcs.slice(0, i).filter((q) => nests(q.mark, outer.mark))
      .map((q) => ({ x: (q.x0 + q.x1) / 2, y: q.y! - rise - m.style.stroke.slur }));
    outer.y = outer.y! + arcClearShift(outer.x0, outer.y!, outer.x1, outer.y!, rise, true, inner, m.ink.stack.gap);
  }
  // **跳房子**：横线让开房内的和弦/注释（vertical.ts::voltaLineTop），一行同高
  const voltaTop = voltaLineTop(voice, m);
  for (const p of out) if (p.mark.type === "volta") p.y = voltaTop;
  // **渐强渐弱**：`y` 记松叶的**底边**。贴着跨度里音符那一摞（含延长记号、弧、三连音）之上一道空；
  // 跨度里有和弦/注释才抬到那一槽之上（从前一律抬到固定的 `hairpinY`，没和弦的行松叶悬在上一组歌词底下）
  const lane = chordLane(voice, m);
  for (const p of out) {
    if (p.mark.type !== "crescendo" && p.mark.type !== "decrescendo") continue;
    let top = Infinity;
    for (const it of items) {
      // 小节线上的 Fine / D.S.（画在记号槽 `ornamentY` 那条基线上，居中在线上，compose/note.ts::paintOrnaments）：
      // 线离末音一个步距上下，字往左伸，按步距算进来
      if (it.element.kind === "barline") {
        if (it.element.ornaments.length && it.x >= p.x0 && it.x <= p.x1 + m.note.noteStep)
          top = Math.min(top, m.note.ornamentY - m.style.size.chord * 0.9);
        continue;
      }
      if (it.x < p.x0 - m.ink.noteHeight || it.x > p.x1 + m.ink.noteHeight) continue;
      const el = it.element;
      top = Math.min(top, stackTop(el, m));
      if (el.kind === "note" && el.ornaments.some((o) => o.name === "yc" || o.name === "ycy"))
        top = Math.min(top, stackTop(el, m) - noteMarkGap(m) - m.ink.noteHeight * 0.6);
      const text = el.kind === "note" ? noteTextTop(el, m, lane) : el.kind === "sustain" && el.chord ? annotationTop(m, lane) : null;
      if (text !== null) top = Math.min(top, text);

    }
    for (const q of out) {
      if (q === p || q.y === undefined || !isArcMark(q.mark) || q.x1 < p.x0 || q.x0 > p.x1) continue;
      top = Math.min(top, q.y - rise - m.style.stroke.slur);
    }
    // 松叶与下面那一摞之间留得比弧宽：弧的那道空（`slurGap`）是让弧端贴着音符的，松叶照它放就压在数字顶上
    const gap = Math.max(m.style.vertical.slurGap, m.ink.noteHeight * 0.3) + m.style.stroke.hairpin / 2;
    // 最高只到原先的固定槽位（`hairpinY`）：两组之间的空是按那个槽位预留的（`groupHeadroom`），
    // 再往上就顶进上一组的歌词——密排多声部里弧顶比槽位还高时，退回槽位（与改动前一样贴着弧）
    const ceiling = m.note.hairpinY + m.note.hairpinOpening / 2 - (p.level - 1) * m.note.levelStep;
    if (Number.isFinite(top)) p.y = Math.max(ceiling, top - gap - (p.level - 1) * m.note.levelStep);
  }
  return out;
}

export function isArcMark(mk: Mark): boolean {
  return mk.type === "slur" || mk.type === "tuplet";
}

/** `inner` 整条落在 `outer` 的跨度里（不是同一条）。 */
function nests(inner: Mark, outer: Mark): boolean {
  return inner !== outer && inner.start >= outer.start && inner.end <= outer.end
    && (inner.start !== outer.start || inner.end !== outer.end);
}

/** 这条弧外面套着几层（里面每多一层弧，它就得多抬一层）。 */
export function arcNestDepth(mk: Mark, marks: readonly Mark[]): number {
  let depth = 0;
  for (const o of marks) if (isArcMark(o) && nests(o, mk)) depth = Math.max(depth, arcNestDepth(o, marks) + 1);
  return depth;
}
