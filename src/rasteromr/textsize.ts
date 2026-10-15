// 位图上一行字的字高：在二值图上量文字框里墨迹的上下沿。OCR 的检测框带留白（页眉小字的框高能有字高的两倍），
// 不能直接当字高；歌词那边按格量（`lyric.ts` 的 `charH`），这里给页眉、文字指示、和弦用。
//
// 口径与歌词的 `charH` 一致——**汉字墨迹高**：`SPage.textEm` 再折成字号。整行没有汉字的按字母的上下伸展折成汉字当量。
import type { Binary, Rect } from "../omrkit/types";

/** 汉字墨迹约占字号的这么多（同 `SPage.textEm` 的口径） */
const CJK_INK = 0.85;
/** 拉丁字母墨迹占字号：x 高约 0.5，有大写 / 升部（数字同）到 0.72，有下伸部再加 0.21 */
const LATIN_X = 0.5;
const LATIN_ASC = 0.72;
const LATIN_DESC = 0.21;
/** 一行里墨迹占到框宽这么多的行当成线（谱线、加线、松叶的横笔压进框里），不算字 */
const LINE_ROW = 0.7;
/** 字里的空行（「三」笔画之间、「i」的点下）不过这么多像素仍算同一段 */
const ROW_GAP = 2;

/** 框里文字的墨迹高（汉字当量，像素）。框里没有墨迹返回 0 */
export function inkTextSize(bin: Binary, box: Rect, text: string): number {
  const x0 = Math.max(0, Math.round(box.x)), x1 = Math.min(bin.w, Math.round(box.x + box.w));
  const y0 = Math.max(0, Math.round(box.y)), y1 = Math.min(bin.h, Math.round(box.y + box.h));
  const w = x1 - x0;
  if (w <= 0 || y1 <= y0) return 0;
  // 最长的一段有墨的行（中间空不过 `ROW_GAP` 行）
  let best = 0, start = -1, last = -1;
  for (let y = y0; y < y1; y++) {
    let n = 0;
    const row = y * bin.w;
    for (let x = x0; x < x1; x++) n += bin.data[row + x]!;
    if (n === 0 || n > w * LINE_ROW) continue;
    if (start < 0 || y - last > ROW_GAP + 1) start = y;
    last = y;
    best = Math.max(best, last - start + 1);
  }
  if (/[\u3400-\u9fff]/.test(text)) return best;
  // 整行没有汉字：按有没有大写 / 升部、下伸部定墨迹占字号多少，折成汉字当量
  const frac = (/[A-Z0-9bdfhklt]/.test(text) ? LATIN_ASC : LATIN_X) + (/[gjpqy]/.test(text) ? LATIN_DESC : 0);
  return (best * CJK_INK) / frac;
}
