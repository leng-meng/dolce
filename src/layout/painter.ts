// 唯一的排版器 `ScorePainter`：按请求排版（简谱原样 / 展开、原样文档、五线谱 / 混排），持有提交后的结果、
// 页面渲染（DOM 映射）、点选与播放高亮索引。排页算法在各自模块（`jianpupages.ts`、`original/compose/`、
// `mixed/staffpages.ts`），SVG 出口在 `render.ts`，这里只管请求版本、结果提交与交互状态。
// 设计与迁移记录见 docs/实现/PuPainter退役.md。
//
// 点选 / 高亮部分移植自 mp/layout/draw.kt。

import type { PlayItem } from "../score/playorder";
import { Rect } from "../common/geom";
import { Group, PageItem } from "./pageitem";
import { Layout } from "./layout";
import { emptyScore, type JScore } from "./input";
import type { ElementId, ScoreDoc } from "../model/doc";
import { headerPartsOf, mixedVisitor, renderPageSvg, type HeaderPart } from "./render";
import { layoutExpandedPages, layoutOriginalPages } from "./jianpupages";
import { fromPt, pageGeometry, type LayoutHit, type LayoutPage, type LayoutResult, type PaintTarget } from "./result";
import { MetaData } from "../smufl/smufl";
import { jianpuFlagsOf, jianpuFontSize, jianpuStyleOf } from "../style/jianpu";
import type { StyleSheet } from "../style/sheet";
import { applyStaffStyle } from "../style/staff";
import { computeStyleForPaper, LONG_IMAGE_WIDTH, THEMES } from "../style/themes";
import { pageMargins, resolvePaper } from "../style/paper";
import type { Region } from "../style/ss";
import { MixedOptions, type StaffLayout, type Sys } from "../mixed/model";
import { layoutStaff } from "../mixed/layout";
import { layoutStaffPages, PAGE_HEIGHT_FALLBACK } from "../mixed/staffpages";
import { isStaffLeaf, STAFF_CHORD, STAFF_SYSTEM, staffLeafKey, type StaffChordData, type StaffLeafData, type StaffSystemData } from "../mixed/prims";
import { layoutOriginalDocument, type OriginalDocumentLayout } from "./original/compose";
import { clearSongBreaks } from "../model/breaks";
import type { PlacedPage } from "./original/place";
import type { JianpuGrid } from "./original/metrics";
import { cellOf, ScoreIndex, type Hit } from "./scoreindex";
import { Playhead, spanIn, svgBox } from "./playhead";
import type { IdentityKind } from "./identity";

// ---------------------------------------------------------------- 请求与资源

/** 简谱引擎的排版设置（原样 / 展开 / 成书 / 帮助示例 / 量宽共用）。 */
export interface JianpuConfig {
  /** 已计算样式表，折成尺子 `JianpuStyle` 灌进 `LayoutOptions`（`style/jianpu.ts::jianpuStyleOf`）；null = 引擎缺省（帮助示例）。 */
  readonly style: StyleSheet | null;
  /** `style` 为 null 时的字号。 */
  readonly fontSize?: number;
  /** 覆盖墨色（帮助示例画在压暗的纸上）。 */
  readonly ink?: number;
  /** 覆盖多段歌词叠排行距（自然量宽要 > 0：不展开反复，一遍就够量）。 */
  readonly lyricStack?: number;
}

/** 简谱引擎这一路的请求。原样 / 展开的输入由调用方投影好（文档级原样投影见退役计划 P3）。 */
export interface JianpuPaintRequest extends JianpuConfig {
  readonly view: "original" | "expanded";
  readonly score: JScore;
  /** `.jpwabc` 的 `.Layout` 分页描述（其他格式没有）。 */
  readonly breakDesc: string | null;
  /** 原样档的纸（排版单位 = pt）。展开档取 `style.page`。 */
  readonly page?: { w: number; h: number };
  /** 只排版面、不加标题页也不叠标题块（帮助示例的谱行片段）。 */
  readonly snippet?: boolean;
}

/** 五线谱 / 混排的请求（`doc` 须是 MusicXML 形状，见 `mixed/layout.ts`）。 */
export interface StaffPaintRequest {
  readonly view: "staff" | "mixed";
  readonly doc: ScoreDoc;
  /** computed 样式表（主题 `staff`）；缺省取内置那份。 */
  readonly style?: StyleSheet;
  /** 谱里没写纸时用的那张（pt；`heightPt` null = 长图），见 `MixedOptions.page`。 */
  readonly page: MixedOptions["page"];
  readonly hideBarNumber: boolean;
  /** 混排：简谱层叠在第几个声部上（缺省 0） */
  readonly jianpuPart?: number;
}

/** 原样文档这一路（文本谱与多声部 123/ABC、MusicXML 的原样档）：整份 `ScoreDoc` 按源行排，印刷原版观感。
 *  `expanded`：展开档（反复逐遍展开、一遍一页、投影片纸），开发开关下才发（子计划 5）。 */
