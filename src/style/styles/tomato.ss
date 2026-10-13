/* 风格「番茄」：照番茄简谱原版渲染逐项量的那套（从前文本谱的出厂度量 `JIANPU_DEFAULTS`）。
 * 原值以音符字号 25pt 为 1em 折成 em，取两位有效数字；叠在 print 主题之上。 */

title { size: 1.4em; }
credit { size: 0.64em; }
keyMeter { size: 0.64em; }
header { size: 0.64em; }
lyric { size: 0.68em; }
verseNum { size: 0.68em; }
chord { size: 0.56em; }

@jianpu {
  /* 多连音画两段弧（底本如此；出厂 500 首是括线） */
  tuplet-style: arc;
  barline: 0.06em;
  final-barline: 0.16em;
  beam-width: 0.08em;
  slur-thickness: 0.24em;
  slur-outline: 0;
  /* 原版弧高恒定（与跨度无关）：上下限同值 */
  slur-max-arc: 0.28em;
  slur-min-arc: 0.28em;
  hairpin-width: 0.05em;
  dot-radius: 0.09em;
  repeat-dot-diameter: 0.16em;
  barline-height: 1.2em;
  double-barline-gap: 0.2em;
  slur-gap: 0.17em;
  lyric-baseline: 1.5em;
  lyric-stack: 1.1em;
  system-gap: 2.7em;
  voice-gap: 1.8em;
  lrc-punct-compress: clreq;
  chord-plain: false;
  grace-scale: 0.5;
}
