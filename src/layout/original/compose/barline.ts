// 小节线（含反复点、跳转记号）的绘制。
import { Font } from "../../font";
import { Group } from "../../pageitem";
import { BarlineGlyph, type BarlineSpec } from "../../../engrave/barline";
import { BarStyle } from "../../../score/enums";
import { barlineSpan } from "../metrics";
import type { PlacedItem } from "../place/model";
import type { OriginalCtx } from "./ctx";
import { paintMeter } from "./header";
import { paintOrnaments } from "./note";

/** 文本谱的小节线类型 → 谱面那一路的 `BarlineSpec`（两边的表达力一一对上）。 */
const PU_BARLINE_SPEC: Record<string, BarlineSpec | undefined> = {
  normal: {},
  double: { style: BarStyle.LIGHT_LIGHT },
  end: { style: BarStyle.LIGHT_HEAVY },
  "repeat-start": { repeatForward: true },
  "repeat-end": { repeatBackward: true },
  "repeat-both": { repeatBackward: true, repeatForward: true },
};

/** `spanHeight` > 0 时，这条小节线从 baseline 一直画到 baseline+spanHeight（贯穿多声部）。
 *
 *  **线本身收在一个 `Group` 里**并作为返回值交出去：几条竖线加反复点是好几个图元，散着放
 *  就是几个互不相干的 `<g>`，可视化编辑罩不出一个框、也点不中整条线。挂在线上的记号与
 *  临时拍号不进这个组（它们各自是独立对象）。线不画时返回 null。 */
export function paintBarline(c: OriginalCtx,
  root: Group,
  x: number,
  baseline: number,
  it: PlacedItem,
  spanHeight = 0,
): Group | null {
  const m = c.metrics;
  const el = it.element;
  if (el.kind !== "barline") return null;
  if (el.type === "hidden" || el.type === "invisible") {
    // 线本身不画，但挂在它上面的记号与临时拍号仍要画
    if (el.ornaments.length > 0) {
      const g = new Group();
      paintOrnaments(c, g, el.ornaments, x, baseline);
      root.add(g);
    }
    if (el.temporaryMeter) {
      const font = new Font(m.style.font.text.family, m.style.size.keyMeter * 0.85);
      paintMeter(c, root, x, baseline, el.temporaryMeter, font);
    }
    return null;
  }

  // 临时拍号：`|"p:2/4"`，画在这条小节线右侧
  if (el.temporaryMeter) {
    const font = new Font(m.style.font.text.family, m.style.size.keyMeter * 0.85);
    paintMeter(c, root, x + m.style.stroke.doubleBarlineGap, baseline, el.temporaryMeter, font);
  }

  // 粗细组合、反复点、线间距**全部走谱面那一路的画法**（engrave/barline.ts::BarlineGlyph）。
  // 原先这里是自成一套：填充 rect 而不是 GraphicLine、粗线 ×2.6、线距 barlineDoubleGap、
  // 反复点在 ±0.18H 且离线 6px——同一件事两种写法，改一处忘一处。
  // 纵向范围与简谱引擎同一口径（`barlineSpan`），连谱号跨声部时下缘再加 spanHeight。
  const span = barlineSpan(m);
  // 下一小节左线上起反复（`repeatForwardAfter`）：这条线画成 `|:` / `:|:`
  const type = el.repeatForwardAfter && el.type === "normal" ? "repeat-start"
    : el.repeatForwardAfter && el.type === "repeat-end" ? "repeat-both" : el.type;
  const spec = PU_BARLINE_SPEC[type];
  if (!spec) {
    if (el.ornaments.length > 0) {
      const og = new Group();
      paintOrnaments(c, og, el.ornaments, x, baseline);
      root.add(og);
    }
    return null;
  }
  const r = new BarlineGlyph(spec, type === "end", {
    top: span.top,
    bot: span.bottom + spanHeight,
    light: m.style.stroke.barline,
    heavy: m.style.stroke.finalBarline,
    dotRadius: m.style.dot.repeat,
    color: c.ink,
  });
  // BarlineGlyph 的 x 从 0 起；文本谱的小节线是**居中于锚点**的
  const ox = x - r.width / 2;
  if (el.ornaments.length > 0) {
    const og = new Group();
    paintOrnaments(c, og, el.ornaments, x, baseline, undefined, { right: ox + r.width, top: baseline + span.top });
    root.add(og);
  }
  const g = new Group();
  for (const item of r.items) {
    item.x += ox;
    item.y += baseline;
    g.add(item);
  }
  root.add(g);
  return g;
}
