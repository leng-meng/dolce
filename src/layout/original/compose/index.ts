// 原样文档布局的构图：定位结构（`place/`）→ PageItem 页面树。原先 `PuPainter`（已退役）的绘制方法
// 原样搬来（`docs/实现/PuPainter退役.md` P4/P5），`this` 换成一次排版的上下文 `OriginalCtx`；
// 加载、DOM、渲染与高亮归唯一的 `layout/painter.ts::ScorePainter`，这里只产出页面与身份索引。
//
// 复用本项目的 PageItem/Group/GraphicPath/GraphicLine/TextFrame，
// 所以「导出 PPTX」那条路（collectShapes 认这几种图元）不用改就能吃这些页面。
//
// 数字用系统字体按**墨迹居中**于步进锚点（字号取样式值 size.note），
// 圆点与线段自绘——位置逐点对齐原版，字形则是规范字形。
//
// 入口只收 `ScoreDoc`：先经 `pu/slots.ts::docView` 线性化成排版行（排版几何都按行写成），再定位、绘制。
//
// 播放逐字高亮与双向定位：绘制时把每个音符与每个歌词音节的 PageItem 按**元素 id** 记进索引，
// 由 ScorePainter 直接按 id 取用，不必反查 SVG，也不依赖对象身份（重新解析一遍 id 不变）。
import { applyDocOptions, gridOf, type GridPage, type JianpuGrid } from "../metrics";
import { Font } from "../../font";
import { Group } from "../../pageitem";
import { syllableRun } from "../../../engrave/syllable";
import type { Region } from "../../../style/ss";
import type { JianpuStyle } from "../../../engrave/jianpustyle";
import type { ElementId, ScoreDoc } from "../../../model/doc";
import type { DocView } from "../../../pu/slots";
import { originalInputOf } from "../input";
import { applyBreaks } from "../../../model/breaks";
import type { InkMeasurer, PlacedScore } from "../place/model";
import { layoutDocument } from "../place/song";
import { reflowLineStarts } from "../place/reflow";
import type { OriginalCtx } from "./ctx";
import { paintPage, systemLeft } from "./page";
import { layoutFooters } from "./footer";
import { headerBottom } from "./header";

/** 原样文档排版的外部配置：尺子（`style/jianpu.ts::jianpuStyleOf`，与简谱引擎同一份）、纸、页脚模板。 */
export interface OriginalDocumentConfig {
  readonly style: JianpuStyle;
  readonly page: GridPage;
  /** 面板上给了边距：谱面自带的 `Margin:` 不再生效（用户说了算） */
  readonly userMargins: boolean;
  readonly foot: Region | null;
  /** 已经按窄纸重新断过行（`reflowLineStarts`），不再断第二次 */
  readonly noReflow?: boolean;
}

/** 一份文档排好的原样页面与身份索引。 */
export interface OriginalDocumentLayout {
  readonly pages: Group[];
  /** 页宽高（排版坐标，即 pt）。连续长图时随内容而定。 */
  readonly width: number;
  readonly height: number;
  readonly metrics: JianpuGrid;
  /** 当前音符数字的字号（pt）。面板上的「基础字号」显示的就是它。 */
  readonly digitFontSize: number;
  readonly view: DocView;
  readonly placed: PlacedScore;
}

