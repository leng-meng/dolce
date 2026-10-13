// 一首（及一份文档）的定位：逐组排声部、组间让位、分页，长图把各页接成一张。
import type { Meter, PuSong } from "../../../pu/ast";
import { contentWidth, type JianpuGrid } from "../metrics";
import { paginate, type SystemBlock } from "../../../jianpu/vertical";
import type { InkMeasurer, PlacedGroup, PlacedPage, PlacedScore, PlacedVoice } from "./model";
import { placeColumns } from "./spacing";
import { type BeatCtx, assignLyrics, computeUnderlines, layoutVoiceLine } from "./voice";
import { GROUP_CLEAR, braceReach, chordLane, groupHeadroom, lineInkBottom, stackTop, voiceHeadroom } from "./vertical";
import { placeMarks } from "./marks";
import { placeLayers } from "./layers";

/**
 * `&sbf`（声部符）标出的分声部位置：取标着它的那条小节线**之后**第一个符号的 x。
 * 组内任一声部标了都算，取最早的一处。
 */
function braceStartX(voices: readonly PlacedVoice[]): number | null {
  let best: number | null = null;
  for (const v of voices) {
    const items = v.items;
    for (let i = 0; i < items.length; i++) {
      const el = items[i]!.element;
      if (el.kind !== "barline") continue;
      if (!el.ornaments.some((o) => o.name === "sbf")) continue;
      const next = items[i + 1];
      const x = next ? next.x : items[i]!.x;
      if (best === null || x < best) best = x;
    }
  }
  return best;
}

/**
 * 把一首曲子排成若干页。文本谱自己管分页（`[fenye]`），我们只在一页塞不下时再补断。
 */
