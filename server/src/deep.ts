import { FAVORITES_ID, FORMAT_TAGS, tasteWeights, type LikedSeries } from "./discover.js";
import { canonKey } from "./genres.js";
import { normalizeTitle, type SearchResult, type SeriesGroup } from "./search.js";

/**
 * The deeper half of "For you". The quick rows search a pair of tags per series, which works for
 * series with a handful of tags and falls apart for ones with dozens (most 18+ series). These rows
 * look across everything you like instead:
 *
 * - themes: combinations of two or three tags that several of your series share;
 * - best matches: a wide pool of candidates, each judged on its full tag list against your whole
 *   taste (rare tags count for more, "not interested" counts against).
 */

export interface Theme {
  tags: string[];
  /** How many of your series have every tag in it, and a few of their names. */
  support: number;
  examples: string[];
  score: number;
}

const THEMES = 3;

/** The tags of a series that say something about it (no format tags, no hidden ones), as canonical keys. */
function storyKeys(tags: string[], hidden: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of tags) {
    const k = canonKey(t);
    if (k && !FORMAT_TAGS.has(k) && !hidden.has(k) && !out.has(k)) out.set(k, t);
  }
  return out;
}

/**
 * Tag combinations that recur across the series you like. Every pair of tags is counted over your
 * series (weighted by how much you like each); pairs that at least two of your series share are
 * scored by that weight and by how telling the tags are, then grown to three tags when a third is
 * shared by most of the same series. The best few that don't overlap much become rows.
 */
