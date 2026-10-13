// 页眉：标题、副标题、词曲、调号拍号、TL/TR/XL/XR。
import { barlineSpan, type JianpuGrid } from "../metrics";
import { Font } from "../../font";
import { Group } from "../../pageitem";
import { TimeSigGlyph } from "../../../engrave/timesig";
import { KeyLabel, keyNameOf } from "../../../engrave/keysig";
import { EQ_PAD_EM } from "../../../engrave/spacing";
import { emptyMetadata, type Metadata } from "../../../pu/ast";
import { type OriginalCtx, text } from "./ctx";

/** 标题（含副标题）最后一行的**墨迹**底。落位同 paintHeader 画标题那段。 */
/** 标题、副标题、题下经文各行：字、基线、字体。画（`paintHeaderItems`）与避让（`titleInkBottom`）共用这一份落位。
 *  经文接在最后一行标题下面，行距同副标题（没有标题就从标题那一行起）。 */
function titleLines(c: OriginalCtx, meta: Metadata): { text: string; y: number; font: Font }[] {
  const m = c.metrics;
  const out: { text: string; y: number; font: Font }[] = [];
  meta.titles.forEach((title, i) => {
    const font = i === 0
      ? new Font(m.style.header.title.family ?? m.style.font.text.family, m.style.header.title.size, true)
      : new Font(m.style.header.subtitle.family ?? m.style.font.text.family, m.style.header.subtitle.size, false);
    const y = m.head.titleBaseline + (i === 0 ? 0 : m.style.header.title.size * 0.2 + i * (m.style.header.subtitle.size * 1.35));
    out.push({ text: title, y, font });
  });
  const size = m.style.header.scripture.size ?? m.style.header.subtitle.size;
  const scrFont = new Font(m.style.header.scripture.family ?? m.style.font.text.family, size, false);
  let y = out.length ? out[out.length - 1]!.y + (out.length === 1 ? m.style.header.title.size * 0.2 : 0) : m.head.titleBaseline - size * 1.35;
  for (const t of meta.scripture ?? []) {
    y += size * 1.35;
    out.push({ text: t, y, font: scrFont });
  }
  return out;
}

function titleInkBottom(c: OriginalCtx, meta: Metadata): number {
  let bottom = 0;
  for (const l of titleLines(c, meta)) bottom = Math.max(bottom, l.y + l.font.charBound(l.text).bottom);
  return bottom;
}

/**
 * 调号拍号行相对其基线 keyY 的**墨迹**上下缘（拍号取分子墨迹顶、分母墨迹底；分数线对准「=」，
 * 与 paintHeader 同一套落位）。没有拍号就只看调号字母。
 */
function keyLineInk(c: OriginalCtx, meta: Metadata): { top: number; bottom: number } {
  const m = c.metrics;
  const headFont = new Font(m.style.font.text.family, m.style.size.keyMeter);
  const f = headFont.charBound("F");
  let top = f.top, bottom = f.bottom;
  const mt = meta.meters[0];
  if (mt) {
    const eq = headFont.charBound("=");
    const meterY = (eq.top + eq.bottom) / 2 + timeSigRule(m) / 2;
    const r = new TimeSigGlyph(mt.numerator, mt.denominator, {
      height: m.style.vertical.barlineHeight, centerY: 0, ruleWidth: timeSigRule(m), color: c.ink, font: headFont,
    });
    const ink = r.box();
    top = Math.min(top, meterY + ink.top);
    bottom = Math.max(bottom, meterY + ink.bottom);
  }
  return { top, bottom };
}

/**
 * 调号拍号行的基线。左侧有 `TL:`/词曲块时排在那块**下方**（否则多行会叠在一起）；
 * 没有时贴着标题：标题墨迹底 → 调号拍号墨迹顶只空**一行**（歌词字高），与首行、system 间距同口径
 * （用户口径：离标题近一点）。原先固定在 keyMeterY（176），离标题两行多。
 */
function keyLineY(c: OriginalCtx, meta: Metadata): number {
  const m = c.metrics;
  const leftLines = Math.max(topLines(meta.topLeft).length, rightColumnLines(meta));
  if (leftLines > 0) return m.head.creditBaseline + leftLines * m.head.creditLineHeight + m.style.size.keyMeter * 0.6;
  if (meta.titles.length === 0) return m.head.keyMeterBaseline;
  return titleInkBottom(c, meta) + m.style.size.lyric - keyLineInk(c, meta).top;
}

/** `TL:` / `TR:` 去掉开头的空行：左右两块顶部对齐（用户定；《圣哉三一歌》TR 前两行留空是为了底对齐，不照它） */
function topLines(lines: readonly string[]): readonly string[] {
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  return lines.slice(i);
}

