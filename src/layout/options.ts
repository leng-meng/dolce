import type { HeaderFonts } from "../style/header";
import { Font } from "./font";
import { MetaData } from "../smufl/smufl";
import { Rect, Colors } from "../common/geom";
import type { CompressMode } from "../common/cjkpunct";
import type { AccidentalSide, AccidentalStyleKind } from "../engrave/spacing";
import { STACK_GAP_DEFAULT, type StackStyle } from "../engrave/stack";

/** 「原样」档多段歌词叠排时的段间行距 ÷ 歌词字号。原书量到的是 1.3 上下。 */
export const LYRIC_STACK_RATIO = 1.35;

// ---------------- options / CJK util ----------------

export class LayoutOptions {
  color = Colors.black;
  lrcFont: Font;
  numberFont: Font;
  /**
   * 音符数字是否加粗。**只管数字与倚音**——`numberFont` 还派生出和弦、房号、
   * 调号拍号那一行，那些不跟着粗，所以这里是个开关而不是把 `numberFont` 换成粗体。
   * 展开档（`style/jianpu.ts` 的 `pptx` 预设）与成书排版（`style/book.ts::applyBookPreset`）关掉：前者是投影的既有观感、
   * 后者要逐像素复刻印刷底本，都不能凭空变粗。
   */
  noteBold = true;
  smuflFont: Font;
  smuflMeta = new MetaData();
  titleSize = 48;
  creditSize = 36;