export interface DocumentPaintRequest {
  readonly view: "original" | "expanded";
  readonly doc: ScoreDoc;
  /** computed 样式表（原样档那份，与简谱引擎同一份）。null = print 主题出厂。 */
  readonly style: StyleSheet | null;
  /** 照文档里的换行排，不按窄纸重新断行（断点已由调用方写进文档时用）。 */
  readonly noReflow?: boolean;
  /** 展开档：`.jpwabc` 的 `.Layout` 分页描述（其他格式没有） */
  readonly breakDesc?: string | null;
  /** 原样档的纸（pt），不给按样式表的纸。`snippet` 时只取宽、高随内容 */
  readonly page?: { w: number; h: number };
  /** 只排谱行、不放页眉页脚（帮助页的谱例片段） */
  readonly snippet?: boolean;
  /** 覆盖墨色（帮助页的谱例画在压暗的纸上） */
  readonly ink?: number;
}

export type PaintRequest = JianpuPaintRequest | DocumentPaintRequest | StaffPaintRequest;
/** 同步入口收的请求（排版不等资源的两路）。 */
export type SyncPaintRequest = JianpuPaintRequest | DocumentPaintRequest;
export type LoadOutcome = "committed" | "superseded";

export interface PreparedResources {
  /** SMuFL 元数据（延长号、跳转记号的包围盒）。简谱这一路缺了只在用到那几个记号时报错。 */
  readonly smuflMeta: MetaData | undefined;
}

/** 排版资源。字体测量沿用 `Font` 自己的机制，这里只管 SMuFL 元数据。
 *  `fixed` = 调用方手里已有（App 构造时就拿到了），同步入口随时可用；`shared` = 首次异步加载、失败不缓存。 */
export class PaintResources {
  private _ready: PreparedResources | null;
  private _pending: Promise<PreparedResources> | null = null;

  private constructor(ready: PreparedResources | null) {
    this._ready = ready;
  }

  static fixed(smuflMeta?: MetaData): PaintResources {
    return new PaintResources({ smuflMeta });
  }

  static shared(): PaintResources {
    return new PaintResources(null);
  }

  /** 已就绪则同步给出，否则 null。同步排版入口只经它取资源。 */
  ready(): PreparedResources | null {
    return this._ready;
  }

  prepare(): Promise<PreparedResources> {
    if (this._ready) return Promise.resolve(this._ready);
    return (this._pending ??= MetaData.shared().then(
      (smuflMeta) => (this._ready = { smuflMeta }),
      (e: unknown) => {
        this._pending = null;
        throw e;
      },
    ));
  }
}

/** 按设置新造一份简谱引擎（选项是单向覆写的，每次排版都要一份干净的）。 */
export function jianpuLayoutOf(cfg: JianpuConfig, res: PreparedResources): Layout {
  const layout = new Layout(cfg.style ? jianpuFontSize(cfg.style) : cfg.fontSize ?? 28);
  const opt = layout.options;
  if (res.smuflMeta) opt.smuflMeta = res.smuflMeta;
  if (cfg.style) opt.applyStyle(jianpuStyleOf(cfg.style), jianpuFlagsOf(cfg.style));
  if (cfg.ink !== undefined) opt.color = cfg.ink;
  if (cfg.lyricStack !== undefined) opt.lyricStack = cfg.lyricStack;
  return layout;
}

/** 自然量宽：整首排成一条（分行之前）量每个和弦的横向区间，不分页、不产 DOM。
 *  直接复用 `Layout.measureNatural`，`spans` 的键就是输入的 `JChord`。 */
export function measureJianpu(
  score: JScore,
  width: number,
  cfg: JianpuConfig,
  res: PreparedResources,
): ReturnType<Layout["measureNatural"]> {
  return jianpuLayoutOf(cfg, res).measureNatural(score, width);
}

/** 自然量宽（原样文档引擎，乐句重排用）：清掉换行、整首不折，量第 `song` 首旋律声部每个音（键为元素 id）的自然横向区间与版心宽。
 *  `slide`：按展开档的画法量（数字共基线、增时线「-」字）。不改 `doc`。 */
export function measureDocument(
  doc: ScoreDoc, sheet: StyleSheet, width: number, slide = false, song = 0,
): { width: number; spans: Map<string | number, { x0: number; x1: number }> } {
  const one = doc.songs[song];
  if (!one) return { width: 0, spans: new Map() };
  // 只量断句的那条旋律：带歌词的声部（同断句输入的 `forExpanded`），没有就第一个。
  // 文本谱不清换行（歌词挂在每行源头，并成一行就丢了），逐行接着量（`naturalSpans`）
  const lead = one.parts.find((p) => p.measures.some((m) => m.elements.some((e) => e.kind === "chord" && (e.lyrics?.length ?? 0) > 0))) ?? one.parts[0];
  if (!lead) return { width: 0, spans: new Map() };
  const clone = structuredClone({ ...doc, songs: [{ ...one, parts: [lead] }] });
  if (doc.sourceFormat !== "pu") for (const song of clone.songs) clearSongBreaks(song);
  const r = layoutOriginalDocument(clone, {
    style: jianpuStyleOf(sheet),
    page: { width, height: width, continuous: true },
    userMargins: pageMargins(sheet.page) !== undefined,
    foot: null,
    measure: true,
    ...(slide ? { book: true } : {}),
  });
  return r.spans ?? { width: 0, spans: new Map() };
}

