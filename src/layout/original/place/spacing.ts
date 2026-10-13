// 横向排列：同一拍位的符号归成一列，列宽按内容定，再做歌词避让与两端对齐，解出每个符号的最终 x。
//
// 单声部、多声部同一份代码。判据整段搬自简谱引擎（`layout.ts::Line.calcXPos` 的紧排与歌词避让、
// `Line.adjust` 的水位法两端对齐、`adjustLastBarline`），那边的阈值与注释里的曲例都是对过原书的；
// 这里只是把「一个条目」换成「一列」：列的左右占位取各声部里最大的那个，歌词按声部各自避让。
//
// 锚点 x 是数字**墨迹中心**（compose 按墨迹居中落笔）；占位按数字**字面宽**算（同简谱引擎 `entryWidth`），
// 所以列的左占位 = 锚点到落笔原点（墨迹中心偏移），右占位 = 字面宽 − 它（+ 附点占位）。
import type { BarlineElement, Meter, NoteElement } from "../../../pu/ast";
import { barlineSpan, jianpuGraceMetrics, jianpuGraceNotes, type JianpuGrid } from "../metrics";
import { latinWordBreak } from "../../../engrave/syllable";
import { graceAdvance } from "../../../engrave/grace";
import { ACCIDENTAL_CLEARANCE, accidentalLead, type AccidentalKind } from "../../../engrave/accidental";
import { BarlineGlyph } from "../../../engrave/barline";
import { timeSigWidth } from "../../../engrave/timesig";
import { puBarlineSpec } from "../barspec";
import type { InkMeasurer, PlacedItem } from "./model";

/** 一列：同一拍位（或同一条小节线）上各声部的符号。 */
interface Column {
  /** 各声部落在这一列的符号（`v` = 第几个声部） */
  members: Array<{ it: PlacedItem; v: number }>;
  /** 小节线那一列 */
  bar: boolean;
  /** 锚点到占位左缘 / 右缘 */
  left: number;
  right: number;
  /** 占位之前硬让出的地方：前倚音（简谱引擎 `Entry.leadSpace`）、小节线前那一小格 */
  lead: number;
  /** 临时记号伸到数字左边那一截再加一道空：紧排时硬让（与前倚音 `lead` 取大者）；简谱引擎那边是软让位（`Entry.leadWant`） */
  want: number;
  /** 临时记号伸出落笔原点左边多少（行首那一列要整个让出来：简谱引擎行首贴的是条目最左的内容） */
  over: number;
  /** 占位之后硬让出的地方（`&sbf` 连谱号、`{dsb}` 花括号，见 `voice.ts::layoutVoiceLine`） */
  pad: number;
}

/** 行中转拍：拍号前后各留的那一格 ÷ 音符字号（同简谱引擎 `TimeSig`：「拍号前后要有间距」）。 */
export const TIME_SIG_PAD_EM = 1 / 4;

/**
 * 小节线的占位（相对锚点的左右），口径同简谱引擎：那边小节线条目的占位是组的包围盒——竖线的盒从线心起、宽一个线宽，
 * 反复点按墨迹。compose/barline.ts 把 `BarlineGlyph` 居中于锚点画（原点 = 锚点 − 宽/2）。
 * 另给出线前那一小格要按的「组里第一个图元的高」（普通线是线高，`:‖` 先画点，是点径）。隐藏线 null。
 */
function barlineBox(el: BarlineElement, m: JianpuGrid): { left: number; right: number; first: number } | null {
  const bs = puBarlineSpec(el);
  if (!bs) return null;
  const span = barlineSpan(m);
  const g = new BarlineGlyph(bs.spec, bs.final, {
    top: span.top,
    bot: span.bottom,
    light: m.style.stroke.barline,
    heavy: m.style.stroke.finalBarline,
    dotRadius: m.style.dot.repeat,
    color: 0,
  });
  const first = g.lines[0];
  const last = g.lines[g.lines.length - 1];
  if (!first || !last) return null;
  const r = m.style.dot.repeat;
  const lo = bs.spec.repeatBackward ? 0 : first.x;
  const hi = bs.spec.repeatForward ? g.width + 2 * r : last.x + last.strokeWidth;
  return { left: g.width / 2 - lo, right: hi - g.width / 2, first: bs.spec.repeatBackward ? 2 * r : span.bottom - span.top };
}