  smuflAsPath = false;
  /** 和弦符号的字号与它到音符墨迹上缘的距离。0 = 不排和弦（默认：编辑器与 OMR 那两条路
   *  的引擎输入里本来就没有 harmony，排了也不会变，但留一道闸更明确）。 */
  chordSize = 0;
  /** 段落词（「（副歌）」）的字号。0 = 不排（编辑器与 OMR 那两条路的引擎输入里没有这东西）。 */
  sectionWordSize = 0;
  chordGap = 0;
  /** 歌词基线到音符基线的距离。0 = 用引擎自算的（贴着音符下方的减时线/低音点）。
   *  成书排版给原书量到的定值，让每一行的歌词都排在同一高度上；
   *  某一行的栈比它还深时仍按栈走（**只放大不缩小**，不会压到减时线上）。 */
  lyricBaselineGap = 0;
  /** 相邻歌词字之间的**最小间隙**。0 = 字紧挨着字（引擎老行为：只保证不重叠）。
   *  印刷歌本的歌词字之间是有呼吸的（原书量到的步距 ≈ 字宽 × 1.32），
   *  不留这道间隙，排版器会以为一行塞得下三十几个字、把整段挤成密不透风的一行
   *  （001《圣哉，圣哉，圣哉》曾因此排成 2 行、字距 9.1pt 小于 11.8pt 的字宽）。 */
  lyricGap = 0;
  /** 反复点的半径。0 = 按小节线宽推算。成书排版给原书量到的值（metrics.repeatDotDiam）。 */
  repeatDotRadius = 0;
  /** 八度点（实心圆）的半径。0 = 按数字字体里 `.` 字形的**墨迹高**折半推算——
   *  纵向栅格是墨迹到墨迹量的（见《简谱纵向栅格》），取墨迹高才能与原来的字形等大。 */
  octaveDotRadius = 0;
  /** 附点（实心圆）的半径。**0 = 与八度点同大**（`jpDotRadius`）。
   *  附点一律是矢量圆、且圆心与数字墨迹的中心等高，见 `NoteEntry.addAugDots`。 */
  augDotRadius = 0;
  /** 和弦排成**纯文本**（升降号不换 SMuFL 的 csym 字形、后缀不上标）。
   *  原书 500 首就是这么印的，成书重排由 `style/book.ts::applyBookPreset` 打开；
   *  编辑器 / 五线谱 / 文本谱三路维持富文本排法。见 engrave/chord.ts。 */
  chordPlainText = false;
  /** 调号、转调、和弦根音/低音的升降号写在字母前还是后；undefined = 各自原来的写法。样式键 `accidental-side`。 */
  accidentalSide: AccidentalSide | undefined = undefined;
  /** 临时记号的样子（`engrave/spacing.ts::AccidentalStyleKind`）。样式键 `accidental-style`；成书缺省 `classic`。 */
  accidentalStyle: AccidentalStyleKind = "csym";
  /** `csym` 临时记号的大小倍数（1 = 照混排）。样式键 `accidental-scale`；展开档的 pptx 预设取小一号。 */
  accidentalScale = 1;
  /** 房号（1./2.）的字号。0 = 不画房号（展开档：反复已逐遍展开）。原样档与成书由样式层给值。 */
  endingSize = 0;
  /** 歌词段号（行首的 `1.` `2.`）标不标：
   *  `always` 一律标（编辑器那条路的老行为）、`never` 一律不标、
   *  `auto` = 段数多于 `verseNumberAutoMin` 才标。 */
  verseNumbers: "always" | "never" | "auto" = "always";
  /** `auto` 的门槛：段数**多于**这个数才标段号。默认 3（三段以内不标）。 */
  verseNumberAutoMin = 3;
  /** 转拍号那条分数线的粗细。0 = 用引擎默认的 1.5（编辑器那条路不变）。 */
  timeSigRuleWidth = 0;
  /** 拍号的两个比例（都是 ÷ 小节线高度 H）。0 = 用 `engrave/timesig.ts::TIME_SIG_DEFAULTS`。
   *  单独提出来是因为 H 一变（见 `jpStaffTopOverride`），照默认比例算出来的拍号会跟着
   *  整体缩放。**竖向没有旋钮**：上下两个数字各离分数线一格「减时线与音符」的距离，
   *  只认拍值字号（`engrave/timesig.ts::TIME_SIG_GAP_EM`）。 */
  timeSigDigitRatio = 0;
  timeSigRuleLenRatio = 0;
  /** 房号/三连音括线的线宽与「脚」（下垂那一小段）的长度。0 = 按字号推算。 */
  bracketWidth = 0;
  bracketFoot = 0;
  /** 三连音的画法：`bracket` = 括线（两端下垂脚、数字坐在横线断口里）；`arc` = **两段弧**——
   *  同页 slur 那条月牙挖掉中段、数字坐在断口里（音符端收尖，见 `SlurStyle.gap`）。
   *  两种都与弧同属上方带 layer 0 参与堆叠（`Line.stackAbove`）。 */
  tupletStyle: "bracket" | "arc" = "bracket";
  /** 多段歌词的排法：0 = **逐段重复整条谱行**（jpword/musicpp 的老行为，流行敬拜谱常见）；
   *  >0 = **一行谱下叠多行词**（传统圣诗本的排法，原书 500 首就是这样），值为段间行距。
   *  只在「无反复、纯多段」（PlayData.isSimpple）的曲子上生效——有反复房号的谱
   *  每一遍的谱面本来就不同，叠不到一起。 */
  lyricStack = 0;
  /** **一张连续长纸**：不按纸张高度分页，所有谱行首尾相接排成一页（高度由内容定）。
   *  「原样」档走它——那一档是「原样展示」，与文本谱的「原版」同一种观感；
   *  展开档仍按 16:9 的纸分页。见 `Line.layoutVertically` 与 `jianpupages.ts::layoutOriginalPages`。 */
  continuousPage = false;
  /** 标题与词曲**排在第一页的顶上**（印刷歌本的排法），而不是另起一张标题页。
   *  「原样」档走它——长图那一档由 `continuousPage` 隐含，分页那一档靠这个字段。
   *  展开档仍是标题页独占第一屏。见 `jianpupages.ts::layoutOriginalPages`。 */
  bookHead = false;
  /** 源里的行有放不下的就**整首重新断行**（只在小节线处断、各行长度尽量均匀，见 `Line.reflowBreak`）。
   *  原样档开（`style/jianpu.ts::applyOriginalPreset`，长图与分页纸同宽）：窄纸照原文的行排会出半截短行。 */
  reflowOverflow = false;
  /** 第一页顶部为标题块预留的高度。分页时首页可用高度按它扣减、首页各行整体下移。
   *  由 `jianpupages.ts::layoutOriginalPages` 量出 `bookHead` 的实际高度后填，**不是给人配的**。 */
  firstPageHeadroom = 0;
  /** 歌词标点挤压的档（见 common/cjkpunct.ts::CompressMode）。
   *
   *  默认 `halfwidth`：**简谱歌词的标点不占音符格**，原书印的就是压缩形。
   *  换成 CLREQ 的上下文挤压（孤立标点占满一格）会把音符间距整排撑开——
   *  实测全书 655 → 695 页，定点断言里 459/363/355/446 的规整分行全都排不出来。
   *  中文**正文**（注解、目录、索引、前言）不受此限，那条路走 `clreq`，见 bookparts.ts。
   *
   *  **原来这里是 `halfWidthPunct = true`**：把 `。，、？！：；` 换成 U+FF61 系半角**字符**。
   *  字符替换的账很难算——印刷字库多半没有那些码位（PDF 端要换回全角、line-check 的 V2
   *  因此跳过 121 处），半角 `,` 又是西文逗号、不在中文逗号该在的位置。挤压是**排版**的事，
   *  不该改内容里的字，所以改成压 advance（字体有 `halt` 就交给字体）。 */
  punctCompress: CompressMode = "halfwidth";
  ignoreVerseNumber = true;
  slurTieThickness = 6; // musicpp render.cpp:1076 (`lw0 = 6/cos`)，按 fontSize≈28 调
  /** 弧高与弧描边宽。同样是按 fontSize≈28 调出来的绝对值，换字号排版要跟着缩。 */
  slurHeightScale = 1;
  slurOutlineWidth = 0.7;
  /** 弧高的**上限**（未乘 slurHeightScale 的原始像素口径；贝塞尔的弧顶约为它的 0.75）。
   *  对数公式没有上限，长跨度的弧会一路长到顶掉上方的和弦符号：28px 字号下实测
   *  跨度 30px 的弧顶 6.6px、跨度 218px 的弧顶 17.8px，差 2.7 倍。
   *  18 = 典型跨度（3 个音符步距、dist≈100）的弧高，也就是「长弧最多长到典型那么高」，
   *  短弧（跨度 < 100px，两三个音符）一点不受影响。<=0 = 不封顶（老行为）。 */
  slurMaxHeight = 18;
  /** 弧高的**下限**（同一口径）。公式在短跨度上塌得很快（dist=20px 时弧顶只剩 4.6px），
   *  短弧几乎成了一条直线。open-fanqie 没有短弧特例——它的弧高**恒定** 10px，短弧自然不塌；
   *  这里取 10（弧顶 7.5px，与它同量级），影响的只有跨度 < 35px 的那批。<=0 = 只用公式自带的 1.2。 */
  slurMinHeight = 10;
  /** 跨度超过它就改画**扁平长连音线**（两端小钩 + 水平细线，见 SlurTieBase.initFlat）。
   *  0 = 按字号自动取 `numberSize * 5`（28px → 140px，约 4 个音符，
   *  与 open-fanqie 的 100px 阈值同一量级）。<0 = 一律画弧。 */
  slurFlatSpan = 0;
  /** **弧覆盖到这么多个音符就改画扁平长连音线**（0 = 只按跨度判）。
   *  跨度那条阈值是物理宽度，音符密的谱行上够不着——91《我灵镇静》那几条覆盖五六个
   *  十六分音符的弧，跨度还不到 4 个音符步距，照旧画成了高高的月牙。 */
  slurFlatNotes = 0;
  /** 弧的**宽高比**超过它就改画扁平式（0 = 不看）。见 SlurStyle.flatRatio。 */
  slurFlatRatio = 0;
  /** 扁平长连音线**中段**的墨迹厚度（两端收尖）。0 = `slurTieThickness * 0.45`。 */
  slurFlatWidth = 0;
  /** 小节线粗细。musicpp lineWidths.lightBarline / heavyBarline（pptutil.cpp:139），
   *  同样是按 fontSize≈28 调出来的绝对值——换字号排版时要等比缩，否则小节线相对字会变粗。 */
  barlineWidth = 2;
  finalBarlineWidth = 3.5;
  staffDist = 0;
  marginTop!: number;
  marginBottom!: number;
  /** 页眉四项（标题/副标题/经文/词曲作者）的字体字号（pt），样式表给了的才有（`style/header.ts`）。
   *  标题与词曲的字号仍以 `titleSize` / `creditSize` 为准（适配器已把角色字号落进去），这里只多给族、粗体，
   *  以及副标题与经文的字号（缺省同 `creditSize`）。 */
  headerFonts: HeaderFonts = {};
  marginLeft = 50;
  /** 右边距。默认与 marginLeft 相同（原来左右共用一个值）；成书排版要对开页镜像时分开给。 */
  marginRight = 50;
  /** 页面装饰：`song` = 每页底部印「曲名 + 第 i/n 页」（编辑器/单曲预览的老行为）；
   *  `none` = 什么都不印，页眉页脚由整本合成那一层统一加（见 scripts/rebuild.mjs）。 */
  pageFurniture: "song" | "none" = "song";
  maxLineDist!: number;
  maxHorizontalScale = 2.0;

