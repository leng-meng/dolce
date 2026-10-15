// 谱面上的**文字指示**（rit. / a tempo / cresc. / dim. / 速度语 / Fine / D.S. al Coda / unis. …）与节拍器记号：切条、算指纹、归位。
//
// 与声部标签（`stafflabel.ts`）同一套架构：**只按固定几何裁带**（两行谱之间的整段空当、页首行上方、页末行下方），
// 定位与认字交给 DBNet + rec，离线按条的内容指纹落盘（`gen-rasterwords.mjs` → `rasterwords.json`），识别时查缓存。
// 带里还压着歌词、和弦字母、力度字母、小节号——这里按内容分开：只留拉丁文的词句，歌词行、纯数字、力度字母不要。
import type { Binary, Rect } from "../omrkit/types";
import { isCreditText, type WordLine } from "../omrkit/headertext";
import { recoverSpacesByInk } from "../omrkit/textspace";
import type { Box, SPage, Staff } from "../staffomr/model";
import type { StaffNote } from "../staffomr/notedata";
import { chordCoverage, isChordLineCoverage, isWholeChord } from "../omrkit/chordgrammar";
import type { RasterUnit } from "./staffline";
import { contentKey } from "../omrkit/contentkey";

/** 一条文字带：裸像素 + 它在页面上的盒。 */
export interface WordStrip {
  w: number;
  h: number;
  /** 逐像素 0/1，长 `w*h`，1 = 墨。 */
  data: Uint8Array;
  box: Rect;
  /** 声部名带（`findNameStrips`）：指纹前缀与挑行口径另算（中文名也留，`keepStripLine`） */
  name?: boolean;
}

/** 页首行上方、页末行下方各取这么多格；两行谱之间取整段空当，上下各让开谱线这么多格。 */
const EDGE_BAND = 7;
const LINE_CLEAR = 0.15;
/** 带的左右：谱行左缘往左这么多格（行首上方的速度语常比谱号还靠左）到右缘往右这么多格。 */
const SIDE = 2;

/**
 * 裁出各条文字带。**几何是死的**（只看谱行的盒），同一页跑几次裁出来一模一样，指纹才稳。
 */
export function findWordStrips(bin: Binary, staves: { box: { left: number; right: number; top: number; bottom: number } }[], unit: RasterUnit): WordStrip[] {
  const sp = unit.space;
  const rows = [...staves].sort((a, b) => a.box.top - b.box.top);
  const out: WordStrip[] = [];
  const cut = (y0: number, y1: number, left: number, right: number) => {
    const box = {
      x: Math.max(0, Math.round(left - sp * SIDE)),
      y: Math.max(0, Math.round(y0)),
      w: 0,
      h: 0,
    };
    box.w = Math.min(bin.w, Math.round(right + sp * SIDE)) - box.x;
    box.h = Math.min(bin.h, Math.round(y1)) - box.y;
    if (box.w < 8 || box.h < sp * 1.2) return;
    const data = new Uint8Array(box.w * box.h);
    let ink = 0;
    for (let y = 0; y < box.h; y++)
      for (let x = 0; x < box.w; x++) {
        const v = bin.data[(box.y + y) * bin.w + box.x + x];
        data[y * box.w + x] = v;
        ink += v;
      }
    if (ink) out.push({ w: box.w, h: box.h, data, box });
  };
  rows.forEach((st, i) => {
    const prev = rows[i - 1];
    // 左右并排的两行谱（同一高度）不算上下邻行
    const above = prev && prev.box.bottom < st.box.top ? prev : undefined;
    if (above) cut(above.box.bottom + sp * LINE_CLEAR, st.box.top - sp * LINE_CLEAR, Math.min(above.box.left, st.box.left), Math.max(above.box.right, st.box.right));
    else cut(st.box.top - sp * EDGE_BAND, st.box.top - sp * LINE_CLEAR, st.box.left, st.box.right);
    if (i === rows.length - 1) cut(st.box.bottom + sp * LINE_CLEAR, st.box.bottom + sp * EDGE_BAND, st.box.left, st.box.right);
  });
  return out;
}

