/* 风格「诗歌本」：照诗歌本 App 自己导出的《圣哉三一歌》长图量的那套（从前文本谱诗歌本方言的度量，
 * 量法见 git 历史里的 src/style/books/original-shige.ss）。原值以音符字号 25.5pt 为 1em 折成 em，取两位有效数字或常见分数；
 * 叠在 print 主题之上，只写与它不同的项。 */

/* 底本的数字是粗的，各系统字体里最接近的是 Helvetica / Arial 粗体 */
note { family: "Helvetica Neue, Helvetica, Arial, PingFang SC, sans-serif"; }

/* 歌词 27pt、四段叠排行距 35pt 是一对（有意比底本放大，字回大之后行距也得跟着回） */
lyric { size: 1.1em; }
verseNum { size: 1.1em; }
chord { size: 0.75em; }

@jianpu {
  /* 多连音画两段弧（底本如此；出厂 500 首是括线） */
  tuplet-style: arc;
  barline-height: 4em / 3;
  double-barline-gap: 0.14em;
  beam-width: 0.06em;
  /* 歌词字块比数字高，不多让就会顶到低八度点 */
  lyric-baseline: 1.7em;
  lyric-stack: 1.4em;
}