// ---------------------------------------------------------------- 排版器

/** 五线谱 / 混排提交的状态。 */
interface StaffState {
  score: StaffLayout;
  pages: Group[];
  placed: { sys: Sys; page: number; top: number }[];
}

const isStaffRequest = (r: PaintRequest): r is StaffPaintRequest => r.view === "staff" || r.view === "mixed";
const isDocumentRequest = (r: PaintRequest): r is DocumentPaintRequest => (r.view === "original" || r.view === "expanded") && "doc" in r;

/** 可视化编辑选中挂在音符上的子项的角色（就是身份标签的 kind，见 `identity.ts`）。 */
export type VisualPartRole = "aug-dot" | "harmony" | "deco" | "annotation";

const defaultStaffStyle = (): StyleSheet => computeStyleForPaper([THEMES.staff], { engine: "staff" });

/** 五线谱 / 混排的排版选项：按样式表（缺省取内置 `staff` 主题）灌好，纸与小节号由请求再覆写。 */
export function staffOptionsOf(meta: MetaData, style?: StyleSheet): MixedOptions {
  const options = new MixedOptions(meta);
  applyStaffStyle(options, style ?? defaultStaffStyle());
  return options;
}

export class ScorePainter {
  /** 最近一次提交的简谱引擎（成书、PPTX、脚本读它的页面树与选项）。五线谱结果提交时保留不动。 */
  layout: Layout = new Layout(28);
  /** 最近一次提交的简谱引擎输入（标题、导出 PPTX 用）。五线谱结果提交时保留不动。 */
  score: JScore = emptyScore();
  /** 最近一次提交的简谱档；还没排过简谱为 null。 */
  jianpuView: "original" | "expanded" | null = null;
  pageWidth = 0;
  pageHeight = 0;
  /** 当前结果。null = 还没排过。 */
  result: LayoutResult | null = null;
  /** PageItem -> rendered <g>, populated each renderPage (for DOM picking). */
  nodeMap = new WeakMap<PageItem, SVGGElement>();
  /** 简谱两条路的身份索引（按图元上的身份标签收，见 `scoreindex.ts`）：试听高亮、点选、可视化编辑查它。 */
  private index: ScoreIndex = ScoreIndex.empty();
  /** 五线谱 / 混排：元素 id → 画它的和弦组（五线谱层在前、简谱叠层在后）与所在系统组。见 `mixed/prims.ts::STAFF_CHORD`。 */
  private staffChords = new Map<ElementId, { page: number; item: PageItem; system: PageItem | null }[]>();
  /** 试听的竖直播放线（各视图同一种，当前在哪页的 svg 里就挂在哪页）。 */
  private playhead = new Playhead();
  /** 五线谱 / 混排：渲染出来的和弦组 `<g>` → 元素 id（点选按事件冒泡认）。 */
  private staffElId = new WeakMap<Element, ElementId>();
  /** 五线谱 / 混排：带身份的叶子（歌词字、弧、小节线，见 `mixed/prims.ts::StaffLeafData`），按 `staffLeafKey` 收。 */
  private staffLeaves = new Map<string, { page: number; item: PageItem }[]>();
  /** 叶子画出的 SVG 元素（`mixedVisitor` 的 `leafMap`）。 */
  private leafMap = new WeakMap<PageItem, SVGGraphicsElement>();
  /** 画出来的叶子元素 → 它的身份（点选按事件目标认）。 */
  private staffLeafOf = new WeakMap<Element, StaffLeafData>();
  /** 逐页高度。空 = 各页同高（`pageHeight`）；连续长纸那一档按内容逐页给。 */
  private pageHeights: number[] = [];
  private staff: StaffState | null = null;
  /** 原样文档这一路提交的结果（页面、定位结构与 note / syllable 身份索引）。与 staff 互斥。 */
  private original: OriginalDocumentLayout | null = null;
  private version = 0;

  constructor(readonly resources: PaintResources = PaintResources.shared()) {}

  /** 当前结果是原样文档引擎排的（`layout` / `score` 那份简谱引擎结果此时是旧的）。 */
  get fromDocument(): boolean {
    return this.original !== null;
  }

  /** 原样文档引擎排的展开档：各首实际走的演唱顺序（`page-check` 的 P5 按它数遍数）；别的结果为 null */
  get expandPlans(): ReadonlyArray<readonly PlayItem[] | null> | null {
    return this.original?.plans ?? null;
  }

  /** 导出 PPTX 用的页面（`editor/pptx.ts::buildPptx`）：原样文档引擎排的就取它那一份，否则取简谱引擎的。 */
  get pptxSource(): { pages: readonly Group[]; stackGap: number; pageWidth: number; pageHeight: number } {
    if (this.original) {
      return { pages: this.original.pages, stackGap: this.original.metrics.style.vertical.stackGap, pageWidth: this.pageWidth, pageHeight: this.pageHeight };
    }
    return { pages: this.layout.pages, stackGap: this.layout.options.stackGap, pageWidth: this.pageWidth, pageHeight: this.pageHeight };
  }

