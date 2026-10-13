// 音符：数字、升降号、八度点、附点、和弦与注释、倚音、`&xx` 记号。
import type { NoteElement } from "../../../pu/ast";
import { noteMarkGap } from "../metrics";
import { AccidentalGlyph, type AccidentalKind } from "../../../engrave/accidental";
import { ACCIDENTAL_GLYPH, ACCOMP_BRACKET, BARLINE_MARKS, DYNAMICS, ORNAMENTS, TERMS } from "../../../pu/glyph";
import { Font } from "../../font";
import { Group, type JpNumber, type PageItem } from "../../pageitem";
import { chordTextSegs, harmonyWidth, layoutHarmonySegs } from "../../../engrave/chord";
import { DYNAMIC_SIZE } from "../../../engrave/dynamics";
import { highDotY, lowDotY } from "../../../engrave/stack";
import { augDotCenter } from "../../../engrave/augdot";
import { breathPath } from "../../../engrave/breath";
import type { PlacedItem } from "../place/model";
import { graceLayout, noteBeams, noteTextTop, stackTop } from "../place/vertical";
import { type OriginalCtx, digitItem, digitOrigin, dot, octaveDot, rect, stroke, text } from "./ctx";

/** 音符/增时线上方的和弦：与五线谱共用富文本分段（根音升降号用 SMuFL csym 字形、后缀上标）。 */
export function paintChord(c: OriginalCtx, g: Group, chord: string, x: number, baseline: number): void {
  const m = c.metrics;
  const wordFont = new Font(m.style.font.text.family, m.style.size.chord);
  const musicFont = new Font("Bravura", m.style.size.chord);
  const segs = chordTextSegs(chord, m.style.look.chordPlain, m.style.look.accidentalSide);
  const grp = layoutHarmonySegs(segs, wordFont, musicFont, c.ink);
  grp.x = x - harmonyWidth(segs, wordFont, musicFont) / 2;
  grp.y = baseline + c.chordLane;
  g.add(grp);
}

export function paintNote(c: OriginalCtx,
  root: Group,
  it: PlacedItem,
  x: number,
  baseline: number,
): void {
  const note = it.element as NoteElement;
  const m = c.metrics;
  const g = new Group();
  g.classes.add("entry");
  g.data = note;

  let num: JpNumber | null = null;
  if (!note.hidden) {
    const ch = note.sound === "rhythm" ? "X" : String(note.pitch);
    const { dx, dy } = digitOrigin(c, ch);
    num = digitItem(ch, x + dx, baseline + dy, c.digitFont, c.ink);
    g.add(num);

    // 变音记号：画法与定位走公共那一份（engrave/accidental.ts，照混排：csym 字形、按数字墨迹盒定位）
    const kind = note.accidental as AccidentalKind | undefined;
    if (kind && ACCIDENTAL_GLYPH[kind]) {
      const digit = { font: c.digitFont, text: ch, x: x + dx, y: baseline + dy };
      g.add(new AccidentalGlyph(kind, digit, { music: new Font("Bravura", 20), color: c.ink, kind: m.style.look.accidentalStyle, scale: m.style.look.accidentalScale }).item);
    }

    // 八度点：高音在上、低音在下，同侧多点向外叠。
    // 低音点必须挂在**减时线最下一层之下**（.jpwabc 的 entryBottom 规则：
    // above = max(数字墨迹底, 最低那条减时线的下缘)，再让开一个 stackGap），
    // 否则十六分音符的两条减时线会和低音点叠在一起。
    // 落点走公共那一份（engrave/stack.ts，墨迹到墨迹等距；低音点挂在减时线之下）
    const half = m.ink.noteHeight / 2;
    for (let i = 0; i < note.octave; i++) {
      g.add(octaveDot(c.ink, x, baseline + highDotY(-half, i, m.ink.stack), m.style.dot.octave));
    }
    for (let i = 0; i < -note.octave; i++) {
      g.add(octaveDot(c.ink, x, baseline + lowDotY(half, noteBeams(note), i, m.ink.stack), m.style.dot.octave));
    }
  }

  // 附点：落点走公共那一份（engrave/augdot.ts：与数字墨迹中心等高，离数字墨迹右缘一道空）
  const { dx: adx, dy: ady, b: ab } = digitOrigin(c, note.sound === "rhythm" ? "X" : String(note.pitch));
  const digitInk = ab.offset(x + adx, baseline + ady);
  for (let i = 0; i < note.dots; i++) {
    const p = augDotCenter(digitInk, i, m.style.dot.aug, m.ink.stack.gap);
    const d = octaveDot(c.ink, p.cx, p.cy, m.style.dot.aug);
    if (num) d.aug = { num, index: i };
    d.classes.add("aug-dot"); // 可视化编辑单独点选附点（`notePartEls`）
    d.ident = { kind: "aug-dot" };
    g.add(d);
  }

  // 和弦：与五线谱共用富文本分段（根音升降号用 SMuFL csym 字形、后缀上标）
  if (note.chord) {
    paintChord(c, g, note.chord, x, baseline);
  } else if (note.annotation) {
    const font = new Font(m.style.font.text.family, m.style.size.chord);
    const a = note.annotation;
    const t = text(a, x - font.measureText(a) / 2, baseline + c.chordLane, font, c.ink);
    t.classes.add("annotation"); // 可视化编辑认挂载记号用（`notePartEls`）
    t.classes.add("section-word"); // 成书 line-check 认段落词（`pdflayout/browser.ts::CLS_TAGS`）
    t.ident = { kind: "annotation" };
    g.add(t);
  }
  // 曲中转调标签：新调首音上方，与和弦/注释同一槽；那一槽已有字就再往上叠一行（`place/vertical.ts::noteTextTop`）。
  // 左缘对齐数字左缘、往右写——居中的话行首那个会伸出左边距
  if (note.keyLabel) {
    const font = new Font(m.style.font.text.family, m.style.size.chord);
    const y = baseline + c.chordLane - (note.chord || note.annotation ? m.style.size.chord * 1.2 : 0);
    const t = text(note.keyLabel, x - m.ink.noteHeight * 0.35, y, font, c.ink); // 数字宽约墨迹高的 0.7
    t.classes.add("key-change");
    g.add(t);
  }

  // 倚音：主音左/右侧的小号数字（默认八分，故带一条减时线）
  paintGrace(c, g, note, "before", x, baseline);
  paintGrace(c, g, note, "after", x, baseline);

  // `&xx` 记号
  const before = g.children.length;
  paintOrnaments(c, g, note.ornaments, x, baseline, stackTop(note, c.metrics), undefined, noteTextTop(note, m, c.chordLane) ?? undefined);
  for (const it of g.children.slice(before)) it.ident = { kind: "deco" };

  root.add(g);
  const id = c.doc?.idOf.get(note);
  if (id !== undefined) g.ident = { kind: "note", id };
}

