// 简谱谱行里的格位（Entry 层）与段落词落位；排版算法在 layout.ts 的 Line。

import { BarlineGlyph, type BarlineSpec } from "../engrave/barline";
import { TimeSigGlyph } from "../engrave/timesig";
import { KeyLabel, keyNameOfFifths } from "../engrave/keysig";
import { beamY, highDotY, lowDotY, stackBottom, stackTop } from "../engrave/stack";
import { augDotCenter } from "../engrave/augdot";
import { articGlyph } from "../engrave/articulation";
import { INVISIBLE } from "./walk";
import { breathPath } from "../engrave/breath";
import { ACCIDENTAL_CLEARANCE, AccidentalGlyph, accidentalKindOf } from "../engrave/accidental";
import { Point, Rect } from "../common/geom";
import { GlyphCodes } from "../smufl/smufl";
import { chordTextSegs, layoutHarmonySegs } from "../engrave/chord";
import { GraceAlter, GraceMetrics, GraceNote, graceAdvance, graceBottom, graceGeometry } from "../engrave/grace";
import type { JChord, JKey, JTime } from "./input";
import { PageItem, GraphicPath, Group, TextFrame, GraphicLine, SmuflText, JpOctaveDot, JpNumber, Lyric, BeamLine } from "./pageitem";
import type { LayoutOptions } from "./options";
import type { Line } from "./layout";

// ---------------- Entry hierarchy ----------------

export abstract class Entry {
  group = new Group();
  selected = false;
  line!: Line;
  /** 这个条目**前面**要先空出多少（倚音那串小号数字就占在这儿）。
   *  `calcXPos` 在给条目定位之前先把游标推过它——不这么做的话，
   *  倚音会贴着主音符往左伸，正好压在前一个音符上。 */
  leadSpace = 0;
  /** 前面**想**多空出的宽（临时记号伸到数字左边那一截）：不占排版宽度，两端对齐时先填给它，见 `Line.adjust`。 */
  leadWant = 0;
  constructor() {
    this.group.classes.add("entry");
  }
  update(): void {
    this.group.update();
  }
  abstract entryItem(): PageItem | null;
  entryWidth(): number {
    return this.entryItem()?.width ?? 0;
  }
}

export class KeySig extends Entry {
  /** 转调标记（「转1=♭B」）的第一个图元：`Group.update` 会把子级整体平移，盒子跟着它走。 */
  private readonly anchor: TextFrame;
  private readonly anchorX: number;
  private readonly anchorY: number;
  /** 建好时的占位盒（文字按字体盒、升降号按墨迹，见 `engrave/keysig.ts`），entry 组坐标。 */
  private readonly box0: Rect;
  constructor(key: JKey, opt: LayoutOptions) {
    super();
    const k = new KeyLabel("1", keyNameOfFifths(key.fifths), {
      font: opt.lrcFont.scaled(0.6),
      music: opt.smuflFont,
      color: opt.color,
      prefix: "转",
      side: opt.accidentalSide,
      classes: ["key-change"], // 见 browser.ts::roleOfItem —— line-check 的 L12 靠它认
    });
    const dx = -k.width / 2;
    const dy = -opt.numberSize;
    for (const it of k.items) {
      it.x += dx;
      it.y += dy;
      it.update();
      this.group.add(it);
    }
    this.anchor = k.items[0] as TextFrame;
    this.anchorX = this.anchor.x;
    this.anchorY = this.anchor.y;
    this.box0 = k.box().offset(dx, dy);
    this.group.data = this;
  }
  /** 转调标记的占位盒，entry 组坐标（上方带堆叠按它判避让）。 */
  get labelBox(): Rect {
    return this.box0.offset(this.anchor.x - this.anchorX, this.anchor.y - this.anchorY);
  }
  entryItem(): PageItem | null {
    return null;
  }
  override entryWidth(): number {
    return 0;
  }
}

