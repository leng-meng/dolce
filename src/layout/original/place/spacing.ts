// 横向排列：多声部按拍位对齐、歌词防撞、两端对齐，解出每个符号的最终 x。
import type { LyricLine } from "../../../pu/ast";
import type { JianpuGrid } from "../metrics";
import { latinWordBreak } from "../../../engrave/syllable";
import type { InkMeasurer, PlacedItem } from "./model";

/** 西文词间空格 ÷ 歌词字号（常见无衬线字体的空格宽约 0.28 em）。 */
export const LATIN_SPACE_EM = 0.28;

/** 相邻两字（含尾随标点）的**墨迹**之间至少留这么多，按歌词字号计（伸出量由绘制端按墨迹注入）。
 *  量墨迹而不量字面框：汉字字面框左右自带留白，按框约束会把墨迹根本没碰到的行也撑开
 * （按框加 0.12 em 时有 62 组原本不挤的谱行被动，含对照原书 PDF 对过的《圣哉三一歌》长图）。
 *  也不能取 0：墨迹恰好相碰（「日|子」）照样是挤在一起的字。 */
export const LYRIC_MIN_GAP_EM = 0.1;
/** 为给歌词让位，音符步进最多压到两端对齐算出的系数的这么多倍；再撑不下就让这一行超宽。 */
const LYRIC_MIN_SCALE_RATIO = 0.6;

/**
 * 两端对齐 + 歌词防重叠，一次解出每个符号的最终 x。
 *
 * 横向步进只按拍值走（layoutVoiceLine），**不看字宽**：两个四分音符挂「荣耀，」「哈利路亚」
 * 这类长音节会叠在一起，行被压缩（超宽）时更甚。从前的做法是整行乘一个缩放系数了事。
 *
 * 这里把各声部的符号 x 归并成**共享的列**（多声部已按拍位对齐，同拍位 x 相同），
 * 列的位置取「前一列 + 系数 × 自然步进」与「同声部同一段里前一个有字的列 + 两字半宽 + 间隙」
 * 的较大者。总宽随系数单调，二分找系数让总宽落到目标宽度：
 * 两端对齐的行等于原来的目标宽；不拉伸的行（番茄）不超版心就保持原系数。
 * **不相撞的行解出来就是原来的系数**，落点一点不动（《圣哉三一歌》对照原书 PDF 对过）。
 * 音符压到 `LYRIC_MIN_SCALE_RATIO` 仍放不下（光歌词就比版心宽）时，歌词约束按比例打折守住版心。
 */
export function placeColumns(
  lines: ReadonlyArray<{ items: PlacedItem[]; width: number }>,
  lyrics: ReadonlyArray<readonly LyricLine[]>,
  scale: number,
  stretchable: boolean,
  width: number,
  m: JianpuGrid,
  ink: InkMeasurer,
): void {
  const natural = Math.max(...lines.map((l) => l.width), 1);
  const apply = (xs: (x: number) => number, s: number): void => {
    for (const l of lines) {
      for (const it of l.items) {
        it.x = xs(it.x);
        it.advance *= s;
      }
    }
  };
  // 共享列：各声部符号 x 的并集（自然坐标）
  const EPS = 0.01;
  const cols = [...new Set(lines.flatMap((l) => l.items.map((it) => it.x)))].sort((a, b) => a - b);
  const colsU: number[] = [];
  for (const x of cols) if (colsU.length === 0 || x - colsU[colsU.length - 1]! > EPS) colsU.push(x);
  const colOf = (x: number): number => {
    let lo = 0;
    let hi = colsU.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (colsU[mid]! <= x + EPS) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // 歌词约束：同声部同一段里相邻两个有字的符号，列距至少 D
  const gap = m.style.size.lyric * LYRIC_MIN_GAP_EM;
  const need = new Map<number, Array<{ from: number; d: number }>>();
  lines.forEach((l, vi) => {
    const verses = lyrics[vi]?.length ?? 0;
    for (let v = 0; v < verses; v++) {
      let prev: { col: number; right: number; text: string } | null = null;
      for (const it of l.items) {
        const syl = it.syllables[v];
        if (!syl) continue;
        const e = ink.lyric(syl);
        const col = colOf(it.x);
        if (prev && col > prev.col) {
          // 西文词与词之间补一个空格宽（判据同简谱引擎，engrave/syllable.ts::latinWordBreak）
          const d = prev.right + e.left + gap + (latinWordBreak(prev.text, syl.text) ? m.style.size.lyric * LATIN_SPACE_EM : 0);
          const list = need.get(col) ?? [];
          list.push({ from: prev.col, d });
          need.set(col, list);
        }
        prev = { col, right: e.right, text: syl.text };
      }
    }
  });
  // 列位置。f 是歌词约束的折扣（1 = 足额；只有整行放不进版心时才往下打）。
  const positions = (s: number, f = 1): { X: number[]; raised: boolean } => {
    const X = new Array<number>(colsU.length).fill(0);
    X[0] = s * colsU[0]!;
    let raised = false;
    for (let c = 1; c < colsU.length; c++) {
      let x = X[c - 1]! + s * (colsU[c]! - colsU[c - 1]!);
      for (const { from, d } of need.get(c) ?? []) {
        const want = X[from]! + d * f;
        if (want > x + 1e-9) {
          x = want;
          raised = true;
        }
      }
      X[c] = x;
    }
    return { X, raised };
  };
  const totalOf = (X: number[], s: number): number =>
    X[X.length - 1]! + s * (natural - colsU[colsU.length - 1]!);
  const first = positions(scale);
  // 没有哪一列被歌词撑开：照老样子整行乘系数。逐列累加与直接相乘在末位上会差 0.01，
  // 不相撞的行就该一个坐标都不动。
  if (!first.raised) {
    apply((x) => x * scale, scale);
    return;
  }
  const target = stretchable ? natural * scale : Math.min(totalOf(first.X, scale), width);
  /** total 随参数单调增：二分取总宽不超过 target 的最大参数。 */
  const largest = (lo: number, hi: number, total: (v: number) => number): number => {
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (total(mid) > target) hi = mid;
      else lo = mid;
    }
    return lo;
  };
  let s = scale;
  let f = 1;
  if (totalOf(first.X, s) > target + EPS) {
    // 压音符步进给歌词让位
    const sMin = scale * LYRIC_MIN_SCALE_RATIO;
    if (totalOf(positions(sMin).X, sMin) <= target) {
      s = largest(sMin, scale, (v) => totalOf(positions(v).X, v));
    } else {
      // 音符压到底，光歌词还是比版心宽（窄纸上一串长英文词）：歌词约束按比例打折，
      // 整行守住版心——字挨得更紧、甚至微叠，也不能伸出纸外被裁掉
      s = sMin;
      f = largest(0, 1, (v) => totalOf(positions(sMin, v).X, sMin));
    }
  }
  const X = positions(s, f).X;
  apply((x) => X[colOf(x)]!, s);
}

