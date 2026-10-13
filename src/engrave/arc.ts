// 弧线（圆滑线 / 延音线，及三连音的两段弧）的几何：三引擎共用一份。月牙形本身（填充 + 描边、扁平长连音线、
// 断口）在 `layout/pageitem.ts::SlurTieBase` 里画；这里只放样式参数与两个纯函数（弧高、控制点），
// 避让与纵向预留（原样文档 `jianpuSlurRise`、混排 `arcExtent`）按它们算，与画出来的弧同一份。
import { Point } from "../common/geom";

/** 弧线（圆滑线 / 连音线）的样式参数。位置参数太多不可读，统一走这个对象。 */
export interface SlurStyle {
  /** 月牙形的最大厚度（musicpp 的 `lw0`），也是扁平式线宽的折算基准。 */
  thickness: number;
  color: number;
  /** 整条弧随字号缩放（成书排版用小字号，绝对像素会显得过高）。默认 1。 */
  heightScale?: number;
  /** 细描边的线宽。默认 0.7。 */
  outlineWidth?: number;
  /** 弧高上限，**未乘 `heightScale` 的原始像素口径**。<=0 或省略 = 不封顶。 */
  maxHeight?: number;
  /** 弧高下限，同样是未乘 `heightScale` 的原始像素口径。<=0 或省略 = 只用公式自带的 1.2。 */
  minHeight?: number;
  /** 跨度超过它就改画扁平长连音线。<=0 或省略 = 一律画弧。 */
  flatSpan?: number;
  /** **这一条**强制走扁平式（按弧覆盖的音符个数判，见 `Line.addSlurTie`）。 */
  forceFlat?: boolean;
  /** 弧的**宽高比**（跨度 ÷ 弧顶高）超过它就改画扁平式。<=0 或省略 = 不看这一条。
   *  跨度阈值是绝对宽度，跟不上字号与弧高上限的变化；宽高比才是「这条弧看着扁不扁」。 */
  flatRatio?: number;
  /** 扁平式**中段**的墨迹厚度（两端一样收尖）。省略 = `thickness * 0.45`。 */
  flatLineWidth?: number;
  /**
   * 弧的开口朝向。默认 `"up"`——**简谱的弧一律在音符上方、开口朝下**，
   * 三条简谱路（编辑器 / 成书重排 / 文本谱）都不设它。
   * `"down"` 只给混排的五线谱层用：那里 slur/tie 跟着符干走，符干朝上时弧在音符下方。
   */
  side?: "up" | "down";
  /**
   * 中间挖掉 `[x0, x1]` 这一截（页面 x），只画两头——三连音的「两段弧」风格（数字坐在断口里，
   * 见 `Line.addTuplet`）。切的是**同一条月牙**，所以音符那一端照样收尖、断口处是弧中段的厚度，
   * 与同页的 slur 同一套形状语言，不另画等宽线。有 gap 时一律画弧，不走扁平式。
   */
  gap?: { x0: number; x1: number };
}

/**
 * 弧高（正数，实际画的时候取负——简谱的弧一律在音符上方、开口朝下）。
 * **这是弧高的唯一算法**：谱面排版、成书重排、文本谱的绘制与纵向预留全走它。
 *
 * musicpp 的公式（按 jianpuFont≈28 调的绝对像素）在**短弧**上会算出负值
 * ——dist < 10^(16/17) ≈ 8.7pt 时 h 变正，弧就翻过来开口朝上了，所以钳住下限。
 *
 * 上限是本项目加的（musicpp / 原 Kotlin 都没有）：对数虽然涨得慢却**没有上限**，
 * 28px 字号下典型跨度（3 个音符步距，dist≈90）弧高 17px，整行的长弧（dist≈600）
 * 冲到 31px，将近两倍——顶到上方的和弦符号上。参考 open-fanqie
 * （renderer.ts:703，弧高恒定 10px 与跨度无关）封顶，短弧的手感一点不变。
 */
export function arcHeight(dist: number, o: Pick<SlurStyle, "heightScale" | "maxHeight" | "minHeight"> = {}): number {
  const floor = o.minHeight !== undefined && o.minHeight > 0 ? o.minHeight : 1.2;
  const raw = Math.max(Math.log10(Math.max(dist, 1e-6)) * 17 - 16, floor);
  const cap = o.maxHeight !== undefined && o.maxHeight > 0 ? Math.max(o.maxHeight, floor) : Infinity;
  return Math.min(raw, cap) * (o.heightScale ?? 1);
}

export function calcSlurPoints(pl: Point, pr: Point, o: Pick<SlurStyle, "heightScale" | "maxHeight" | "minHeight" | "side"> = {}): [Point, Point, number] {
  const xr = pr.x, xl = pl.x, yr = pr.y, yl = pl.y;
  const dx = xr - xl, dy = yr - yl;
  const square = dx * dx + dy * dy;
  const dist = Math.sqrt(square);
  const theta = Math.atan2(dy, dx);
  const cos = Math.cos(-theta);
  const sin = Math.sin(-theta);
  const xlen = Math.min(dist * 0.04 + 10, dist * 0.25);
  // 页面坐标 y 向下为正，所以「弧在上方」= 控制点 y 取负。
  const h = arcHeight(dist, o) * (o.side === "down" ? 1 : -1);
  let p1 = new Point(xlen, h).rotate(cos, sin);
  let p2 = new Point(dist - xlen, h).rotate(cos, sin);
  p1 = p1.offset(xl, yl);
  p2 = p2.offset(xl, yl);
  return [p1, p2, cos];
}

/** 首尾相接的两条弧（前一条的终点就是后一条的起点）在接点**各内缩**数字字号的几分之一：免得两条弧顶在一起。
 *  简谱引擎与原样文档同一个值（musicpp 的 size/14）。 */
export const ARC_CHAIN_INSET_DIV = 14;
