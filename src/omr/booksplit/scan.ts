// 歌本切分 · 第一遍逐页扫描：版面几何 + 页脚页码 OCR + 标题候选 OCR + 像目录的页整页 OCR。只留几何与文字，不留像素。
import type { OcrBackend } from "../../omrkit/ocr";
import type { Binary, Rect } from "../../omrkit/types";
import type { RgbaImage } from "../../omrkit/decode";
import { otsu, rgbaToBinary, toGray } from "../../omrkit/preprocess";
import { analyzePage, footerCandidate, isMusicBand, isTitleCandidate, type Band, type PageLayout } from "./layout";
import type { PageInfo, TitleHit, TocEntry } from "./types";

type OcrLine = { text: string; bbox: Rect; chars?: { text: string; cx: number; x1?: number }[] };

const CJK = /[㐀-鿿豈-﫿]/;
const PAGE_NO_RE = /^[-–—_~·.\s]*(\d{1,4})[-–—_~·.\s]*$/;

/** `toc`：true = 当目录页整页 OCR，false = 不当，undefined = 按版面自动认。 */
export async function scanPage(index: number, img: RgbaImage, ocr: OcrBackend, toc?: boolean): Promise<PageInfo> {
  const bin = pageBinary(img);
  const layout = analyzePage(bin, img.data);
  const info: PageInfo = { index, layout, body: layout.bands, titles: [], toc: [] };
  if (!ocr.recognizeRegion) throw new Error("OCR 后端不支持整片识别（需要 PaddleOCR 检测模型）");

  const foot = footerCandidate(layout);
  const printed = foot ? await readPageNumber(bin, foot, layout, ocr) : undefined;
  if (foot && printed !== undefined) {
    info.printed = printed;
    info.footer = foot;
    info.body = layout.bands.slice(0, -1);
  }

  for (const b of info.body) {
    if (!isTitleCandidate(b, layout)) continue;
    const hit = parseTitle(await ocr.recognizeRegion(bin, pad(b, layout, layout.charH * 0.3)), b, layout);
    if (hit) info.titles.push(hit);
  }

  if (toc ?? looksLikeToc(info.body, layout.h)) info.toc = parseToc(await ocr.recognizeRegion(bin, fullRect(bin)));
  for (const b of layout.bands) b.boxes = [];
  return info;
}

/**
 * 页脚页码：带里够高的块按横向重叠并成字，逐字按 0–9 认（「– 4 –」这种单字整片检测常读丢）；
 * 有字认不出再退整片 OCR。返回 undefined = 不是页码。
 */
async function readPageNumber(bin: Binary, foot: Band, p: PageLayout, ocr: OcrBackend): Promise<number | undefined> {
  const cells: Rect[] = [];
  for (const r of [...foot.boxes].sort((a, b) => a.x - b.x)) {
    if (r.h < p.charH * 0.45 || r.w > r.h * 1.5) continue; // 横杠、斑点
    const last = cells[cells.length - 1];
    if (last && r.x < last.x + last.w) {
      const x = Math.min(last.x, r.x), y = Math.min(last.y, r.y);
      cells[cells.length - 1] = { x, y, w: Math.max(last.x + last.w, r.x + r.w) - x, h: Math.max(last.y + last.h, r.y + r.h) - y };
    } else cells.push(r);
  }
  if (cells.length && cells.length <= 4 && ocr.recognizeNumerals) {
    const ds = await ocr.recognizeNumerals(bin, cells);
    if (ds.every((d) => d !== undefined)) return Number(ds.join(""));
  }
  const lines = await ocr.recognizeRegion!(bin, pad(foot, p, p.charH * 0.4));
  const m = PAGE_NO_RE.exec(lines.map((l) => l.text).join(""));
  return m ? Number(m[1]) : undefined;
}

/**
 * 页面二值图：Sauvola 的墨再与全局 Otsu 阈值取交。扫描页常有背面透印的淡灰字，Sauvola 是局部阈值，
 * 在透印处照样判成墨，把相邻两带粘成一片；透印比正面墨浅得多，全局阈值一卡就掉。
 */
export function pageBinary(img: RgbaImage): Binary {
  const bin = rgbaToBinary(img.data, img.width, img.height);
  const gray = toGray(img.data, img.width, img.height);
  const { thr } = otsu(gray);
  for (let i = 0; i < gray.length; i++) if (gray[i] > thr) bin.data[i] = 0;
  return bin;
}

