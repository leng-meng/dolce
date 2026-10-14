#!/usr/bin/env node
// 简谱 OMR 命令行：图片 → 文本谱 / 123，**不起浏览器**（onnxruntime-node 原生推理）。
// 用法（仓库里从根跑；分发包里就在包目录跑）：
//   node scripts/omr-cli.mjs 图片.jpg                      # 默认输出诗歌本文本谱到 stdout
//   node scripts/omr-cli.mjs 图片.jpg -f 123 -o 曲.123   # 换格式、写文件
//   node scripts/omr-cli.mjs 图片.jpg --profile             # 附带分段耗时与线程配置
//   node scripts/omr-cli.mjs a.jpg b.jpg 谱子目录/ -o 出目录/ # 批量：一个进程跑完整批
//   node scripts/omr-cli.mjs 图.jpg --thread-mode=always --threads=8   # 调线程策略
//   node scripts/omr-cli.mjs 图.jpg --lyrics 歌词.txt        # 参照歌词互证：形近字按歌词选字、补漏字，不一致处报到 stderr
//   node scripts/omr-cli.mjs 图.jpg -l 歌词.lrc --lyrics-report 核对.json   # 核对结果另落 JSON
// 格式清单取自 src/omr/emit.ts::OMR_EMITTERS，加格式不用改本脚本。
//
// 参照歌词（--lyrics）只配**单张图**：一份歌词文件对一首歌（.txt / .lrc，编码 UTF-8/GBK/UTF-16 自动认）。
// 歌词按演唱顺序写全（反复、副歌每段都写）即可，结构行 `1.`、`(副歌)` 与 lrc 时间戳自动去掉。
//
// **批量比逐张起进程快得多**：模型 21MB、ONNX 图反序列化 + ORT 初始化 + JIT 预热大约要
// 2.4s（M5 实测，弱 CPU 上更久），逐张调用等于每张都付一遍；同一进程连跑只付一次。
// 服务端集成请优先用批量，或把本文件当库 import（见包内 README）。
//
// 线程策略（同一份判据在不同 CPU 上结论会反，详见 src/omr/runtime.node.ts）：
//   --thread-mode=auto    默认，按张量形状分派；单核强、核少的机器（Apple M 系）最快
//   --thread-mode=always  一律多线程；**单核弱、核多的机器（Xeon E5 那代）该用这个**
//   --thread-mode=single  一律单线程；CPU quota 只有一两核的容器里用
//   --threads=N           多线程时用几个核（默认 4）
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"]);

const argv = process.argv.slice(2);
const opts = { format: "shige", out: null, profile: false, help: false, imgs: [], lyrics: null, lyricsReport: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-f" || a === "--format") opts.format = argv[++i];
  else if (a === "-o" || a === "--out") opts.out = argv[++i];
  else if (a === "--profile") opts.profile = true;
  else if (a === "-l" || a === "--lyrics") opts.lyrics = argv[++i];
  else if (a === "--lyrics-report") opts.lyricsReport = argv[++i];
  else if (a === "-h" || a === "--help") opts.help = true;
  // 线程开关要在 import 产物**之前**落到 env——那两个是模块顶层常量，import 完再设就晚了。
  else if (a.startsWith("--threads=")) process.env.OMR_THREADS = a.slice(10);
  else if (a.startsWith("--thread-mode=")) process.env.OMR_THREAD_MODE = a.slice(14);
  else opts.imgs.push(a);
}

function usage(emitters) {
  const list = emitters ? emitters.map((e) => `${e.id}（${e.label}）`).join("、") : "shige / tomato / 123";
  console.error(`用法: omr-cli.mjs <图片…|目录…> [-f 格式] [-o 输出] [--profile]
              [--thread-mode=auto|always|single] [--threads=N]
              [-l 歌词文件 [--lyrics-report 核对.json]]
格式: ${list}
批量: 多个图片或目录一起给，同一进程跑完（省掉每张的模型加载）；-o 给目录则逐个写文件。
歌词: -l/--lyrics 给同一首诗歌的歌词文本（.txt/.lrc），只配单张图；形近字按歌词选字、补漏字，
      两边不一致处打到 stderr，--lyrics-report 另落 JSON。`);
}

// 两种布局都要认：仓库里是 ../out/cli/omr.js，打包产物里是同目录的 ./omr.js。
const CLI_URL = ["./omr.js", "../out/cli/omr.js"]
  .map((r) => new URL(r, import.meta.url))
  .find((u) => existsSync(fileURLToPath(u)));
if (!CLI_URL) { console.error("找不到 omr.js —— 仓库里先跑 npm run build:cli"); process.exit(1); }
const cli = await import(CLI_URL.href);

if (opts.help || !opts.imgs.length) { usage(cli.OMR_EMITTERS); process.exit(opts.help ? 0 : 1); }
if (!cli.isOmrFormat(opts.format)) {
  console.error(`未知格式 ${opts.format}`); usage(cli.OMR_EMITTERS); process.exit(1);
}

