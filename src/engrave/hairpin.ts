// 渐强 / 渐弱（松叶）：原样文档与五线谱/混排共用一个画法。
// 两条边各是一段直线（一条路径），尖端处两边高度同为 0 自然汇于一点；跨行断开的那一截由调用方给开口。
import { GraphicPath } from "../layout/pageitem";

export interface HairpinSpec {
  x0: number;
  x1: number;
  /** 中线 y。 */
  y: number;
  /** 左、右两端的**半**开口（尖端为 0）。 */
  half0: number;
  half1: number;
  lineWidth: number;
  color: number;
}

export function hairpinPath(h: HairpinSpec): GraphicPath {
  const p = new GraphicPath();
  p.fill = false;
  p.stroke = true;
  p.strokeColor = h.color;
  p.strokeWidth = h.lineWidth;
  p.moveTo(h.x0, h.y + h.half0);
  p.lineTo(h.x1, h.y + h.half1);
  p.moveTo(h.x0, h.y - h.half0);
  p.lineTo(h.x1, h.y - h.half1);
  return p;
}