  // --- jianpu vertical grid ---------------------------------------------
  // 数字上下那一摞（高音点 / 减时线 / 低音点）走公共那一份（engrave/stack.ts）：墨迹到墨迹等距，
  // 一道空 = `stackGap` × 数字墨迹高（样式键 `stack-gap`）。
  /** 叠层的空 ÷ 数字墨迹高（engrave/stack.ts）。样式键 `stack-gap`。 */
  stackGap = STACK_GAP_DEFAULT;
  /** 这一摞**之上**再给弧 / 三连音括线 / 上方带留的空（墨迹到墨迹）。 */
  jpStackGap!: number;
  jpBeamWidth = 1.5; // musicpp lineWidths.jpBeam (pptutil.cpp:138)

  /** `jpStaffTop` / `jpStaffBottom` 的覆写（0 = 按字号推算，见那两个 getter）。
   *  展开档要回到本项目原来的 −23/28 em 与 +5/28 em。 */
  jpStaffTopOverride = 0;
  jpStaffBottomOverride = 0;

  /** 叠层的取尺（已乘好数字墨迹高）。 */
  get stack(): StackStyle {
    return { gap: this.stackGap * this.numberBound("1").height, dotRadius: this.jpDotRadius, beamWidth: this.jpBeamWidth };
  }

