// Node 侧取 PDF 每页的**源图**：只认页面里内嵌的最大位图，按它的原生像素给出，不渲染、不重采样。
// 扫描本 PDF 每页就是一张 JPEG，这样取出来与原扫描图同尺寸；矢量 PDF（没有内嵌位图）直接报错。
// pdf.js 用 legacy 构建（Node 没有 DOM / OffscreenCanvas），图对象回来是 `{width, height, kind, data}`。
import { largestPageImageAt } from "./pdf";
import type { RgbaImage } from "./decode";

// pdf.js 图对象的 kind（ImageKind）
const GRAYSCALE_1BPP = 1, RGB_24BPP = 2, RGBA_32BPP = 3;

export interface PdfPages {
  count: number;
  /** 第 i 页（0 起）的源图。 */
  page(i: number): Promise<RgbaImage>;
  close(): Promise<void>;
}

export async function openPdfPages(bytes: Uint8Array): Promise<PdfPages> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: bytes, isEvalSupported: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    disableFontFace: true, verbosity: 0,
  });
  const doc = await task.promise;
  return {
    count: doc.numPages,
    async page(i) {
      const page = await doc.getPage(i + 1);
      try {
        const hit = await largestPageImageAt(page, pdfjs.OPS, (o) => (o?.data && o.width && o.height ? o.width * o.height : null));
        if (!hit) throw new Error(`PDF 第 ${i + 1} 页没有内嵌图片（矢量 PDF 请先导出为图片）`);
        return orient(toRgba(hit.obj), hit.ctm);
      } finally {
        page.cleanup();
      }
    },
    async close() { await task.destroy(); },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRgba(o: any): RgbaImage {
  const { width: w, height: h, kind, data } = o as { width: number; height: number; kind: number; data: Uint8Array };
  const out = new Uint8ClampedArray(w * h * 4);
  if (kind === RGBA_32BPP) out.set(data);
  else if (kind === RGB_24BPP) {
    for (let i = 0, j = 0; i < w * h; i++, j += 3) {
      out[i * 4] = data[j]; out[i * 4 + 1] = data[j + 1]; out[i * 4 + 2] = data[j + 2]; out[i * 4 + 3] = 255;
    }
  } else if (kind === GRAYSCALE_1BPP) {
    // 1 位：每行按字节对齐，1 = 白
    const stride = (w + 7) >> 3;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        const p = (y * w + x) * 4;
        out[p] = out[p + 1] = out[p + 2] = v; out[p + 3] = 255;
      }
    }
  } else throw new Error(`不认识的 PDF 图像格式 kind=${kind}`);
  return { data: out, width: w, height: h };
}

/** 按画图时的变换矩阵摆正：图的单位正方形（u 向右、v 向上；图像第 0 行在 v=1）→ 页面（y 向上）。
 *  只做翻转与 90° 倍数旋转，不缩放；正常摆放（a>0、d>0、b=c=0）原样返回。 */
function orient(img: RgbaImage, m: number[]): RgbaImage {
  const sgn = (v: number) => Math.sign(Math.round(v * 1000));
  const [sa, sb, sc, sd] = m.slice(0, 4).map(sgn);
  if (sa > 0 && sd > 0 && !sb && !sc) return img;
  const { width: w, height: h, data } = img;
  const xByU = sa !== 0; // 页面 x 随 u 变（否则随 v 变，即转了 90°）
  const W = xByU ? w : h, H = xByU ? h : w;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w, v = 1 - (y + 0.5) / h;
      const fx = xByU ? (sa > 0 ? u : 1 - u) : (sc > 0 ? v : 1 - v);
      const fyUp = xByU ? (sd > 0 ? v : 1 - v) : (sb > 0 ? u : 1 - u);
      const X = Math.min(W - 1, Math.floor(fx * W)), Y = Math.min(H - 1, Math.floor((1 - fyUp) * H));
      const s = (y * w + x) * 4, t = (Y * W + X) * 4;
      out[t] = data[s]; out[t + 1] = data[s + 1]; out[t + 2] = data[s + 2]; out[t + 3] = data[s + 3];
    }
  }
  return { data: out, width: W, height: H };
}
