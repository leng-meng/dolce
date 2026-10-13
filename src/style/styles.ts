// 内置风格：原样档在设置面板里选的那一层（「诗歌 500 首」/「诗歌本」/「番茄」），叠在 print 主题之上、歌本样式表之下
//（`editor/app.ts::styleOf`）。风格不按格式自动套：文本谱的方言只管解析，同一种风格下各格式同值。
// 各风格的数值写在 `styles/*.ss`，按 em（音符字号）写、取两位有效数字。
import HYMN500_SS from "./styles/hymn500.ss?raw";
import SHIGE_SS from "./styles/shige.ss?raw";
import TOMATO_SS from "./styles/tomato.ss?raw";
import type { StyleRule } from "./cascade";
import { parseSs } from "./ss";

export const PRINT_STYLES = ["hymn500", "shige", "tomato"] as const;
export type PrintStyle = (typeof PRINT_STYLES)[number];

export const PRINT_STYLE_DEFAULT: PrintStyle = "hymn500";

const SOURCES: Record<PrintStyle, string> = { hymn500: HYMN500_SS, shige: SHIGE_SS, tomato: TOMATO_SS };
const cache = new Map<PrintStyle, StyleRule[]>();

/** 风格那一层的规则（解析一次）。 */
export function printStyleLayer(style: PrintStyle): StyleRule[] {
  let hit = cache.get(style);
  if (!hit) cache.set(style, (hit = parseSs(SOURCES[style]).rules));
  return hit;
}

export const isPrintStyle = (v: unknown): v is PrintStyle => typeof v === "string" && (PRINT_STYLES as readonly string[]).includes(v);

/** 设置面板「音符字体」能选的：字体族串与要不要加粗（空串 = 跟随风格）。 */
export const NOTE_FONTS: readonly { id: string; family: string; bold: boolean }[] = [
  { id: "pingfang", family: "PingFang SC, Microsoft YaHei, sans-serif", bold: true },
  { id: "helvetica", family: "Helvetica Neue, Helvetica, Arial, PingFang SC, sans-serif", bold: true },
  { id: "times", family: "Times New Roman, Times, serif", bold: false },
];