export function layoutSong(
  song: PuSong,
  m: JianpuGrid,
  songIndex = 0,
  headerBottom = 0,
  ink: InkMeasurer,
): PlacedPage[] {
  // 行占满版心：行首最左的内容（数字落笔原点、升降号、歌词左缘）贴左缘，两端对齐后行末的占位右缘
  //（末个音符的字面右缘、或末条小节线）贴右缘，同简谱引擎
  const width = contentWidth(m);

  const bottomLimit = m.page.height - m.page.margin.bottom;
  // 拍号一路带过来：头部 `1=D4/4 3/4 5/4` 这类混合拍只有首个是起头拍号，其余由曲中
  // 的 `"p:3/4"` 逐小节改写（`BarlineElement.temporaryMeter`），故要跨行延续。
  // 只有减时线分组用得着（见 beatGroups）。
  let meterCursor: Meter | undefined = song.metadata.meters[0];
  // 跨行小节：上一行行末那个开口小节已用掉的拍数（见 openTailBeats）
  let carryCursor = 0;
  let atSongStart = true; // 整首的头一组——首小节不满就是弱起
  // 末组（整首的最后一个 system）单独判断：太短就不拉伸，留它短着
  const lastPage = song.pages[song.pages.length - 1];
  const lastGroup = lastPage?.groups[lastPage.groups.length - 1];
  // 每组先按**自己的原点**排（光标从 0 起），占位 = 光标推进的那一段（头顶让位 + 声部 + 歌词
  // + 组间距都在里面）；排完交给公共分页器定页与 y（`jianpu/vertical.ts::paginate`，`.jpwabc` 也走它）。
  // 从前这里自己分页：整组挪下页时先把光标重置到页顶、再减位移，下一组被排到页顶之上
  //（日光之下展开档第 2 页第二组 y = −515），挪过去的那组也丢了头顶的让位。
  const blocks: Array<SystemBlock & { group: PlacedGroup }> = [];
  for (const [pageIdx, srcPage] of song.pages.entries()) {
    for (const [groupIdx, group] of srcPage.groups.entries()) {
      let y = 0;
      // 记号往上画，先给这一组留够头顶空间：上一组末行（歌词基线或音符基线）到本组基线是 `system-gap`，
      // 本组头顶（常备的和弦槽，或更高的弧、房号、记号）与上一组末行之间至少留 `GROUP_CLEAR` 个歌词字号
      //（歌词下伸约 0.25 字号，再空半行），不够就整组下移
      const head = groupHeadroom(group, m);
      y += Math.max(0, head + GROUP_CLEAR * m.style.size.lyric - m.style.vertical.systemGap);
      // `W:` 文字行与和弦同处头顶那一槽，让位口径也同和弦（见 groupHeadroom）：墨迹顶再往上让一个数字高。
      // 只让到基线（textLineY）的话，字顶正落在上一组的组间距里——gapGroup 收到「只空一行」之后，
      // 上一组没有歌词时文字行就压到它的音符与小节线上（小兔子乖乖「前奏」压「引子」那行 16pt）。
      // 不改 groupHeadroom：首组离页首的「空一行」按文字行墨迹顶另算（layoutSong 的 firstTop），那边不该多出这一截。
      if (group.texts.length > 0) {
        y += Math.max(0, -(m.note.wordsY - m.style.size.words * 0.85) + m.ink.noteHeight - head);
      }

      const beatCtx: BeatCtx = {
        meter: meterCursor,
        carryIn: carryCursor,
        songStart: atSongStart,
        songEnd: group === lastGroup,
      };
      atSongStart = false;
      // 本组之后生效的拍号：以主声部为准（各声部拍号相同）
      for (const el of group.voices[0]?.elements ?? []) {
        if (el.kind === "barline" && el.temporaryMeter) meterCursor = el.temporaryMeter;
      }
      const laidOut = group.voices.map((voice) => layoutVoiceLine(voice, m, beatCtx));
      carryCursor = laidOut[0]?.tail ?? 0;
      // 音节先挂上（只按序号对到跟词的符号上），列宽要看字宽
      laidOut.forEach((l, vi) => {
        const voice = group.voices[vi]!;
        for (const it of l.items) it.syllables = new Array(voice.lyrics.length).fill(null);
        assignLyrics(l.items, voice.lyrics);
      });
      // 横向：各声部同一拍位归一列、列宽按内容、歌词避让、两端对齐（spacing.ts）
      placeColumns(laidOut, m, ink, width);

      const voices: PlacedVoice[] = [];
      let textY = y + m.note.wordsY;
      laidOut.forEach((l, vi) => {
        const voice = group.voices[vi]!;
        const underlines = computeUnderlines(voice, l.items, m, l.groups);
        // 第一行歌词的位置：样式给了 `lyric-baseline` 就不低于它；自动值与简谱引擎同一口径
        //（`layout.ts::Line.updateLyricY`）：数字墨迹底往下一个音符字号，再让开 max(0.4 字号, 数字底之下的叠层深度)
        //——一行里有「减时线 + 低音点」叠下来的音，歌词整行跟着下移，免得字顶贴到低音点上。
        const inkBottom = lineInkBottom(l.items, m);
        const digitBottom = m.ink.noteHeight / 2;
        const firstLyric = Math.max(
          m.style.vertical.lyricBaseline,
          digitBottom + m.style.size.note + Math.max(m.style.size.note * 0.4, inkBottom - digitBottom),
        );
        const lyricY0 = firstLyric;
        // 内联层要先排：`{dsb}` 会给主旋律那一段打上 dy，减时线与记号都得跟着走
        const layers = placeLayers(voice, l.items, m, beatCtx);
        // 并排块里主旋律下移了半个行距，歌词要跟着让开，否则会和下行音符叠在一起
        let splitDrop = 0;
        for (const lay of layers) {
          if (lay.split) splitDrop = Math.max(splitDrop, -lay.split.dy);
        }
        for (const u of underlines) {
          const at = l.items.find((it) => it.x >= u.x0 - 0.01 && it.x <= u.x1 + 0.01);
          if (at?.dy !== undefined) u.dy = at.dy;
        }
        const lyricY = voice.lyrics.map(
          (_, li) => y + lyricY0 + splitDrop + li * m.style.vertical.lyricStack,
        );
        const marks = placeMarks(voice, l.items, m);
        // 并排块的上行会顶到跳房子/记号的高度，跨过它的记号要整体抬到上行之上。
        // 跳房子还得**整行一起抬**——原版里一房二房的横线是同一条高度。
        let voltaLift = 0;
        for (const lay of layers) {
          const sp = lay.split;
          if (!sp || lay.items.length === 0) continue;
          const lx0 = Math.min(...lay.items.map((it) => it.x));
          const lx1 = Math.max(...lay.items.map((it) => it.x));
          // 只抬到**刚好让开上行**为止：原版里跳房子的线就贴在上行弧线上方一点点，
          // 整块抬一个行距会高得离谱
          const innerTop = sp.dy - voiceHeadroom(sp.line, m);
          const need = innerTop - m.ink.noteHeight * 0.15;
          for (const mk of marks) {
            if (mk.dy !== undefined || mk.x1 < lx0 || mk.x0 > lx1) continue;
            const lane = mk.mark.type === "volta" ? m.note.voltaY : (mk.y ?? m.note.slurY);
            const d = Math.min(0, need - lane);
            if (mk.mark.type === "volta") voltaLift = Math.min(voltaLift, d);
            else if (d < 0) mk.dy = d;
          }
        }
        if (voltaLift < 0) {
          for (const mk of marks) {
            if (mk.mark.type === "volta" && mk.dy === undefined) mk.dy = voltaLift;
          }
        }
        voices.push({
          voice,
          y,
          items: l.items,
          underlines,
          layers,
          marks,
          lyricY,
          chordY: chordLane(voice, m),
        });
        // 下一声部：先让过本声部的歌词块，再按「有没有歌词」取不同的间距
        //（歌词字块的下缘比数字低，所以它之后要多让一点）
        const isLast = vi === laidOut.length - 1;
        const hasLyrics = voice.lyrics.length > 0;
        // 并排块把主旋律压低了半个行距，下一声部要连这一段一起让开
        const consumed = hasLyrics
          ? lyricY0 + splitDrop + (voice.lyrics.length - 1) * m.style.vertical.lyricStack
          : splitDrop;
        let after = isLast ? m.style.vertical.systemGap : hasLyrics ? m.style.vertical.voiceGap : m.style.vertical.voiceGap;
        // 下一声部头顶的弧线/记号也要让开，否则会画进上面的歌词或音符里
        const next = group.voices[vi + 1];
        if (next) {
          after = Math.max(after, voiceHeadroom(next, m) + m.ink.noteHeight * 0.6);
        }
        y += consumed + after;
      });

      const hasBrace = voices.length > 1;
      const placedGroup: PlacedGroup = {
        group,
        voices,
        textY,
        braceTop: voices[0]!.y,
        braceBottom: voices[voices.length - 1]!.y,
        hasBrace,
      };
      // `&sbf`（声部符）标在哪条小节线上，连谱号就从那里起——前半段还是单声部，
      // 不该被括进来（原版《同一首歌》第 3 个 system 就是这样：前 4 小节 `8` 占位）。
      const sbf = braceStartX(voices);
      if (sbf !== null) placedGroup.braceFromX = sbf;
      // 源里的 `[fenye]`：新的一页从这组起（长图里也分开，由 layoutDocument 接成一张时多留一段白）
      blocks.push({ group: placedGroup, top: 0, bottom: y, breakBefore: groupIdx === 0 && pageIdx > 0 });
    }
  }
  // 连谱号的上下花头各伸出首/末声部 ≈1.5 个墨迹高（粗线探出 0.85，花头字形高 1.18 线距 =
  // 1.18/4 em × 字号 2.2 墨迹高，见 compose/brace.ts::paintBrace）。末声部底下有歌词时歌词块早把它盖住；
  // 展开档里末声部这一遍没词（同一首歌的 Q2）时，上一组的下花头会压到下一组的上花头。
  // 只在真会相压时把上一块往下撑——不压的一点不动，原样档的行距是对过原书的。
  const reach = braceReach(m);
  for (let i = 0; i + 1 < blocks.length; i++) {
    const a = blocks[i]!;
    const b = blocks[i + 1]!.group;
    if (!a.group.hasBrace || !b.hasBrace) continue;
    const need = a.group.braceBottom + 2 * reach - b.braceTop + m.ink.noteHeight * 0.3;
    if (a.bottom < need) a.bottom = need;
  }
  // 首页要让过标题/词曲/调号那一整块——头部行数因谱而异，写死会压到正文
  // headerBottom 是页首的**墨迹底**（compose/header.ts::headerBottom）。页首 → 首组**真正的墨迹顶**只空一行
  // （歌词字高，与 system 间距同口径）：墨迹顶取首声部数字/高八度点、和弦等头顶记号、`W:` 文字行里
  // 最高的那个——只按数字顶算，首组头顶有「引子」这类文字行时一行空隙就被吃掉了。
  // 不再拿 bodyTop 兜底（兜底会把「只空一行」重新撑大）；没传页首（0）时才用 bodyTop。
  let firstTop = m.page.margin.top + m.page.firstSystemTop;
  const g0 = blocks[0]?.group;
  if (headerBottom > 0 && g0) {
    const base = g0.voices[0]?.y ?? 0;
    let inkTop = base - m.ink.noteHeight / 2;
    for (const el of g0.voices[0]?.voice.elements ?? []) inkTop = Math.min(inkTop, base + stackTop(el, m));
    // 头顶槽位默认常备一行和弦（annotationY），真有和弦/记号时 groupHeadroom 才会超过它
    const head = groupHeadroom(g0.group, m);
    if (head > -m.note.chordY + 1e-6) inkTop = Math.min(inkTop, base - head);
    if (g0.group.texts.length > 0) inkTop = Math.min(inkTop, g0.textY - m.style.size.words * 0.85);
    firstTop = headerBottom + m.style.size.lyric - inkTop;
  }
  const otherTop = m.page.margin.top + m.page.firstSystemTop * 0.35;
  const laid = paginate(blocks, {
    pageTop: (i) => (i === 0 ? firstTop : otherTop),
    // 连续长图不按高度分页，页高随内容长
    bottom: m.page.longImage ? Infinity : bottomLimit,
    gap: 0,
  });
  if (laid.length === 0) return [{ groups: [], song: songIndex, firstOfSong: true }];
  return laid.map((pg, i) => ({
    song: songIndex,
    firstOfSong: i === 0,
    groups: pg.map(({ block, y }) => {
      shiftGroup(block.group, y);
      return block.group;
    }),
  }));
}

