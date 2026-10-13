// 房号括线（volta / ending）的**画法**：简谱引擎（`layout.ts::Line.drawEnding`）与五线谱 / 混排
// （`mixed/render.ts::drawEnding`）共用。位置各算各的（简谱按小节线墨迹、五线谱按小节的 tick 与数据区），
// 这里只管「横线 + 可选的两侧竖脚 + 房号」怎么落笔，两边观感因此一致。
import type { Font } from "../layout/font";
import { GraphicPath, Group, TextFrame } from "../layout/pageitem";

/** 房号墨迹顶与横线下沿之间的空，按房号字号计。 */
const LABEL_GAP = 0.3;

export interface EndingBracket {
  /** 横线左右端（竖脚就落在这两处）。坐标系是调用方给的 `g`。 */
  x0: number;
  x1: number;
  /** 横线的 y；竖脚从这里往下 `drop`。 */
  top: number;
  drop: number;
  /** 左脚：跨行续过来的那一段不画。 */
  leftFoot: boolean;
  /** 右脚：`stop` 封口；`discontinue`、跨到下一行、一组房的最后一房都不封。 */
  rightFoot: boolean;
  lineWidth: number;
  color: number;
  /** 房号：摆在左脚右侧 `dx` 处；纵向**从横线往下算**，见 `labelBaseline`。 */
  label?: { text: string; font: Font; dx: number };
  /** 给下游认的类名（成书的 line-check 靠它们认房号，见 `pdflayout/browser.ts::CLS_TAGS`）。 */
  classes?: { line: string; label: string };
}

/**
 * 房号基线相对横线（线心）的下移量：半个线宽 + 一道空 + 房号**墨迹**的上伸高度。
 * 按墨迹量而不是按字号或竖脚长估，所以换字体、换字号、竖脚长短不一（成书是实测的短脚）时，
 * 文字顶都落在横线下方，永远不与横线相压。
 */
export function labelBaseline(font: Font, text: string, lineWidth: number): number {
  const inkTop = Math.min(0, font.charBound(text).top); // 基线之上为负
  return lineWidth / 2 + font.size * LABEL_GAP - inkTop;
}

/** 画进 `g`，返回房号那个文字对象（没有房号时为 null），调用方需要时自己 `update()`。 */
export function addEndingBracket(g: Group, b: EndingBracket): TextFrame | null {
  const path = new GraphicPath();
  if (b.classes) path.classes.add(b.classes.line);
  path.stroke = true;
  path.fill = false;
  path.strokeColor = b.color;
  path.strokeWidth = b.lineWidth;
  if (b.leftFoot) {
    path.moveTo(b.x0, b.top + b.drop);
    path.lineTo(b.x0, b.top);
  } else {
    path.moveTo(b.x0, b.top);
  }
  path.lineTo(b.x1, b.top);
  if (b.rightFoot) path.lineTo(b.x1, b.top + b.drop);
  g.add(path);
  if (b.label) {
    const tf = new TextFrame();
    if (b.classes) tf.classes.add(b.classes.label);
    tf.font = b.label.font;
    tf.color = b.color;
    tf.text = b.label.text;
    tf.x = b.x0 + b.label.dx;
    tf.y = b.top + labelBaseline(b.label.font, b.label.text, b.lineWidth);
    g.add(tf);
    return tf;
  }
  return null;
}