export class TimeSig extends Entry {
  hline!: GraphicLine;
  width = 0;
  beats: number;
  beatType: number;
  constructor(beats: number, beatType: number, opt: LayoutOptions) {
    super();
    this.beats = beats;
    this.beatType = beatType;
    this.layout(opt);
    this.group.data = this;
  }
  static fromTime(t: JTime, opt: LayoutOptions): TimeSig {
    return new TimeSig(t.beats, t.beatType, opt);
  }
  entryItem(): PageItem | null {
    return this.hline;
  }
  override entryWidth(): number {
    return this.width;
  }
  layout(opt: LayoutOptions): void {
    const top = opt.jpStaffTop;
    const bot = opt.jpStaffBottom;
    // 尺寸一律按**小节线高度**的比例（见 engrave/timesig.ts::TimeSigGlyph），三条简谱路同一份。
    const r = new TimeSigGlyph(this.beats, this.beatType, {
      height: bot - top,
      centerY: (bot + top) / 2,
      // 分数线的粗细：原书量到的才 0.3pt（比小节线 1.0 还细一半多），
      // 引擎默认的 1.5 是按屏幕上 fontSize≈28 调的，缩到成书字号就成了一道黑杠。
      ruleWidth: opt.timeSigRuleWidth > 0 ? opt.timeSigRuleWidth : 1.5,
      color: opt.color,
      // **与音符同一份字体**（用户口径）。原先 `withBold()`：同一个字族但字重不同，
      // 导出到 .pptx 里就是 YaHei Bold 对 YaHei Regular，一眼看得出拍号比音符黑一档。
      font: opt.numberFont,
      // 0 = 让 TimeSigGlyph 用它自己的默认比例（编辑器/成书两条路不变）。
      // 竖向不在这里给：它只认拍值字号（engrave/timesig.ts::TIME_SIG_GAP_EM）。
      digitRatio: opt.timeSigDigitRatio > 0 ? opt.timeSigDigitRatio : undefined,
      ruleLengthRatio: opt.timeSigRuleLenRatio > 0 ? opt.timeSigRuleLenRatio : undefined,
    });
    // **前后各留一格**（用户口径：「拍号前后要有间距」）。`r.width` 只是分数线的长度，
    // 两个数字本身还比它宽出一点点，于是曲中转拍号紧贴着前一条小节线
    //（144《求圣灵吹我》实测净距 1.75pt）。
    //
    // 前面那一格走 `Entry.leadSpace`（`Line.calcXPos` 在定位之前先加它），**不能靠
    // 把图元整体右移**：`Group.update()` 会把组原点归到子级包围盒的左上角，右移多少
    // 就被吃掉多少。后面那一格加进 `entryWidth()` 即可。
    // 从前 `calcXPos` 里那句 `if (e instanceof TimeSig) curX += it!.height / 5` 恒等于 0
    //——拍号的 `entryItem()` 是**分数线**，横线的 height 就是 0。
    const pad = opt.numberSize / 4;
    this.leadSpace = pad;
    this.width = r.width + pad;
    this.hline = r.rule;
    for (const it of r.items) this.group.add(it);
  }
}

/**
 * 一个音符条目的**左右缘**（相对条目自己的组原点），**不含和弦与表情记号**。
 *
 * 和弦印在音符上方、可以横向伸出音符的范围（原书就这么印的），撞上了另有
 * `Line.spreadChordsHorizontally` 沿 x 让位——把它算进「这一行放不放得下」，
 * 宽和弦（`E♭7` 那种）就会把整句挤到下一行去（446《迦勒看见主》实测从原书的
 * 3 行变成 6 行）。表情记号（`rit.` / `Fine`）同理，它们本来就挂在行上。
 *
 * **`doLineBreak` 与 `naturalSpans` 必须共用这一个**：前者是排版器折行的实际判据、
 * 后者是断句量「一行放得下多少」的尺子，两把尺子不一致的话，断句算得下的行
 * 排版器会再折一刀（行尾挂着孤零零几个音）。
 */
export function entryBounds(g: Group): { left: number; right: number } {
  let lo = Infinity, hi = 0;
  for (const it of g.children) {
    if (it instanceof Group && (it.classes.has("chord-group") || it.classes.has("direction-group"))) continue;
    lo = Math.min(lo, it.x);
    hi = Math.max(hi, it.x + it.width);
  }
  // **左缘也要算**：`Group.update()` 会把组原点归到子级包围盒的左上角，宽和弦往左伸出时
  // 整个条目的原点跟着左移——只挡右缘的话，和弦仍旧从左边溜进这把尺子里
  //（446 的容量因此在纯文本 / 富文本两种和弦下差出一格）。
  return { left: Number.isFinite(lo) ? lo : 0, right: hi };
}

/**
 * 把条目的组原点归到**非标记内容**的左缘（`Group.normalizeX` 的替身）。
 *
 * `normalizeX` / `Group.update()` 都是按**所有**子级的包围盒归一的，和弦往左伸出时
 * 条目原点跟着左移——于是「这一行放不放得下」不管怎么量都掺着和弦：右缘挡住了，
 * 左缘又从原点溜进来（446《迦勒看见主》的容量因此在两种和弦风格下差出一格）。
 * 归到音符内容的左缘之后，和弦组的 `x` 允许为负（照常绘制），横向度量则完全干净。
 */
export function normalizeEntryX(g: Group): void {
  if (!g.children.length) return;
  const { left } = entryBounds(g);
  if (left === 0) return;
  for (const it of g.children) it.x -= left;
  g.x += left;
}

/** `Note.jpAlter` → 公共倚音几何的升降号名。空格（没有临时记号）不在表里。 */
const GRACE_ALTER: Record<string, GraceAlter | undefined> = {
  "#": "sharp",
  b: "flat",
  n: "natural",
};