function pad(b: Band, p: PageLayout, d: number): Rect {
  const x = Math.max(0, Math.floor(b.x0 - d)), y = Math.max(0, Math.floor(b.y0 - d));
  return { x, y, w: Math.min(p.w, Math.ceil(b.x1 + d)) - x, h: Math.min(p.h, Math.ceil(b.y1 + d)) - y };
}

function fullRect(bin: Binary): Rect { return { x: 0, y: 0, w: bin.w, h: bin.h }; }

/** 像目录的页：没有谱行、字占了页高的四分之一以上（两栏错行时多行会并成一带，不能按带数算）。
 *  前言之类的文字页也会过，整页 OCR 后按「文字 + 两个数」认不出条目，不碍事。 */
function looksLikeToc(body: readonly Band[], h: number): boolean {
  return body.length >= 3 && !body.some(isMusicBand) && body.reduce((a, b) => a + b.y1 - b.y0, 0) >= h * 0.25;
}

/** 调号「1=C」「1=♭E」：标题行的标志（调名字母常读错，只认「1=」）。 */
const KEY_RE = /1\s*[=＝]/;
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff·、，！？]+/g;

/**
 * 标题带的 OCR → 曲名 + 曲号。带里读出调号（`1=`），或大字比本页字行高出 15% 且读得到曲号，才算标题
 * （有的本子某首歌词字号比别的大，光凭字大会把歌词行认成标题；段号「1.」不算曲号）。
 * 曲名：与最高那框等高、横排相挨的各框里各取最长一段汉字拼起来（「圣　哉」检测常切成两框），字间空格去掉；
 * 曲号：不属于调号、拍号（`4/4`）、出处（`诗67篇`、`33:8`）的独立整数里最靠两端的那个；
 * 曲号紧挨调号读成一串（「115 1=C」→「1151=C」）时去掉末位的 1。
 */
export function parseTitle(lines: OcrLine[], band: Band, p: PageLayout): TitleHit | null {
  const cjkLines = lines.filter((l) => CJK.test(l.text));
  if (!cjkLines.length) return null;
  // 调号常被检测切成几框（「1=」「E」），按横向次序拼起来再认
  const hasKey = KEY_RE.test([...lines].sort((a, b) => a.bbox.x - b.bbox.x).map((l) => l.text).join(" "));
  const main = cjkLines.reduce((a, b) => (b.bbox.h > a.bbox.h ? b : a));
  // 与最高框等高、同一横排、且一框挨一框（间隙 ≤ 2.2 字高，「悔　　改」这种疏排标题字距近两字）的才拼：隔得远的同号字多是旁边的分类、出处（「悔改」「爱主」）
  const peers = cjkLines
    .filter((l) => l.bbox.h >= main.bbox.h * 0.85 && overlapY(l.bbox, main.bbox) >= Math.min(l.bbox.h, main.bbox.h) * 0.5)
    .sort((a, b) => a.bbox.x - b.bbox.x);
  const at = peers.indexOf(main);
  let lo = at, hi = at;
  const near = (a: Rect, b: Rect) => b.x - (a.x + a.w) <= main.bbox.h * 2.2;
  while (lo > 0 && near(peers[lo - 1].bbox, peers[lo].bbox)) lo--;
  while (hi < peers.length - 1 && near(peers[hi].bbox, peers[hi + 1].bbox)) hi++;
  const parts = peers.slice(lo, hi + 1);
  const title = parts.map((l) => {
    const runs = (l.text.replace(/\s+/g, "").match(CJK_RUN) ?? []).filter((r) => CJK.test(r));
    return runs.reduce((a, b) => (b.length > a.length ? b : a), "").replace(/^[·、，]+|[·、，]+$/g, "");
  }).join("");

  const nums: { v: number; x: number }[] = [];
  for (const l of lines) {
    const t = l.text;
    const re = /\d+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      let digits = m[0];
      const before = t.slice(0, m.index).replace(/\s+$/, "");
      const after = t.slice(m.index + digits.length).replace(/^\s+/, "");
      if (/^[=＝]/.test(after)) {
        if (digits.length < 2 || !digits.endsWith("1")) continue; // 调号本身
        digits = digits.slice(0, -1);
      } else if (/[=＝:：/／]$/.test(before) || /^[:：/／]/.test(after)) continue; // 4/4、33:8
      if (/[诗篇第章节]$/.test(before) || /^[篇章节首.．、]/.test(after)) continue; // 出处、段号「1.」
      const v = Number(digits);
      if (!(v >= 1 && v <= 9999)) continue;
      const ch = l.chars;
      const x = ch && ch.length === t.length ? ch[m.index].cx : l.bbox.x + ((m.index + digits.length / 2) / Math.max(1, t.length)) * l.bbox.w;
      nums.push({ v, x });
    }
  }
  // 最靠左（在曲名左边）或最靠右（在曲名右边）的数；两边都有取离带边更近的
  const mid = main.bbox.x + main.bbox.w / 2;
  const left = nums.filter((n) => n.x < mid).sort((a, b) => a.x - b.x)[0];
  const right = nums.filter((n) => n.x >= mid).sort((a, b) => b.x - a.x)[0];
  let number: number | undefined;
  if (left && right) number = left.x - band.x0 <= band.x1 - right.x ? left.v : right.v;
  else number = (left ?? right)?.v;
  // 没读出调号的，要字比本页字行大、且读得到曲号才算（防大字号歌词行）
  if (!hasKey && (band.bigH < p.textH * 1.15 || number === undefined)) return null;
  return { band, title, number };
}