  /** 当前结果是哪一路画的。 */
  get renderer(): "jianpu" | "staff" | null {
    return this.staff ? "staff" : this.result ? "jianpu" : null;
  }

  /** 排版并提交。资源等待后与提交前各核一次版本：期间来了新请求就丢掉这份（`superseded`），
   *  不边算边改当前结果；最新请求失败则抛出、保留上次成功的结果。 */
  async load(request: PaintRequest): Promise<LoadOutcome> {
    const v = ++this.version;
    const res = await this.resources.prepare();
    if (v !== this.version) return "superseded";
    let commit: () => void;
    try {
      if (isStaffRequest(request)) {
        const meta = res.smuflMeta ?? (await MetaData.shared());
        if (v !== this.version) return "superseded";
        commit = this._staffCommit(request, meta);
      } else {
        commit = this._syncCommit(request, res);
      }
    } catch (e) {
      if (v !== this.version) return "superseded";
      throw e;
    }
    if (v !== this.version) return "superseded";
    commit();
    return "committed";
  }

  /** 资源已就绪时同步排版并提交（编辑器预览的简谱路与原样文档、成书、帮助、量断行）。也作废在途的异步请求。 */
  loadSync(request: SyncPaintRequest): void {
    const res = this.resources.ready();
    if (!res) throw new Error("排版资源还没准备好");
    ++this.version;
    this._syncCommit(request, res)();
  }

  private _syncCommit(request: SyncPaintRequest, res: PreparedResources): () => void {
    return isDocumentRequest(request) ? this._documentCommit(request) : this._jianpuCommit(request, res);
  }

  /** 让未完成的请求作废，放掉持有的 DOM 引用。 */
  dispose(): void {
    ++this.version;
    this.nodeMap = new WeakMap();
    this.index = ScoreIndex.empty();
    this.original = null;
  }

  /** 简谱引擎这一路：在局部变量里排完，返回提交动作。 */
  private _jianpuCommit(req: JianpuPaintRequest, res: PreparedResources): () => void {
    const layout = jianpuLayoutOf(req, res);
    let w: number;
    let h: number;
    let pageHeights: number[] = [];
    if (req.view === "expanded") {
      w = req.style?.page.size?.[0] ?? 960;
      h = req.style?.page.size?.[1] ?? 540;
      layoutExpandedPages(layout, req.score, w, h, req.breakDesc);
    } else {
      w = req.page?.w ?? 0;
      h = req.page?.h ?? 0;
      if (req.snippet) {
        layout.fromScore(req.score, req.breakDesc, w, h);
        layout.pages[0]?.update();
      } else {
        pageHeights = layoutOriginalPages(layout, req.score, w, h, req.breakDesc);
      }
    }
    const pages: LayoutPage[] = layout.pages.map((root, i) => ({
      root,
      geometry: pageGeometry(w, pageHeights[i] ?? h, 1),
      renderer: "jianpu",
      songIndexes: [0],
    }));
    const result: LayoutResult = {
      title: req.score.title,
      pages,
      hits: [],
      diagnostics: [],
      staffPlacements: [],
      jianpuLineStarts: [...layout.lineStarts],
    };
    return () => {
      this.layout = layout;
      this.score = req.score;
      this.jianpuView = req.view;
      this.pageWidth = w;
      this.pageHeight = h;
      this.pageHeights = pageHeights;
      this.staff = null;
      this.original = null;
      this.result = result;
      this.nodeMap = new WeakMap();
      this.playhead.reset();
      this.index = ScoreIndex.build(layout.pages, { cellLyrics: true });
    };
  }