/** 倚音升降号用的 SMuFL 字形，与主音那一套同源（`addAccidental`）。 */
const GRACE_ALTER_GLYPH: Record<GraceAlter, string | undefined> = {
  sharp: GlyphCodes.accidentalSharp,
  flat: GlyphCodes.accidentalFlat,
  natural: GlyphCodes.accidentalNatural,
  "double-sharp": undefined,
  "double-flat": undefined,
};

/** 简谱这一路的倚音度量——折算成公共几何要的那几个数（见 engrave/grace.ts）。 */
function graceMetricsOf(opt: LayoutOptions): GraceMetrics {
  const bnd = opt.numberBound("1");
  return {
    ink: bnd.height,
    // 原书 260/264 两页实测：倚音数字墨迹高 4.82~5.00、正常音符 8.33 → 0.58~0.60
    scale: opt.graceScale,
    octaveUpY: bnd.top - opt.stack.gap,
    octaveDownY: opt.jpDotRung,
    octaveDotGap: opt.jpDotRung,
    octaveDotRadius: opt.numberFont.size * 0.06,
    underlineGap: opt.stack.gap + opt.jpBeamWidth,
    stackGap: opt.stackGap,
  };
}

export class NoteEntry extends Entry {
  chord!: JChord;
  verse = 0; // repeat pass / lyric verse this rendered entry belongs to
  lrc: Lyric | null = null;
  /** 叠排时这个音符底下的各段歌词（lrc 是其中第一段，供既有的宽度/链表逻辑用）。 */
  lrcs: Lyric[] = [];
  number: JpNumber | null = null;
  accidental: TextFrame | null = null;
  beams = 0;
  octaveDot: JpOctaveDot[] = [];
  notations: SmuflText[] = [];

  constructor() {
    super();
    this.group.data = this;
  }
  get jpOctave(): number {
    return this.chord.notes[0].jpOctave;
  }
  get numberPos(): number {
    return this.number!.numberPos;
  }
  /** 和弦符号：排在音符正上方（以数字墨迹中心对齐）。
   *  富文本分段（根音升降号走 SMuFL、后缀上标）复用 engrave/chord.ts，与五线谱、文本谱同一套。 */
  static addHarmony(ch: JChord, opt: LayoutOptions, ent: NoteEntry, num: JpNumber, text = ch.harmony): void {
    if (!text || opt.chordSize <= 0) return;
    const wordFont = opt.numberFont.makeWithSize(opt.chordSize);
    const musicFont = opt.smuflFont.makeWithSize(opt.chordSize);
    const g = layoutHarmonySegs(chordTextSegs(text, opt.chordPlainText, opt.accidentalSide), wordFont, musicFont, opt.color);
    g.classes.add("chord-group"); // 段落词要按它的位置让路，见 Line.addSectionWords
    g.ident = { kind: "harmony" };
    g.update();
    g.x = num.x + num.cx - g.width / 2;
    // 挂在这个音符**已有内容的栈顶**之上（八度点已经加过了），不是固定高度——
    // 否则带高音点的音符上，和弦会压到点上。原书的 chordGap 就是量的这个净距。
    //
    // 和弦一律**按基线对齐**（同一行的和弦要齐平），不能按墨迹顶或底摆：
    // 带升降号的那些用 Bravura 的 csym 字形，em 框比字母高得多，按墨迹摆会比邻近的
    // 和弦高出十来个点。`g.update()` 之后 `g.y` 正好是「墨迹顶相对基线」的偏移，
    // 所以这里**累加**目标基线，而不是赋值。
    // 基准是音符的**墨迹顶**，不是 -numberSize（那是字号，Times 的数字墨迹只占 0.66em，
    // 拿字号当墨迹顶会把和弦白白多抬三四个点）。原书量的 chordToNote 也是
    // 「音符墨迹顶 − 和弦基线」（stats.ts: noteTop − baselineY），两边口径必须一致。
    const inkTop = opt.numberBound("1").top;
    const top = Math.min(inkTop, ent.group.childrenBound.top);
    g.y += top - opt.chordGap;
    ent.group.add(g);
  }