/** 展开输入：目录 → 里面的图片（不递归，按名排序）。 */
async function expand(paths) {
  const out = [];
  for (const p of paths) {
    let st;
    try { st = await stat(p); } catch { console.error(`跳过（打不开）：${p}`); continue; }
    if (!st.isDirectory()) { out.push(p); continue; }
    const files = (await readdir(p)).filter((f) => IMG_EXT.has(extname(f).toLowerCase())).sort();
    if (!files.length) console.error(`跳过（目录里没图片）：${p}`);
    for (const f of files) out.push(join(p, f));
  }
  return out;
}

const imgs = await expand(opts.imgs);
if (!imgs.length) { console.error("没有可识别的图片"); process.exit(1); }
if (opts.lyricsReport && !opts.lyrics) { console.error("--lyrics-report 要和 --lyrics 一起给"); process.exit(1); }
let refLyrics;
if (opts.lyrics) {
  if (imgs.length !== 1) { console.error("--lyrics 只配单张图（一份歌词对一首歌），批量请逐张跑"); process.exit(1); }
  try { refLyrics = cli.decodeLyricsBytes(new Uint8Array(await readFile(opts.lyrics))); }
  catch (e) { console.error(`读不了歌词文件 ${opts.lyrics}：${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
}

// -o 是目录（多图，或路径本身就是已存在的目录）时逐个写文件，否则当单个输出文件。
const outIsDir = opts.out != null && (imgs.length > 1 || (existsSync(opts.out) && (await stat(opts.out)).isDirectory()));
if (outIsDir) await mkdir(opts.out, { recursive: true });
const EXT = { "123": ".123", jpwabc: ".jpwabc" };
// .jpwabc 按 JP-Word 的 UTF-16LE 带 BOM 落盘，其余 UTF-8
const encodeOut = (r) => (r.format === "jpwabc" ? Buffer.from("\ufeff" + r.text, "utf16le") : Buffer.from(r.text, "utf-8"));

let failed = 0;
const t0all = performance.now();
for (const img of imgs) {
  const t0 = performance.now();
  cli.omrProfileReset();
  let r;
  try {
    r = await cli.recognizeImage(new Uint8Array(await readFile(img)), {
      mime: MIME[extname(img).toLowerCase()], format: opts.format, lyrics: refLyrics,
    });
  } catch (e) {
    console.error(`✗ ${basename(img)}: ${e instanceof Error ? e.message : String(e)}`);
    failed++;
    continue;
  }
  const wall = performance.now() - t0;

  if (outIsDir) {
    const dst = join(opts.out, basename(img, extname(img)) + (EXT[r.format] ?? ".txt"));
    await writeFile(dst, encodeOut(r));
    console.error(`已写入 ${dst}`);
  } else if (opts.out) {
    await writeFile(opts.out, encodeOut(r));
    console.error(`已写入 ${opts.out}`);
  } else {
    if (imgs.length > 1) process.stdout.write(`# ===== ${basename(img)} =====\n`);
    process.stdout.write(r.text.endsWith("\n") ? r.text : r.text + "\n");
  }

  if (refLyrics !== undefined) {
    const lc = r.detail.score.lyricCheck;
    if (!lc) console.error("[歌词核对] 没有识别到歌词，未核对");
    else {
      const cnt = (k) => lc.items.filter((x) => x.kind === k).length;
      const review = lc.items.filter((x) => x.review).length;
      console.error(`[歌词核对] 按${lc.order === "expanded" ? "演唱顺序" : "谱面顺序"}对齐：同字 ${lc.matched}/${lc.ocrChars}（参照 ${lc.refChars} 字）`
        + ` ｜ 已改 ${cnt("fixed")}、已补 ${cnt("filled")}${review ? `（其中待复查 ${review}）` : ""}、待核 ${lc.items.length - cnt("fixed") - cnt("filled")}`);
      for (const x of lc.items) console.error("  " + cli.formatLyricCheckItem(x));
      for (const u of lc.unmatchedRef) console.error(`  [参照未对上] 第 ${u.from + 1}–${u.to} 字「${u.text}」`);
    }
    if (opts.lyricsReport) {
      await writeFile(opts.lyricsReport, JSON.stringify(lc ?? null, null, 2));
      console.error(`已写入 ${opts.lyricsReport}`);
    }
  }

  if (opts.profile) {
    const p = cli.omrProfile();
    const rows = r.detail.score.rows ?? [];
    const notes = rows.reduce((a, x) => a + (x.nums?.length ?? 0), 0);
    const ti = cli.threadInfo();
    console.error(`[OMR] ${basename(img)} ${r.detail.bin.w}×${r.detail.bin.h} ${rows.length}行/${notes}音`
      + ` ｜ 总 ${wall.toFixed(0)}ms = infer ${p.infer.toFixed(0)}(${p.calls}次) + CTC ${p.ctc.toFixed(0)}`
      + ` + 其余 ${(wall - p.infer - p.ctc).toFixed(0)}`
      + ` ｜ 线程 ${ti.mode}/${ti.threads}`);
  }
}

if (imgs.length > 1) {
  const total = performance.now() - t0all;
  console.error(`\n共 ${imgs.length} 张，成功 ${imgs.length - failed}，合计 ${(total / 1000).toFixed(1)}s，`
    + `平均 ${(total / imgs.length).toFixed(0)}ms/张（首张含模型加载）`);
}
process.exit(failed ? 1 : 0);
