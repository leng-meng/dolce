// 纵向量：头顶让位（和弦槽、弧、记号、倚音、八度点叠层）、墨迹底、连谱号伸出量。
import type { MusicElement, NoteElement, ScoreLine, VoiceGroup } from "../../../pu/ast";
import { jianpuGraceMetrics, jianpuGraceNotes, jianpuSlurRise, noteMarkGap, type JianpuGrid } from "../metrics";
import { graceBottom, graceGeometry, type GraceGeom } from "../../../engrave/grace";
import { stackBottom, stackTop as stackTopOf } from "../../../engrave/stack";
import { accidentalRise, type AccidentalKind } from "../../../engrave/accidental";
import { DYNAMICS, TERMS } from "../../../pu/glyph";
import type { PlacedItem } from "./model";
import { arcNestDepth, isArcMark } from "./marks";

/** 和弦/注释那一行**墨迹顶**（相对音符基线，负为上）：基线在 `lane`（缺省 chordY），字往上长。 */
export function annotationTop(m: JianpuGrid, lane = m.note.chordY): number {
  return lane - m.style.size.chord * 0.9;
}

/** 音符头顶那一槽的墨迹顶：和弦/注释一行，转调标签（`keyLabel`）与它们同在时它占贴音那一槽、和弦/注释叠到上一行。没有字返回 null */
export function noteTextTop(el: NoteElement, m: JianpuGrid, lane = m.note.chordY): number | null {
  const rows = (el.chord || el.annotation ? 1 : 0) + (el.keyLabel ? 1 : 0);
  return rows === 0 ? null : annotationTop(m, lane) - (rows - 1) * m.style.size.chord * 1.2;
}

/**
 * 一组倚音画在哪（相对锚点 x、基线 baseline）。**画（compose/note.ts::paintGrace）与让位共用这一份**：
 * 整块倚音（不含钩）的墨迹底离主音那一摞的顶一道空，与简谱引擎、混排同一条规则。
 */
export function graceLayout(note: NoteElement, side: "before" | "after", m: JianpuGrid, x: number, baseline: number): GraceGeom {
  const list = side === "before" ? note.graceBefore : note.graceAfter;
  const dir = side === "before" ? -1 : 1;
  const gn = jianpuGraceNotes(list);
  const gm = jianpuGraceMetrics(m);
  const probe = graceGeometry(gn, gm, x, 0, dir, m.style.size.note, 0);
  const centerY = baseline + stackTop(note, m) - m.ink.stack.gap - graceBottom(probe, gm);
  return graceGeometry(gn, gm, x, baseline, dir, m.style.size.note, centerY);
}

/** 这个音符上倚音那几块的墨迹顶（相对基线，负为上）；没有倚音返回 null。 */
export function graceTop(el: MusicElement, m: JianpuGrid): number | null {
  if (el.kind !== "note" || (el.graceBefore.length === 0 && el.graceAfter.length === 0)) return null;
  const gInk = m.ink.noteHeight * 0.5;
  let top = Infinity;
  for (const side of ["before", "after"] as const) {
    const g = graceLayout(el, side, m, 0, 0);
    for (const d of g.digits) top = Math.min(top, d.cy - gInk / 2);
    for (const d of g.dots) top = Math.min(top, d.cy - d.r);
    for (const a of g.accidentals) top = Math.min(top, a.inkCy - a.inkHeight / 2);
  }
  return Number.isFinite(top) ? top : null;
}

/**
 * 这一行和弦/注释那一槽的基线（相对音符基线）。缺省是 `chordY`；行里有倚音时整行一起往上抬，
 * 抬到倚音墨迹顶之上 0.3 个数字墨迹高——和弦是固定一槽（原版观感），倚音不让开它就压到字上（260《感恩的泪》）。
 * 整行同抬，一行的和弦才仍在一条线上。
 */
