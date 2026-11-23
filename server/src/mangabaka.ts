import { normalizeTitle } from "./search.js";

/**
 * MangaBaka (mangabaka.org): an open manga database whose tags are detailed, nested ("Themes > Horror >
 * Body Horror") and weighted per series (core, defining, recurrent, incidental), plus a content rating.
 * Public reads need no key. Limits are per IP: search 30 a minute, everything else 180 a minute, so
 * calls here are spaced out. Data is CC BY-NC-SA 4.0 (personal use, with credit).
 */
const BASE = "https://api.mangabaka.org";
type FetchLike = typeof fetch;

export type TagWeight = "core" | "defining" | "recurrent" | "incidental" | "unweighted";
export interface BakaTag {
  name: string;
  /** Where it sits, e.g. "Themes > Horror > Body Horror". */
  path: string;
  weight: TagWeight;
  genre: boolean;
  spoiler: boolean;
}
export interface BakaSeries {
  id: number;
  title: string;
  titles: string[];
  type: string | null;
  year: string | null;
  /** safe, suggestive, erotica or pornographic (sexual content only, not violence). */
  contentRating: string | null;
  /** Out of 100. */
  rating: number | null;
  anilistId: number | null;
  malId: number | null;
  muId: string | null;
  tags: BakaTag[];
}
export interface BakaHit {
  id: number;
  title: string;
  titles: string[];
  type: string | null;
  year: string | null;
  anilistId: number | null;
}

const WEIGHTS: TagWeight[] = ["core", "defining", "recurrent", "incidental", "unweighted"];
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

function titlesOf(r: Obj): string[] {
  const out: string[] = [];
  const main = str(r.title);
  if (main) out.push(main);
  for (const t of Array.isArray(r.titles) ? r.titles : []) {
    const s = typeof t === "string" ? str(t) : str(obj(t).title);
    if (s && !out.includes(s)) out.push(s);
  }
  for (const t of Array.isArray(r.secondary_titles) ? r.secondary_titles : []) {
    const s = typeof t === "string" ? str(t) : str(obj(t).title);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
const yearOf = (r: Obj) => str(obj(r.published).start_date)?.slice(0, 4) ?? (num(r.year) !== null ? String(num(r.year)) : null);
const anilistOf = (r: Obj) => num(obj(obj(r.source).anilist).id);

/** One tag, whichever of the shapes the API uses ({tag: {...}, weight} or a flat object). */
function tagOf(raw: unknown): BakaTag | null {
  const x = obj(raw);
  const t = x.tag && typeof x.tag === "object" ? { ...obj(x.tag), ...x } : x;
  const name = str(t.name) ?? (typeof raw === "string" ? str(raw) : null);
  if (!name) return null;
  const w = String(t.weight ?? t.relevance ?? "unweighted").toLowerCase();
  return {
    name,
    path: str(t.name_path) ?? name,
    weight: (WEIGHTS as string[]).includes(w) ? (w as TagWeight) : "unweighted",
    genre: t.is_genre === true,
    spoiler: t.is_spoiler === true,
  };
}

export function parseSeries(raw: unknown): BakaSeries | null {
  const r = obj(obj(raw).data ?? raw);
  const id = num(r.id);
  const title = str(r.title);
  if (id === null || !title) return null;
  const src = obj(r.source);
  const rawTags = Array.isArray(r.tags_v2) ? r.tags_v2 : Array.isArray(r.tags) ? r.tags : [];
  const tags = rawTags.map(tagOf).filter((t): t is BakaTag => t !== null);
  return {
    id,
    title,
    titles: titlesOf(r),
    type: str(r.type),
    year: yearOf(r),
    contentRating: str(r.content_rating),
    rating: num(r.rating),
    anilistId: anilistOf(r),
    malId: num(obj(src.my_anime_list).id),
    muId: str(obj(src.manga_updates).id) ?? (num(obj(src.manga_updates).id) !== null ? String(num(obj(src.manga_updates).id)) : null),
    tags,
  };
}

function parseHits(raw: unknown): BakaHit[] {
  const j = obj(raw);
  const list = Array.isArray(j.data) ? j.data : Array.isArray(j.results) ? j.results : Array.isArray(j.items) ? j.items : Array.isArray(raw) ? raw : [];
  const out: BakaHit[] = [];
  for (const item of list) {
    const r = obj(item);
    const id = num(r.id);
    const title = str(r.title);
    if (id === null || !title) continue;
    if (r.state === "deleted") continue;
    out.push({ id: num(r.merged_with) ?? id, title, titles: titlesOf(r), type: str(r.type), year: yearOf(r), anilistId: anilistOf(r) });
  }
  return out;
}

/** Calls spaced out so Sapphire stays well inside MangaBaka's limits. */
export class MangaBaka {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  constructor(
    private fetchImpl: FetchLike = fetch,
    private gaps = { search: 2500, other: 500 },
  ) {}

  private queued<T>(gap: number, run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const wait = this.last + gap - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return run();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async get(path: string, gap: number): Promise<unknown> {
    return this.queued(gap, async () => {
      const res = await this.fetchImpl(BASE + path, { headers: { accept: "application/json", "user-agent": "sapphire-reader" }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`MangaBaka answered ${res.status}`);
      return res.json();
    });
  }

  async search(q: string, limit = 10): Promise<BakaHit[]> {
    const j = await this.get(`/v2/series/search?q=${encodeURIComponent(q)}&limit=${limit}`, this.gaps.search);
    return j === null ? [] : parseHits(j);
  }

  async series(id: number): Promise<BakaSeries | null> {
    const j = await this.get(`/v2/series/${id}`, this.gaps.other);
    return j === null ? null : parseSeries(j);
  }
}

/**
 * Finds a series on MangaBaka: the same AniList entry wins outright; otherwise a result whose title (or one
 * of its other names) is exactly one of ours. A near miss is no match, so a series never borrows another's tags.
 */
export async function findOnBaka(mb: MangaBaka, names: string[], anilistId: number | null): Promise<BakaHit | null> {
  const wanted = new Set(names.map(normalizeTitle).filter(Boolean));
  const tries = [...new Set(names.filter((n) => n.trim().length >= 2))].slice(0, 3);
  let titleHit: BakaHit | null = null;
  for (const q of tries) {
    const hits = await mb.search(q);
    if (anilistId !== null) {
      const same = hits.find((h) => h.anilistId === anilistId);
      if (same) return same;
    }
    titleHit ??= hits.find((h) => h.titles.some((t) => wanted.has(normalizeTitle(t)))) ?? null;
    // An exact title match with no AniList to check against (or a different AniList entry is a sign it isn't the same).
    if (titleHit && (anilistId === null || titleHit.anilistId === null)) return titleHit;
  }
  return titleHit && (anilistId === null || titleHit.anilistId === null || titleHit.anilistId === anilistId) ? titleHit : null;
}

export const bakaUrl = (id: number) => `https://mangabaka.org/${id}`;