/** 声部名带往左伸到全页最靠左那行谱的左缘再往左这么多格（不缩进的系统，缩写印在页边）；右界让开花括号、方括号这么多格 */
const NAME_REACH = 8;
const NAME_CLEAR = 1.5;

/**
 * **声部名带**：每个系统谱行左边那一段（首行缩进里的全名「Soprano Alto」「Piano」、以后各行页边的缩写「S. A.」），
 * 上下到系统首尾谱行外一格。认字同文字指示带（同一个缓存、同一套 OCR），名字归哪个声部由 `staffomr/score.ts::nameParts` 按纵向定。
 */
export function findNameStrips(bin: Binary, systems: { staves: { box: { left: number; top: number; bottom: number } }[] }[], unit: RasterUnit): WordStrip[] {
  const sp = unit.space;
  const lefts = systems.flatMap((s) => s.staves.map((st) => st.box.left));
  if (!lefts.length) return [];
  const pageLeft = Math.min(...lefts);
  const out: WordStrip[] = [];
  for (const sys of systems) {
    if (!sys.staves.length) continue;
    const left = Math.min(...sys.staves.map((st) => st.box.left));
    const x0 = Math.max(0, Math.round(pageLeft - sp * NAME_REACH));
    const x1 = Math.round(left - sp * NAME_CLEAR);
    const y0 = Math.max(0, Math.round(Math.min(...sys.staves.map((st) => st.box.top)) - sp));
    const y1 = Math.min(bin.h, Math.round(Math.max(...sys.staves.map((st) => st.box.bottom)) + sp));
    if (x1 - x0 < sp * 2 || y1 - y0 < sp * 2) continue;
    const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const data = new Uint8Array(box.w * box.h);
    let ink = 0;
    for (let y = 0; y < box.h; y++)
      for (let x = 0; x < box.w; x++) {
        const v = bin.data[(box.y + y) * bin.w + box.x + x];
        data[y * box.w + x] = v;
        ink += v;
      }
    if (ink) out.push({ w: box.w, h: box.h, data, box, name: true });
  }
  return out;
}

/** 声部名的一块里上下两行之间的空不超过行高的这么多倍（「Soprano」「Alto」叠成一个名字） */
const NAME_STACK_GAP = 0.8;

/**
 * 声部名带里读出来的行 → 页面上的名字块（页面坐标，字号按墨迹量）。上下叠着、左右相交的行并成一块（多行名用换行连）；
 * 只要像名字的：有拉丁字母或汉字（「女低」）、不是力度字母（行首的 `p`、`mf`）。
 */
export function partNameLines(pg: SPage, strips: readonly WordStrip[], ocr: ReadonlyMap<string, WordLine[]>): { text: string; box: Box; size: number }[] {
  const out: { text: string; box: Box; size: number }[] = [];
  for (const strip of strips) {
    const lines = (ocr.get(wordKey(strip)) ?? [])
      .map((l) => ({ t: l.t.trim(), x: strip.box.x + l.x, y: strip.box.y + l.y, w: l.w, h: l.h }))
      .filter((l) => NAME_CHAR_RE.test(l.t) && !/^(ppp|pp|p|mp|mf|fff|ff|f|sfz|sf|fz|fp)$/.test(l.t))
      .sort((a, b) => a.y - b.y);
    const blocks: (typeof lines)[] = [];
    for (const l of lines) {
      const b = blocks.find((bl) => {
        const last = bl[bl.length - 1]!;
        return l.y - (last.y + last.h) < Math.min(l.h, last.h) * NAME_STACK_GAP && l.x < last.x + last.w && last.x < l.x + l.w;
      });
      if (b) b.push(l);
      else blocks.push([l]);
    }
    for (const bl of blocks) {
      const sizes = bl.map((l) => pg.inkTextSize?.({ x: l.x, y: l.y, w: l.w, h: l.h }, l.t) || l.h);
      out.push({
        text: bl.map((l) => l.t).join("\n"),
        box: {
          left: Math.min(...bl.map((l) => l.x)),
          right: Math.max(...bl.map((l) => l.x + l.w)),
          top: bl[0]!.y,
          bottom: Math.max(...bl.map((l) => l.y + l.h)),
        },
        size: Math.max(...sizes),
      });
    }
  }
  return out;
}

