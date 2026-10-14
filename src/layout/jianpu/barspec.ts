// 文本谱的小节线类型 → 谱面那一路的 `BarlineSpec`（两边的表达力一一对上）。定位（量宽）与绘制共用。
import type { BarlineSpec } from "../../engrave/barline";
import type { BarlineElement } from "../../pu/ast";
import { BarStyle } from "../../score/enums";

/** 文本谱的小节线类型 → 谱面那一路的 `BarlineSpec`（两边的表达力一一对上）。 */
const PU_BARLINE_SPEC: Record<string, BarlineSpec | undefined> = {
  normal: {},
  double: { style: BarStyle.LIGHT_LIGHT },
  end: { style: BarStyle.LIGHT_HEAVY },
  "repeat-start": { repeatForward: true },
  "repeat-end": { repeatBackward: true },
  "repeat-both": { repeatBackward: true, repeatForward: true },
};

/** 一条小节线画成什么样；`null` = 不画线（隐藏线、认不出的类型）。
 *  下一小节左线上起反复（`repeatForwardAfter`）：这条线画成 `|:` / `:|:`。 */
export function puBarlineSpec(el: BarlineElement): { spec: BarlineSpec; final: boolean } | null {
  const type = el.repeatForwardAfter && el.type === "normal" ? "repeat-start"
    : el.repeatForwardAfter && el.type === "repeat-end" ? "repeat-both" : el.type;
  const spec = PU_BARLINE_SPEC[type];
  return spec ? { spec, final: type === "end" } : null;
}
