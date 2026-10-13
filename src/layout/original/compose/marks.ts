// 记号层：弧线、多连音、跳房子、渐强渐弱，以及内联层。
import { Font } from "../../font";
import { Point } from "../../../common/geom";
import { Group, Slur } from "../../pageitem";
import { addEndingBracket } from "../../../engrave/ending";
import { TupletGlyph } from "../../../engrave/tuplet";
import { sustainDash } from "../../../engrave/dash";
import { beamY, highDotY, lowDotY } from "../../../engrave/stack";
import { hairpinPath } from "../../../engrave/hairpin";
import { jianpuSlurStyle } from "../metrics";
import type { PlacedLayer, PlacedMark } from "../place/model";
import { chordLane, noteBeams } from "../place/vertical";
import { type OriginalCtx, dot, rect, text } from "./ctx";
import { braceItem } from "./brace";
import { paintVoice } from "./page";

/** 弧线：直接用简谱谱面那套 SlurTieBase（月牙形，中间厚两端尖），两处观感一致。
 *  弧高（含超长跨度改扁平的阈值）由 jianpuSlurStyle 定，与 layout 的纵向预留同源。 */
function paintArc(c: OriginalCtx, root: Group, x0: number, x1: number, y: number): Slur {
  const arc = new Slur();
  arc.init(new Point(x0, y), new Point(x1, y), jianpuSlurStyle(c.metrics, c.ink));
  arc.update();
  root.add(arc);
  return arc;
}

export function paintMark(c: OriginalCtx, root: Group, mk: PlacedMark, left: number, baseline: number): void {
  const m = c.metrics;
  const x0 = left + mk.x0;
  const x1 = Math.max(left + mk.x1, x0 + 6);
  switch (mk.mark.type) {
    case "slur": {
      const y = baseline + (mk.y ?? m.note.slurY - (mk.level - 1) * m.note.slurLevelStep);
      const arc = paintArc(c, root, x0, x1, y);
      // 弧没有自己的 id，可视化编辑按「起点:终点」认它（同 `Tie.startId`）。
      // **不能用 `mk.mark.start/end`**——那是行内下标，元素 id 要从两端实际落在的符号上取
      const sid = mk.startEl && c.doc?.idOf.get(mk.startEl);
      const eid = mk.endEl && c.doc?.idOf.get(mk.endEl);
      if (sid !== undefined && eid !== undefined) arc.ident = { kind: "slur", id: sid, end: eid };
      break;
    }
    case "tuplet": {
      // 多连音：弧线在正中**被连音数字断开**（原版如此）。画法走公共那一份（engrave/tuplet.ts）：
      // 与同页 slur 同一条月牙挖掉数字那一截，数字是 SMuFL 的 tuplet 字形、按墨迹坐在弧顶。
      const y = baseline + (mk.y ?? m.note.slurY - (mk.level - 1) * m.note.slurLevelStep);
      // 连音数取模型里的实际数（`caption` = tupletActual），没有才按跨了几个符号数
      const n = Number(mk.mark.caption) || mk.mark.end - mk.mark.start + 1;
      const tg = new TupletGlyph(new Point(x0, y), new Point(x1, y), n, {
        kind: "arc",
        color: c.ink,
        music: new Font("Bravura", c.digitFont.size),
        arc: jianpuSlurStyle(m, c.ink),
      });
      for (const it of tg.items) root.add(it);
      break;
    }
    case "crescendo":
    case "decrescendo": {
      const half = m.note.hairpinOpening / 2;
      // `mk.y` 是松叶底边（`placeMarks` 按跨度里的音符与和弦定的）；没有才退回固定槽位
      const y = mk.y !== undefined ? baseline + mk.y - half - m.style.stroke.hairpin / 2
        : baseline + m.note.hairpinY - (mk.level - 1) * m.note.levelStep;
      const open = mk.mark.type === "crescendo";
      // 画法走公共那一份（engrave/hairpin.ts，与五线谱同一笔）
      root.add(hairpinPath({
        x0, x1, y, half0: open ? 0 : half, half1: open ? half : 0, lineWidth: m.style.stroke.hairpin, color: c.ink,
      }));
      break;
    }
    case "volta": {
      const y = baseline + m.note.voltaY - (mk.level - 1) * m.note.levelStep;
      // 画法走公共那一份（engrave/ending.ts，与简谱引擎、混排同一套）：比例照混排——
      // 竖脚与房号字号都是谱高的一半（谱高取小节线高），房号在左脚右侧、横线下方按墨迹定位。
      const H = m.style.vertical.barlineHeight;
      const size = H * 0.5;
      const lw = m.style.stroke.barline;
      const showLabel = !!mk.mark.caption && !mk.openLeft; // 跨行续过来的房子不再重复房号
      addEndingBracket(root, {
        x0, x1, top: y, drop: H * 0.5,
        leftFoot: !mk.openLeft,
        // `]/`（诗歌本）与 `[…/`（番茄）表示右端不封口
        rightFoot: !mk.openRight && mk.mark.openEnd !== true,
        lineWidth: lw, color: c.ink,
        label: showLabel ? { text: mk.mark.caption!, font: c.digitFont.makeWithSize(size), dx: lw + size * 0.4 } : undefined,
        classes: { line: "ending-line", label: "ending" },
      });
      break;
    }
  }
}

