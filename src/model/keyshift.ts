// 文本谱曲中转调 `"k:2"`：新调主音在主调里的级数 ↔ 小节调号（`Measure.attrs.key`）。
// 按五度圈算：级数对应的五度数加到主调的 fifths 上，拼写因此唯一（`k:#4` 与 `k:b5` 是两个调），往返不丢。

import { MusicCommon } from "../score/jppitch";
import type { Key, Song } from "./doc";

/** 各级（1..7）相对主音的五度数 */
const DEGREE_FIFTHS = [0, 2, 4, -1, 1, 3, 5];

/** 首调号的 fifths。文本谱读进来的只记拼写（`fifths` 留 0），按拼写补算 */
export function songFifths(song: Song): number {
  const k = song.key;
  if (!k) return 0;
  if (k.fifths !== 0 || !k.spelling) return k.fifths;
  const f = MusicCommon.keyNameToFifth(k.spelling);
  return f >= -7 && f <= 7 ? f : 0;
}

/** `k:#4` → 新调号。超出 ±7 的（`1=B` 里 `k:#5`）按同音换成 ±7 以内的拼写 */
export function keyOfDegree(home: number, degree: string): Key | undefined {
  const m = /^([#b]?)([1-7])$/.exec(degree);
  if (!m) return undefined;
  let f = home + DEGREE_FIFTHS[Number(m[2]) - 1]! + (m[1] === "#" ? 7 : m[1] === "b" ? -7 : 0);
  while (f > 7) f -= 12;
  while (f < -7) f += 12;
  return { fifths: f, spelling: MusicCommon.keys[f + 7]! };
}

/** `keyOfDegree` 的逆：新调号 → 级数写法（`2`、`#4`、`b7`） */
export function degreeOfKey(home: number, fifths: number): string {
  let d = fifths - home;
  while (d > 12) d -= 12;
  while (d < -8) d += 12;
  const acc = d >= 6 ? "#" : d <= -2 ? "b" : "";
  const base = acc === "#" ? d - 7 : acc === "b" ? d + 7 : d;
  return acc + String(DEGREE_FIFTHS.indexOf(base) + 1);
}