export function chordLane(voice: ScoreLine, m: JianpuGrid): number {
  let lane = m.note.chordY;
  // 力度记号按墨迹贴着音符那一摞往上一道空（compose/note.ts::paintOrnaments），术语走固定槽（`note.ornamentY`），
  // 都在和弦那一槽底下：行里有和弦时，和弦整排抬到它们的墨迹顶之上（同倚音）。
  // 音符自己带和弦/注释的不算：它的力度、术语摞到那行字之上（`expressionTop`，用户口径：力度不压在和弦底下）
  const hasChord = voice.elements.some((el) => (el.kind === "note" || el.kind === "sustain") && !!el.chord);
  for (const el of voice.elements) {
    const t = graceTop(el, m);
    // 净空按文字算（和弦是字，叠层那道空对字太紧，看着还是挨着）
    if (t !== null) lane = Math.min(lane, t - m.ink.noteHeight * 0.3);
    if (hasChord && el.kind === "note" && !el.chord && !el.annotation && el.ornaments.some((o) => DYNAMICS[o.name] || TERMS[o.name])) {
      // 力度字形的墨迹约高一个数字墨迹高的 0.75（Bravura 力度字母的 x 高）
      const base = Math.min(m.note.ornamentY, stackTop(el, m) - noteMarkGap(m));
      lane = Math.min(lane, base - m.ink.noteHeight * 0.75 - m.ink.noteHeight * 0.15);
    }
  }
  return lane;
}

/** 上一组末行与本组头顶之间至少留几个歌词字号（`layoutSong` 的组间让位）。 */
export const GROUP_CLEAR = 0.75;

/**
 * 一组曲行头顶需要留多少空间——记号是往上画的（弧线、跳房子、渐强渐弱、装饰音、
 * 临时伴奏），不预留就会压到上一组的歌词。
 */
export function groupHeadroom(group: VoiceGroup, m: JianpuGrid): number {
  // 注释/和弦这一槽是常备的（行里有倚音时整槽抬高，见 chordLane）
  let top = Math.min(m.note.chordY, ...group.voices.map((v) => chordLane(v, m)));
  const consider = (v: number): void => {
    if (v < top) top = v;
  };
  for (const voice of group.voices) {
    const lane = chordLane(voice, m);
    for (const mark of voice.marks) {
      const level = Math.max(1, mark.level);
      if (mark.type === "volta") consider(voltaLineTop(voice, m));
      else if (mark.type === "crescendo" || mark.type === "decrescendo") {
        consider(m.note.hairpinY - (level - 1) * m.note.levelStep - m.note.hairpinOpening / 2);
      } else {
        const nest = isArcMark(mark) ? arcNestDepth(mark, voice.marks) * (jianpuSlurRise(m) + m.note.slurLevelStep / 2) : 0;
        consider(-m.ink.noteHeight / 2 - m.style.vertical.slurGap - (level - 1) * m.note.slurLevelStep - jianpuSlurRise(m) - nest);
      }
    }
    for (const el of voice.elements) {
      if (el.kind === "inline-layer" && el.role === "voice") {
        // `{dsb}` 并排块：上行整体抬高 `splitRise`，头顶是它自己的记号或花括号上端，取高的那个
        const inner: ScoreLine = { voice: voice.voice, elements: el.elements, marks: el.marks, lyrics: [], raw: el.code, source: el.source };
        consider(-splitRise(m) - Math.max(m.ink.noteHeight * 0.64, voiceHeadroom(inner, m)));
      } else if (el.kind === "inline-layer") consider(m.note.cueY - m.ink.noteHeight * 0.6);
      // 和弦/注释画在 annotationY 那条**基线**上，字还要往上长一截——只留 annotationY
      // 的话，system 间距一收紧（gapGroup 按无和弦的底本量得）和弦就顶进上一组的低音点。
      // 再往上让一个数字高：只让到墨迹顶是「不打架」，两组之间还得看得出是两组。
      const nt = el.kind === "note" ? noteTextTop(el, m, lane) : null;
      if (nt !== null) consider(nt - m.ink.noteHeight);
      // 注释可能让邻音的和弦挤到上一行（compose/page.ts::liftedAnnotations）
      if (el.kind === "note" && !el.chord && el.annotation && voice.elements.some((o) => (o.kind === "note" || o.kind === "sustain") && !!o.chord)) {
        consider(annotationTop(m, lane) - m.style.size.chord * 1.2 - m.ink.noteHeight);
      }
      // 带和弦的音上的力度/术语摞在那行字之上（compose/note.ts::paintOrnaments 的 textTop）
      if (nt !== null && el.kind === "note" && el.ornaments.some((o) => DYNAMICS[o.name] || TERMS[o.name])) {
        consider(nt - noteMarkGap(m) - m.ink.noteHeight * 0.9 - m.ink.noteHeight);
      }
      if (el.kind === "sustain" && el.chord) consider(annotationTop(m, lane) - m.ink.noteHeight);
      const gt = graceTop(el, m);
      if (gt !== null) consider(gt);
      if (el.kind === "note" || el.kind === "sustain" || el.kind === "barline") {
        for (const orn of el.ornaments) {
          // 换气的 V 有自己的高度（照原版放在基线上方两个墨迹高），不走记号槽
          if (orn.name === "hx") consider(-m.ink.noteHeight * 1.05);
          else consider(m.note.ornamentY - orn.level * m.note.levelStep - m.ink.noteHeight * 0.7);
        }
      }
    }
  }
  if (group.texts.length > 0) consider(m.note.wordsY - (group.texts.length - 1) * wordsLead(m));
  // 多声部的连谱号：上花头伸出首声部基线 `braceReach`（见 layoutSong 末尾、compose/brace.ts::paintBrace）
  if (group.voices.length > 1) consider(-braceReach(m));
  return -top;
}