  addAccidental(tf: TextFrame): void {
    this.accidental = tf;
    this.group.add(tf);
  }
  add(item: JpNumber | Lyric): void {
    if (item instanceof JpNumber) {
      this.number = item;
      this.group.add(item);
    } else {
      if (this.lrc === null) this.lrc = item;
      this.lrcs.push(item);
      this.group.add(item);
    }
  }
  get left(): number {
    return this.number !== null ? this.number.left : 0;
  }
  get cx(): number {
    return this.number!.x + this.number!.cx;
  }
  get right(): number {
    return this.number?.right ?? 0;
  }
  entryItem(): TextFrame | null {
    return this.number;
  }
  get beginOfSlurTied(): boolean {
    if (this.chord.slurStart) return true;
    if (this.chord.notes[0].tieStart) return true;
    return false;
  }
  get endOfSlurTied(): boolean {
    if (this.chord.slurEnds > 0) return true;
    if (this.chord.notes[0].tieEnd) return true;
    return false;
  }
  /** 数字墨迹顶加它上面那摞高音点的墨迹顶——叠层的顶（engrave/stack.ts），弧与连音接着往上排。 */
  entryTop(opt: LayoutOptions): number {
    return stackTop(opt.numberBound("1").top, this.chord.notes[0].jpOctave, opt.stack);
  }
  /** 数字**加它上面那摞八度点**的墨迹顶（倚音贴着它摆）。与 `entryTop` 同一个数。 */
  stackInkTop(opt: LayoutOptions): number {
    return this.entryTop(opt);
  }
  /** 弧 / 延音线落在哪：叠层顶再让一个 `jpStackGap`。 */
  slurRung(opt: LayoutOptions): number {
    return this.entryTop(opt) - opt.jpStackGap;
  }
  /** 叠层的底：数字墨迹底 → 减时线 → 低音点（engrave/stack.ts）。 */
  entryBottom(options: LayoutOptions): number {
    const oct = this.chord.notes[0].jpOctave;
    return stackBottom(options.numberBound("1").bottom, this.chord.beams, Math.max(0, -oct), options.stack);
  }