export function findThemes(liked: LikedSeries[], weight: (tag: string) => number, hidden: Set<string> = new Set()): Theme[] {
  // Themes are what your series share, so the favorite-tags stand-in doesn't take part.
  const series = liked.filter((s) => s.weight > 0 && s.mangaId !== FAVORITES_ID).map((s) => ({ ...s, keys: storyKeys(s.tags, hidden) })).filter((s) => s.keys.size >= 2);
  // How central a tag is to one series (primary, MangaBaka core…); 1 when unknown.
  const centrality = (i: number, k: string) => series[i].importance?.(series[i].keys.get(k) ?? k) ?? 1;
  if (series.length < 2) return [];
  const label = new Map<string, string>();
  for (const s of series) for (const [k, t] of s.keys) if (!label.has(k)) label.set(k, t);
  const w = (k: string) => weight(label.get(k) ?? k);

  // Pairs, with the series that have both.
  const pairs = new Map<string, { a: string; b: string; members: number[]; weight: number }>();
  series.forEach((s, i) => {
    const keys = [...s.keys.keys()].sort();
    for (let x = 0; x < keys.length; x++) {
      for (let y = x + 1; y < keys.length; y++) {
        const id = `${keys[x]}|${keys[y]}`;
        const p = pairs.get(id) ?? { a: keys[x], b: keys[y], members: [], weight: 0 };
        p.members.push(i);
        // A pair counts for as much as the series likes it and as central both tags are to it.
        p.weight += s.weight * Math.sqrt(centrality(i, keys[x]) * centrality(i, keys[y]));
        pairs.set(id, p);
      }
    }
  });
  const scored = [...pairs.values()]
    .filter((p) => p.members.length >= 2)
    .map((p) => ({ ...p, score: p.weight * w(p.a) * w(p.b) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 40);

  const grown: Theme[] = scored.map((p) => {
    // A third tag that most of these same series also have makes the theme sharper.
    const counts = new Map<string, number>();
    const central = new Map<string, number>();
    for (const i of p.members)
      for (const k of series[i].keys.keys())
        if (k !== p.a && k !== p.b) {
          counts.set(k, (counts.get(k) ?? 0) + 1);
          central.set(k, (central.get(k) ?? 0) + centrality(i, k));
        }
    let third: string | null = null;
    let best = 0;
    for (const [k, n] of counts) {
      const value = (central.get(k) ?? n) * w(k);
      if (n >= 2 && n >= Math.ceil(p.members.length * 0.6) && value > best) {
        best = value;
        third = k;
      }
    }
    const keys = third ? [p.a, p.b, third] : [p.a, p.b];
    const members = third ? p.members.filter((i) => series[i].keys.has(third!)) : p.members;
    const examples = [...members].sort((x, y) => series[y].weight - series[x].weight).slice(0, 3).map((i) => series[i].title);
    return {
      tags: keys.sort((x, y) => w(y) - w(x)).map((k) => label.get(k) ?? k),
      support: members.length,
      examples,
      score: p.score * (third ? 1 + w(third) : 1),
    };
  });

  // The best few that cover different ground: little overlap, and no tag in more than two rows.
  const chosen: Theme[] = [];
  const used = new Map<string, number>();
  for (const t of grown.sort((x, y) => y.score - x.score)) {
    if (chosen.length >= THEMES) break;
    const keys = t.tags.map(canonKey);
    if (keys.some((k) => (used.get(k) ?? 0) >= 2)) continue;
    const overlaps = chosen.some((c) => {
      const ck = new Set(c.tags.map(canonKey));
      const shared = keys.filter((k) => ck.has(k)).length;
      return shared / new Set([...keys, ...ck]).size > 0.34;
    });
    if (overlaps) continue;
    chosen.push(t);
    keys.forEach((k) => used.set(k, (used.get(k) ?? 0) + 1));
  }
  return chosen;
}

/**
 * How well a series' full tag list fits your taste: the taste weight of each of its tags, divided by
 * the size of its tag list (so a series with fifty tags doesn't win just by having many). Returns
 * null for a series with a hidden tag.
 */
export function tasteFit(tags: string[], taste: Map<string, { w: number }>, weight: (tag: string) => number, hidden: Set<string>): number | null {
  const keys = new Map<string, string>();
  for (const t of tags) {
    const k = canonKey(t);
    if (!k) continue;
    if (hidden.has(k)) return null;
    if (!FORMAT_TAGS.has(k) && !keys.has(k)) keys.set(k, t);
  }
  if (keys.size === 0) return 0;
  let total = 0;
  let norm = 0;
  for (const [k, t] of keys) {
    total += taste.get(k)?.w ?? 0;
    norm += weight(t) ** 2;
  }
  return total / Math.sqrt(Math.max(norm, 1));
}

export interface DeepRow {
  kind: "best" | "theme";
  tags: string[];
  support?: number;
  examples?: string[];
  groups: SeriesGroup[];
}

const PER_ROW = 18;
/** A theme row shorter than this borrows from Best matches. */
const MIN_ROW = 6;
/** Series whose tags Sapphire doesn't know yet are read from their source, at most this many per run. */
const LOOKUPS = 48;

export async function deepRecommendations(
  liked: LikedSeries[],
  ownTitles: string[],
  opts: {
    weight: (tag: string) => number;
    tagsOf: (mangaId: number) => string[] | null;
    /** Reads a series' tags from its source (and remembers them). */
    fetchTags: (mangaId: number) => Promise<string[]>;
    browse: (tags: string[], strict: boolean) => Promise<SearchResult | null>;
    hidden?: Set<string>;
    disliked?: { mangaId: number; titleKey: string; tags: string[] }[];
    /** Multiplies a candidate's fit by how well its MangaBaka tags match your taste (1 = unknown). */
    boost?: (g: SeriesGroup) => number;
  },
): Promise<DeepRow[]> {
  const { weight, tagsOf, fetchTags, browse, hidden = new Set<string>(), disliked = [], boost } = opts;
  const signals = [...liked, ...disliked.map((d) => ({ mangaId: d.mangaId, title: "", tags: d.tags, weight: -0.8 }))];
  const taste = tasteWeights(signals, weight, hidden);
  if ([...taste.values()].every((t) => t.w <= 0)) return [];
  const themes = findThemes(liked, weight, hidden);
  const topTags = [...taste.values()].filter((t) => t.w > 0).sort((a, b) => b.w - a.w).map((t) => t.tag);

  // The pool: each theme (dropping its least telling tag if the sites find nothing), plus your
  // strongest single tags, so Best matches has plenty to choose from.
  const themeRun = async (t: Theme) => {
    let r = await browse(t.tags, true).catch(() => null);
    if ((r?.groups.length ?? 0) === 0 && t.tags.length > 2) r = await browse(t.tags.slice(0, 2), true).catch(() => null);
    return r?.groups ?? [];
  };
  const singleRun = (tag: string) => browse([tag], true).then((r) => r?.groups ?? [], () => [] as SeriesGroup[]);
  const [themeResults, singleResults] = await Promise.all([Promise.all(themes.map(themeRun)), Promise.all(topTags.slice(0, 3).map(singleRun))]);

  const own = new Set(ownTitles.map(normalizeTitle));
  const ownIds = new Set(liked.map((l) => l.mangaId));
  const notKeys = new Set(disliked.map((d) => d.titleKey));
  const notIds = new Set(disliked.map((d) => d.mangaId));
  const usable = (g: SeriesGroup) => !own.has(g.key) && !notKeys.has(g.key) && !g.hits.some((h) => ownIds.has(h.mangaId) || notIds.has(h.mangaId));

  const pool = new Map<string, SeriesGroup>();
  for (const list of [...themeResults, ...singleResults]) for (const g of list) if (usable(g) && !pool.has(g.key)) pool.set(g.key, g);

  // Full tag lists: known ones right away, the rest read from their source (a few at a time).
  const tagsFor = new Map<string, string[]>();
  const unknown: SeriesGroup[] = [];
  for (const g of pool.values()) {
    const known = g.hits.map((h) => tagsOf(h.mangaId)).find((t) => t !== null && t.length > 0);
    if (known) tagsFor.set(g.key, known);
    else unknown.push(g);
  }
  const queue = unknown.slice(0, LOOKUPS);
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let g = queue.shift(); g; g = queue.shift()) {
        const tags = await fetchTags(g.hits[0].mangaId).catch(() => [] as string[]);
        if (tags.length > 0) tagsFor.set(g.key, tags);
      }
    }),
  );

  const fitOf = (g: SeriesGroup) => {
    const tags = tagsFor.get(g.key);
    const f = tags ? tasteFit(tags, taste, weight, hidden) : undefined;
    return typeof f === "number" && boost ? f * boost(g) : f;
  };
  const rows: DeepRow[] = [];
  const taken = new Set<string>();

  // Best matches: only series whose full tag list was read, best fit first.
  const best = [...pool.values()]
    .map((g) => ({ g, f: fitOf(g) }))
    .filter((x): x is { g: SeriesGroup; f: number } => typeof x.f === "number" && x.f > 0)
    .sort((a, b) => b.f - a.f)
    .slice(0, PER_ROW)
    .map((x) => x.g);
  if (best.length >= 4) {
    rows.push({ kind: "best", tags: topTags.slice(0, 3), groups: best });
    best.forEach((g) => taken.add(g.key));
  }

  // A row per theme: its own results, ranked by fit where tags are known (site order otherwise). Rows
  // don't repeat each other, except that a theme short on fresh series may also show a few that are in
  // Best matches rather than shrink to nothing.
  const inBest = new Set(taken);
  const inThemes = new Set<string>();
  themes.forEach((t, i) => {
    const ranked = themeResults[i]
      .filter((g) => usable(g))
      .map((g, rank) => ({ g, f: fitOf(g), rank }))
      .filter((x) => x.f !== null)
      .sort((a, b) => (b.f ?? -1) - (a.f ?? -1) || a.rank - b.rank)
      .map((x) => x.g);
    const fresh = ranked.filter((g) => !taken.has(g.key));
    const list = fresh.length >= MIN_ROW ? fresh.slice(0, PER_ROW) : [...fresh, ...ranked.filter((g) => inBest.has(g.key) && !inThemes.has(g.key) && !fresh.includes(g))].slice(0, Math.max(MIN_ROW, fresh.length));
    if (list.length === 0) return;
    list.forEach((g) => {
      taken.add(g.key);
      inThemes.add(g.key);
    });
    rows.push({ kind: "theme", tags: t.tags, support: t.support, examples: t.examples, groups: list });
  });
  return rows;
}