/**
 * 一行跳房子横线的高度（相对基线，负为上）：缺省是固定槽位 `voltaY`；房内音符头顶有和弦/注释/转调字时，
 * 整条抬到房号（线下半个小节线高）也让开那行字——房号与和弦不并排挤在同一高度（用户口径）。
 * 一行里的房子同一高度（原版一房二房的横线是一条）。
 */
export function voltaLineTop(voice: ScoreLine, m: JianpuGrid): number {
  let top = Infinity;
  const lane = chordLane(voice, m);
  for (const mark of voice.marks) {
    if (mark.type !== "volta") continue;
    const level = Math.max(1, mark.level);
    let t = m.note.voltaY - (level - 1) * m.note.levelStep;
    for (let i = Math.max(0, mark.start); i <= Math.min(mark.end, voice.elements.length - 1); i++) {
      const el = voice.elements[i]!;
      const nt = el.kind === "note" ? noteTextTop(el, m, lane) : el.kind === "sustain" && el.chord ? annotationTop(m, lane) : null;
      if (nt !== null) t = Math.min(t, nt - noteMarkGap(m) - m.style.vertical.barlineHeight * 0.5);
    }
    top = Math.min(top, t);
  }
  return Number.isFinite(top) ? top : m.note.voltaY;
}

/** 多条 `W:` 文字行的行距（compose/page.ts 逐行画，place/song.ts 让位，同此） */
export function wordsLead(m: JianpuGrid): number {
  return m.style.size.words * 1.35;
}

/** `{dsb}` 并排块里上行比主旋律抬高多少（下行主旋律同量下移）。 */
export function splitRise(m: JianpuGrid): number {
  return m.ink.noteHeight * 1.552;
}

/** 连谱号上下花头伸出首/末声部基线多少：粗线探出 0.85 个墨迹高，花头字形高 1.18 线距（= 1.18/4 em × 字号 2.2 墨迹高）。 */
export function braceReach(m: JianpuGrid): number {
  return m.ink.noteHeight * (0.85 + (1.18 / 4) * 2.2);
}

/**
 * 一个声部**自己头顶**需要多少空间（弧线、和弦注释、装饰记号都画在音符上方）。
 * 组间用 groupHeadroom，组内声部之间用这个——否则四声部谱里第 3 声部的弧线
 * 会画进它上方的歌词块。
 */