  /** 一格：一个点加它上面那道空。弧与弧、弧与三连音之间逐层上移也用它。 */
  get jpDotRung(): number {
    const st = this.stack;
    return st.gap + 2 * st.dotRadius;
  }

  constructor(public fontSize: number) {
    // Original used 苹方-简 / Microsoft YaHei; in the webview we rely on the
    // system CJK font via a CSS stack.
    const cjk = "PingFang SC, Microsoft YaHei, sans-serif";
    this.lrcFont = new Font(cjk, fontSize);
    this.numberFont = new Font(cjk, fontSize);
    this.smuflFont = new Font("Bravura", fontSize);
    this.applyFontSize(fontSize);
  }

  /** 由字号派生的那几个间距。构造时算一次；成书排版会在之后按 BookStyle 逐项覆盖
   *  （见 src/style/book.ts::applyBookPreset）——**默认值必须原样保持**，
   *  编辑器与 OMR 那两条路的观感不能变。 */
  applyFontSize(fontSize: number): void {
    this.fontSize = fontSize;
    this.marginTop = fontSize * 1.5;
    this.marginBottom = fontSize * 3;
    this.maxLineDist = fontSize * 0.75;
    this.jpStackGap = fontSize / 6;
  }

  get lrcSize(): number {
    return this.lrcFont.size;
  }
  set lrcSize(v: number) {
    this.lrcFont = this.lrcFont.makeWithSize(v);
  }
  get numberSize(): number {
    return this.numberFont.size;
  }
  set numberSize(v: number) {
    this.numberFont = this.numberFont.makeWithSize(v);
  }

  /** 八度点的实际半径（`octaveDotRadius` 为 0 时按 `.` 的墨迹高折半）。 */
  get jpDotRadius(): number {
    if (this.octaveDotRadius > 0) return this.octaveDotRadius;
    const b = this.numberBound(".");
    return (b.bottom - b.top) / 2;
  }

  /** 附点的实际半径。0 = **与八度点同大**（用户口径：三种点一个大小）。
   *  别拿 `·` 字形的墨迹高折半——那是 ⌀4.06 @28pt，比八度点的 ⌀3.44 明显胖一圈。 */
  get jpAugDotRadius(): number {
    return this.augDotRadius > 0 ? this.augDotRadius : this.jpDotRadius;
  }

  /** 音符数字实际用的那支字（`numberFont` 加不加粗，见 `noteBold`）。 */
  get noteFont(): Font {
    return this.noteBold ? this.numberFont.withBold() : this.numberFont;
  }

  /** Tight glyph box of a jianpu number/dot. Was measured on `lrcFont`, which
   * is a no-op only as long as the two fonts stay identical (they do today,
   * but `lrcSize` is settable) — the numbers are drawn with `noteFont`. */
  numberBound(ch: string): Rect {
    return this.noteFont.charBound(ch);
  }

  /**
   * Vertical extent of barlines and time signatures, relative to the digit
   * baseline. musicpp spans the whole 40-unit jianpu staff at jianpuFont 30
   * (render.cpp:802, :1793): 1.0em above the baseline — which is exactly the
   * high octave-dot row — down to 0.333em below, the low octave-dot row.
   * This project used 23/28 and 5/28, a third shorter, whose lower edge did
   * not even reach the first low octave dot.
   */
  get jpStaffTop(): number {
    if (this.jpStaffTopOverride !== 0) return this.jpStaffTopOverride;
    return -this.numberSize;
  }
  get jpStaffBottom(): number {
    if (this.jpStaffBottomOverride !== 0) return this.jpStaffBottomOverride;
    return this.numberSize / 3;
  }
}