  /** 原样文档这一路：整份文档排好（不等资源，`Font` 同步量字），返回提交动作。
   *  简谱引擎的 `layout` / `score` 保留不动（标题等取用）；`jianpuView` 记成原样档，PPTX 因此不会拿旧引擎页复用。 */
  private _documentCommit(req: DocumentPaintRequest): () => void {
    const sheet = req.style ?? computeStyleForPaper([THEMES.print], { mode: "original", engine: "jianpu" });
    const paper = resolvePaper(sheet.page);
    // 展开档：投影片纸（展开档样式的 `page.size`，同 `_jianpuCommit`）
    const slide = req.view === "expanded" ? { width: sheet.page.size?.[0] ?? 960, height: sheet.page.size?.[1] ?? 540, continuous: false } : null;
    const r = layoutOriginalDocument(req.doc, {
      style: jianpuStyleOf(sheet),
      // 长图：宽与简谱引擎的长图同一张（500 首那张纸的宽），高由内容定
      page: slide ?? (req.page
        ? { width: req.page.w, height: req.snippet ? req.page.w : req.page.h, continuous: !!req.snippet }
        : paper ? { width: paper.w, height: paper.h, continuous: false } : { width: LONG_IMAGE_WIDTH, height: LONG_IMAGE_WIDTH, continuous: true }),
      userMargins: pageMargins(sheet.page) !== undefined,
      foot: (sheet.template?.regions?.["song-foot"] as Region | undefined) ?? null,
      noReflow: req.noReflow,
      expanded: req.view === "expanded",
      breakDesc: req.breakDesc ?? null,
      ...(req.snippet ? { snippet: true } : {}),
      ...(req.ink !== undefined ? { ink: req.ink } : {}),
    });
    const result: LayoutResult = {
      title: r.view.songs[0]?.metadata.titles[0] ?? "",
      pages: r.pages.map((root, i) => ({
        root,
        geometry: pageGeometry(r.width, r.height, 1),
        renderer: "jianpu",
        songIndexes: [r.placed.pages[i]?.song ?? 0],
      })),
      hits: [],
      diagnostics: [],
      staffPlacements: [],
      jianpuLineStarts: r.lineStarts,
    };
    return () => {
      this.original = r;
      this.staff = null;
      this.jianpuView = req.view;
      this.pageWidth = r.width;
      this.pageHeight = r.height;
      this.pageHeights = [];
      this.result = result;
      this.nodeMap = new WeakMap();
      this.playhead.reset();
      this.index = ScoreIndex.build(r.pages, { cellLyrics: false });
    };
  }

  /** 五线谱 / 混排这一路：读谱 → 排页，返回提交动作。 */
  private _staffCommit(req: StaffPaintRequest, meta: MetaData): () => void {
    const options = staffOptionsOf(meta, req.style);
    options.hideBarNumber = req.hideBarNumber;
    options.page = req.page;
    const score = layoutStaff(req.doc, options);
    const { pages, placed } = layoutStaffPages(score, req.view === "mixed", req.jianpuPart ?? 0);
    const d = score.defaults;
    const wT = d.pageWidth ?? 1200;
    const hT = d.pageHeight ?? PAGE_HEIGHT_FALLBACK;
    const result: LayoutResult = {
      title: score.title,
      pages: pages.map((root) => ({ root, geometry: pageGeometry(wT, hT, score.scaling), renderer: "staff", songIndexes: [0] })),
      hits: [],
      diagnostics: [],
      staffPlacements: [{ songIndex: 0, score, systems: placed }],
      jianpuLineStarts: null,
    };
    return () => {
      this.staff = { score, pages, placed };
      this.original = null;
      this.result = result;
      this.nodeMap = new WeakMap();
      this.playhead.reset();
      this.index = ScoreIndex.empty();
      this.buildStaffIndex(pages);
    };
  }

  /** 五线谱各页页面树里的和弦组，按元素 id 收起来，连同它所在的系统组。 */
  private buildStaffIndex(pages: readonly Group[]): void {
    this.staffChords.clear();
    this.staffLeaves.clear();
    this.leafMap = new WeakMap();
    const walk = (item: PageItem, page: number, system: PageItem | null): void => {
      if (isStaffLeaf(item.data)) {
        const key = staffLeafKey(item.data);
        const list = this.staffLeaves.get(key) ?? [];
        list.push({ page, item });
        this.staffLeaves.set(key, list);
      }
      if (item.classes.has(STAFF_SYSTEM)) system = item;
      if (item.classes.has(STAFF_CHORD)) {
        const id = (item.data as StaffChordData).chordId;
        const list = this.staffChords.get(id) ?? [];
        list.push({ page, item, system });
        this.staffChords.set(id, list);
        return;
      }
      for (const c of item.children) walk(c, page, system);
    };
    pages.forEach((pg, i) => walk(pg, i, null));
  }

  /** 当前结果的曲名（导出文件名取首行）。 */
  get title(): string {
    return this.result?.title ?? this.score.title;
  }

  /** 当前结果是不是原样文档这一路排的（按源行排，没有几何拾取；面板按它摆原样档的设置）。 */
  get isDocumentLayout(): boolean {
    return this.original !== null;
  }

  /** 原样文档这一路音符数字的字号（pt），面板「基础字号」显示它；别的路为 null。 */
  /** 原样文档这一路定稿的栅格与尺子（样式快照脚本核对用）；别的路为 null。 */
  get documentMetrics(): JianpuGrid | null {
    return this.original?.metrics ?? null;
  }

  /** 原样文档的定位结构（回归脚本核对几何用）；别的路为空。 */
  placedPages(): PlacedPage[] {
    return this.original?.placed.pages ?? [];
  }

  /** 原样文档按播放顺序列出全部音符的 id（第一声部为主旋律）；别的路为空。 */
  playbackNotes(): ElementId[] {
    const r = this.original;
    const out: ElementId[] = [];
    for (const page of r?.placed.pages ?? []) {
      for (const group of page.groups) {
        const voice = group.voices[0];
        if (!voice) continue;
        for (const it of voice.items) {
          const id = it.element.kind === "note" ? r!.view.idOf.get(it.element) : undefined;
          if (id !== undefined) out.push(id);
        }
      }
    }
    return out;
  }