/**
 * 倚音：dir=-1 前倚音（画在左），dir=1 后倚音（画在右）。
 *
 * **几何走公共那一份**（`engrave/grace.ts`），简谱排版引擎那条路
 * （`layout.ts::addGraceNotes`）用的是同一套比例——两边各自落笔，坐标只算一次。
 */
function paintGrace(c: OriginalCtx,
  g: Group,
  note: NoteElement,
  side: "before" | "after",
  x: number,
  baseline: number,
): void {
  const notes = side === "before" ? note.graceBefore : note.graceAfter;
  if (notes.length === 0) return;
  const m = c.metrics;
  const font = new Font(m.style.font.text.family, c.digitFont.size * m.style.size.grace);
  // 落位与让位同一份（place/vertical.ts::graceLayout）：整块倚音的墨迹底离主音那一摞的顶一道空
  const geom = graceLayout(note, side, m, x, baseline);
  for (const d of geom.digits) {
    // 数字按**墨迹中心**定位（公共几何给的是中心，这里换算成落笔点）
    const b = font.charBound(d.text);
    const t = text(d.text, d.cx - (b.left + b.right) / 2, d.cy - (b.top + b.bottom) / 2, font, c.ink);
    t.classes.add("grace");
    g.add(t);
  }
  for (const o of geom.dots) g.add(dot(c.ink, o.cx, o.cy, o.r));
  // 升降号：与主音同一套画法（Bravura 的 SMuFL 字形、按墨迹定位），只是所有量
  // 都由公共几何按倚音的墨迹给好——字号也是反推出来的，不能照主音那个字号缩。
  for (const acc of geom.accidentals) {
    const glyph = ACCIDENTAL_GLYPH[acc.alter];
    if (!glyph) continue;
    const probe = new Font("Bravura", 100);
    const pb = probe.charBound(glyph);
    const inkAt100 = Math.abs(pb.bottom - pb.top) || 68;
    const accFont = new Font("Bravura", (acc.inkHeight * 100) / inkAt100);
    const ab = accFont.charBound(glyph);
    g.add(text(glyph, acc.inkRight - ab.right, acc.inkCy - (ab.top + ab.bottom) / 2, accFont, c.ink));
  }
  for (const bm of geom.beams) {
    const r = rect(c.ink, bm.x, bm.y, bm.w, bm.h);
    r.classes.add("grace-line");
    g.add(r);
  }
  if (geom.hook) {
    const p = stroke(c.ink, geom.hook.width);
    p.moveTo(geom.hook.m[0], geom.hook.m[1]);
    p.cubicTo(...geom.hook.c);
    p.classes.add("grace-line");
    g.add(p);
  }
}

