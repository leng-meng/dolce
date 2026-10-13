// 元素类共用的小件：SMuFL 字形文字与它的墨迹盒。
import { Rect } from "../common/geom";
import type { Font } from "../layout/font";
import { TextFrame } from "../layout/pageitem";
import { glyphCodeName, type MetaData } from "../smufl/smufl";

/** 一串 SMuFL 字形（Bravura 等），挂类名 `smufl`：成书按它落乐谱字体、PPTX 按它转曲。
 *  盒子按**墨迹**（`inkBound`）——Bravura 的字体盒约 4 em 高，按它算会把所在的组、谱行整个撑开。 */
export function musicText(glyphs: string, font: Font, color: number): TextFrame {
  const tf = new TextFrame();
  tf.font = font;
  tf.color = color;
  tf.text = glyphs;
  tf.inkBound = true;
  tf.classes.add("smufl");
  return tf;
}

/**
 * 一串 SMuFL 字形的**墨迹盒**（相对笔位、基线，y 向下为正）。
 *
 * 有元数据且每个字形都查得到就按元数据（与 `SmuflText.bound` 同一口径，`字号 = 4 个 staff space`），
 * 否则退回 canvas 量的墨迹（`Font.charBound`）。**不用字体盒**：Bravura 的 ascent−descent 约 4 em。
 */
export function musicInk(glyphs: string, font: Font, meta?: MetaData): Rect {
  if (meta && [...glyphs].every((g) => glyphCodeName(g) && meta.getBBox(g))) {
    const sp = font.size / 4;
    let x = 0;
    let r = new Rect();
    for (const g of glyphs) {
      const b = meta.getBBox(g)!;
      r = r.union(new Rect(x + b.bBoxSW[0] * sp, -b.bBoxNE[1] * sp, x + b.bBoxNE[0] * sp, -b.bBoxSW[1] * sp));
      x += font.measureText(g);
    }
    return r;
  }
  return font.charBound(glyphs);
}
