// 歌词音节的量宽与落笔：旧简谱引擎、原样文档、五线谱/混排共用一份。
//
// 一个音节切成「前标点 / 主体 / 后标点」三段（`“凡`、`召：`、`主,`），**按主体居中**对音符，
// 两头的标点挂出去。宽度与逐字笔位一律取**标点挤压后**的那一串（`Font.run`，规则在 common/cjkpunct.ts），
// 量宽与绘制同一串坐标——挤压档由样式键 `lrc-punct-compress`（halfwidth / clreq / none）选。
// 原先三路三套：旧简谱引擎按 `LYRIC_SPLIT_PUNCT` 切、混排把首尾所有非汉字（连英文字母）都当标点、
// 原样文档按未挤压的主体宽居中却按挤压后的笔位画。
import type { CompressMode } from "../common/cjkpunct";
import { LYRIC_SPLIT_PUNCT, MIXED_PUNCT } from "../common/cjkpunct";
import type { Font } from "../layout/font";

/** 音节首尾当标点挂出去的字（两份表的并集：旧简谱引擎那份含数字与半角标点，混排那份含书名号括号与顿号）。 */
export const LYRIC_EDGE_PUNCT = [...new Set([...LYRIC_SPLIT_PUNCT, ...MIXED_PUNCT])].join("");

export interface SyllableRun {
  /** 逐字（按码点）落笔点，相对音节起点；`none` 档或单字时为 null（连排）。 */
  xs: number[] | null;
  width: number;
  /** 前标点 / 主体 / 后标点三段宽。 */
  lead: number;
  body: number;
  tail: number;
}

/** 量一个音节。`compress = "none"` 不挤压（逐字按 advance 连排）。 */
export function syllableRun(text: string, font: Font, compress: CompressMode): SyllableRun {
  const chars = [...text];
  let nl = 0, nc = chars.length;
  if (chars.length > 1) {
    let pos = 0;
    while (pos < chars.length && LYRIC_EDGE_PUNCT.includes(chars[pos]!)) pos++;
    nl = pos;
    while (pos < chars.length && !LYRIC_EDGE_PUNCT.includes(chars[pos]!)) pos++;
    nc = pos - nl;
  }
  const { xs, width } = compress !== "none"
    ? font.run(text, compress)
    : { xs: chars.map((_, i) => font.measureText(chars.slice(0, i).join(""))), width: font.measureText(text) };
  const at = (i: number): number => (i <= 0 ? 0 : i >= xs.length ? width : xs[i]!);
  return {
    xs: compress !== "none" && xs.length > 1 ? xs : null,
    width,
    lead: at(nl),
    body: at(nl + nc) - at(nl),
    tail: width - at(nl + nc),
  };
}

/**
 * 相邻两个音节之间要不要补一个**西文词间空格**（三引擎共用的判据）。中文一字一格挨着排没问题，
 * 西文照中文挨排就成了 `love,andjoy?`、`十love`。交界的任一侧是西文——后一个以西文字母开头，
 * 或前一个以西文字母/数字收尾（后面可以跟半角标点；`主啊,` 这种中文带半角逗号的不算）——就补；
 * 前一个以连字符 `-` 收尾的是词中断开的音节，不补。
 */
export function latinWordBreak(prev: string, next: string): boolean {
  if (!prev || !next || prev.endsWith("-")) return false;
  return /^[A-Za-zÀ-ɏ]/.test(next) || /[A-Za-zÀ-ɏ0-9][,.;:!?'")]*$/.test(prev);
}
