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

export class ScoreIndex {
  private cells = new Map<ElementId, CellHit[]>();
  private barlines = new Map<string, Hit>();
  private slurs = new Map<string, Hit>();
  private syllables = new Map<string, Hit>();
  private systems = new Map<PageItem, PageItem[]>();

  private constructor() {}

  static build(pages: readonly PageItem[]): ScoreIndex {
    const ix = new ScoreIndex();
    pages.forEach((pg, i) => ix.walk(pg, i));
    return ix;
  }

  static empty(): ScoreIndex {
    return new ScoreIndex();
  }

  private lastNoteId: ElementId | null = null;
  /** 最近一个音符格的 id：带自己 id 的增时线格也记到它名下（排在音符格之后），按宿主 + 序数也认得出 */
  private lastHostId: ElementId | null = null;
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
              if (ident.kind === "note") this.lastHostId = ident.id;
              else if (this.lastHostId !== null && this.lastHostId !== ident.id) this.cells.get(this.lastHostId)?.push({ ...hit, pass: ident.pass ?? 0 });
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

  /** 元素 `id` 第 `verse` 段（行内 0 起）歌词那个字。 */
  syllable(id: ElementId, verse = 0): Hit | null {
    return this.syllables.get(`${id}:${verse}`) ?? null;
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
