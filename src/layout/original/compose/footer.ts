// 页脚（BL/BC/BR 模板）的排版。
import { Font } from "../../font";
import { TextFrame } from "../../pageitem";
import { layoutRegion, songFields } from "../../../style/template";
import { type OriginalCtx, text } from "./ctx";

/** 页脚区域（样式表的 `song-foot`，出厂在 print 主题）。按页宽算右缘，所以 `shiftX` 与 paintHeader 同口径；字号按 `as 角色` 取（`footerSize`）。 */
export function layoutFooters(c: OriginalCtx, shiftX: number): { page: number; bottom: number; items: TextFrame[] }[] {
  const region = c.foot;
  const placed = c.placed;
  if (!region || !c.doc || !placed) return [];
  const m = c.metrics;
  const out: { page: number; bottom: number; items: TextFrame[] }[] = [];
  placed.pages.forEach((pg, i) => {
    const next = placed.pages[i + 1];
    if (next && next.song === pg.song) return; // 不是本曲末页
    const meta = c.doc!.songs[pg.song]?.metadata;
    if (!meta || ![...meta.bottomLeft, ...meta.bottomCenter, ...meta.bottomRight].some((t) => t.trim() && t.trim() !== "-")) return;
    let low = 0;
    for (const g of pg.groups) for (const v of g.voices) low = Math.max(low, v.y, ...v.lyricY);
    const font = (size: number): Font => new Font(m.style.font.text.family, size);
    const res = layoutRegion(region, {
      field: songFields(undefined, {
        "pageText.bottomLeft": meta.bottomLeft.map((text) => ({ text })),
        "pageText.bottomCenter": meta.bottomCenter.map((text) => ({ text })),
        "pageText.bottomRight": meta.bottomRight.map((text) => ({ text })),
      }),
      pageNo: 1,
      content: { left: m.page.margin.left, right: c.pageWidth - m.page.margin.right - shiftX },
      dy: low + m.style.size.lyric,
      sizeOf: (role) => footerSize(m, role),
      measure: (_r, t, size) => font(size).measureText(t),
      fontMetrics: (_r, size) => ({ ascent: -font(size).metrics.ascent, height: size }),
    });
    const items = res.items.flatMap((p) => {
      if (p.kind !== "text") return [];
      const f = font(p.size);
      const w = f.measureText(p.text);
      const x = p.align === "center" ? p.x - w / 2 : p.align === "right" ? p.x - w : p.x;
      return [text(p.text, x, p.y, f, c.ink)];
    });
    out.push({ page: i, bottom: low + m.style.size.lyric + res.span, items });
  });
  return out;
}

/** 模板角色 → 字号：取尺子 `JianpuStyle` 的 `size` 与页眉四项，角色名与字段同名（`header`、`lyric`、`note`、`title`…）。 */
function footerSize(m: OriginalCtx["metrics"], role: string): number {
  const st = m.style;
  const sizes: Record<string, number> = { ...st.size };
  for (const r of ["title", "subtitle", "credit", "scripture"] as const) sizes[r] = st.header[r].size;
  const v = sizes[role];
  if (typeof v !== "number") throw new Error(`原样文档布局的模板认不出角色 ${role}（可用：${Object.keys(sizes).join(" ")}）`);
  return v;
}
