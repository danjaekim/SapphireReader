import type { BakaTag } from "./mangabaka.js";

/**
 * MangaBaka tags as numbers for recommendations. Each tag counts by how central it is to the series
 * (core 3, defining 2, recurrent 1, incidental a little), genres count less (the source's own tags
 * already cover them), spoilers not at all, and each tag lends some weight to the tags above it in the
 * tree, so "Body Horror" and "Psychological Horror" still meet at "Horror".
 */
const WEIGHT: Record<string, number> = { core: 3, defining: 2, recurrent: 1, incidental: 0.35, unweighted: 0.5 };
const GENRE_FACTOR = 0.3;
const PARENT_SHARE = 0.35;

export type TagVector = Map<string, number>;

export function bakaVector(tags: BakaTag[]): TagVector {
  const v: TagVector = new Map();
  const add = (k: string, w: number) => v.set(k, Math.max(v.get(k) ?? 0, w));
  for (const t of tags) {
    if (t.spoiler) continue;
    const w = (WEIGHT[t.weight] ?? 0.5) * (t.genre ? GENRE_FACTOR : 1);
    const parts = t.path.split(">").map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (parts.length === 0) continue;
    add(parts.join(">"), w);
    // Ancestors, but not the top-level buckets ("Themes", "Genres"), which say nothing.
    for (let n = parts.length - 1; n >= 2; n--) add(parts.slice(0, n).join(">"), w * PARENT_SHARE ** (parts.length - n));
  }
  return v;
}

export function cosine(a: TagVector, b: TagVector): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, w] of a) {
    na += w * w;
    const o = b.get(k);
    if (o) dot += w * o;
  }
  for (const w of b.values()) nb += w * w;
  return dot / Math.sqrt(na * nb);
}

/** Your taste in MangaBaka tags: liked series' vectors added up by how much you like each (dislikes subtract). */
export function tasteVector(items: { weight: number; vec: TagVector }[]): TagVector {
  const out: TagVector = new Map();
  for (const { weight, vec } of items) for (const [k, w] of vec) out.set(k, (out.get(k) ?? 0) + weight * w);
  for (const [k, w] of out) if (w <= 0) out.delete(k);
  return out;
}

/**
 * How much a fit multiplies a candidate's score: 1 with no MangaBaka data; with data, a weak fit counts a
 * little against (0.85 at none) and a strong one for (1.65 at a perfect fit), so having data isn't itself a bonus.
 */
export const boostFrom = (fit: number | null) => (fit === null ? 1 : 0.85 + 0.8 * fit);