/**
 * 多声部横向对齐：同一拍位的符号推到同一个 x。
 *
 * 各声部时值往往不同（长音对切分音），所以按「小节序号 + 小节内累计拍数」做键，
 * 而不是按序号。做法是**按拍位归并扫描**：键从早到晚处理，每个键的列 x 取各声部
 * 当前位置的最大值，然后把落后的声部整体右推。
 *
 * （早先的写法用「位移前」的 x 预先算好目标，一行被推右之后后续列不会再跟进，
 * 于是越往后越对不齐——必须边扫边更新。）
 */
export function alignVoices(lines: Array<{ items: PlacedItem[]; width: number }>): void {
  // 小节线用 `bar:∞` 作键——它是各声部**共享**的结构，第 n 条就该对齐到同一个 x，
  // 哪怕各声部这一小节的拍数对不上（源里写岔了也该看得出来是同一条线）。
  const keysOf = (items: PlacedItem[]): string[] => {
    let bar = 0;
    return items.map((it) => {
      if (it.element.kind === "barline") {
        const key = `${bar}:Infinity`;
        bar += 1;
        return key;
      }
      return `${bar}:${it.beat.toFixed(4)}`;
    });
  };
  const keys = lines.map((l) => keysOf(l.items));
  // 每行每个键取**首次**出现的位置（同拍位的重复项跟着走即可）
  const indexByKey = keys.map((ks) => {
    const m = new Map<string, number>();
    ks.forEach((k, i) => {
      if (!m.has(k)) m.set(k, i);
    });
    return m;
  });
  const allKeys = [...new Set(keys.flat())].sort((a, b) => {
    const [ba, pa] = a.split(":").map(Number) as [number, number];
    const [bb, pb] = b.split(":").map(Number) as [number, number];
    return ba - bb || pa - pb;
  });

  const delta = lines.map(() => 0);
  const cursor = lines.map(() => 0);
  for (const key of allKeys) {
    // 把各行落在本键之前的符号先按当前位移定位
    lines.forEach((l, li) => {
      const at = indexByKey[li]!.get(key);
      if (at === undefined) return;
      for (; cursor[li]! < at; cursor[li]!++) l.items[cursor[li]!]!.x += delta[li]!;
    });
    let colX = -Infinity;
    lines.forEach((l, li) => {
      const at = indexByKey[li]!.get(key);
      if (at !== undefined) colX = Math.max(colX, l.items[at]!.x + delta[li]!);
    });
    if (colX === -Infinity) continue;
    lines.forEach((l, li) => {
      const at = indexByKey[li]!.get(key);
      if (at === undefined) return;
      delta[li] = colX - l.items[at]!.x;
      l.items[at]!.x = colX;
      cursor[li] = at + 1;
    });
  }
  lines.forEach((l, li) => {
    for (; cursor[li]! < l.items.length; cursor[li]!++) l.items[cursor[li]!]!.x += delta[li]!;
    l.width += delta[li]!;
  });
  const w = Math.max(...lines.map((l) => l.width));
  for (const l of lines) l.width = w;
}