/** 词曲署名逐行：一条署名里换了行（MusicXML `<creator>` 常把「作词：…\n作曲：…」写成一条）照原样分行，不并成一行 */
function authorLines(meta: Metadata): string[] {
  return meta.authors.flatMap((a) => a.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
}

/** 右侧那一列的行数：`TR:` 在上、`Z:` 词曲接在它下面（同落右侧，各排各的就叠在一起） */
function rightColumnLines(meta: Metadata): number {
  return topLines(meta.topRight).length + authorLines(meta).length;
}

/** 头部（标题/副标题/词曲/TL/TR/调号拍号）占到哪个 y——正文首行据此避让。 */
export function headerBottom(c: OriginalCtx, meta: Metadata): number {
  const m = c.metrics;
  const leftLines = Math.max(topLines(meta.topLeft).length, rightColumnLines(meta));
  const rightLines = rightColumnLines(meta);
  // 只有真有左右文字块时才算它的底；没有时不能拿 authorY 一行兜底，否则调号贴上标题也白贴
  const lines = Math.max(leftLines, rightLines);
  const blockBottom = lines > 0 ? m.head.creditBaseline + (lines - 1) * m.head.creditLineHeight + m.style.header.credit.size * 0.2 : 0;
  const hasTempoWords = meta.tempos.some((t) => typeof t === "string" && t !== "");
  const keyY = keyLineY(c, meta);
  let keyBottom = keyY + keyLineInk(c, meta).bottom;
  if (hasTempoWords) keyBottom = keyY + m.style.size.keyMeter * 1.55 + m.style.size.keyMeter * 0.85 * 0.15;
  // 只报页首的**墨迹底**；「空一行」由 layout 量到首组真正的墨迹顶（和弦、W: 文字行、弧线都算），
  // 见 place/song.ts::layoutSong 的 firstTop。在这里按数字顶加一行，首组头顶有文字行时就被吃掉了
  //（小兔子乖乖的「引子」贴上了拍号）。
  return Math.max(titleInkBottom(c, meta), blockBottom, keyBottom);
}

export function paintHeader(c: OriginalCtx, root: Group, songIndex: number, systemLeft: number): void {
  const before = root.children.length;
  paintHeaderItems(c, root, songIndex, systemLeft);
  // 可视化编辑认页眉：文字标 `hdr`（按字对回原文的字段），调号、拍号另标 `hdr-keysig` / `hdr-time`（`headerParts`）
  for (const it of root.children.slice(before)) {
    if (!it.classes.has("hdr-keysig") && !it.classes.has("hdr-time")) it.classes.add("hdr");
  }
}

function paintHeaderItems(c: OriginalCtx, root: Group, songIndex: number, systemLeft: number): void {
  const m = c.metrics;
  const meta = c.doc?.songs[songIndex]?.metadata ?? c.doc?.songs[0]?.metadata ?? emptyMetadata();
  // 连续长图会按内容收窄页宽，所以居中/右对齐都要用**实际**页宽，不能用 metrics 里的纸张宽
  const centre = c.pageWidth / 2 - c._pageShiftX;

  for (const l of titleLines(c, meta)) {
    const w = l.font.measureText(l.text);
    root.add(text(l.text, centre - w / 2, l.y, l.font, c.ink));
  }

  const right = c.pageWidth - m.page.margin.right - c._pageShiftX;
  const authorFont = new Font(m.style.header.credit.family ?? m.style.font.text.family, m.style.header.credit.size);
  // `Z:` 词曲作者靠右；`TL:`/`TR:` 是与标题同高的左右文字块（多行，允许空行占位）
  // 与 `TR:` 同在右侧：排成一列，TR 在上、词曲接在下面（rightColumnLines）
  authorLines(meta).forEach((a, i) => {
    const w = authorFont.measureText(a);
    root.add(text(a, right - w, m.head.creditBaseline + (topLines(meta.topRight).length + i) * m.head.creditLineHeight, authorFont, c.ink));
  });
  const topFont = new Font(m.style.font.text.family, m.style.size.header);
  topLines(meta.topLeft).forEach((t, i) => {
    if (!t) return;
    // `TL:` 与 system 左缘对齐（它不是跟着音符走的）
    root.add(text(t, systemLeft, m.head.creditBaseline + i * m.head.creditLineHeight, topFont, c.ink));
  });
  topLines(meta.topRight).forEach((t, i) => {
    if (!t) return;
    const w = topFont.measureText(t);
    root.add(text(t, right - w, m.head.creditBaseline + i * m.head.creditLineHeight, topFont, c.ink));
  });

  // 调号拍号行的基线（左侧文字块之下，或贴着标题空一行，见 keyLineY）
  const keyY = keyLineY(c, meta);

  const headFont = new Font(m.style.font.text.family, m.style.size.keyMeter);
  const tonic = meta.tonic ?? "1";
  let x = systemLeft;
  // 调号走公共那一份（engrave/keysig.ts）：升降号是 SMuFL csym 字形并抬高，`=` 两侧各让一点。
  const keyName = meta.mode ? keyNameOf(meta.mode) : null;
  if (keyName) {
    const k = new KeyLabel(tonic, keyName, {
      font: headFont,
      music: new Font("Bravura", headFont.size),
      color: c.ink,
      side: m.style.look.accidentalSide,
      classes: ["hdr-keysig"],
    });
    for (const it of k.items) {
      it.x += x;
      it.y += keyY;
      root.add(it);
    }
    // 调号 → 拍号的**墨迹**间距 = 「=」→ 调号的墨迹间距（用户口径）；分数线左端就是拍号墨迹左缘
    x += k.inkRight + (k.nameInkLeft - k.eqInkRight);
  } else if (meta.mode) {
    // 认不出的调名（不是「字母 + 升降」）照原文写，`=` 两侧照样让空
    const pad = headFont.size * EQ_PAD_EM;
    for (const [i, part] of [tonic, "=", meta.mode].entries()) {
      if (i > 0) x += pad;
      const t = text(part, x, keyY, headFont, c.ink);
      t.classes.add("hdr-keysig");
      root.add(t);
      x += headFont.measureText(part);
    }
    x += pad;
  }
  // 拍号的分数线与调号的「=」**视觉居中**：按「=」墨迹的竖直中心定分数线（用户口径）。
  // TimeSigGlyph 把分数线描边中心放在 centerY − ruleWidth/2，这里补回那半个线宽。
  const eq = headFont.charBound("=");
  const meterY = keyY + (eq.top + eq.bottom) / 2 + timeSigRule(m) / 2;
  const meterFrom = root.children.length;
  for (const meter of meta.meters) {
    x += paintMeter(c, root, x, meterY, meter, headFont) + 14;
  }
  for (const it of root.children.slice(meterFrom)) it.classes.add("hdr-time");
  // `J:` 里的文字部分（「深情地」「高亢、自由地」）排在调号拍号**下一行**，左对齐。
  // 数字部分是速度值，不显示在这里。
  const tempoWords = meta.tempos.filter((t): t is string => typeof t === "string" && t !== "");
  if (tempoWords.length > 0) {
    const wordFont = new Font(m.style.font.text.family, m.style.size.keyMeter * 0.85);
    root.add(
      text(tempoWords.join(" "), systemLeft, keyY + m.style.size.keyMeter * 1.55, wordFont, c.ink),
    );
  }

  // 序号：左上 / 右上
  const indexFont = new Font(m.style.font.text.family, m.style.header.title.size * 0.62);
  // `XL:` 序号同样对齐 system 左缘
  if (meta.indexLeft) root.add(text(meta.indexLeft, systemLeft, m.head.titleBaseline, indexFont, c.ink));
  if (meta.indexRight) {
    const w = indexFont.measureText(meta.indexRight);
    root.add(text(meta.indexRight, right - w, m.head.titleBaseline, indexFont, c.ink));
  }
}

/** 拍号分数线粗细（`time-sig-rule`；0 = 与减时线同粗）。 */
function timeSigRule(m: JianpuGrid): number {
  return m.style.stroke.timeSigRule || m.style.stroke.beam;
}

/**
 * 分数式拍号（分子在上、分母在下、中间一横）。返回占用的宽度。
 * 头部的调号拍号与小节线上的临时拍号共用。
 */
export function paintMeter(c: OriginalCtx,
  root: Group,
  x: number,
  y: number,
  meter: { numerator: number; denominator: number },
  font: Font,
): number {
  // 尺寸走公共那一份：**一切长度都是小节线高度的比例**（engrave/timesig.ts::TimeSigGlyph），
  // 两个数字横向居中于分数线。原先这里各按 `font.size` 的 0.42/0.62/0.1 给，
  // 与谱面、混排三处口径各不相同。
  const r = new TimeSigGlyph(meter.numerator, meter.denominator, {
    height: c.metrics.style.vertical.barlineHeight,
    centerY: (barlineSpan(c.metrics).top + barlineSpan(c.metrics).bottom) / 2,
    ruleWidth: timeSigRule(c.metrics),
    color: c.ink,
    font,
  });
  for (const item of r.items) {
    item.x += x;
    item.y += y;
    root.add(item);
  }
  return r.width;
}