export function voiceHeadroom(voice: ScoreLine, m: JianpuGrid): number {
  let top = 0;
  const consider = (v: number): void => {
    if (v < top) top = v;
  };
  for (const mark of voice.marks) {
    const level = Math.max(1, mark.level);
    if (mark.type === "volta") consider(voltaLineTop(voice, m));
    else if (mark.type === "crescendo" || mark.type === "decrescendo") {
      consider(m.note.hairpinY - (level - 1) * m.note.levelStep - m.note.hairpinOpening / 2);
    } else {
      // 弧线现在贴着音符堆叠顶（见 placeMarks），头顶只需留这么高
      // （jianpuSlurRise 与 painter 实际画的弧同源，见 metrics.ts::jianpuSlurStyle）
      const nest = isArcMark(mark) ? arcNestDepth(mark, voice.marks) * (jianpuSlurRise(m) + m.note.slurLevelStep / 2) : 0;
      consider(-m.ink.noteHeight / 2 - m.style.vertical.slurGap - (level - 1) * m.note.slurLevelStep - jianpuSlurRise(m) - nest);
    }
  }
  // `{dsb}` 并排块的上行抬高 `splitRise`，头顶是它自己的记号或花括号上端（同 groupHeadroom）：
  // 不算的话上一声部的歌词压在上行数字上（太阳出来喜洋洋 A4 第 3 页）
  for (const el of voice.elements) {
    if (el.kind !== "inline-layer" || el.role !== "voice") continue;
    const inner: ScoreLine = { voice: voice.voice, elements: el.elements, marks: el.marks, lyrics: [], raw: el.code, source: el.source };
    consider(-splitRise(m) - Math.max(m.ink.noteHeight * 0.64, voiceHeadroom(inner, m)));
  }
  const lane = chordLane(voice, m);
  // 注释可能让邻音的和弦挤到上一行（compose/page.ts::liftedAnnotations）：行里和弦与注释同在就多留一行
  const hasChord = voice.elements.some((el) => (el.kind === "note" || el.kind === "sustain") && !!el.chord);
  for (const el of voice.elements) {
    const nt = el.kind === "note" ? noteTextTop(el, m, lane) : null;
    if (nt !== null) consider(nt);
    if (hasChord && el.kind === "note" && !el.chord && el.annotation) consider(annotationTop(m, lane) - m.style.size.chord * 1.2);
    if (el.kind === "sustain" && el.chord) consider(annotationTop(m, lane)); // 增时线上的和弦同样要留头顶
    const gt = graceTop(el, m);
    if (gt !== null) consider(gt);
    if (el.kind === "note" || el.kind === "sustain" || el.kind === "barline") {
      for (const orn of el.ornaments) {
        if (orn.name === "hx") consider(-m.ink.noteHeight * 1.05);
        else consider(m.note.ornamentY - orn.level * m.note.levelStep - m.ink.noteHeight * 0.7);
      }
    }
  }
  return -top;
}

/**
 * 音符「上方堆叠」的顶端（相对基线，负为上）：没有高八度点时就是数字墨迹顶，
 * 有几个高八度点就抬到最上面那个点的上缘。弧线据此定位——与 .jpwabc 谱面同一规则
 * （见 layout.ts 的 NoteEntry.entryTop / slurRung），固定槽位会离音符太远。
 */
export function stackTop(el: MusicElement | undefined, m: JianpuGrid, withAccidental = true): number {
  const inkTop = -m.ink.noteHeight / 2;
  if (el?.kind !== "note") return inkTop;
  // 临时记号比数字高出一截（engrave/accidental.ts），弧与连音要让开它（简谱弧的起点除外：那个临时记号在弧外侧）
  const accTop = withAccidental && el.accidental !== undefined
    ? inkTop - accidentalRise(el.accidental as AccidentalKind, m.ink.noteHeight, m.style.look.accidentalScale) : inkTop;
  if (el.octave <= 0) return accTop;
  return Math.min(accTop, stackTopOf(-m.ink.noteHeight / 2, el.octave, m.ink.stack));
}


/**
 * 一个音符**最低的墨迹**（相对基线）：数字墨迹底、减时线最下一层、低音点，取最低的那个。
 * 落点走公共那一份（engrave/stack.ts），与画点、简谱引擎的 entryBottom 同一套。
 */
export function noteInkBottom(note: NoteElement, m: JianpuGrid): number {
  return stackBottom(m.ink.noteHeight / 2, noteBeams(note), Math.max(0, -note.octave), m.ink.stack);
}

/** 音符下面有几层减时线（按时值：八分 1、十六分 2……）。 */
export function noteBeams(note: NoteElement): number {
  return Math.max(0, Math.round(Math.log2(note.duration / 4)));
}

/** 一行里最低的墨迹（歌词要据此下推，免得贴到低音点上）。 */
export function lineInkBottom(items: readonly PlacedItem[], m: JianpuGrid): number {
  let bottom = m.ink.noteHeight / 2;
  for (const it of items) {
    if (it.element.kind !== "note" || it.element.hidden) continue;
    const b = noteInkBottom(it.element, m);
    if (b > bottom) bottom = b;
  }
  return bottom;
}
