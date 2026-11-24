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
  /** MangaBaka's tag id (for tag searches); missing on data cached before ids were kept. */
  id?: number;
  name: string;
  /** Where it sits, e.g. "Themes > Horror > Body Horror". */
  path: string;
  weight: TagWeight;
  genre: boolean;
  spoiler: boolean;
  /** How many series carry it on MangaBaka (rarer = more telling); missing on older data. */
  count?: number;
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

/** Every string under "title" keys (or plain strings) in a value of any shape: arrays, {en: [...]} maps, objects. */
function collectTitles(v: unknown, out: string[], depth = 0): void {
  if (depth > 4 || v == null) return;
  if (typeof v === "string") {
    const s = str(v);
    if (s && !out.includes(s)) out.push(s);
  } else if (Array.isArray(v)) for (const x of v) collectTitles(x, out, depth + 1);
  else if (typeof v === "object") {
    const o = v as Obj;
    if (typeof o.title === "string") collectTitles(o.title, out, depth + 1);
    else for (const x of Object.values(o)) if (typeof x === "object") collectTitles(x, out, depth + 1);
  }
}
/** v1 has title / native_title / romanized_title / secondary_titles; v2 only a titles list with is_primary. */
function mainTitle(r: Obj): string | null {
  if (str(r.title)) return str(r.title);
  const list = Array.isArray(r.titles) ? r.titles.map(obj) : [];
  return str(list.find((t) => t.is_primary === true)?.title) ?? str(list[0]?.title) ?? null;
}
function titlesOf(r: Obj): string[] {
  const out: string[] = [];
  const main = mainTitle(r);
  if (main) out.push(main);
  for (const k of ["native_title", "romanized_title", "secondary_titles", "titles"]) collectTitles(r[k], out);
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
  const id = num(x.tag && typeof x.tag === "object" ? obj(x.tag).id : x.id);
  const count = num(t.series_count);
  return {
    ...(id !== null ? { id } : {}),
    ...(count !== null ? { count } : {}),
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
  const title = mainTitle(r);
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
    const title = mainTitle(r);
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

  // v1, not v2: v2 records have no tags and no plain title (checked against the live API, Nov 23 2026).
  async search(q: string, limit = 10): Promise<BakaHit[]> {
    const j = await this.get(`/v1/series/search?q=${encodeURIComponent(q)}&limit=${limit}`, this.gaps.search);
    return j === null ? [] : parseHits(j);
  }

  /**
   * MangaBaka's own "Similar series" (by shared tags, author and relations), best first. Each item carries
   * the full series record (v1), so its tags come along. (Multi-tag search doesn't work as an AND filter:
   * repeated tag= keeps only the first, checked live Nov 23 2026, so this is the way to get tag neighbours.)
   */
  async similar(id: number): Promise<{ score: number; sharedTotal: number; shared: string[]; series: BakaSeries }[]> {
    const j = await this.get(`/v1/series/${id}/similar`, this.gaps.other);
    const list = j === null ? [] : obj(j).data;
    const out: { score: number; sharedTotal: number; shared: string[]; series: BakaSeries }[] = [];
    for (const item of Array.isArray(list) ? list : []) {
      const x = obj(item);
      const series = parseSeries(x.series);
      if (!series) continue;
      const shared = (Array.isArray(x.shared_tags) ? x.shared_tags : []).map((t) => str(obj(t).name)).filter((n): n is string => n !== null);
      out.push({ score: num(x.score) ?? 0, sharedTotal: num(x.shared_tags_total) ?? shared.length, shared, series });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /**
   * Series carrying one tag, as full records (with their tags and rating). One tag per call: repeated tag=
   * keeps only the first (checked live Nov 23 2026).
   */
  async byTag(tagId: number, limit = 50, rating?: string): Promise<BakaSeries[]> {
    // A content rating narrows the list to that rating, so an explicit series' pool isn't mostly safe titles.
    const r = rating ? `&content_rating=${encodeURIComponent(rating)}` : "";
    const j = await this.get(`/v1/series/search?tag=${tagId}&limit=${limit}${r}`, this.gaps.search);
    const j2 = obj(j);
    const list = Array.isArray(j2.data) ? j2.data : Array.isArray(j2.results) ? j2.results : [];
    return list.filter((x) => obj(x).state !== "deleted").map((x) => parseSeries(x)).filter((x): x is BakaSeries => x !== null);
  }

  async series(id: number): Promise<BakaSeries | null> {
    const j = await this.get(`/v1/series/${id}`, this.gaps.other);
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

export const bakaUrl = (id: number) => `https://mangabaka.org/${id}`;  // redirects to the canonical page