export function paintLayer(c: OriginalCtx,
  root: Group,
  layer: PlacedLayer,
  left: number,
  baseline: number,
  pageIndex = 0,
): void {
  const m = c.metrics;
  const split = layer.split;
  if (split) {
    // `{dsb}` 并排块：上行与主旋律**同字号同画法**，所以直接借主行那套绘制
    paintVoice(c,
      root,
      {
        voice: split.line,
        y: baseline + split.dy,
        items: layer.items,
        underlines: layer.underlines.map((u) => ({ ...u, dy: 0 })),
        marks: split.marks,
        chordY: chordLane(split.line, m),
        layers: [],
        lyricY: [],
      },
      pageIndex,
      false,
    );
    // 花括号：细线描边的自绘路径，尖端朝并排的两行
    const y0 = baseline + split.braceTop;
    const y1 = baseline + split.braceBottom;
    if (split.braceLeftX !== undefined) {
      root.add(braceItem(c.ink, left + split.braceLeftX, y0, y1, -1, "split"));
    }
    if (split.braceRightX !== undefined) {
      root.add(braceItem(c.ink, left + split.braceRightX, y0, y1, 1, "split"));
    }
    return;
  }
  const y = baseline + m.note.cueY;
  const cs = m.style.size.cue;
  const font = new Font(m.style.font.text.family, c.digitFont.size * cs);
  const st = m.ink.stack;
  const cue = { gap: st.gap * cs, dotRadius: st.dotRadius * cs, beamWidth: st.beamWidth * cs };
  for (const it of layer.items) {
    const x = left + it.x;
    if (it.element.kind === "barline") {
      root.add(rect(c.ink, x - 0.6, y - 10, 1.2, 20));
      continue;
    }
    if (it.element.kind === "sustain") {
      root.add(sustainDash(x, y, { font, color: c.ink }));
      continue;
    }
    if (it.element.kind !== "note" || it.element.hidden) continue;
    const ch = String(it.element.pitch);
    const b = font.charBound(ch);
    root.add(
      text(ch, x - (b.left + b.right) / 2, y - (b.top + b.bottom) / 2, font, c.ink),
    );
    // 小字层的叠层与主旋律同一套（engrave/stack.ts），整体按 cueScale 缩；低音点同样让开减时线
    const oct = it.element.octave;
    const h = m.ink.noteHeight * cs;
    for (let i = 0; i < oct; i++) root.add(dot(c.ink, x, y + highDotY(-h / 2, i, cue), cue.dotRadius));
    for (let i = 0; i < -oct; i++) root.add(dot(c.ink, x, y + lowDotY(h / 2, noteBeams(it.element), i, cue), cue.dotRadius));
  }
  for (const u of layer.underlines) {
    root.add(
      rect(c.ink,
        left + u.x0,
        y + beamY((m.ink.noteHeight * cs) / 2, u.level, cue) - cue.beamWidth / 2,
        u.x1 - u.x0,
        cue.beamWidth,
      ),
    );
  }
}