/** 页眉带：`creditFrom` 是首行谱上方那一段在带里的起点（拼页面那一路没有这一段）。 */
export type HeaderStrip = WordStrip & { creditFrom?: number };

/**
 * **页眉带**（曲首页）：页顶 → 首行谱上沿（让开谱线 `LINE_CLEAR`），整页宽——标题、副标题、书眉、词曲作者、译者。
 * 下沿从谱上沿往上找第一条空白行（墨不过两点），免得把一行字拦腰切开；几何只看谱行与像素，指纹稳。
 * 与文字指示带同一套认字（DBNet + rec），缓存另放（`gen-rasterheader.mjs` → `rasterheader.json`）：那边只留拉丁行，这边中文也要。
 *
 * - **首行谱上方 `EDGE_BAND` 格以内这一段**也进带（`creditFrom` 标出它在带里的起点）：紧贴谱表印的小字署名块
 *   （新编赞美诗「刘廷芳译 1934」「(Thomas Hastings)」、伴奏谱「伴奏编写：陈尚哲」、父恩广大三行英文署名）都在这里；
 *   这一段也是首行文字指示带（速度、和弦、表情），里面的行由 `headerZoneLines` 挑——像署名的归页眉，其余照旧归文字指示。
 *   上面那段切不出（`EDGE_BAND` 以上没有空白行、或贴着页顶）就整条不切，照旧走拼页面那条路。
 * - **扫描件页边带着贯穿上下的竖条**（破碎扫描版右缘一道 80 点宽的网点灰带，每行十几二十点墨）：没有一行墨不过两点，
 *   往上一路找到页顶。判空白行时不数页边「这一段里平均每列一成以上的行有墨」的列（`HEADER_BORDER`）。
 * - 密排的序言曾被凑成一行假谱表、把页眉带截在标题下面：找谱线之前已按文字框剔掉（`pagetext.ts`）。
 */
export function findHeaderStrip(bin: Binary, staves: { box: { top: number } }[], unit: RasterUnit): HeaderStrip | null {
  if (!staves.length) return null;
  const sp = unit.space;
  const top = Math.min(...staves.map((s) => s.box.top));
  let y1 = Math.min(bin.h - 1, Math.round(top - sp * LINE_CLEAR));
  let y0 = Math.min(y1, Math.round(top - sp * EDGE_BAND));
  if (y0 < sp * 2) return null;
  // 页边的竖条：页顶到谱上沿这一段里，按两格宽滑窗平均、墨行占比过 `HEADER_BORDER` 的列，只看左右各 `HEADER_MARGIN` 页宽
  const colInk = new Uint32Array(bin.w + 1);
  for (let y = 0; y <= y1; y++) for (let x = 0; x < bin.w; x++) colInk[x + 1] += bin.data[y * bin.w + x];
  for (let x = 1; x <= bin.w; x++) colInk[x] += colInk[x - 1];
  const half = Math.max(1, Math.round(sp));
  const border = new Uint8Array(bin.w);
  for (let x = 0; x < bin.w; x++) {
    if (x > bin.w * HEADER_MARGIN && x < bin.w * (1 - HEADER_MARGIN)) continue;
    const a = Math.max(0, x - half);
    const b = Math.min(bin.w, x + half + 1);
    border[x] = colInk[b] - colInk[a] > (b - a) * (y1 + 1) * HEADER_BORDER ? 1 : 0;
  }
  const inkOf = (y: number) => {
    let n = 0;
    for (let x = 0; x < bin.w && n <= HEADER_BLANK; x++) if (!border[x]) n += bin.data[y * bin.w + x];
    return n;
  };
  // 往上退到空白行，最多退 `HEADER_RETREAT` 格：排得密的页眉（晨曦破晓左右两栏署名与标题、题记上下交错）一整段找不到空白行，
  // 一路退会退到页顶、整条页眉只剩几十点高——退不到就照原线切，被切到的行按行心归哪段
  const retreat = (y: number, floor: number) => {
    let t = y;
    while (t > floor && y - t <= sp * HEADER_RETREAT && inkOf(t) > HEADER_BLANK) t--;
    return inkOf(t) <= HEADER_BLANK ? t : y;
  };
  y0 = retreat(y0, 0);
  if (y0 < sp * 2) return null;
  y1 = retreat(y1, y0);
  const box = { x: 0, y: 0, w: bin.w, h: y1 };
  const data = new Uint8Array(box.w * box.h);
  let ink = 0;
  for (let i = 0; i < data.length; i++) ink += data[i] = bin.data[i];
  return ink ? { w: box.w, h: box.h, data, box, creditFrom: y0 } : null;
}

