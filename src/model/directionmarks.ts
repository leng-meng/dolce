// 小节里的 `<direction>`（MusicXML / `.jpwabc` 来的力度、术语、跳转、文字、渐强渐弱）→ 简谱那套「挂在符号上的记号」。
//
// 简谱一路（文本谱视图 `pu/slots.ts::docView`、文本谱写出 `topu.ts`）的记号都挂在音符/小节线上（`&mp` `&fine`），
// MusicXML 却是小节里独立的 direction，靠「游标位置 + `<offset>`」定拍位。两边在这里对齐，一份规则：
//   - 挂哪个符号：按**拍位**找——力度、术语、segno/coda、文字、渐强起点挂在拍位上（或之后）的第一个占时值的符号；
//     渐强收尾挂在拍位**之前**的最后一个（写出端 `xmlproject.ts::wedgeDirections` 把收尾写在收尾音的终点）；
//   - Fine / D.C. / D.S.：挂本小节的右线（唱到这里才跳）；
//   - 不是术语的文字（`副歌`）当段落词。
import type { Element, Measure, SourceOrnament } from "./doc";
import { DYNAMICS, TERMS } from "../pu/glyph";
import { decoKey } from "./deconames";

/** 文字术语 → 记号名（MusicXML 的 `<words>rit.</words>`）。 */
export const TERM_OF: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TERMS).map(([name, text]) => [text, name]),
);

/** 挂在小节右线上的跳转记号（唱到这里才跳）。 */
const AT_BAR_END = new Set(["fine", "dc", "ds"]);

export interface DirectionMarks {
  /** 挂在本小节第几个元素上的记号（下标是 `Measure.elements` 的下标） */
  byElement: Map<number, SourceOrnament[]>;
  /** 挂在本小节右线上的（Fine / D.C. / D.S.） */
  barEnd: SourceOrnament[];
  /** 不是术语的文字：挂在第几个元素上当段落词 */
  words: Map<number, string>;
  /** 渐强渐弱的起止：按出现顺序，`index` 同 `byElement` */
  wedges: ({ edge: "start"; type: "crescendo" | "diminuendo"; index: number } | { edge: "stop"; index: number })[];
}

const timed = (el: Element): boolean => (el.kind === "chord" ? !el.grace : el.spacer === "x");

export function directionMarks(mea: Measure): DirectionMarks {
  const out: DirectionMarks = { byElement: new Map(), barEnd: [], words: new Map(), wedges: [] };
  const dirs = mea.directions ?? [];
  if (!dirs.length) return out;
  // 各元素的起点（divisions）
  const onset: number[] = [];
  let pos = 0;
  for (const el of mea.elements) {
    onset.push(pos);
    if (timed(el)) pos += Math.round(el.duration?.divisions ?? 0);
  }
  const timedIdx = mea.elements.map((el, i) => (timed(el) ? i : -1)).filter((i) => i >= 0);
  if (!timedIdx.length) return out;
  const posOf = (k: number | undefined, offset: number | undefined): number =>
    (k !== undefined && k < onset.length ? onset[k]! : k !== undefined ? pos : 0) + (offset ?? 0);
  /** 拍位上（或之后）的第一个占时值的符号 */
  const atOrAfter = (p: number): number => timedIdx.find((i) => onset[i]! >= p - 1e-6) ?? timedIdx[timedIdx.length - 1]!;
  /** 拍位之前的最后一个 */
  const before = (p: number): number => {
    let best = timedIdx[0]!;
    for (const i of timedIdx) if (onset[i]! < p - 1e-6) best = i;
    return best;
  };
  const push = (i: number, name: string): void => {
    const list = out.byElement.get(i) ?? [];
    if (!list.some((o) => o.name === name)) list.push({ name, level: 0 });
    out.byElement.set(i, list);
  };
  for (const dir of dirs) {
    const p = posOf(dir.afterElements, dir.offset);
    for (const part of [dir, ...(dir.more ?? [])]) {
      if (part.type === "wedge") {
        if (part.spanType === "start" && part.wedgeType) out.wedges.push({ edge: "start", type: part.wedgeType, index: atOrAfter(p) });
        else if (part.spanType === "stop") out.wedges.push({ edge: "stop", index: before(p) });
        continue;
      }
      let name: string | undefined;
      if (part.type === "dynamics" && part.text && part.text in DYNAMICS) name = part.text;
      else if (part.type === "segno" || part.type === "coda") name = decoKey(part.type);
      else if (part.type === "words" && part.text) {
        const t = part.text.trim();
        name = TERM_OF[t] ?? decoKey(t);
        if (!name && t && !out.words.has(atOrAfter(p))) out.words.set(atOrAfter(p), t);
      }
      if (!name) continue;
      if (AT_BAR_END.has(name)) {
        if (!out.barEnd.some((o) => o.name === name)) out.barEnd.push({ name, level: 0 });
      } else push(atOrAfter(p), name);
    }
  }
  return out;
}
