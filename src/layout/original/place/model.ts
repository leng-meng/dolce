// 原样文档布局的定位结构：排版行视图 → 各符号、记号、声部、谱组、页的位置。只有数据，算法在同目录各文件。
import type { InlineLayerElement, LyricSyllable, Mark, MusicElement, ScoreLine, VoiceGroup } from "../../../pu/ast";
import type { JianpuGrid } from "../metrics";
import type { Rect } from "../../../common/geom";

/** 一个占位的谱面符号（音符 / 增时线 / 小节线）。 */
export interface PlacedItem {
  /** 占位序号（只数音符/增时线/小节线） */
  index: number;
  /** 在 voice.elements 里的下标——记号的 start/end 用的是这个坐标系 */
  srcIndex: number;
  /** 锚点 x（行坐标系；数字按墨迹居中于此） */
  x: number;
  /** 自然宽度（拉伸前），供两端对齐用 */
  advance: number;
  element: MusicElement;
  /** 起始拍位（小节内），用于减时线分组与多声部对齐 */
  beat: number;
  /** 时值（拍） */
  beats: number;
  /** 本音符所跟的歌词音节，逐段一个（缺段为 null） */
  syllables: Array<LyricSyllable | null>;
  /** 纵向偏移：`{dsb}` 并排块里，主旋律这一段要下移半个行距 */
  dy?: number;
  /** 小节线不画（分声部前的空声部，见 song.ts::hideEmptyBarlines）；占位照旧 */
  noBarline?: true;
}

/** 一条跨若干符号的记号（弧线 / 多连音 / 跳房子 / 渐强渐弱），已换算成行内坐标。 */
export interface PlacedMark {
  /** 纵向偏移：并排块里主旋律那一段的记号也要跟着下移 */
  dy?: number;
  mark: Mark;
  x0: number;
  x1: number;
  /** 弧线/多连音的顶点 y（相对该声部的音符基线，负为上）。其余记号走固定槽位。 */
  y?: number;
  /** 嵌套层数或 `+` 抬高级别 */
  level: number;
  /** 左端续自上一行 / 右端续到下一行（弧线与跳房子支持跨行） */
  openLeft: boolean;
  openRight: boolean;
  /** 两端实际落在哪两个符号上。`PuMark.start/end` 是**行内下标**不是元素 id，
   *  可视化编辑要按元素 id 认这条弧，只能从这里取（`DocView.idOf`）。排版不读。 */
  startEl?: MusicElement;
  endEl?: MusicElement;
}

/**
 * 临时伴奏 `{bz…}`：画在主旋律上方的小字号行。
 * 临时多声部 `{dsb…}`：**并排块**——括起的内容与主旋律的对应片段上下并排、同字号，
 * 左（或右）侧一个大花括号；主旋律在这一段里下移半个行距，并排段外仍在原位。
 */
export interface PlacedLayer {
  layer: InlineLayerElement;
  items: PlacedItem[];
  underlines: PlacedUnderline[];
  /** `{dsb}` 的并排块信息；`{bz}` 没有 */
  split?: PlacedSplit;
}

export interface PlacedSplit {
  /** 上行（括起的内容）相对主旋律基线的偏移，负值 */
  dy: number;
  line: ScoreLine;
  marks: PlacedMark[];
  /** 花括号：并排段在行内开始就画左向的，在行内结束就画右向的 */
  braceLeftX?: number;
  braceRightX?: number;
  braceTop: number;
  braceBottom: number;
}

/** 一条减时线段：第 level 层，从 x0 到 x1。 */
export interface PlacedUnderline {
  level: number;
  x0: number;
  x1: number;
  dy?: number;
}

export interface PlacedVoice {
  voice: ScoreLine;
  /** 音符基线 y（页坐标系） */
  y: number;
  items: PlacedItem[];
  underlines: PlacedUnderline[];
  marks: PlacedMark[];
  layers: PlacedLayer[];
  /** 各段歌词的基线 y，与 voice.lyrics 平行 */
  lyricY: number[];
  /** 和弦/注释那一槽的基线（相对音符基线，见 chordLane） */
  chordY: number;
}

export interface PlacedGroup {
  group: VoiceGroup;
  voices: PlacedVoice[];
  /** 说明性文字（`W:`）的基线 y */
  textY: number;
  /** 连谱号：多声部时从首声部画到末声部 */
  braceTop: number;
  braceBottom: number;
  hasBrace: boolean;
  /** `&sbf` 标出的分声部起点（行内 x）；没标就从 system 左缘起 */
  braceFromX?: number;
}

export interface PlacedPage {
  groups: PlacedGroup[];
  /** 本页属于第几首（一首多唱时用来决定是否重画标题） */
  song: number;
  /** 是否是该首的首页——首页才画标题、作者、调号拍号 */
  firstOfSong: boolean;
}

export interface PlacedScore {
  pages: PlacedPage[];
  metrics: JianpuGrid;
  /** 内容最下沿（连续长图模式据此定页高） */
  contentBottom: number;
  /** 内容最右沿（行内坐标；连续长图模式据此定页宽） */
  contentRight: number;
}

/** 一个音节画出来的那串（字 + 尾随标点，标点挤压后）的横向度量，口径同简谱引擎的 `Lyric`（`pageitem.ts`）。
 *  音节按**主体**居中于锚点、前后标点挂出去（同 compose/lyric.ts::paintSyllables）。 */
export interface LyricRun {
  text: string;
  /** 整串字面宽 */
  width: number;
  /** 前置标点（`“凡` 的引号）宽 */
  lead: number;
  /** 主体宽 */
  body: number;
  /** 首字墨迹左边的留白（从挤压后的笔位起算） */
  headBlank: number;
  /** 末字墨迹右边的留白 */
  tailBlank: number;
}

/** 定位用的墨迹量具，由绘制端注入（`compose/index.ts`）：排版这一层不碰字体。 */
export interface InkMeasurer {
  lyric(syl: LyricSyllable): LyricRun;
  /** 歌词字体的空格宽（西文词与词之间补的那一格） */
  readonly lyricSpace: number;
  /** 音符数字（`0`–`7`、`X`、增时线 `-`、附点 `·`）：字面宽，与墨迹盒（相对落笔原点、基线 y = 0）。 */
  digit(ch: string): { advance: number; ink: Rect };
}