/** 排一整份文档（可含多首「一首多唱」）。 */
export function layoutDocument(
  songs: readonly PuSong[],
  m: JianpuGrid,
  headerBottoms: readonly number[] = [],
  ink: InkMeasurer,
): PlacedScore {
  let pages: PlacedPage[] = [];
  songs.forEach((song, i) => pages.push(...layoutSong(song, m, i, headerBottoms[i] ?? 0, ink)));

  // 连续长图：所有页面首尾相接成一张，源里的 `[fenye]` 只当作一段额外留白
  if (m.page.longImage && pages.length > 1) {
    const merged: PlacedPage = { groups: [], song: 0, firstOfSong: true };
    let offset = 0;
    for (const [i, pg] of pages.entries()) {
      if (i > 0) {
        const top = pg.groups[0]?.voices[0]?.y ?? 0;
        offset = lowestOf(merged) + m.style.vertical.systemGap * 1.4 - top;
        for (const g of pg.groups) shiftGroup(g, offset);
      }
      merged.groups.push(...pg.groups);
    }
    pages = [merged];
  }

  return {
    pages,
    metrics: m,
    contentBottom: pages.reduce((b, p) => Math.max(b, lowestOf(p)), 0),
    contentRight: pages.reduce((r, p) => Math.max(r, rightmostOf(p)), 0),
  };
}

/** 一页里最右沿的 x（行内坐标）。 */
function rightmostOf(page: PlacedPage): number {
  let right = 0;
  for (const g of page.groups) {
    for (const v of g.voices) {
      const last = v.items[v.items.length - 1];
      if (last) right = Math.max(right, last.x);
      for (const layer of v.layers) {
        const lastLayer = layer.items[layer.items.length - 1];
        if (lastLayer) right = Math.max(right, lastLayer.x);
      }
    }
  }
  return right;
}

/** 一页里最下沿的 y（末行歌词或末个声部）。 */
function lowestOf(page: PlacedPage): number {
  let bottom = 0;
  for (const g of page.groups) {
    for (const v of g.voices) {
      bottom = Math.max(bottom, v.y, ...v.lyricY);
    }
  }
  return bottom;
}

function shiftGroup(g: PlacedGroup, dy: number): void {
  g.textY += dy;
  g.braceTop += dy;
  g.braceBottom += dy;
  for (const v of g.voices) {
    v.y += dy;
    for (let i = 0; i < v.lyricY.length; i++) v.lyricY[i]! += dy;
  }
}