  /** 临时记号：画法与定位走公共那一份（engrave/accidental.ts，样子由 `accidentalStyle` 选）。
   *  这会儿数字在条目组里还在原点（笔位 0、基线 0）。 */
  static addAccidental(it: JpNumber, options: LayoutOptions, ch: JChord, ent: NoteEntry): void {
    const kind = accidentalKindOf(ch.notes[0].jpAlter);
    if (!kind) return;
    const acc = new AccidentalGlyph(kind, { font: options.noteFont, text: it.text, x: it.x, y: it.y }, {
      music: options.smuflFont,
      color: options.color,
      meta: options.smuflMeta,
      kind: options.accidentalStyle,
      scale: options.accidentalScale,
    });
    ent.addAccidental(acc.item);
    // 给它让位要「软」的（`Entry.leadWant`）：升降号伸出数字笔位左边多少、再多留一道空，由 `Line.adjust`
    // 两端对齐时**先**填给它；行已排满就不硬挤——`.jpwabc` 的行是原文定死的，硬让会把行末挤到下一行去。
    // `classic`（成书照原书）原先就不让位，保持原样。
    if (options.accidentalStyle !== "classic") {
      ent.leadWant = Math.max(0, it.x - acc.box.left) + options.numberBound("1").height * ACCIDENTAL_CLEARANCE;
    }
  }
  /** 八度点：落点走公共那一份（engrave/stack.ts，墨迹到墨迹等距；低音点挂在减时线之下）。 */
  static octaveDot(ch: JChord, options: LayoutOptions, ent: NoteEntry): void {
    const oct = ch.notes[0].jpOctave;
    const numBound = options.numberBound("1");
    const st = options.stack;
    for (let d = 0; d < Math.abs(oct); d++) {
      const r = options.jpDotRadius;
      const tf = new JpOctaveDot(r, options.color);
      // 圆的局部包围盒就是墨迹本身（(0,0)–(2r,2r)），圆心往上退一个半径就是 y
      const cy = oct >= 0 ? highDotY(numBound.top, d, st) : lowDotY(numBound.bottom, ch.beams, d, st);
      tf.y = cy - r;
      ent.group.add(tf);
      ent.octaveDot.push(tf);
    }
  }
  static addLyric(ch: JChord, options: LayoutOptions, ent: NoteEntry, it: JpNumber, lrc: number): void {
    // 叠排：这个音符底下把各段歌词一行行摞起来（原书的排法）。段序按 lyric.number。
    const stack = options.lyricStack > 0;
    const all = stack
      ? [...ch.notes[0].lyrics].sort((a, b) => a.number - b.number)
      : ch.notes[0].lyrics;
    let row = 0;
    for (const l of all) {
      if (!stack && !l.refrain) {
        if (l.number !== lrc) continue;
      }
      let text = l.text;
      if (options.ignoreVerseNumber) {
        for (let idx = 0; idx < l.text.length; idx++) {
          const _ch = l.text[idx];
          if ((_ch >= "0" && _ch <= "9") || _ch === ".") {
            // skip leading verse number/dot
          } else {
            text = l.text.substring(idx);
            break;
          }
        }
      }
      const lit = new Lyric();
      lit.font = options.lrcFont;
      lit.y = 1.0 * options.numberFont.size + (stack ? row * options.lyricStack : 0);
      row++;
      lit.compress = options.punctCompress;
      lit.text = text;
      lit.color = options.color;
      lit.verse = l.number;
      lit.ident = { kind: "syllable", verse: l.number };
      lit.update();
      // 对到数字的落笔点：前面有倚音时主音已右移了 `leadSpace`（`addGraceNotes`），不加 `it.x` 歌词就留在倚音底下
      lit.x = it.x + it.left - lit.left;
      ent.add(lit);
    }
  }
  /**
   * **倚音**（`Chord.graceNotes`）：主音符左边的小号数字 + 减时线 + 连接钩。
   *
   * **几何走公共那一份**（`engrave/grace.ts`）——文本谱那条路
   * （`layout/original/compose/note.ts::paintGrace`）用的是同一套比例（照原版矢量量的），两边各自落笔。
   * 占位走 `Entry.leadSpace`：倚音在拍点**之前**唱，位置也该在主音符之前，
   * 直接往左伸会压住上一个音符。
   */
  static addGraceNotes(ch: JChord, options: LayoutOptions, ent: NoteEntry, main: JpNumber): void {
    if (!ch.graceNotes.length) return;
    const gm = graceMetricsOf(options);
    const size = options.numberFont.size * gm.scale;
    const font = options.noteFont.makeWithSize(size);
    // 公共几何按「主音数字的墨迹中心 x、基线 y」定位；这里先摆在原点，稍后整体右移。
    //
    // **倚音整组的底缘贴着主音的墨迹顶**（用户口径：「倚音底部对齐正常音符顶部」）。
    // 最低的那一笔不一定是数字——减时线在数字之下，连接钩还要再往下垂一截，
    // 有低音点时低音点更低。所以先按 `centerY = 0` 排一遍量出底缘，再回填真正的 centerY。
    // 摆的基准是 `stackInkTop`（数字加高音点那一摞的墨迹顶），不是 `entryTop`：
    // 后者在旧式档里是「上方那一带的底」，比墨迹顶还高出一格。
    const notes: GraceNote[] = ch.graceNotes.map((g) => ({
      digit: g.number,
      octave: g.jpOctave,
      duration: g.duration ?? 8,
      ...(GRACE_ALTER[g.jpAlter] ? { alter: GRACE_ALTER[g.jpAlter]! } : {}),
    }));
    const probe = graceGeometry(notes, gm, 0, 0, -1, options.numberFont.size, 0);
    // 整块倚音的墨迹底离主音那一摞的顶**一道空**（叠层的空，与原样文档、混排同一条规则）
    const centerY = ent.stackInkTop(options) - options.stack.gap - graceBottom(probe, gm);
    const geom = graceGeometry(notes, gm, 0, 0, -1, options.numberFont.size, centerY);
    const lead = graceAdvance(notes, gm);
    // 主音符右移，给倚音腾地方；游标也要跟着推（不然倚音会压上一个音符）
    main.x += lead;
    ent.leadSpace = lead;
    const ox = main.x + main.cx; // 倚音那一串相对主音墨迹中心排
    for (const d of geom.digits) {
      const it = new JpNumber();
      it.classes.add("grace");
      it.color = options.color;
      it.text = d.text;
      it.font = font;
      it.update();
      // 公共几何给的是**墨迹中心**，换算成落笔点与基线
      const cb = font.charBound(d.text);
      it.x = ox + d.cx - (cb.left + cb.right) / 2;
      it.y = d.cy - (cb.top + cb.bottom) / 2;
      ent.group.add(it);
    }
    // 八度点与主音同一套画法（实心圆），只取公共几何算好的位置。
    // 半径用 graceMetricsOf 里那个倚音专用的 `octaveDotRadius`（比主音的小）。
    for (const o of geom.dots) {
      // 半径用公共几何算好的那个（倚音专用，比主音小；`GraceGeom.dots[].r`）
      const r = o.r;
      const dot = new JpOctaveDot(r, options.color);
      dot.x = ox + o.cx - r;
      dot.y = o.cy - r;
      ent.group.add(dot);
    }
    // 升降号：与主音同一套 SMuFL 字形（`addAccidental`），但**按墨迹摆**——
    // 公共几何给的是墨迹右缘、竖向中心与墨迹高，字号由墨迹高反推（主音那边用的是
    // 固定的 0.8 缩放 + 常数偏移，倚音这么小，一点漂移就骑到左边那颗上）。
    for (const acc of geom.accidentals) {
      const smufl = GRACE_ALTER_GLYPH[acc.alter];
      if (!smufl) continue;
      const tf = new SmuflText(options);
      tf.color = options.color;
      if (options.smuflAsPath) tf.asPath = true;
      tf.text = smufl;
      const b0 = tf.bound;
      const h0 = b0.bottom - b0.top;
      if (h0 > 0) tf.font = options.smuflFont.makeWithSize(options.smuflFont.size * (acc.inkHeight / h0));
      const b = tf.bound;
      tf.x = ox + acc.inkRight - b.right;
      tf.y = acc.inkCy - (b.top + b.bottom) / 2;
      ent.group.add(tf);
    }
    for (const bm of geom.beams) {
      const ln = new GraphicLine();
      ln.classes.add("grace-line");
      ln.strokeColor = options.color;
      ln.strokeWidth = bm.h;
      ln.x = ox + bm.x;
      ln.y = bm.y + bm.h / 2;
      ln.p0 = new Point(0, 0);
      ln.p1 = new Point(bm.w, 0);
      ent.group.add(ln);
    }
    if (geom.hook) {
      const path = new GraphicPath();
      path.classes.add("grace-line");
      path.fill = false;
      path.stroke = true;
      path.strokeColor = options.color;
      path.strokeWidth = geom.hook.width;
      const [mx, my] = geom.hook.m;
      const c = geom.hook.c;
      path.moveTo(ox + mx, my);
      path.cubicTo(ox + c[0], c[1], ox + c[2], c[3], ox + c[4], c[5]);
      ent.group.add(path);
    }
  }

