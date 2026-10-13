// 混排渲染的落笔小工具（线、SMuFL 字形、平移组）。五线谱层（`render.ts`）与简谱叠层（`jianpuoverlay.ts`）共用。

import { Matrix33 } from "../common/geom";
import { type GraphicLine, Group } from "../layout/pageitem";
import { lineItem, textItem } from "../engrave/prims";
import { Font } from "../layout/font";
import type { ElementId } from "../model/doc";

/** 一个和弦画出来的那一组（五线谱层的符头、符干、符尾；简谱叠层的那一柱）的类名。
 *  `data` 是 `StaffChordData`：编辑器按元素 id 找到它，放播放线、认点选。 */
export const STAFF_CHORD = "staff-chord";
export interface StaffChordData {
  readonly chordId: ElementId;
}
/** 一行系统的组的类名。`data` 是 `StaffSystemData`：谱表带（混排连同简谱层）的上下沿，系统坐标（tenths）。 */
export const STAFF_SYSTEM = "staff-system";
export interface StaffSystemData {
  readonly top: number;
  readonly bottom: number;
}

/**
 * 五线谱层里**叶子图元**（歌词字、弧、小节线）的身份，挂在 `PageItem.data` 上。编辑器按它认点选（可视化编辑）。
 * 只挂数据、不加类名不包组：`mixedVisitor` 对叶子不写 class，所以 SVG 输出一字不变（`mixed-tree-dump` 指纹不动）；
 * 渲染时由 `mixedVisitor` 的 `leafMap` 记下它画出的那个 SVG 元素。
 * 小节线没有 id：按「第几小节（全曲下标）+ 在它哪一侧」认（系统开头那条是首小节的 `before`，其余是前一小节的 `after`）。
 */
export type StaffLeafData =
  | { readonly staffRole: "lyric"; readonly chordId: ElementId; readonly verse: number }
  | { readonly staffRole: "slur"; readonly start: ElementId; readonly end: ElementId }
  | { readonly staffRole: "barline"; readonly measure: number; readonly side: "before" | "after" }
  /** 标题块的一行字（credit）。自动铺排会按 `work-title` 重新合成 credit，下标对不上原文，所以按字认（同简谱档页眉） */
  | { readonly staffRole: "credit"; readonly text: string };

/** `data` 是不是 `StaffLeafData`。 */
export function isStaffLeaf(data: unknown): data is StaffLeafData {
  return typeof data === "object" && data !== null && "staffRole" in data;
}

/** 叶子身份的查表键（同一身份可能画成好几个图元：小节线每个谱表组一段、混排的简谱层再一段）。 */
export function staffLeafKey(d: StaffLeafData): string {
  switch (d.staffRole) {
    case "lyric": return `lyric:${d.chordId}:${d.verse}`;
    case "slur": return `slur:${d.start}:${d.end}`;
    case "barline": return `bar:${d.measure}:${d.side}`;
    case "credit": return `credit:${d.text}`;
  }
}

/** 和弦 `id` 的组（见 `STAFF_CHORD`）。 */
export function chordGroup(id: ElementId): Group {
  const g = new Group();
  g.classes.add(STAFF_CHORD);
  g.data = { chordId: id } satisfies StaffChordData;
  return g;
}

export function addLine(g: Group, x1: number, y1: number, x2: number, y2: number, lw: number): GraphicLine {
  const l = lineItem(x1, y1, x2, y2, lw, 0xff000000);
  g.add(l);
  return l;
}

/** SMuFL glyph via TextFrame with Bravura family. */
export function addSmufl(g: Group, glyph: string, x: number, y: number, size: number): void {
  g.add(textItem(glyph, new Font("Bravura", size), 0xff000000, x, y));
}

/** SMuFL glyph with scale transform. */
export function addSmuflScaled(
  g: Group,
  glyph: string,
  x: number,
  y: number,
  size: number,
  scx: number,
  scy: number,
): void {
  const grp = new Group();
  const m = new Matrix33();
  m.setAffine([scx, 0, 0, scy, x, y]);
  grp.matrix = m;
  addSmufl(grp, glyph, 0, 0, size);
  g.add(grp);
}

export function translated(x: number, y: number): Group {
  const g = new Group();
  const m = new Matrix33();
  m.setAffine([1, 0, 0, 1, x, y]);
  g.matrix = m;
  return g;
}