/** 行中转拍的拍号占位（含前后两格），与 compose/barline.ts 画的同一个宽。 */
export function meterAdvance(meter: Meter, m: JianpuGrid): number {
  const pad = m.style.size.note * TIME_SIG_PAD_EM;
  return pad + timeSigWidth(meter.numerator, meter.denominator, m.style.vertical.barlineHeight) + pad;
}

/** 一个符号的占位（相对锚点），口径见文件头。 */
function itemBox(it: PlacedItem, m: JianpuGrid, ink: InkMeasurer): { left: number; right: number; lead: number; want: number; over: number } {
  const el = it.element;
  if (el.kind === "barline") {
    const meter = el.temporaryMeter ? meterAdvance(el.temporaryMeter, m) : 0;
    const b = barlineBox(el, m);
    if (!b) return { left: 0, right: meter, lead: 0, want: 0, over: 0 };
    // 小节线前空一小格：简谱引擎是「条目项高度的 1/5」，条目项是组里第一个图元。照搬，两边才对得上。
    // 简谱引擎的拍号是小节线后的单独一个条目，那条线前面不空这一格
    return { left: b.left, right: b.right + meter, lead: el.temporaryMeter ? 0 : b.first / 5, want: 0, over: 0 };
  }
  const ch = el.kind === "sustain" ? "-" : (el as NoteElement).sound === "rhythm" ? "X" : String((el as NoteElement).pitch);
  const d = ink.digit(ch);
  const center = (d.ink.left + d.ink.right) / 2;
  let right = d.advance - center;
  let lead = 0;
  let want = 0;
  let over = 0;
  if (el.kind === "note") {
    // 附点是画上去的圆，占位照旧按 `·` 的字面宽留（同简谱引擎 `JpNumber.augDotAdvance`）
    if (el.dots > 0) right += ink.digit("·").advance * el.dots;
    if (el.graceBefore.length > 0) lead = graceAdvance(jianpuGraceNotes(el.graceBefore), jianpuGraceMetrics(m));
    if (el.graceAfter.length > 0) right += graceAdvance(jianpuGraceNotes(el.graceAfter), jianpuGraceMetrics(m));
    // 临时记号软让位：伸出落笔原点左边多少、再多留一道空（`NoteEntry.addAccidental`）；`classic`（成书照原书）不让
    if (el.accidental !== undefined && m.style.look.accidentalStyle !== "classic") {
      const h = m.ink.noteHeight;
      over = Math.max(0, accidentalLead(el.accidental as AccidentalKind, h, m.style.look.accidentalScale) - d.ink.left);
      want = over + h * ACCIDENTAL_CLEARANCE;
    }
  }
  return { left: center, right, lead, want, over };
}

/** 各声部的符号按「小节:拍位」归列（小节线按「第几条」），列按先后排好。键法同旧的多声部对齐。 */
function columnsOf(lines: ReadonlyArray<{ items: PlacedItem[]; pad: number[] }>, m: JianpuGrid, ink: InkMeasurer): Column[] {
  const byKey = new Map<string, { bar: number; beat: number; occ: number; col: Column }>();
  lines.forEach((l, v) => {
    let bar = 0;
    const seen = new Map<string, number>();
    l.items.forEach((it, i) => {
      const isBar = it.element.kind === "barline";
      const beat = isBar ? Infinity : Math.round(it.beat * 1e4) / 1e4;
      const base = `${bar}:${beat}`;
      const occ = seen.get(base) ?? 0;
      seen.set(base, occ + 1);
      const key = `${base}:${occ}`;
      let e = byKey.get(key);
      if (!e) {
        e = { bar, beat, occ, col: { members: [], bar: isBar, left: 0, right: 0, lead: 0, want: 0, over: 0, pad: 0 } };
        byKey.set(key, e);
      }
      const b = itemBox(it, m, ink);
      const c = e.col;
      c.members.push({ it, v });
      c.left = Math.max(c.left, b.left);
      c.right = Math.max(c.right, b.right);
      c.lead = Math.max(c.lead, b.lead);
      c.want = Math.max(c.want, b.want);
      c.over = Math.max(c.over, b.over);
      c.pad = Math.max(c.pad, l.pad[i] ?? 0);
      if (isBar) bar += 1;
    });
  });
  return [...byKey.values()]
    .sort((a, b) => a.bar - b.bar || a.beat - b.beat || a.occ - b.occ)
    .map((e) => e.col);
}