function overlapY(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

/**
 * 目录页整页 OCR → 条目。一条 = 文字 + 曲号 + 页码（「天使歌声 59 46」）。检测常把文字与数字切成两框、
 * 两个数又时分时合（「5946」「346」「267」），故先按纵向位置聚成行、行内按横坐标排，
 * 数字框再按字距拆数（字距大于全页数内字距中位的 1.6 倍就断开）。文字后跟 ≥2 个数 → 取末两个为曲号、页码；
 * 经文目录「经文 首句 曲号 页码」同样适用。
 */
export function parseToc(lines: OcrLine[]): TocEntry[] {
  const isNum = (t: string) => /^[\s\d]+$/.test(t) && /\d/.test(t);
  // 全页数内字距：数字框里相邻两字的横距中位
  const steps: number[] = [];
  for (const l of lines) {
    if (!isNum(l.text) || !l.chars || l.chars.length !== l.text.length) continue;
    const cs = l.chars.filter((c) => /\d/.test(c.text));
    for (let k = 1; k < cs.length; k++) steps.push(cs[k].cx - cs[k - 1].cx);
  }
  steps.sort((a, b) => a - b);
  const pitch = steps.length ? steps[Math.floor(steps.length * 0.3)] : 0;

  const hs = lines.map((l) => l.bbox.h).sort((a, b) => a - b);
  const tol = (hs[Math.floor(hs.length / 2)] ?? 40) * 0.5;
  const rows: OcrLine[][] = [];
  for (const l of [...lines].sort((a, b) => cyOf(a) - cyOf(b))) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(cyOf(l) - cyOf(row[0])) <= tol) row.push(l);
    else rows.push([l]);
  }

  const out: TocEntry[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.bbox.x - b.bbox.x);
    let text = "";
    let nums: number[] = [];
    const flush = () => {
      const t = text.replace(/[\s*＊—–\-.…·]+/g, " ").trim();
      if (CJK.test(t) && nums.length >= 2) out.push({ text: t, number: nums[nums.length - 2], page: nums[nums.length - 1] });
      text = ""; nums = [];
    };
    for (const l of row) {
      if (isNum(l.text)) nums.push(...splitNumbers(l, pitch));
      else {
        // 文字框尾巴上粘着的数（「主啊我赞美 1」）
        const m = /^(.*?[^\d\s])\s*([\d\s]*\d)$/.exec(l.text);
        if (nums.length) flush();
        if (m && CJK.test(m[1])) { text += m[1]; nums.push(...m[2].trim().split(/\s+/).map(Number)); }
        else text += l.text;
      }
    }
    flush();
  }
  return out;
}

function cyOf(l: OcrLine): number { return l.bbox.y + l.bbox.h / 2; }

/** 一个纯数字框 → 若干数：空格处断，字距明显大于数内字距处也断。 */
function splitNumbers(l: OcrLine, pitch: number): number[] {
  const out: number[] = [];
  const ch = l.chars && l.chars.length === l.text.length ? l.chars : null;
  let cur = "";
  let prevX = -Infinity;
  for (let k = 0; k < l.text.length; k++) {
    const c = l.text[k];
    if (!/\d/.test(c)) { if (cur) out.push(Number(cur)); cur = ""; prevX = -Infinity; continue; }
    const x = ch ? ch[k].cx : NaN;
    if (cur && ch && pitch > 0 && x - prevX > pitch * 1.6) { out.push(Number(cur)); cur = ""; }
    cur += c;
    prevX = x;
  }
  if (cur) out.push(Number(cur));
  return out;
}