  /** 五线谱排好的版面与各系统落位（MusicXML 布局导出写版面坐标用，`mixed/engrave.ts`）。 */
  get staffPlacement(): LayoutResult["staffPlacements"][number] | null {
    return this.result?.staffPlacements[0] ?? null;
  }

  /** 元素 `id` 的音符格：简谱两条路按第 `pass` 遍（找不到那一遍取第一个），五线谱取五线谱层那一组。 */
  private noteHit(id: ElementId, pass = 0): Hit | null {
    if (this.staff) return this.staffChords.get(id)?.[0] ?? null;
    return this.index.note(id, pass);
  }

  private elsOf(items: readonly PageItem[]): SVGGElement[] {
    return items.flatMap((it) => {
      const el = this.nodeMap.get(it);
      return el ? [el] : [];
    });
  }

  private elOf(hit: Hit | null): SVGGElement | null {
    return hit ? this.nodeMap.get(hit.item) ?? null : null;
  }

  /** 试听光标挪到元素 `id` 第 `pass` 遍的音（null = 撤掉）。返回所在页。
   *  各视图统一放竖直播放线（`playhead.ts`），不给音符着色；播放器跟各声部起音走，多声部时
   *  女高休止、别的声部在唱也照走。这一视图里没画的音（展开档只排带歌词的那个声部）不挪，留在上一处。
   *  纵向：五线谱 / 混排取谱表带；简谱两条路取音符所在那一行（`system` 标签，多声部是连谱号括起的整组）。 */
  highlight(id: ElementId | null, pass = 0): number | null {
    if (id === null) {
      this.playhead.move();
      return null;
    }
    if (this.staff) {
      const hit = this.staffChords.get(id)?.[0];
      if (!hit?.system) return null;
      const sysEl = this.nodeMap.get(hit.system);
      const band = hit.system.data as StaffSystemData;
      this.playhead.move(this.nodeMap.get(hit.item), sysEl ? spanIn(sysEl, band.top, band.bottom) : null);
      return hit.page;
    }
    const hit = this.index.note(id, pass);
    const el = hit ? this.nodeMap.get(hit.item) : undefined;
    if (!hit || !el) return null;
    const span = this.playhead.systemSpan(this.index, hit.item, (it) => this.nodeMap.get(it));
    this.playhead.move(el, span ?? svgBox(el));
    return hit.page;
  }

  /** 五线谱 / 混排：点中的元素（事件目标）落在哪个和弦组里 → 元素 id；不在和弦上为 null。 */
  staffChordAt(target: Element | null): ElementId | null {
    if (!this.staff) return null;
    for (let el = target; el && !(el instanceof SVGSVGElement); el = el.parentElement) {
      const id = this.staffElId.get(el);
      if (id !== undefined) return id;
    }
    return null;
  }

  /** 五线谱 / 混排：元素 `id` 画出来的各个和弦组（五线谱层、简谱叠层各一个）。 */
  staffChordEls(id: ElementId): SVGGElement[] {
    return (this.staffChords.get(id) ?? []).flatMap((h) => {
      const el = this.nodeMap.get(h.item);
      return el ? [el] : [];
    });
  }

  /** 五线谱 / 混排：某个叶子身份（歌词字、弧、小节线）画出来的各个元素；没画出来为空。 */
  staffLeafEls(d: StaffLeafData): SVGGraphicsElement[] {
    return (this.staffLeaves.get(staffLeafKey(d)) ?? []).flatMap((h) => {
      const el = this.leafMap.get(h.item);
      return el?.isConnected ? [el] : [];
    });
  }

  /** 五线谱 / 混排：事件目标是不是一个带身份的叶子（歌词字、弧、小节线）。 */
  staffLeafAt(target: Element | null): StaffLeafData | null {
    return target ? this.staffLeafOf.get(target) ?? null : null;
  }

  /** 五线谱 / 混排：和弦 `id` 所在系统的谱表带（混排连同简谱层），换成它所在页面 SVG 的用户坐标：光标竖线照这一带的高度画。 */
  staffBand(id: ElementId): { svg: SVGSVGElement; y: number; h: number } | null {
    const hit = this.staffChords.get(id)?.[0];
    const sys = hit?.system;
    const g = sys ? this.nodeMap.get(sys) : undefined;
    const svg = g?.ownerSVGElement;
    if (!sys || !g || !svg) return null;
    const d = sys.data as StaffSystemData;
    const m = svg.getScreenCTM()?.inverse().multiply(g.getScreenCTM() ?? new DOMMatrix());
    if (!m) return null;
    const y0 = new DOMPoint(0, d.top).matrixTransform(m).y;
    const y1 = new DOMPoint(0, d.bottom).matrixTransform(m).y;
    return { svg, y: Math.min(y0, y1), h: Math.abs(y1 - y0) };
  }

  /** 元素 `id` 第一次出现在第几页（光标同步翻页用）；没画出来为 null。 */
  pageOf(id: ElementId): number | null {
    if (this.staff) return this.staffChords.get(id)?.[0]?.page ?? null;
    return this.index.pageOf(id);
  }