  /** 音符自己的记号（fermata / 重音）落在哪条线上：音符墨迹栈顶之上一格，
   *  **临时升降号也要让开**——它印在数字左上角，比数字墨迹顶还高（470《出到营外》
   *  那几个重音因此贴在升号上）。`addNotations` 跑在 `ent.update()` 之前，
   *  这会儿子级坐标还是「相对基线」那一套，没归一化过。 */
  private static notationTop(options: LayoutOptions, ent: NoteEntry): number {
    let y = ent.slurRung(options);
    const accTop = ent.accidentalTop();
    // 与升降号之间留宽一点（1.6 格）：那个 `#` 本来就斜挎在数字左上角，
    // 只留一格的话 `>` 看着像挂在它身上（470《出到营外》）。
    if (accTop !== null) y = Math.min(y, accTop - options.jpStackGap * 1.6);
    return y;
  }

  /** 临时记号的墨迹顶，相对数字基线（`update()` 前组原点就在基线上；之后子级归一、组原点挪到 `group.y`，
   *  加回去仍是相对基线——行坐标里数字基线在 0）。没有临时记号返回 null。 */
  accidentalTop(): number | null {
    const acc = this.accidental;
    if (!acc) return null;
    const sc = Math.abs(acc.matrix.scaleY) || 1;
    const top = acc instanceof SmuflText ? -acc.bound.bottom : acc.bound.top;
    return this.group.y + acc.y + top * sc;
  }

  static addNotations(ch: JChord, options: LayoutOptions, ent: NoteEntry): void {
    if (ch.fermata) {
      const t = new SmuflText(options);
      t.color = options.color;
      t.classes.add("artic"); // line-check 的 V12 靠它认（见 browser.ts::CLS_TAGS）
      t.ident = { kind: "deco" };
      t.text = articGlyph("fermata", true);
      // Same ladder as the octave dots / slur (musicpp render.cpp:349-355 uses
      // `y -= dot*7` plus a flat -10 over a slur; both collapse to one rung).
      // 压不压弧交给上方带堆叠统一算（Line.stackAbove）——从前这里自己按
      // 「这个音符是不是弧的端点」抬一整格 `jpDotRung`，与堆叠叠加就抬了两回。
      t.y = NoteEntry.notationTop(options, ent);
      t.x += ent.number!.x + ent.number!.cx;
      t.x -= t.bound.width / 2;
      ent.group.add(t);
      ent.notations.push(t);
    }
    // 奏法记号（重音、顿音、保持音…）。与 fermata 同一带，堆叠时一起算（layer 0）：同一个音上
    // 几个记号先都落在同一条线上，撞上的由上方带逐个往上抬（`Line.stackAbove`）。
    // 换气不进这一带：它是挂在音符右上角的 V（engrave/breath.ts），不压在数字正上方。
    for (const a of ch.articulations) {
      if (a === "breath") {
        const H = options.numberBound("1").height;
        ent.group.add(breathPath(ent.number!.x + ent.number!.cx, 0, H, H * 0.07, options.color));
        continue;
      }
      const glyph = articGlyph(a, true);
      if (!glyph) continue;
      const t = new SmuflText(options);
      t.color = options.color;
      t.classes.add("artic");
      t.ident = { kind: "deco" };
      t.text = glyph;
      t.y = NoteEntry.notationTop(options, ent);
      t.x += ent.number!.x + ent.number!.cx;
      t.x -= t.bound.width / 2;
      ent.group.add(t);
      ent.notations.push(t);
    }
  }
  /**
   * 附点 —— **一个实心矢量圆**（三条简谱路统一，见 `engrave/dot.ts`；八度点、反复点同理）。
   * 大小默认照字体里那个 `·`（`jpAugDotRadius`），展开档把它与八度点设成同一个值。
   *
   * **advance 照旧留给附点**（`JpNumber.augDotAdvance`）：横向间距走 `JpNumber.right`，
   * 把 `·` 从文本里摘掉而不补回它的 advance，带附点的音符就会与后一个音符贴到一起。
   */
  static addAugDots(num: JpNumber, opt: LayoutOptions, dots: number, ent: NoteEntry): void {
    const font = opt.noteFont;
    const adv = font.measureText("·");
    const r = opt.jpAugDotRadius;
    // 落点走公共那一份（engrave/augdot.ts）：圆心与数字墨迹中心等高；第一个点离数字墨迹右缘一道空
    //（叠层那道空），点与点之间也是一道空。占位照旧按 `·` 的 advance 留（`augDotAdvance`）。
    const last = num.text[num.text.length - 1] ?? "0";
    const ink = font.charBound(last).offset(num.measureText(0, num.text.length - 1), 0);
    const gap = opt.stack.gap;
    for (let d = 0; d < dots; d++) {
      const { cx, cy } = augDotCenter(ink, d, r, gap);
      const dot = new JpOctaveDot(r, opt.color);
      dot.x = cx - r;
      dot.y = cy - r;
      dot.aug = { num, index: d };
      dot.classes.add("aug-dot"); // 可视化编辑单独点选附点（`ScorePainter.partEls`）
      dot.ident = { kind: "aug-dot" };
      ent.group.add(dot);
    }
    num.augDotAdvance = adv * dots;
    num.update();
  }

