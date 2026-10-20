// 各声部**共用的时间轴**（试听、演唱顺序、导出 MusicXML 共用）：轴上一格是一小节，各声部的小节按「组号 + 组内第几小节」落格。
//
// 文本谱一组不一定含全部声部（issue 11：前几行只有 `Q:`，末组才出 `Q1:`/`Q2:`），`frompu.ts` 按声部号建 part 时
// 各声部首尾相接、缺席的组不占位，小节序号对不上。同组里第 k 小节同时起（同原样档组内按「小节序号 + 拍数」归列），
// 每组在轴上占「该组各声部小节数的最大值」格，组的起点是前面各组的累加。缺席、偏短的声部在那几格上**没有小节**，
// 不补任何东西（从前在克隆上补无声小节，补出来的是新 id、照抄小节线的假小节）。
//
// 组号取 `Measure.print.system`（各声部每行首小节都有，往后继承）；有声部的首小节没有它（非文本谱来源）就按小节序号一一对应。

import type { Song } from "./doc";

export interface TimeAxis {
  /** 轴上一共几格 */
  length: number;
  /** 各声部第 i 小节落在轴上第几格（严格递增） */
  slot: number[][];
  /** 轴上第 s 格是各声部的第几小节；那一格没有该声部的小节为 -1 */
  local: number[][];
  /** 各组在轴上从第几格起、占几格（不按组排时整首一组） */
  groups: { start: number; length: number }[];
  /** 是不是按组排的（false = 按小节序号一一对应） */
  grouped: boolean;
}

/** 由各声部各小节的组号排时间轴。`systems[p][i]` 为 undefined 的沿用前一小节的组；有声部首小节没有组号、或只有一个声部时按序号一一对应。 */
export function axisOf(systems: readonly (readonly (number | undefined)[])[]): TimeAxis {
  const grouped = systems.length > 1 && systems.every((s) => s.length === 0 || s[0] !== undefined);
  if (!grouped) {
    const length = Math.max(0, ...systems.map((s) => s.length));
    const slot = systems.map((s) => s.map((_, i) => i));
    const local = systems.map((s) => Array.from({ length }, (_, i) => (i < s.length ? i : -1)));
    return { length, slot, local, groups: [{ start: 0, length }], grouped };
  }
  /** 各声部各小节所属的组、在组内第几小节 */
  const at = systems.map((s) => {
    let sys = s[0]!;
    let k = -1;
    return s.map((v) => {
      if (v !== undefined && v !== sys) {
        sys = v;
        k = -1;
      }
      return { sys, k: ++k };
    });
  });
  const size = new Map<number, number>();
  for (const part of at) for (const { sys, k } of part) size.set(sys, Math.max(size.get(sys) ?? 0, k + 1));
  const start = new Map<number, number>();
  const groups: TimeAxis["groups"] = [];
  let length = 0;
  for (const sys of [...size.keys()].sort((a, b) => a - b)) {
    start.set(sys, length);
    groups.push({ start: length, length: size.get(sys)! });
    length += size.get(sys)!;
  }
  const slot = at.map((part) => part.map(({ sys, k }) => start.get(sys)! + k));
  const local = slot.map((s) => {
    const out = new Array<number>(length).fill(-1);
    s.forEach((g, i) => (out[g] = i));
    return out;
  });
  return { length, slot, local, groups, grouped };
}

/** 一首的时间轴（按 `Song.parts` 的次序）。 */
export function axisOfSong(song: Song): TimeAxis {
  return axisOf(song.parts.map((p) => p.measures.map((m) => m.print?.system)));
}

/** 一个声部的小节按轴摊开：没有小节的格为 undefined。 */
export function spreadOnAxis<T>(items: readonly T[], slots: readonly number[], length: number): (T | undefined)[] {
  const out = new Array<T | undefined>(length).fill(undefined);
  items.forEach((it, i) => (out[slots[i]!] = it));
  return out;
}