  /** 元素 `id` 第 `pass` 遍那个音的 `<g>`（点选、滚动到可见用）；没画出来为 null。 */
  entryEl(id: ElementId, pass = 0): SVGGElement | null {
    return this.elOf(this.noteHit(id, pass));
  }

  /** 挨着元素 `id` 的那条小节线的 `<g>`（`edge` 是它在音符的哪一侧）；没画出来为 null。
   *  小节线没有自己的 id，按「相邻音符 + 侧」认（身份标签的 `edge`，见 `identity.ts`）。 */
  barlineEl(id: ElementId, edge: "before" | "after"): SVGGElement | null {
    return this.elOf(this.index.barline(id, edge));
  }

  /** 从 `start` 连到 `end` 的那条圆滑线/延音线的 `<g>`；没画出来（跨行时另一端不在本行）为 null。 */
  slurEl(start: ElementId, end: ElementId): SVGGElement | null {
    return this.elOf(this.index.slur(start, end));
  }

  /** 宿主音符 `hostId` 的第 `ord` 条增时线（0 起）的 `<g>`；没画出来为 null。
   *  增时线有自己 id 的（行视图里它就带着，`ownId`）按 id 认；没有的（`.jpwabc` 的 `-` 写在音符 token 里）
   *  按跟在音符格后面的序数认——第 0 个是音符本身。 */
  sustainEl(hostId: ElementId, ord: number, ownId?: ElementId, pass = 0): SVGGElement | null {
    return this.elOf(this.index.sustain(hostId, ord, ownId, pass));
  }

  /** 元素 `id` 的各条增时线格的 `<g>`（跟在音符格后面的那几个「-」格，按序）。
   *
   *  `.jpwabc` 的增时线写在音符 token 里、模型里没有它自己的对象，可视化编辑只能按这几个格
   *  认出「点中的是第几条」，再去选 token 里那一串 `-`（见 `NoteParts.sustains`）。 */
  sustainCellEls(id: ElementId, pass = 0): SVGGElement[] {
    return this.elsOf(this.index.sustainCells(id, pass).map((h) => h.item));
  }

  /** 元素 `id` 第 `verse` 段（行内 0 起）歌词的那个字的 `<g>`；`verseNo` 是源段号（缺省 = verse + 1）。
   *  原样文档一段一个音节；简谱引擎的音符格把各段歌词收在同一个 `<g>` 里，按段号取这一段自己的那个字，
   *  取不到（格里没有歌词图元）就退回整个音符格。 */
  lyricEl(id: ElementId, verse = 0, verseNo?: number): SVGGElement | null {
    return this.elOf(this.index.syllable(id, verse, verseNo));
  }

  /** 收在元素 `id` 音符格里的各段歌词 `<g>`（只亮音符时要把它们摘出来）。原样文档的歌词不在格里，为空。 */
  cellLyricEls(id: ElementId): SVGGElement[] {
    return this.elsOf(this.index.cellSyllables(id, 0).map((l) => l.hit.item));
  }

  /** 元素 `id` 音符格里某角色子项的 `<g>`，按页面树顺序（可视化编辑选中附点与挂在音符上的记号）。 */
  partEls(id: ElementId, role: VisualPartRole, pass = 0): SVGGElement[] {
    const kind: IdentityKind = role;
    return this.elsOf(this.index.parts(id, kind, pass).map((h) => h.item));
  }

  /** 页眉里画出来的东西（标题、署名、调号拍号）：`<g>`、所画的字、是不是调号拍号。可视化编辑按字对回原文字段。 */
  headerParts(): HeaderPart[] {
    if (this.staff) {
      // 五线谱 / 混排：标题块各行（`StaffLeafData` 的 credit），按字认
      const out: HeaderPart[] = [];
      for (const hits of this.staffLeaves.values()) {
        for (const h of hits) {
          const d = h.item.data;
          const el = this.leafMap.get(h.item);
          if (isStaffLeaf(d) && d.staffRole === "credit" && el?.isConnected) out.push({ el, text: d.text, role: "text" });
        }
      }
      return out;
    }
    return headerPartsOf(this.result?.pages.map((p) => p.root) ?? [], this.nodeMap);
  }

  // ---------------- SVG rendering ----------------

  /** 第 `pageIndex` 页渲染成独立的 `<svg>`（viewBox 是原生坐标：简谱排版单位 / 五线谱 tenths）。 */
  renderPage(pageIndex: number): SVGSVGElement {
    if (this.staff) {
      const page = this.result?.pages[pageIndex];
      if (!page) throw new Error(`ScorePainter: 没有第 ${pageIndex + 1} 页`);
      const { w, h } = page.geometry.viewBox;
      const svg = renderPageSvg(page.root, w, h, { cls: "score-page mixed-page", visitor: mixedVisitor(this.nodeMap, this.leafMap) });
      for (const [id, hits] of this.staffChords) {
        for (const h of hits) {
          const el = h.page === pageIndex ? this.nodeMap.get(h.item) : undefined;
          if (el) this.staffElId.set(el, id);
        }
      }
      for (const hits of this.staffLeaves.values()) {
        for (const h of hits) {
          const el = h.page === pageIndex ? this.leafMap.get(h.item) : undefined;
          if (el && isStaffLeaf(h.item.data)) this.staffLeafOf.set(el, h.item.data);
        }
      }
      return svg;
    }
    const page = this.result?.pages[pageIndex];
    if (!page) throw new Error(`ScorePainter: 没有第 ${pageIndex + 1} 页`);
    const { w, h } = page.geometry.viewBox;
    return renderPageSvg(page.root, w, h, this.nodeMap);
  }

