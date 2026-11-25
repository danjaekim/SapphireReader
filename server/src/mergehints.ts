import { normalizeTitle } from "./search.js";
import { looksCluttered, tidyTitle } from "./titles.js";

/**
 * Spotting listings that are the same series under slightly different names: both matched the same
 * MangaBaka entry, their names are the same once a version word ("(Uncensored)", "[Raw]") is taken off,
 * or (doujin-style names full of circles, tags and translator notes) the names shown after tidying agree.
 * Only ever suggestions; nothing merges without a tap.
 */
const VERSION_WORD = /(uncensored|censored|raws?|colou?red|full[\s-]colou?r|official)/;
const LABELS: [RegExp, string][] = [
  [/^uncensored$/i, "Uncensored"],
  [/^censored$/i, "Censored"],
  [/^raws?$/i, "Raw"],
  [/^(colou?red|full[\s-]colou?r)$/i, "Colored"],
  [/^official$/i, "Official"],
];
const labelOf = (w: string) => LABELS.find(([re]) => re.test(w.trim()))?.[1] ?? null;

/** "Someone Stop Her (Uncensored)" → base "Someone Stop Her", label "Uncensored". */
export function splitVersion(title: string): { base: string; label: string | null } {
  const bracket = new RegExp(String.raw`\s*[(\[{]\s*${VERSION_WORD.source}\s*(?:version|ver\.?)?\s*[)\]}]\s*`, "i");
  const m = bracket.exec(title);
  if (m) return { base: (title.slice(0, m.index) + " " + title.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(), label: labelOf(m[1]) };
  const tail = new RegExp(String.raw`\s*(?:[-–:|]\s*)?${VERSION_WORD.source}\s*(?:version|ver\.?)?\s*$`, "i").exec(title);
  if (tail && tail.index > 0) return { base: title.slice(0, tail.index).trim(), label: labelOf(tail[1]) };
  return { base: title, label: null };
}

export interface KnownListing {
  mangaId: number;
  title: string;
  sourceName: string | null;
  adult: boolean;
}
export interface MergeSuggestion {
  key: string;
  reason: "mangabaka" | "version" | "tidy";
  a: KnownListing & { label: string | null };
  b: KnownListing & { label: string | null };
}

export const pairKey = (x: string, y: string) => [x, y].sort().join("|");

/**
 * The key of the name a doujin-style title is shown as ("[Circle (Artist)] Romaji | English Title [English]
 * {Group} [Decensored]" → "english title"), without a version word; for any other title, its own name
 * without a version word. Null when what's left is too short to say two listings are the same work.
 */
export function shownKey(title: string): string | null {
  const shown = looksCluttered(title) ? tidyTitle(title) : title;
  const key = normalizeTitle(splitVersion(shown).base);
  return key.replace(/\s+/g, "").length >= 6 ? key : null;
}

/**
 * Pairs of listings worth merging. `mbOf` gives the MangaBaka id for a title key (when matched). Listings
 * already merged share a key (normalizeTitle follows merges), so they never pair up; dismissed pairs stay gone.
 */
export function suggestMerges(listings: KnownListing[], mbOf: (key: string) => number | null, dismissed: Set<string>): MergeSuggestion[] {
  const byKey = new Map<string, KnownListing>();
  for (const l of listings) {
    const k = normalizeTitle(l.title);
    if (k && !byKey.has(k)) byKey.set(k, l);
  }
  const groups = new Map<string, { reason: MergeSuggestion["reason"]; keys: string[] }>();
  const add = (sig: string, reason: MergeSuggestion["reason"], key: string) => {
    const g = groups.get(sig) ?? { reason, keys: [] };
    if (!g.keys.includes(key)) g.keys.push(key);
    groups.set(sig, g);
  };
  for (const [k, l] of byKey) {
    const mb = mbOf(k);
    if (mb !== null) add(`mb:${mb}`, "mangabaka", k);
    const { base, label } = splitVersion(l.title);
    const baseKey = normalizeTitle(base);
    // A name with a version word pairs with the same name without it (or with another version word).
    if (baseKey) add(`base:${baseKey}`, "version", k + (label ? "" : "\u0000plain"));
    // Doujin-style names: the tidied name shown for each (a tidy name pairs with a plain one too).
    const shown = shownKey(l.title);
    if (shown) add(`tidy:${shown}`, "tidy", k + (looksCluttered(l.title) ? "" : "\u0000plain"));
  }
  const out = new Map<string, MergeSuggestion>();
  for (const g of groups.values()) {
    const keys = g.keys.map((k) => k.replace("\u0000plain", ""));
    // A base group needs at least one versioned name (a tidy group one doujin-style name), else it's just
    // ordinary titles that happen to be equal.
    if (g.reason !== "mangabaka" && !g.keys.some((k) => !k.endsWith("\u0000plain"))) continue;
    if (keys.length < 2) continue;
    const [first, ...rest] = keys;
    for (const other of rest) {
      const key = pairKey(first, other);
      if (dismissed.has(key) || out.has(key)) continue;
      const a = byKey.get(first)!;
      const b = byKey.get(other)!;
      out.set(key, { key, reason: g.reason, a: { ...a, label: splitVersion(a.title).label }, b: { ...b, label: splitVersion(b.title).label } });
    }
  }
  // MangaBaka matches first (the surest), then version words, then tidied doujin names.
  const order = { mangabaka: 0, version: 1, tidy: 2 } as const;
  return [...out.values()].sort((x, y) => order[x.reason] - order[y.reason]);
}