/** 排一份文档并生成全部页面（原 `PuPainter.load`）。 */
export function layoutOriginalDocument(source: ScoreDoc, cfg: OriginalDocumentConfig): OriginalDocumentLayout {
  const doc = originalInputOf(source);
  // 谱面自带的 `FontSize:` / `Margin:` 也要生效（真实语料里 `all=` 用得最多）：乘在尺子上
  const meta0 = doc.songs[0]?.metadata;
  const style = applyDocOptions(cfg.style, meta0?.fontSizes ?? [], meta0?.margins ?? [], cfg.userMargins);
  const m = gridOf(style, cfg.page);
  const c: OriginalCtx = {
    metrics: m,
    doc,
    placed: null,
    digitFont: new Font(m.style.font.note.family, m.style.size.note, m.style.look.noteBold),
    chordLane: m.note.chordY,
    pageWidth: m.page.width,
    pageHeight: m.page.height,
    _pageShiftX: 0,
    ink: style.page.color,
    lyricInk: style.page.color,
    foot: cfg.foot,
  };
  const headerBottoms = doc.songs.map((song) => headerBottom(c, song.metadata));
  // 墨迹量具注入给排版（它不碰字体）。
  // 歌词：落位口径同 paintSyllables——主体居中于锚点、尾随标点挂右边。量墨迹而不是字面框：「声，」的全角逗号字面框右半边是空的，
  // 按字面框约束会把墨迹根本没碰到的行也撑开（《圣哉三一歌》长图就是这样被误伤的）。
  // 歌词避让量的是**画出来的**那串：与 paintSyllables 同一个居中点、同一串挤压后的宽
  const lyricFont = new Font(m.style.font.lyric.family, m.style.size.lyric);
  const ink: InkMeasurer = {
    lyric(syl) {
      const str = syl.text + (syl.trailingPunctuation ?? "");
      const run = syllableRun(str, lyricFont, m.style.look.punctCompress);
      const b = lyricFont.charBound(str);
      const center = run.lead + run.body / 2;
      return { left: center - b.left, right: Math.min(run.width, b.right) - center };
    },
    digit: (ch) => ({ advance: c.digitFont.measureText(ch), ink: c.digitFont.charBound(ch) }),
  };
  // **源里的行放不下就整首重新断行**（用户定：原样档按排得下的位置断、中间不要短行）：断点写进文档克隆的换行位、
  // 整份重排一遍。元素 id 不变，编辑器的点选、高亮照旧对得上。多声部文本谱（各声部小节对不齐）`applyBreaks` 不重断
  if (!cfg.noReflow) {
    const starts = reflowLineStarts(doc.songs, doc.idOf, m, ink);
    if (starts) {
      const clone = structuredClone(source);
      let changed = false;
      clone.songs.forEach((song, i) => {
        const ls = starts[i];
        if (ls && applyBreaks(song, ls.map((id) => ({ id: id as ElementId })), { mid: "source", pages: "keep" })) changed = true;
      });
      if (changed) return layoutOriginalDocument(clone, { ...cfg, noReflow: true });
    }
  }
  const placed = layoutDocument(doc.songs, m, headerBottoms, ink);
  c.placed = placed;
  // 页脚（BL/BC/BR）：每首末页、最低一行之下。先排一遍拿到占高，连续长图的页高要把它算进去
  const footers = layoutFooters(c, 0);
  const footerBottom = Math.max(0, ...footers.map((f) => f.bottom));
  // 连续长图：页面尺寸随内容走，不受纸张尺寸约束（短曲子不该拖着一大片空白）
  if (m.page.longImage) {
    c.pageHeight = Math.max(
      m.page.margin.top + m.page.firstSystemTop,
      placed.contentBottom + m.ink.noteHeight + m.page.margin.bottom,
      footerBottom > 0 ? footerBottom + m.page.margin.bottom : 0,
    );
    // 页宽按**实际墨迹**裁紧并左右等距留白：连谱号会探进左边距，
    // 直接用 marginLeft 会左右不对称（实测 14 / 81）。
    const inkLeft = Math.min(...placed.pages.map((p) => systemLeft(c, p)));
    const inkRight =
      m.page.margin.left + m.page.systemIndent + placed.contentRight + m.ink.noteHeight * 0.6;
    // **纸宽固定**（用户定：长图与分页纸同宽，各曲一样宽）：墨迹那一段在纸宽里左右居中；
    // 放不下（单个小节就比版心宽）才按墨迹撑宽
    // 墨迹段本来就是「版心 + 两侧伸出的一点」，不再另加长图留白（加了就总比纸宽）
    const span = inkRight - inkLeft;
    c.pageWidth = Math.max(m.page.width, span);
    c._pageShiftX = (c.pageWidth - span) / 2 - inkLeft;
  }
  const footerItems = layoutFooters(c, c._pageShiftX);
  const pages = placed.pages.map((pg, i) => {
    const g = paintPage(c, pg, i);
    for (const f of footerItems) if (f.page === i) for (const it of f.items) g.add(it);
    g.x += c._pageShiftX;
    return g;
  });
  for (const p of pages) p.update();
  return {
    pages,
    width: c.pageWidth,
    height: c.pageHeight,
    metrics: m,
    digitFontSize: c.digitFont.size,
    view: doc,
    placed,
  };
}