/**
 * 页眉带里**首行谱上方那一段**（`creditFrom` 以下）读出来的行，哪些归页眉：像署名的——
 * 带汉字的要有职能字 / 年份 / 冒号（「刘廷芳译 1934」「伴奏编写：陈尚哲」「颂主诗集 1931」），
 * 拉丁的是括号原名、`Words by` 一类，或两词以上、多半首字母大写的名字（「Chinese Traditional Melody」「Chao Tzu-Chen」）；
 * 再加**续行**：紧接在已收的署名行下面、与它左对齐或右对齐的行（「Song of The Hoe」「Psalmodia Sacra, Goths 1715」）。
 * 拉丁的另收全大写的曲调名、带四位年份的行（「1795-1848」）；**居中**的行（副标题、题记「Be still and know that I am God.」）
 * 照收——速度、表情都印在谱首、不居中。
 * 和弦、节拍器、力度、文字指示术语（含中文的「齐唱」「感恩地」）一概不收（留给文字指示带）——`creditFrom` 以上也不收：
 * 「感恩地」印在速度旁边、比谱上方 7 格还高。返回留下的行。
 */
export function headerZoneLines<L extends WordLine>(lines: readonly L[], creditFrom: number, stripW: number): L[] {
  const inZone = (l: L) => l.y + l.h / 2 > creditFrom;
  const centered = (l: L) => Math.abs(l.x + l.w / 2 - stripW / 2) <= stripW * 0.15;
  const music = (t: string) => {
    const s = t.trim();
    if (METRO_RE.test(s) || DYNAMIC_RE.test(s) || DIRECTION_RE.test(s) || CN_EXPRESSION_RE.test(s)) return true;
    const { cov, count } = chordCoverage(s.replace(/\s+/g, ""));
    return isChordLineCoverage(cov, count);
  };
  const looksCredit = (t: string) => {
    if (music(t)) return false;
    if (/[\u3400-\u9fff]/.test(t)) return /[词詞曲译譯编編修配写寫作选選据據改源]|\d{2,}|[:：]/.test(t);
    if (isCreditText(t, true, true) || /\d{4}/.test(t) || SCRIPTURE_REF_RE.test(t)) return true;
    const words = t.match(/[A-Za-z][A-Za-z'’.-]*/g) ?? [];
    // 右上角全大写的曲调名（「AZMON」「DIX」「FINLANDIA」）
    if (words.length && words.every((w) => !/[a-z]/.test(w)) && words.join("").length >= 3) return true;
    // 人名、出处：两词以上、首字母大写的过三分之一（补空格把字距拉开的词切碎时，小写碎片会多出来）
    const caps = words.filter((w) => /^[A-Z]/.test(w)).length;
    return words.length >= 2 && caps >= 2 && caps * 3 >= words.length;
  };
  const kept = lines.filter((l) => (!inZone(l) || looksCredit(l.t) || centered(l)) && !music(l.t));
  const zone = lines.filter((l) => inZone(l) && !kept.includes(l)).sort((a, b) => a.y - b.y);
  for (const l of zone) {
    if (music(l.t)) continue;
    const near = kept.some((k) => {
      const gap = l.y - (k.y + k.h);
      const tol = Math.max(k.h, l.h) * 1.5;
      return gap >= -k.h * 0.3 && gap <= Math.max(k.h, l.h) && (Math.abs(l.x - k.x) <= tol || Math.abs(l.x + l.w - (k.x + k.w)) <= tol);
    });
    if (near) kept.push(l);
  }
  return lines.filter((l) => kept.includes(l));
}
/** 经文 / 诗篇出处：「Psalm 23」「— Ephesians 2:7」。 */
const SCRIPTURE_REF_RE = /^[—–-]?\s*(?:[1-3I]{1,3}\s*)?[A-Z][a-z]+\.?\s*\d+(?:\s*:\s*\d+)?\s*$/;
/** 中文的演唱 / 表情提示：「齐唱」「合唱」「间奏」「感恩地」「温柔有感情的」（以「地 / 的」收尾的状语）。 */
const CN_EXPRESSION_RE = /^[(（]?(?:齐唱|齊唱|合唱|独唱|獨唱|领唱|領唱|轮唱|輪唱|副歌|间奏|間奏|前奏|尾声|尾聲|[\u3400-\u9fff]{1,6}[地的])[)）]?$/;
/** 页眉带的上下界往上找空白行，最多退这么多格。 */
const HEADER_RETREAT = 3;
/** 页眉带下沿的「空白行」：一行墨不过这么多点（扫描件的零星噪点）。 */
const HEADER_BLANK = 2;
/** 页边竖条：页眉那一段里平均每列有墨的行占这么多以上（实心黑边、扫描的网点灰带；页眉字行稀，一列不过几个百分点）。 */
const HEADER_BORDER = 0.1;
/** 竖条只在页边找：左右各这么宽（页宽的比例）。 */
const HEADER_MARGIN = 0.12;

/** 条的内容指纹（与 `stafflabel.ts::labelKey` 同一套：尺寸 + FNV-1a）。声部名带另用前缀（挑行口径不同，同一块像素不能共用一条缓存）。 */
export function wordKey(s: WordStrip): string {
  return contentKey(s.name ? "N" : "W", s.w, s.h, s.data);
}

/** 声部名里有的字：拉丁字母或汉字 */
const NAME_CHAR_RE = /[A-Za-z\u3400-\u9fff]/;

/** 这条带该存的行：文字指示带按 `keepWordLine`；声部名带中文名也留（「女低」「男低」，带在谱行左边，压不进歌词） */
export function keepStripLine(strip: { name?: boolean }, text: string): boolean {
  return strip.name ? NAME_CHAR_RE.test(text) : keepWordLine(text);
}

/** 值得存进缓存的行：有拉丁字母（力度只有一个字母），或者像节拍器记号（`= 86`）。纯中文行（歌词、署名）、纯数字不存。 */
export function keepWordLine(text: string): boolean {
  return /[A-Za-z]/.test(text) || METRO_RE.test(text);
}

/**
 * rec 不出空格：按字行的**列投影**补——行盒里连着这么宽（行高的 `WORD_GAP` 倍）没有墨的一段就是词界，
 * 空格插在这段空白右边的头一个字之前。逐字位置（`recognizeRegion` 回来的 `cx`，各字的左缘）只有六分之一行高的精度，
 * 拿相邻两字的边界间隙判词界分不开（词内 0~0.34、词间 0.33~0.5），所以只用它定「哪个字在空白右边」。
 */
export function spaceWordText(
  text: string,
  chars: { text: string; cx: number }[] | undefined,
  strip: { w: number; h: number; data: ArrayLike<number> },
  box: { x: number; y: number; w: number; h: number },
): string {
  if (!chars?.length) return text;
  const y0 = Math.max(0, Math.round(box.y));
  const y1 = Math.min(strip.h, Math.round(box.y + box.h));
  const x0 = Math.max(0, Math.round(box.x));
  const x1 = Math.min(strip.w, Math.round(box.x + box.w));
  const gaps: number[] = [];
  let run = 0;
  let seenInk = false;
  for (let x = x0; x < x1; x++) {
    let ink = false;
    for (let y = y0; y < y1 && !ink; y++) ink = strip.data[y * strip.w + x] === 1;
    if (ink) {
      if (seenInk && run >= box.h * WORD_GAP) gaps.push(x - run / 2);
      run = 0;
      seenInk = true;
    } else run++;
  }
  let out = "";
  let g = 0;
  chars.forEach((c, i) => {
    let space = false;
    while (g < gaps.length && gaps[g] < c.cx + box.h * 0.1) {
      space = i > 0;
      g++;
    }
    out += (space ? " " : "") + c.text;
  });
  return out;
}
const WORD_GAP = 0.17;

/**
 * 页眉带的一行补词间空格：与简谱页眉同一份（`omrkit/textspace.ts::recoverSpacesByInk`，按本行空白宽度的跳变定门、
 * 只在字母与字母、字母与数字之间插）——`spaceWordText` 的固定门槛会把字距拉开的年份拆成「1 7 7 6」、把粗体标题粘成
 * 「CountYourBlessings」。在线识别（`ocrlive.ts::ocrHeaderStrips`）与离线缓存（`gen-rasterheader.mjs`）都调这一份。
 */
export function spaceHeaderText(text: string, chars: { text: string; cx: number }[] | undefined, strip: Binary, box: Rect): string {
  return recoverSpacesByInk(strip, text, box, chars, true);
}

/** 力度（另有一路按字形认，`dynamics.ts`；它漏掉的由这里读出来的补）。字行以力度字母起头、后面跟着别的（歌词的头一个字）也算。 */
const DYNAMIC_RE = /^(ppp|pp|p|mp|mf|fff|ff|f|sfz|sf|fz|fp)(?![a-z])/;
/** 文字指示的术语：歌词行里夹着的字行，含这些词的才留。 */
const DIRECTION_RE = /\b(rit|rall|riten|accel|tempo|cresc|decresc|dim|poco|molto|dolce|legato|unis|unison|solo|tutti|div|sim|sub|piu|meno|mosso|espress|cantabile|sost|marc|stacc|fine|coda|segno|slower|faster|broadly|d\. ?[sc])\b/i;
/** 同一高度上有这么多段拉丁文就是一行歌词（歌词带里的门槛低一档）。 */
const LYRIC_ROW = 3;
const LYRIC_ROW_IN_ZONE = 2;
/** 和弦页的门槛：一页里至少这么多行整行是和弦记号、其中至少一行带后缀（`m7`、`/F`…），才把和弦记号从文字里分出去。 */
const CHORD_PAGE_MIN = 3;
/** 两个字母以内也算文字指示的那几样（声部缩写、管风琴键盘名）。 */
const SHORT_RE = /^(S|A|T|B|SA|TB|ST|AB|Ch|Sw|Gt)\.?$/;
/** 短标记的字高下限（格）。 */
const SHORT_MIN_H = 1.3;
/** 上下两行字叠成一条指示：左端对齐（格）、行距不过行高的这么多倍。 */
const STACK_X = 1.5;
const STACK_GAP = 0.6;
/** 节拍器记号：`♩= 86`（音符那个字形 OCR 读不出，只认等号后的数）。 */
const METRO_RE = /=\s*(\d ?\d ?\d?)(?!\d)/;
/** 一行字离它那行谱的距离上限（格）。 */
const REACH = 7;

export interface PlacedWord {
  text: string;
  above: boolean;
  box: Rect;
  note: StaffNote;
}

/** 页脚注的字样：脚注号 `*` 打头、「page 43」、版权、`Words:` / `Tune;`（OCR 常把冒号读成分号）、生卒年 */
const FOOTNOTE_RE = /^\s*[*＊]|\bpage\s*\d|copyright|©|\b(?:words|tune|music)\s*[:;]|\d{4}\s*[-–—]\s*\d{4}/i;

/**
 * 把缓存里的字行归位：定谱行（离哪行近）、定音符（字行左端右边最近的那个音）、落到 `StaffNote.words` / `metronome` 上。
 * 读出来的力度不在这里挂，交回去（`dynamics`）由调用方按力度那一路的判据补。
 *
 * @param skip 已经另有身份的文字盒（歌词行、和弦字母）：中心落在里面的行不要。
 * @param lyricZones 歌词带（切出来的歌词条，不论认没认下来）：判「这一行是英文歌词」时门槛低一档。
 */
export function attachWordLines(
  pg: SPage,
  notes: StaffNote[],
  strips: WordStrip[],
  ocr: Map<string, WordLine[]>,
  unit: RasterUnit,
  skip: Rect[],
  lyricZones: Rect[],
): { words: PlacedWord[]; dynamics: { px: number; py: number; text: string }[]; chords: { text: string; box: Rect }[] } {
  const sp = unit.space;
  const words: PlacedWord[] = [];
  const dynamics: { px: number; py: number; text: string }[] = [];
  const inside = (q: Rect, x: number, y: number) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h;
  // 先收齐各行（页面坐标），同一处被上下两条带各读一遍的只留一份
  const lines: { text: string; box: Rect }[] = [];
  for (const strip of strips)
    for (const l of ocr.get(wordKey(strip)) ?? []) {
      const box = { x: strip.box.x + l.x, y: strip.box.y + l.y, w: l.w, h: l.h };
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      if (lines.some((q) => inside(q.box, cx, cy))) continue;
      lines.push({ text: l.t.replace(/\s+/g, " ").trim(), box });
    }
  lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  // 叠着的两行并成一条（`1st time SA Unison` / `2nd time Parts`）
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i];
    const j = lines.findIndex((b, k) => k > i && Math.abs(b.box.x - a.box.x) <= sp * STACK_X && b.box.y - (a.box.y + a.box.h) <= a.box.h * STACK_GAP && b.box.y > a.box.y + a.box.h * 0.5);
    if (j < 0) continue;
    const b = lines[j];
    if (DYNAMIC_RE.test(a.text) || DYNAMIC_RE.test(b.text)) continue;
    const r = Math.max(a.box.x + a.box.w, b.box.x + b.box.w);
    a.text += "\n" + b.text;
    a.box = { x: Math.min(a.box.x, b.box.x), y: a.box.y, w: r - Math.min(a.box.x, b.box.x), h: b.box.y + b.box.h - a.box.y };
    lines.splice(j, 1);
    i--;
  }
  // 和弦记号（是爱那种谱表上方印和弦的）：整行去掉空格后正好是一个或几个和弦记号。一页里够多才认，
  // 不然单个大写字母（排练号 `A`、`B`，或者把谱号读成的字母）都成了和弦
  const chordOf = (text: string): string[] | null => {
    const toks = text.split(/\s+/).filter(Boolean);
    const whole = text.replace(/\s+/g, "");
    const full = isWholeChord;
    if (full(whole)) return [whole];
    return toks.length > 1 && toks.every(full) ? toks : null;
  };
  const chordLines = lines.filter((l) => chordOf(l.text));
  const chordPage = chordLines.length >= CHORD_PAGE_MIN && chordLines.some((l) => l.text.replace(/\s+/g, "").length > 1);
  const chords: { text: string; box: Rect }[] = [];
  for (const l of lines) {
    const box = l.box;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    let text = l.text;
    // 力度：起头那一两个字母。歌词行行首的力度会与头一个字读成一行（`mf夫`），所以先于「歌词行不要」判，位置取行首
    const dyn = DYNAMIC_RE.exec(text);
    const rest = dyn ? text.slice(dyn[0].length).trimStart() : "";
    if (dyn && (!rest || /^[\u4e00-\u9fff]/.test(rest))) {
      dynamics.push({ px: box.x + Math.min(box.w, box.h * 0.6 * dyn[0].length) / 2, py: cy, text: dyn[0] });
      continue;
    }
    if (skip.some((q) => inside(q, cx, cy))) continue;
    // 页脚注不是文字指示（望十架 p1 末系统下「*Flute part is on page 43」挂成了钢琴上的文字）
    if (FOOTNOTE_RE.test(text)) continue;
    if (chordPage) {
      // 和弦后面跟着文字的（`G7 cresc.`）：前头的和弦摘走，剩下的照文字走
      const toks = text.split(/\s+/).filter(Boolean);
      const whole = chordOf(text);
      let n = whole ? toks.length : 0;
      // 带后缀的才算（`A tempo` 的 `A` 不是和弦）
      const isChord = (t: string) => t.length > 1 && isWholeChord(t);
      if (!whole) while (n < toks.length - 1 && isChord(toks[n])) n++;
      if (n > 0) {
        const parts = whole ?? toks.slice(0, n);
        const span = whole ? box.w : box.w * (toks.slice(0, n).join(" ").length / text.length);
        parts.forEach((t, i) => chords.push({ text: t, box: { x: box.x + (span * i) / parts.length, y: box.y, w: span / parts.length, h: box.h } }));
        if (whole) continue;
        text = toks.slice(n).join(" ");
      }
    }
    // 英文歌词：一行歌词被 DBNet 切成好几段，同一高度上排着三段以上；文字指示一行里顶多一两处。
    // 这样的行里只留含术语的（歌词行中间夹着的 `rit.`）。歌词带里的行两段就算
    const peers = lines.filter((o) => Math.abs(o.box.y + o.box.h / 2 - cy) <= box.h * 0.6 && /[A-Za-z]{2}/.test(o.text)).length;
    const crowded = peers >= (lyricZones.some((q) => inside(q, cx, cy)) ? LYRIC_ROW_IN_ZONE : LYRIC_ROW);
    // rec 偶尔给元音添上重音符（`póco`、`dím.`），术语里没有这种写法，一律去掉
    text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const term = DIRECTION_RE.exec(text);
    if (crowded && !term) continue;
    // 歌词与紧跟着的术语被框成一行（`paid so willingly poco rit.`）：从头一个术语起才是文字指示
    if (crowded && term) text = text.slice(term.index);
    // 头尾粘着的力度字母（`ff unis.`、`unis. mp`）不算在文字里
    text = text.replace(/^(?:[pmf]{1,3}|s?fz?)\s+(?=\S)/, "").replace(/\s+(?:[pmf]{1,3}|s?fz?)$/, "");
    const metro = METRO_RE.exec(text);
    if (metro) text = text.slice(0, metro.index).replace(/[\s(（♩J]+$/, "").trim();
    const letters = (text.match(/[A-Za-z]/g) ?? []).length;
    // 夹着汉字的是歌词或署名；字母太少的多半是把符头、弧线读成了字
    const isWord = !/[\u4e00-\u9fff]/.test(text) && (letters >= 3 || SHORT_RE.test(text)) && !/^[pmfsz]+$/i.test(text.replace(/[^A-Za-z]/g, ""));
    if (!isWord && !metro) continue;
    // 只靠 `SHORT_RE` 进来的一两个字母（声部标记、排练号）要够大：排练号、分部标记是大字，一格来高的多是别的东西读成的
    //（宁静 p3 只剩一个字的歌词行「人.」读成 `A.`、谱表左缘的小号码读成 `A`，一页好几个）
    if (isWord && letters < 3 && box.h < sp * SHORT_MIN_H) continue;
    // 定谱行：上下最近的那行（按谱表边到字心的距离比）
    let stf: Staff | undefined;
    let bd = sp * REACH;
    let above = true;
    for (const st of pg.staves) {
      if (cx < st.box.left - sp * SIDE || cx > st.box.right + sp * SIDE) continue;
      const d = cy < st.box.top ? st.box.top - cy : cy > st.box.bottom ? cy - st.box.bottom : 0;
      if (d < bd) {
        bd = d;
        stf = st;
        above = cy < (st.box.top + st.box.bottom) / 2;
      }
    }
    if (!stf) continue;
    // 定音符：字行左端对着它起作用的那个音——取左端往左让一格之后、右边最近的；没有就取这一行最后一个
    const row = notes.filter((n) => n.staff === stf && !n.chordExtra && !n.grace).sort((a, b) => a.x - b.x);
    const note = row.find((n) => n.x >= box.x - sp) ?? row[row.length - 1];
    if (!note) continue;
    if (metro) note.metronome = { unit: "quarter", bpm: Number(metro[1].replace(/ /g, "")) };
    // 速度文字与节拍器同一行的（`Andante ♩=76`）写进同一个 `<direction>`（见 `staffomr/textanalyze.ts::attachDirectionTexts`）
    if (metro && isWord && text) {
      note.tempoText = text;
      note.tempoSize = pg.inkTextSize?.(box, text) || box.h;
      words.push({ text, above, box, note });
    } else if (isWord && text) {
      (note.words ??= []).push({ text, above, size: pg.inkTextSize?.(box, text) || box.h });
      words.push({ text, above, box, note });
    }
  }
  return { words, dynamics, chords };
}