  static fromChord(res: Entry[], ch: JChord, lrc: number, options: LayoutOptions): void {
    let ent = new NoteEntry();
    ent.beams = ch.beams;
    ent.chord = ch;
    ent.verse = lrc;
    if (ch.id !== null) ent.group.ident = { kind: "note", id: ch.id, pass: lrc };
    let it = new JpNumber();
    it.color = options.color;
    it.text = ch.notes[0].number;
    it.font = options.noteFont;
    if (ch.hidden) it.classes.add(INVISIBLE); // 不可见休止 `x`：照 0 占位，不印
    ent.add(it);
    NoteEntry.addAccidental(it, options, ch, ent);
    if (ch.beats <= 1 && ch.dot > 0) NoteEntry.addAugDots(it, options, ch.dot, ent);
    NoteEntry.addGraceNotes(ch, options, ent, it);
    NoteEntry.octaveDot(ch, options, ent);
    NoteEntry.addLyric(ch, options, ent, it, lrc);
    NoteEntry.addNotations(ch, options, ent);
    NoteEntry.addHarmony(ch, options, ent, it);
    ent.update();
    res.push(ent);
    for (let i = 1; i < ch.beats; i++) {
      ent = new NoteEntry();
      ent.chord = ch;
      ent.verse = lrc;
      // 增时线格不带自己的 id（`.jpwabc` 的 `-` 写在音符 token 里）：用宿主的 id，按序数认
      if (ch.id !== null) ent.group.ident = { kind: "sustain", id: ch.id, pass: lrc };
      const num = ch.rest ? "0" : "-";
      it = new JpNumber();
      it.text = num;
      it.color = options.color;
      it.font = options.noteFont;
      if (ch.hidden) it.classes.add(INVISIBLE);
      ent.add(it);
      // 长音中途换的和弦印在对应那条增时线上
      NoteEntry.addHarmony(ch, options, ent, it, ch.sustainHarmonies?.[i - 1] ?? null);
      ent.update();
      res.push(ent);
    }
  }
}

/** 小节线的样子：粗细组合 + 反复点。与五线谱同一套画法（`‖:` 点在右、`:‖` 点在左）。 */
export class Barline extends Entry {
  /** The vertical strokes, kept so `clipBarlinesUnderSlurs` can shorten them. */
  readonly lines: GraphicLine[] = [];
  /** 是不是「一条普通细线」（没有反复点、没有粗线）——`‖:` 会把紧挨着的这种吃掉。 */
  isPlain = false;
  readonly defaultTop: number;
  private readonly bot: number;

  /** 建这条线时用的 spec（`dropDoubledBarlines` 要拿它判断能不能把两条并成一条）。 */
  readonly spec: BarlineSpec;

  /** 这条线画在挨着的那个音符**之前**（小节开头的 `‖:`）还是**之后**（小节末的线）。
   *
   *  小节线在模型里**没有自己的 `ElementId`**（`model/doc.ts` 的 `Barline` 只有样式与 `source`），
   *  可视化编辑要点中它就得有个键，口径与 `editor/sync.ts::addPartExtras` 一致：借挨着的那个音符的 id。
   *  借哪一个由 `ScorePainter` 遍历页面树时按前后顺序定（那里才看得到跨小节、跨行的相邻关系），
   *  这里只记是哪一侧（同时写进身份标签，`scoreindex.ts` 按树序借 id）。**排版不读它**。 */
  get ownerEdge(): "before" | "after" {
    return this.group.ident?.edge ?? "after";
  }
  set ownerEdge(edge: "before" | "after") {
    this.group.ident = { kind: "barline", edge };
  }