  /** Walk up from a picked item to its enclosing "entry" group (else the item). */
  entryGroupOf(item: PageItem): PageItem {
    let cur: PageItem | null = item;
    while (cur) {
      if (cur.classes.has("entry")) return cur;
      cur = cur.parent;
    }
    return item;
  }

  get pageCount(): number {
    return this.result?.pages.length ?? 0;
  }

  /** 第 `index` 页的物理尺寸（pt）。简谱排版单位就是 pt；五线谱按谱里的 scaling 从 tenths 换算。 */
  pageSize(index: number): { w: number; h: number } {
    const g = this.result?.pages[index]?.geometry ?? this.result?.pages[0]?.geometry;
    if (g) return { ...g.sizePt };
    return { w: this.pageWidth, h: this.pageHeights[index] ?? this.pageHeight };
  }

  // ---------------- picking (Phase 3) ----------------

  private calcDist(x: number, y: number, inn: Rect): number {
    let dx = 0;
    if (x < inn.left) dx = inn.left - x;
    else if (x > inn.right) dx = x - inn.right;
    let dy = 0;
    if (y < inn.top) dy = inn.top - y;
    else if (y > inn.bottom) dy = y - inn.bottom;
    return dx + dy;
  }

  pick(root: PageItem, x: number, y: number): [PageItem | null, number] {
    let bnd = root.bound;
    bnd = bnd.offset(root.x, root.y);
    const edge = 5;
    const dist = this.calcDist(x, y, bnd);
    if (root.children.length === 0) {
      let outer = new Rect(bnd.left, bnd.top, bnd.right, bnd.bottom);
      const dx = Math.min(bnd.width - edge * 2, 0) / 2;
      const dy = Math.min(bnd.height - edge * 2, 0) / 2;
      outer = outer.inset(dx, dy);
      return outer.contains(x, y) ? [root, dist] : [null, dist];
    }
    let outer = new Rect(bnd.left, bnd.top, bnd.right, bnd.bottom);
    outer = outer.inset(-edge, -edge);
    if (outer.contains(x, y)) {
      const xx = x - bnd.left;
      const yy = y - bnd.top;
      const items: PageItem[] = [];
      let minDist = Number.MAX_VALUE;
      let best: PageItem | null = null;
      let small: PageItem | null = null;
      for (const ch of root.children) {
        const [p, pd] = this.pick(ch, xx, yy);
        if (p !== null) {
          if (pd < minDist) {
            best = p;
            minDist = pd;
            items.length = 0;
            items.push(p);
          }
          if (pd === minDist) items.push(p);
          if (ch.bound.width < edge || ch.bound.height < edge) small = ch;
        }
      }
      if (small !== null) return [small, 0];
      let area = Number.MAX_VALUE;
      for (const it of items) {
        const a = it.bound.width * it.bound.height;
        if (a < area) {
          best = it;
          area = a;
        }
      }
      return [best, minDist];
    }
    return [null, Number.MAX_VALUE];
  }

  /** 页面 pt 坐标处的图元（简谱两条路；五线谱没有几何拾取，靠事件冒泡找和弦组）。
   *  `target` 是它所在音符格 / 增时线格的元素（按身份标签认），页眉、小节线等为 null。 */
  pickPage(page: number, pointPt: { x: number; y: number }): LayoutHit | null {
    const lp = this.result?.pages[page];
    if (!lp || lp.renderer !== "jianpu") return null;
    const pos = fromPt(lp.geometry, pointPt.x, pointPt.y);
    const [item] = this.pick(lp.root, pos.x, pos.y);
    if (!item) return null;
    const cell = cellOf(item)?.ident;
    const target: PaintTarget | null = cell?.id !== undefined
      ? { kind: "element", songIndex: 0, id: cell.id, occurrence: cell.pass ?? 0 }
      : null;
    return { target, pageIndex: page, item, boundsPt: absBounds(item, lp.geometry.ptPerUnit), layer: "jianpu" };
  }
}

/** 图元在页上的包围盒（pt）：沿父链累加各级 x/y 偏移（简谱这一路的页面树不带旋转缩放）。 */
function absBounds(item: PageItem, ptPerUnit: number): { x: number; y: number; w: number; h: number } {
  let x = item.bound.left;
  let y = item.bound.top;
  for (let cur: PageItem | null = item; cur; cur = cur.parent) {
    x += cur.x;
    y += cur.y;
  }
  return { x: x * ptPerUnit, y: y * ptPerUnit, w: item.bound.width * ptPerUnit, h: item.bound.height * ptPerUnit };
}
