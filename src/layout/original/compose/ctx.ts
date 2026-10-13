// 一次原样文档排版的绘制上下文与几样共用的小画法（点、线、文字、数字落笔原点）。
import type { JianpuGrid } from "../metrics";
import { Font } from "../../font";
import type { Rect } from "../../../common/geom";
import { GraphicPath, TextFrame } from "../../pageitem";
import { jpDot } from "../../../engrave/dot";
import { fillRect, strokePath, textItem } from "../../../engrave/prims";
import type { Region } from "../../../style/ss";
import type { DocView } from "../../../pu/slots";
import type { PlacedScore } from "../place/model";

/** 一次原样文档排版的上下文（原 PuPainter 的实例状态）。墨色也在这里：
 *  原先是模块级可变量、在 `load` 开头设一次，现在随上下文传，多个实例互不影响。 */
export interface OriginalCtx {
  metrics: JianpuGrid;
  doc: DocView;
  placed: PlacedScore | null;
  digitFont: Font;
  /** 正在画的这一行和弦/注释那一槽的基线（相对音符基线，place/vertical.ts::chordLane）。 */
  chordLane: number;
  pageWidth: number;
  pageHeight: number;
  /** 连续长图裁紧后，整页要平移多少（把墨迹推到左侧留白处） */
  _pageShiftX: number;
  /** 墨色（`style.page.color`）。歌词同色。 */
  ink: number;
  lyricInk: number;
  /** 页脚模板（样式表的 `song-foot` 区域；没有就不印） */
  foot: Region | null;
}

/** 实心圆。谱面/混排/文本谱共用一份（`engrave/dot.ts::jpDot`，四段贝塞尔的标准正圆）。
 *  这里原先是两段近似（控制点 1.34r），腰部比正圆略胖。 */
export const dot = (color: number, cx: number, cy: number, r: number): GraphicPath =>
  jpDot(cx, cy, r, color);

export const rect = fillRect;
export const stroke = (color: number, width = 1.4): GraphicPath => strokePath(color, width);

/** 标点挤压（CLREQ，见 common/cjkpunct.ts）：一个音节 = 一个 `<text>`，字 + 尾随标点、或前引号 + 字都在同一串里，
 *  挤压在这里就压掉了（engrave/prims.ts::textItem）。 */
export function text(str: string, x: number, y: number, font: Font, color: number): TextFrame {
  return textItem(str, font, color, x, y, true);
}

/** 数字按墨迹居中于锚点：返回该把文字画在哪个 x/y，并附带墨迹盒。 */
export function digitOrigin(c: OriginalCtx, ch: string): { dx: number; dy: number; b: Rect } {
  const b = c.digitFont.charBound(ch);
  return {
    dx: -(b.left + b.right) / 2,
    dy: -(b.top + b.bottom) / 2,
    b,
  };
}