/** 紧排 + 歌词避让后的列锚点（还没两端对齐），以及每列歌词伸到的最右处。 */
function packColumns(cols: readonly Column[], voices: number, m: JianpuGrid, ink: InkMeasurer): { X: number[]; lyricRight: number[] } {
  const gap = m.style.spacing.lyricGap;
  // 紧排：落笔原点挨着上一列的占位右缘（+ 硬让位）；行首那一列的倚音、临时记号整个让出来
  const N: number[] = [];
  let cur = 0;
  // 临时记号**硬**让位（伸出 + 一道空，`want`）：软让位只在两端对齐有余量时才填，行一挤满升降号就压到前面的音与小节线上
  //（原样分页《同一首歌》）。简谱引擎那边仍是软的（硬让会把 .jpwabc 定死的行挤折）；这边放不下由重断行收
  cols.forEach((c, i) => {
    cur += i === 0 ? Math.max(c.lead, c.over) : Math.max(c.lead, c.want);
    N.push(cur + c.left);
    cur = N[i]! + c.right + c.pad;
  });
  // 歌词避让：各声部各自一道游标（同 `Line.calcXPos` 的第二遍）。各段一起算——叠排时一个音符底下摞着好几段，
  // 取各段里最靠左的左缘、最靠右的右缘；推开一列，后面的列整体跟着右移
  const X: number[] = [];
  const lyricRight: number[] = cols.map(() => -Infinity);
  // 游标从行首起（0）：行首那个字的左缘也不出行首
  const state = Array.from({ length: voices }, () => ({ curX: 0, prevBlank: 0, prevLatin: [] as string[] }));
  let offset = 0;
  cols.forEach((c, ci) => {
    let x = N[ci]! + offset;
    const runs = new Map<number, ReturnType<InkMeasurer["lyric"]>[]>();
    c.members.forEach(({ it, v }) => {
      const rs = it.syllables.filter((s) => s !== null && s.text.length > 0).map((s) => ink.lyric(s!));
      if (rs.length) runs.set(v, rs);
    });
    for (const [v, rs] of runs) {
      const st = state[v]!;
      // **前置标点悬挂**：`“凡` 这种带前引号的字，避让只看主体，让引号伸进左边的空档里；
      // 悬挂多少由墨迹说了算（标点挤压），且只许吃掉字与字之间那道呼吸（`hang ≤ lyricGap`）。
      // 判据与曲例（190 首、376《将心给我》）见 `layout.ts::Line.calcXPos`
      const room = st.prevBlank + gap + Math.min(...rs.map((r) => r.headBlank));
      const hang = Math.max(0, Math.min(Math.min(...rs.map((r) => r.lead)), room, gap));
      const leftMost = Math.min(...rs.map((r) => -(r.lead + r.body / 2))) + hang;
      // 西文的词与词之间要留一个空格（`love, and joy?` 照中文挨排就成了 `love,andjoy?`）
      const wordGap = rs.some((r, k) => latinWordBreak(st.prevLatin[k] ?? st.prevLatin[0] ?? "", r.text)) ? ink.lyricSpace : 0;
      x = Math.max(x, st.curX + wordGap - leftMost);
    }
    offset = x - N[ci]!;
    X.push(x);
    for (const [v, rs] of runs) {
      const st = state[v]!;
      const rightMost = Math.max(...rs.map((r) => r.width - r.lead - r.body / 2));
      st.curX = x + rightMost + gap;
      // 各段里**留白最少**的那一段说了算（有一段挤不下就是挤不下）
      st.prevBlank = Math.min(...rs.map((r) => r.tailBlank));
      st.prevLatin = rs.map((r) => r.text);
      lyricRight[ci] = Math.max(lyricRight[ci]!, x + rightMost);
    }
  });
  return { X, lyricRight };
}

/**
 * 水位法两端对齐（`Line.adjust`）：把 `extra` 摊进各列之间的空档，空档按「已有宽 ÷ 权重」从窄到宽依次灌平。
 * 权重：音符到音符 2，挨着小节线的 1。临时记号的让位已在紧排里硬留（packColumns），这里不再另算。
 */