  constructor(final: boolean, opt: LayoutOptions, spec: BarlineSpec = {}) {
    super();
    this.spec = spec;
    this.group.data = this;
    this.group.ident = { kind: "barline", edge: "after" };
    const top = opt.jpStaffTop;
    const bot = opt.jpStaffBottom;
    this.defaultTop = top;
    this.bot = bot;
    // 粗细组合、反复点、间距一律走公共那一份（engrave/barline.ts）——文本谱也用它。
    const r = new BarlineGlyph(spec, final, {
      top,
      bot,
      light: opt.barlineWidth, // musicpp lineWidths.lightBarline (pptutil.cpp:139)
      heavy: opt.finalBarlineWidth,
      dotRadius: opt.repeatDotRadius,
      color: opt.color,
    });
    for (const it of r.items) this.group.add(it);
    this.lines.push(...r.lines);
    this.isPlain = r.isPlain;
    this.group.update();
  }

  /** 小节线**墨迹**的左右缘（相对本 entry 的组原点）。
   *
   *  `group.x` 不是线的位置：`:‖` 会先画反复点再画线，两者差着 `dotR × 2 + dotGap`
   *  （实测 4.8pt）。房号横线要贴着小节线画，拿 `group.x` 当线位就会短一截
   *  （158《一件礼物》的一房终点差了 4.3pt，看着没对齐）。 */
  get inkLeft(): number {
    const f = this.lines[0];
    return f ? f.x - f.strokeWidth / 2 : 0;
  }
  get inkRight(): number {
    const l = this.lines[this.lines.length - 1];
    return l ? l.x + l.strokeWidth / 2 : 0;
  }
  /** 第一根 / 最后一根线的线位（线心，相对本 entry 的组原点）。房号的竖脚对齐它们。 */
  get firstLineX(): number {
    return this.lines[0]?.x ?? 0;
  }
  get lastLineX(): number {
    return this.lines[this.lines.length - 1]?.x ?? 0;
  }


  /**
   * Lower the top edge so the barline stops below a slur/tie crossing it.
   * Only ever shortens; a `top` above `defaultTop` is ignored.
   *
   * Works on the post-`update()` representation: `Group.update()` has already
   * folded each line's p0 into the group's y and left the children at y=0 with
   * p1 holding the length, so trimming means moving the group down and
   * shortening p1 by the same amount. (Re-assigning p0 instead would be folded
   * in a *second* time by GraphicLine.update(), which both moves and lengthens
   * the stroke.)
   */
  /** 小节线占多宽 —— **要把整组算进去**（粗细两条线、反复点都在 group 里）。
   *  基类只看 `entryItem()`（第一条竖线），于是 `‖:` 右边那两个反复点没有占位，
   *  后面的音符直接压上来（037 第三行的 `‖:5` 里点与 5 叠在一起）。 */
  override entryWidth(): number {
    return this.group.width;
  }

  clipTop(top: number): void {
    const y = Math.max(this.defaultTop, Math.min(top, this.bot));
    const dy = y - this.group.y;
    if (dy <= 0) return;
    for (const l of this.lines) {
      l.p1 = new Point(l.p1.x, l.p1.y - dy);
      l.height = Math.abs(l.p1.y);
    }
    this.group.y += dy;
    this.group.height -= dy;
  }
  entryItem(): PageItem | null {
    // **可能一个子级都没有**：`<bar-style>none</bar-style>` 的小节线什么也不画
    //（见 engrave/barline.ts::barlineWidths），`children[0]` 就是 undefined——
    // 不收成 null 的话 `calcXPos` 里那句 `if (it !== null) x = it.x` 会直接崩。
    return this.group.children[0] ?? null;
  }
}

export class LineBreak extends Entry {
  newPage = false;
  constructor() {
    super();
    this.group.width = 0;
    this.group.height = 0;
    this.group.data = this;
  }
  entryItem(): PageItem | null {
    return null;
  }
}

/** 简谱引擎的一条减时线：两端对到两个音符数字（`lev` 从 1 起）。 */
export function beamLineOf(lev: number, l: NoteEntry, r: NoteEntry, opt: LayoutOptions): BeamLine {
  const grp = l.line.group;
  const x0 = l.entryItem()!.pos(grp).x;
  const x1 = r.entryItem()!.pos(grp).offset(r.numberPos, 0).x;
  // 落点走公共那一份（engrave/stack.ts，墨迹到墨迹等距）
  const y = beamY(opt.numberBound("1").bottom, lev, opt.stack);
  return new BeamLine(lev, x0, x1, y, opt.jpBeamWidth, opt.color, l.number, r.number);
}

export class EntryItemInfo {
  dist = 0;
  rate = 0;
  entry: Entry | null = null;
}


