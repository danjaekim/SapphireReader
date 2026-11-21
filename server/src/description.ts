import { normalizeTitle } from "./search.js";

export interface About {
  /** The story summary, with the stats and alternative titles taken out. */
  body: string;
  altTitles: string[];
  /** Numbers the site puts in its description, e.g. Rank #11, Rating 9.76, Bookmarks 121.4K. */
  stats: { label: string; value: string }[];
}

const NON_LATIN = /[Ѐ-ӿ؀-ۿ฀-๿぀-ヿ㐀-鿿가-힯]/;
const ALT_HEAD = /(?:^|\n|\s)(?:alternative|alternate|alt\.?|other|associated)\s*(?:titles?|names?)?\s*(?:\(s\))?\s*:\s*/i;
const STAT = /^\s*([A-Za-z][A-Za-z ]{1,18}?)\s*:\s*(#?\d[\d.,]*\s*[KMB]?\+?)(?=\s|$|[•|·,])\s*(?:[•|·,]\s*)?/;

function splitTitles(text: string): string[] {
  const t = text.trim();
  const parts = /(^|\s)[-–•]\s/.test(t) || t.includes("\n")
    ? t.split(/\s*\n\s*|(?:^|\s)[-–•]\s+/)
    : t.split(/\s*[;/|]\s*|,\s+/);
  return parts.map((p) => p.trim().replace(/^[-–•]\s*/, "")).filter((p) => p.length > 0 && p.length <= 150);
}

/** Pulls the stats line and alternative titles out of a source's description so they can be shown on their own. */
export function parseDescription(description: string | null, title: string): About {
  let text = (description ?? "").replace(/\r/g, "").trim();
  const stats: About["stats"] = [];
  let alt: string[] = [];

  // "Rank: #11 • Rating: 9.76 • Bookmarks: 121.4K" at the start.
  for (let m = STAT.exec(text); m; m = STAT.exec(text)) {
    stats.push({ label: m[1].trim(), value: m[2].trim() });
    text = text.slice(m[0].length);
  }

  // "Alternative Titles: - A - B - C" (usually at the end; stop at a blank line).
  const head = ALT_HEAD.exec(text);
  if (head) {
    const start = head.index;
    const after = text.slice(start + head[0].length);
    const blank = after.search(/\n\s*\n/);
    const list = blank >= 0 ? after.slice(0, blank) : after;
    alt = splitTitles(list);
    text = (text.slice(0, start) + (blank >= 0 ? after.slice(blank) : "")).trim();
  } else {
    // A first line that's just other names, e.g. "The 100th Regression of the Max-Level Player, 만렙 플레이어의 100번째 회귀".
    const nl = text.indexOf("\n");
    const first = nl > 0 ? text.slice(0, nl).trim() : "";
    if (first && first.length <= 200 && !/[.!?"”]$/.test(first) && (NON_LATIN.test(first) || first.includes(","))) {
      alt = splitTitles(first);
      text = text.slice(nl + 1).trim();
    }
  }

  const own = normalizeTitle(title);
  const seen = new Set<string>([own]);
  const altTitles = alt.filter((a) => {
    const k = normalizeTitle(a) || a;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { body: text.replace(/\n{3,}/g, "\n\n").trim(), altTitles, stats };
}