function justify(cols: readonly Column[], X: number[], extra: number): void {
  const infos: Array<{ i: number; dist: number; rate: number }> = [];
  for (let i = 0; i + 1 < cols.length; i++) {
    const a = cols[i]!;
    const b = cols[i + 1]!;
    const dist = X[i + 1]! - b.left - (X[i]! + a.right);
    infos.push({ i, dist, rate: !a.bar && !b.bar ? 2 : 1 });
  }
  infos.sort((p, q) => {
    const diff = p.dist * q.rate - q.dist * p.rate;
    return diff < 0 ? -1 : diff > 0 ? 1 : p.rate - q.rate;
  });
  let totalDist = 0;
  let totalRate = 0;
  let end = 0;
  for (; end < infos.length; end++) {
    const it = infos[end]!;
    const share = (extra + totalDist + it.dist) / (totalRate + it.rate);
    if (share < it.dist / it.rate) break;
    totalDist += it.dist;
    totalRate += it.rate;
  }
  if (totalRate === 0) return;
  const share = (extra + totalDist) / totalRate;
  const add = new Array<number>(cols.length).fill(0);
  for (let k = 0; k < end; k++) {
    const it = infos[k]!;
    add[it.i] = share * it.rate - it.dist;
  }
  let offset = 0;
  for (let i = 0; i < cols.length; i++) {
    X[i] = X[i]! + offset;
    offset += add[i]!;
  }
}

/**
 * 一组（system）各声部的横向排列：归列 → 紧排 → 歌词避让 → 两端对齐，写回每个符号的 `x` 与 `advance`。
 *
 * `width` 是这一行能用的宽（占位右缘最多到这里）。每行都两端对齐，末行也一样；往空档里加的总量最多是
 * 自然宽的 `maxHorizontalScale` 倍（同简谱引擎，短行因此不会被扯得满行都是）。放不下不压缩（紧排已是最紧），
 * 由窄纸重断行（`reflow.ts`）保证放得下。
 * 返回自然宽（占位右缘，含歌词）。
 */
export function placeColumns(
  lines: ReadonlyArray<{ items: PlacedItem[]; pad: number[] }>,
  m: JianpuGrid,
  ink: InkMeasurer,
  width: number,
): number {
  const cols = columnsOf(lines, m, ink);
  if (cols.length === 0) return 0;
  const { X, lyricRight } = packColumns(cols, lines.length, m, ink);
  // 行右缘：从末列往回，到最后一个带歌词的列为止，取占位与歌词右缘里最靠右的（同 `Line.adjust`）
  let right = 0;
  for (let i = cols.length - 1; i >= 0; i--) {
    right = Math.max(right, X[i]! + cols[i]!.right, lyricRight[i]!);
    if (lyricRight[i]! > -Infinity) break;
  }
  if (width > right) {
    let extra = width - right;
    const cap = m.style.spacing.maxHorizontalScale * right;
    const capped = extra > cap;
    if (capped) extra = cap;
    justify(cols, X, extra);
    // 末一条小节线贴到版心右缘（`Line.adjustLastBarline`）：离前一个音最多三个字号
    const n = cols.length;
    if (!capped && n >= 2 && cols[n - 1]!.bar && !cols[n - 2]!.bar) {
      const last = cols[n - 1]!;
      const prev = cols[n - 2]!;
      const dx = X[n - 1]! - last.left - (X[n - 2]! + prev.right);
      const space = width - (X[n - 1]! + last.right);
      if (space > 0) X[n - 1] = X[n - 1]! + Math.max(0, Math.min(space, m.style.size.note * 3 - dx));
    }
  }
  cols.forEach((c, i) => {
    for (const { it } of c.members) {
      it.x = X[i]!;
      it.advance = i + 1 < cols.length ? X[i + 1]! - X[i]! : c.right;
    }
  });
  return right;
}

/**
 * 整组的**自然**列锚点（紧排 + 歌词避让，不两端对齐）：窄纸重断行按它量每小节要多宽（`reflow.ts`）。
 * 返回各符号的自然 x 与这一组的自然宽。
 */
export function naturalColumns(
  lines: ReadonlyArray<{ items: PlacedItem[]; pad: number[] }>,
  m: JianpuGrid,
  ink: InkMeasurer,
): { xOf: Map<PlacedItem, number>; width: number } {
  const cols = columnsOf(lines, m, ink);
  const { X, lyricRight } = packColumns(cols, lines.length, m, ink);
  const xOf = new Map<PlacedItem, number>();
  let width = 0;
  cols.forEach((c, i) => {
    for (const { it } of c.members) xOf.set(it, X[i]!);
    width = Math.max(width, X[i]! + c.right + c.pad, lyricRight[i]!);
  });
  return { xOf, width };
}
