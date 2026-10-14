// 跨若干符号的记号（弧线 / 多连音 / 跳房子 / 渐强渐弱）换算成行内坐标，弧按嵌套定层。
import type { Mark, ScoreLine } from "../../../pu/ast";
import { jianpuSlurRise, type JianpuGrid } from "../metrics";
import { ARC_CHAIN_INSET_DIV, arcClearShift, jpArcY } from "../../../engrave/arc";
import type { PlacedItem, PlacedMark } from "./model";
import { stackTop } from "./vertical";
import { barlineLines } from "./spacing";

/** 把记号的元素下标区间换算成行内 x 区间；弧线、多连音的 y 也在这里定（跳房子、松叶的 y 见 band.ts）。 */
export function placeMarks(
  voice: ScoreLine, items: PlacedItem[], m: JianpuGrid,
  /** 并排块（`{dsb}`）的左花括号 x：房号收在它之前，不罩到并排块上行 */
  stops: readonly number[] = [],
): PlacedMark[] {
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
    // 跳房子的竖脚**对齐小节线的线位**（同简谱引擎 `Line.endingSpan`）：起点取房内首音之前那条线的最后一根、
    // 终点取末音之后那条的第一根（`:‖` 与 `‖:` 两房相接时一个落细线、一个落粗线，天然分开）。不画的线按锚点
    let vx0: number | null = null;
    let vx1: number | null = null;
    if (mark.type === "volta") {
      for (const it of items) {
        if (it.element.kind !== "barline") continue;
        const ln = barlineLines(it.element, m);
        if (it.x <= a.x) vx0 = it.x + (ln?.last ?? 0);
        if (it.x >= b.x && vx1 === null) vx1 = it.x + (ln?.first ?? 0);
      }
      // 房后紧跟并排块、中间没有小节线（`[2 5 - - - {dsb …}`）：收在花括号之前（同一首歌）
      for (const x of stops) if (x > a.x && (vx1 === null || x < vx1)) vx1 = x;
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
        - (level - 1) * m.note.levelStep;
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
  // 跳房子、松叶的 y 按上方带堆叠的结果定（band.ts::placeBand）
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
