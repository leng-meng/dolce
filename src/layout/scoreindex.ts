// 谱面的身份索引：遍历页面树，按图元上的身份标签（`identity.ts`）收起来，供播放高亮、点选、可视化编辑查。
// 引擎只管打标签；这里不认任何引擎内部的类型。

import type { ElementId } from "../model/doc";
import type { PageItem } from "./pageitem";
import type { IdentityKind } from "./identity";

export interface Hit {
  page: number;
  item: PageItem;
}

/** 同一元素的音符格与增时线格（展开档每遍各一组），按页面树顺序。 */
interface CellHit extends Hit {
  pass: number;
}

export interface ScoreIndexOptions {
  /** 歌词收在音符格里（简谱引擎）：音节标签不带 id，按所在音符格认；某段取不到就退回整个音符格。
   *  原样文档的音节各自成一格、带 id，取不到就是没有。 */
  cellLyrics: boolean;
}

export class ScoreIndex {
  private cells = new Map<ElementId, CellHit[]>();
  private barlines = new Map<string, Hit>();
  private slurs = new Map<string, Hit>();
  private syllables = new Map<string, Hit>();
  private systems = new Map<PageItem, PageItem[]>();

  private constructor(private readonly opts: ScoreIndexOptions) {}

  static build(pages: readonly PageItem[], opts: ScoreIndexOptions): ScoreIndex {
    const ix = new ScoreIndex(opts);
    pages.forEach((pg, i) => ix.walk(pg, i));
    return ix;
  }

  static empty(): ScoreIndex {
    return new ScoreIndex({ cellLyrics: false });
  }

  private lastNoteId: ElementId | null = null;
  /** 还等着后面那个音符来认领的小节线（`‖:` 画在小节第一个音符之前） */
  private pendingBefore: Hit[] = [];

  private walk(root: PageItem, page: number): void {
    let system: PageItem | null = null;
    const go = (item: PageItem): void => {
      const outer = system;
      const ident = item.ident;
      if (ident) {
        const hit = { page, item };
        switch (ident.kind) {
          case "system":
            system = item;
            this.systems.set(item, []);
            break;
          case "note":
          case "sustain":
            if (ident.id !== undefined) {
              const list = this.cells.get(ident.id) ?? [];
              list.push({ ...hit, pass: ident.pass ?? 0 });
              this.cells.set(ident.id, list);
              this.lastNoteId = ident.id;
              for (const b of this.pendingBefore) this.barlines.set(`${ident.id}:before`, b);
              this.pendingBefore = [];
              if (system) this.systems.get(system)!.push(item);
            }
            break;
          case "barline": {
            const edge = ident.edge ?? "after";
            if (ident.id !== undefined) {
              for (const id of [ident.id, ...(ident.also ?? [])]) this.barlines.set(`${id}:${edge}`, hit);
            } else if (edge === "before") this.pendingBefore.push(hit);
            else if (this.lastNoteId !== null) this.barlines.set(`${this.lastNoteId}:after`, hit);
            break;
          }
          case "slur":
            if (ident.id !== undefined && ident.end !== undefined) this.slurs.set(`${ident.id}:${ident.end}`, hit);
            break;
          case "syllable":
            if (ident.id !== undefined) {
              this.syllables.set(`${ident.id}:${ident.verse ?? 0}`, hit);
              if (system) this.systems.get(system)!.push(item);
            }
            break;
        }
      }
      for (const c of item.children) go(c);
      system = outer;
    };
    go(root);
  }

  /** 元素 `id` 第 `pass` 遍的音符格（找不到那一遍就取第一个）。增时线有自己 id 的，按它的 id 也认得出。 */
  note(id: ElementId, pass = 0): Hit | null {
    const list = this.cells.get(id);
    if (!list || list.length === 0) return null;
    return list.find((h) => h.pass === pass) ?? list[0]!;
  }

  pageOf(id: ElementId): number | null {
    return this.note(id)?.page ?? null;
  }

  /** 跟在音符格后面的增时线格（宿主 id 下第 1 个起），按序。 */
  sustainCells(id: ElementId, pass = 0): Hit[] {
    const list = this.cells.get(id);
    if (!list || list.length === 0) return [];
    const same = list.filter((h) => h.pass === pass);
    return (same.length > 0 ? same : list).slice(1);
  }

  /** 宿主 `host` 的第 `ord` 条增时线：有自己的 id（`own`）按 id 认，否则按序数。 */
  sustain(host: ElementId, ord: number, own: ElementId | undefined, pass = 0): Hit | null {
    if (own !== undefined) {
      const hit = this.cells.get(own)?.find((h) => h.item.ident?.kind === "sustain");
      if (hit) return hit;
    }
    return this.sustainCells(host, pass)[ord] ?? null;
  }

  barline(id: ElementId, edge: "before" | "after"): Hit | null {
    return this.barlines.get(`${id}:${edge}`) ?? null;
  }

  slur(start: ElementId, end: ElementId): Hit | null {
    return this.slurs.get(`${start}:${end}`) ?? null;
  }

  /** 收在元素 `id` 第 `pass` 遍那个音符格里的各段歌词与源段号。 */
  cellSyllables(id: ElementId, pass = 0): { hit: Hit; verse: number }[] {
    const cell = this.note(id, pass);
    if (!cell) return [];
    return findByKind(cell.item, "syllable").map((item) => ({ hit: { page: cell.page, item }, verse: item.ident?.verse ?? 0 }));
  }

  /** 元素 `id` 第 `verse` 段（行内 0 起）歌词那个字；`verseNo` 是源段号（缺省 = verse + 1）。 */
  syllable(id: ElementId, verse = 0, verseNo?: number): Hit | null {
    const own = this.syllables.get(`${id}:${verse}`);
    if (own || !this.opts.cellLyrics) return own ?? null;
    const ls = this.cellSyllables(id, verse);
    const one = ls.find((l) => l.verse === (verseNo ?? verse + 1)) ?? (ls.length === 1 ? ls[0] : undefined);
    return one ? one.hit : this.note(id, verse);
  }

  /** 元素 `id` 音符格里某种部件，按页面树顺序（命中的不再往下找）。 */
  parts(id: ElementId, kind: IdentityKind, pass = 0): Hit[] {
    const cell = this.note(id, pass);
    return cell ? findByKind(cell.item, kind).map((item) => ({ page: cell.page, item })) : [];
  }

  /** 图元所在那一行谱（`system` 标签）与行里的音符、增时线、歌词格。不在任何行里为 null。 */
  systemOf(item: PageItem): { system: PageItem; members: readonly PageItem[] } | null {
    for (let cur: PageItem | null = item; cur; cur = cur.parent) {
      const members = this.systems.get(cur);
      if (members) return { system: cur, members };
    }
    return null;
  }
}

/** 子树里某种标签的图元，按页面树顺序；命中的项不再往下找。 */
export function findByKind(root: PageItem, kind: IdentityKind): PageItem[] {
  const out: PageItem[] = [];
  const walk = (it: PageItem): void => {
    if (it !== root && it.ident?.kind === kind) {
      out.push(it);
      return;
    }
    for (const c of it.children) walk(c);
  };
  walk(root);
  return out;
}

/** 从点中的图元往上找它所在的音符格 / 增时线格（带 `note` / `sustain` 标签的那一层）。 */
export function cellOf(item: PageItem): PageItem | null {
  for (let cur: PageItem | null = item; cur; cur = cur.parent) {
    const k = cur.ident?.kind;
    if (k === "note" || k === "sustain") return cur;
  }
  return null;
}
