// 小节里的 `<direction>`（MusicXML / `.jpwabc` 来的力度、术语、跳转、文字、渐强渐弱）→ 简谱那套「挂在符号上的记号」。
//
// 简谱一路（文本谱视图 `pu/slots.ts::docView`、文本谱写出 `topu.ts`）的记号都挂在音符/小节线上（`&mp` `&fine`），
// MusicXML 却是小节里独立的 direction，靠「游标位置 + `<offset>`」定拍位。两边在这里对齐，一份规则：
//   - 挂哪个符号：按**拍位**找——力度、术语、segno/coda、文字、渐强起点挂在拍位上（或之后）的第一个占时值的符号；
//     渐强收尾挂在拍位**之前**的最后一个（写出端 `xmlproject.ts::wedgeDirections` 把收尾写在收尾音的终点）；
//   - Fine / D.C. / D.S.：挂本小节的右线（唱到这里才跳）；
//   - 不是术语的文字（`副歌`）当段落词。
import type { Element, Measure, Song, SourceOrnament } from "./doc";
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

/** 跳转目标记号的短名 → 123 / ABC 的写法（`!segno!`，见 `abcfamily/jumpmarks.ts`）。 */
const TEXT_NAME: Readonly<Record<string, string>> = { hs: "segno", ty: "coda" };

/**
 * 简谱文本写出端（123 / ABC / jcx）用：小节里的 `<direction>` 换成简谱那套写法——力度、术语、segno/coda
 * 进挂靠符号的 `notations.articulations`（`!mf!`），Fine / D.C. / D.S. 进右线的 `ornaments`（`!D.S.!|`），
 * 不是术语的文字当段落词，渐强渐弱换成 `wedge` 记号；之后删掉 `directions`。
 * 挂靠规则与排版视图同一份（`directionMarks`）。没有 direction 的歌原样返回，有的先克隆、不动原件。
 * 以前不换：MusicXML 转出来的 123 丢了全部力度与跳转（064《啊！圣善夜》的 D.S. / D.C.）。
 */
export function directionsAsMarks(src: Song): Song {
  if (!src.parts.some((p) => p.measures.some((m) => m.directions?.length))) return src;
  const song: Song = structuredClone(src);
  for (const part of song.parts) {
    // 渐强渐弱常跨小节：起点留着等后面小节的收尾
    const open: { type: "crescendo" | "diminuendo"; id: number }[] = [];
    for (const mea of part.measures) {
      if (!mea.directions?.length) continue;
      const dm = directionMarks(mea);
      for (const [i, orns] of dm.byElement) {
        const el = mea.elements[i];
        if (el?.kind !== "chord") continue;
        // 小节第一个符号上的 segno / coda 是左线上的跳转目标（123 读 `| !segno! 5` 就这么记，`j123/parse.ts`），照它记才往返不变
        if (i === 0) {
          for (const o of orns.filter((x) => x.name in TEXT_NAME)) {
            const bls = (mea.barlines ??= []);
            const left = bls.find((b) => b.location === "left");
            if (left) (left.ornaments ??= []).push({ name: o.name, level: 0 });
            else bls.push({ location: "left", ornaments: [{ name: o.name, level: 0 }] });
          }
        }
        const arts = (el.notations ??= {}).articulations ??= [];
        for (const o of orns) {
          if (i === 0 && o.name in TEXT_NAME) continue;
          const name = TEXT_NAME[o.name] ?? o.name;
          if (!arts.includes(name)) arts.push(name);
        }
      }
      if (dm.barEnd.length) {
        let right = (mea.barlines ?? []).find((b) => b.location === "right");
        if (!right) (mea.barlines ??= []).push((right = { location: "right", style: "regular" }));
        const own = (right.ornaments ??= []);
        for (const o of dm.barEnd) if (!own.some((x) => x.name === o.name)) own.push({ name: o.name, level: 0 });
      }
      for (const [i, text] of dm.words) {
        const el = mea.elements[i];
        if (el?.kind === "chord" && el.sectionWord === undefined) el.sectionWord = text;
      }
      for (const w of dm.wedges) {
        const el = mea.elements[w.index];
        if (!el) continue;
        if (w.edge === "start") open.push({ type: w.type, id: el.id });
        else {
          const st = open.shift();
          if (st) song.marks.push({ type: "wedge", start: st.id, end: el.id, wedgeType: st.type });
        }
      }
      delete mea.directions;
    }
  }
  return song;
}