export function paintOrnaments(c: OriginalCtx,
  g: Group,
  ornaments: readonly { name: string; level: number }[],
  x: number,
  baseline: number,
  /** 音符上方堆叠顶（相对基线，含高八度点，见 layout.ts::stackTop）；小节线/增时线上的记号不传 */
  noteTop?: number,
  /** 挂在小节线上时，那条线的墨迹右缘与线顶（页坐标）：`Fine` / `D.S.` 照它右对齐、让开线头 */
  bar?: { right: number; top: number },
  /** 音符头顶和弦/注释那行字的墨迹顶（相对基线）：有的话力度、术语摞到它之上，不压在和弦底下 */
  textTop?: number,
): void {
  const top = noteTop ?? -c.metrics.ink.noteHeight / 2;
  if (ornaments.length === 0) return;
  const m = c.metrics;
  /** 记号带上类名：乐谱字形的奏法记号 `artic`，力度、术语、跳转字 `direction`（成书 line-check 认，`pdflayout/browser.ts::CLS_TAGS`） */
  const add = (it: PageItem, cls: "artic" | "direction"): void => {
    it.classes.add(cls);
    g.add(it);
  };
  let slot = 0;
  for (const orn of ornaments) {
    const y = baseline + m.note.ornamentY - orn.level * m.note.levelStep - slot * 11;

    if (ACCOMP_BRACKET.has(orn.name)) {
      // 伴奏括弧：音符外侧的一个大圆括号
      const isLeft = orn.name === "zkh";
      const h = m.ink.noteHeight * 1.5;
      const bx = x + (isLeft ? -m.ink.noteHeight * 0.62 : m.ink.noteHeight * 0.62);
      const p = stroke(c.ink, 1.4);
      const bend = isLeft ? -4.5 : 4.5;
      p.moveTo(bx, baseline - h / 2);
      p.cubicTo(bx + bend, baseline - h / 4, bx + bend, baseline + h / 4, bx, baseline + h / 2);
      add(p, "artic");
      continue;
    }

    if (orn.name === "hx") {
      // 换气：细笔画的 V 挂在音符右上角（形状与落点走公共那一份，engrave/breath.ts）
      add(breathPath(x, baseline, m.ink.noteHeight, 1.1, c.ink), "artic");
      continue;
    }

    const glyph = ORNAMENTS[orn.name];
    if (glyph) {
      const font = new Font("Bravura", c.digitFont.size * glyph.scale);
      const w = font.measureText(glyph.glyph);
      if (orn.name === "yc" || orn.name === "ycy") {
        // 延长记号按**墨迹**贴着音符堆叠顶（含高八度点）放，净距与减时线、八度点同一个值
        // （metrics.ts::alignNoteMarks）；走 laneOrnament 固定槽位离音符太远（用户口径）。
        const ab = font.charBound(glyph.glyph);
        add(text(glyph.glyph, x - w / 2, baseline + top - noteMarkGap(m) - ab.bottom, font, c.ink), "artic");
      } else {
        add(text(glyph.glyph, x - w / 2, y, font, c.ink), "artic");
      }
      slot += 1;
      continue;
    }

    const dyn = DYNAMICS[orn.name];
    if (dyn) {
      const font = new Font("Bravura", c.digitFont.size * DYNAMIC_SIZE);
      const w = font.measureText(dyn);
      // 按**墨迹**贴着音符那一摞（含高八度点）往上一道空（同延长记号）——固定槽位 `ornamentY` 不随字号走，
      // 数字一大力度就压到数字顶上；小节线、增时线上的（不传 top）照旧走槽位
      const ab = font.charBound(dyn);
      const dy = textTop !== undefined ? baseline + textTop - noteMarkGap(m) - slot * m.ink.noteHeight - ab.bottom
        : noteTop !== undefined && slot === 0 ? baseline + top - noteMarkGap(m) - ab.bottom : y;
      add(text(dyn, x - w / 2, dy, font, c.ink), "direction");
      slot += 1;
      continue;
    }

    const term = TERMS[orn.name];
    if (term) {
      const font = new Font(m.style.font.text.family, m.style.size.chord);
      const ty = textTop !== undefined ? baseline + textTop - noteMarkGap(m) - slot * m.ink.noteHeight : y;
      add(text(term, x - font.measureText(term) / 2, ty, font, c.ink), "direction");
      slot += 1;
      continue;
    }

    const mark = BARLINE_MARKS[orn.name];
    if (mark?.text) {
      const font = new Font(m.style.font.text.family, m.style.size.chord);
      const w = font.measureText(mark.text);
      // **与小节线右对齐**（同简谱引擎 `layout.ts::addDirections`）：居中在线上的话一半压着线，
      // 线头又比数字高，正好戳进字里。基线也不许低于线顶一道空
      if (bar) add(text(mark.text, bar.right - w, Math.min(y, bar.top - noteMarkGap(m)), font, c.ink), "direction");
      else add(text(mark.text, x - w / 2, y, font, c.ink), "direction");
      slot += 1;
    } else if (mark?.glyph) {
      const font = new Font("Bravura", c.digitFont.size * 0.95);
      const w = font.measureText(mark.glyph);
      add(text(mark.glyph, x - w / 2, y, font, c.ink), "direction");
      slot += 1;
    }
  }
}
