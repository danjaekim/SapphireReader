import { normalizeTitle } from "./search.js";

export interface About {
  /** The story summary, with the stats and alternative titles taken out. */
  body: string;
  altTitles: string[];
  /** Numbers the site puts in its description, e.g. Rank #11, Rating 9.76, Bookmarks 121.4K. */
  stats: { label: string; value: string }[];
  /** Named lists some sites (gallery sites especially) write as "Parodies: a, b" lines: parodies, characters, groups… */
  facets: { label: string; values: string[] }[];
  /** Tags the description names ("…is about Comedy, Drama story") that the site's tag list may lack. */
  tags: string[];
  /** Details the description states in words; the page uses them where the source left its own fields empty. */
  info: { author?: string; artist?: string; status?: string; year?: string };
}

// Labels we treat as lists of names. Anything else stays in the description.
const FACET_LABELS = new Map([
  ["parody", "Parodies"], ["parodies", "Parodies"], ["series", "Parodies"],
  ["character", "Characters"], ["characters", "Characters"],
  ["group", "Groups"], ["groups", "Groups"], ["circle", "Groups"], ["circles", "Groups"],
  ["artist", "Artists"], ["artists", "Artists"],
  ["language", "Languages"], ["languages", "Languages"],
  ["category", "Categories"], ["categories", "Categories"],
]);
// "**Parodies**: a, b" / "Parodies: a, b" / "Pages: 24", one per line.
const FACET_LINE = /^\s*(?:\*\*|__)?([A-Za-z]{3,12})(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+?)\s*$/;
// Values that just mean "none".
const EMPTY_VALUE = /^(?:original|none|n\/a|-|unknown)$/i;

function takeFacets(text: string, stats: About["stats"]): { text: string; facets: About["facets"] } {
  const facets = new Map<string, string[]>();
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const m = FACET_LINE.exec(line);
    const label = m ? FACET_LABELS.get(m[1].toLowerCase()) : undefined;
    if (m && /^pages?$/i.test(m[1]) && /^\d+$/.test(m[2])) {
      stats.push({ label: "Pages", value: m[2] });
      continue;
    }
    if (!m || !label) {
      kept.push(line);
      continue;
    }
    const values = m[2].split(/\s*,\s*/).map((v) => v.trim()).filter((v) => v && !EMPTY_VALUE.test(v));
    const have = facets.get(label) ?? [];
    for (const v of values) if (!have.some((h) => h.toLowerCase() === v.toLowerCase())) have.push(v);
    facets.set(label, have);
  }
  return { text: kept.join("\n"), facets: [...facets].filter(([, v]) => v.length > 0).map(([label, values]) => ({ label, values })) };
}

const NON_LATIN = /[Ѐ-ӿ؀-ۿ฀-๿぀-ヿ㐀-鿿가-힯]/;
const ALT_HEAD = /(?:^|\n|\s)(?:alternative|alternate|alt\.?|other|associated)\s*(?:titles?|names?)?\s*(?:\(s\))?\s*:\s*/i;
const STAT = /^\s*([A-Za-z][A-Za-z ]{1,18}?)\s*:\s*(#?\d[\d.,]*\s*[KMB]?\+?)(?=\s|$|[•|·,])\s*(?:[•|·,]\s*)?/;

// Lines that are notes about the upload or the translation, not the story: "*Source: Seven Seas, Vol. 1*", "NOTE: reupload…".
const NOTE_LINE = /^\s*[*_]*\s*(?:notes?|n\.b\.|source|sources|tl ?notes?|translator['’]?s? notes?|disclaimer|credits?|raws?)\s*:.*$/gim;
// A "Links:" heading followed by a list of links.
const LINKS_BLOCK = /(?:^|\n)\s*(?:external |official )?links?\s*:\s*\n(?:\s*(?:[-*•]\s*)?\[[^\]\n]*\]\([^)\n]*\)[^\n]*(?:\n|$))+/gi;
// Leading "★★★★✬ 9.1 (89)" and a bare "2021".
const STAR_LINE = /^\s*[★☆✬✭✮✯⭐½⯨⯪]+\s*(\d+(?:\.\d+)?)?\s*(?:\((\d[\d,.]*\s*[KkMm]?)\))?\s*$/;
const YEAR_LINE = /^\s*((?:19|20)\d\d)\s*$/;
// Site boilerplate: "Read the latest Manhwa X at Site…", "Browse more than 1000+ Webtoons…", "Connect with Site on Social Media:".
const AD_PARAGRAPH = [
  /^\s*read (?:the )?latest\b/i,
  /\balways updated at\b/i,
  /^\s*browse more than\b/i,
  /\bconnect with .{1,40} on social media\b/i,
  /\bdon['’]t forget to read\b/i,
  /\bfastest notif/i,
  /^\s*(?:you are|you['’]re) (?:now )?reading\b/i,
];
// "[X Manhwa](url) also known as A , B. This on-going [webtoon](url) was released in 2025. This series was written by
// AA and illustrations by B. [X Webtoon](url) is about Comedy, Drama story." (ToonGod and other Madara sites).
function takeBlurb(p: string, out: { alt: string[]; tags: string[]; info: About["info"] }): boolean {
  const plain = p.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  const known = /\balso known as\s+(.+?)(?:\.\s+(?=This\b|[A-Z])|\.?$)/.exec(plain);
  const about = /\bis about (.+?) stor(?:y|ies)\b/i.exec(plain);
  const written = /\bwritten by (.+?)(?:\s+and illustrat|\.\s|\.?$)/i.exec(plain);
  if (!known && !about && !written) return false;
  if (known) out.alt.push(...known[1].split(/\s+[,\/]\s+|\s*;\s*/));
  if (about) out.tags.push(...about[1].split(/\s*,\s*|\s+and\s+/).map((t) => t.trim()).filter((t) => t && t.length <= 30));
  if (written) out.info.author = written[1].trim();
  const art = /\billustrations? by (.+?)(?:\.\s|\.?$)/i.exec(plain);
  if (art) out.info.artist = art[1].trim();
  const status = /\bThis (on-?going|completed|finished|hiatus|cancell?ed)\b/i.exec(plain);
  if (status) out.info.status = /on-?going/i.test(status[1]) ? "Ongoing" : /hiatus/i.test(status[1]) ? "On hiatus" : /cancel/i.test(status[1]) ? "Cancelled" : "Completed";
  const year = /\breleased in ((?:19|20)\d\d)\b/i.exec(plain);
  if (year) out.info.year = year[1];
  return true;
}

function splitTitles(text: string): string[] {
  const t = text.trim();
  const parts = /(^|\s)[-–•]\s/.test(t) || t.includes("\n")
    ? t.split(/\s*\n\s*|(?:^|\s)[-–•]\s+/)
    : t.split(/\s*[;/|]\s*|,\s+/);
  // A single list item can still hold several names: "A , B , C" or "A / B / C".
  return parts
    .flatMap((p) => p.split(/\s+[,\/]\s+/))
    .map((p) => p.trim().replace(/^[-–•]\s*/, ""))
    .filter((p) => p.length > 0 && p.length <= 150);
}

/** Pulls the stats line and alternative titles out of a source's description so they can be shown on their own. */
export function parseDescription(description: string | null, title: string): About {
  // Markdown emphasis and heading marks hide labels like "**Alternative Names:**" or "### Links", so they go first.
  let text = (description ?? "")
    .replace(/\r/g, "")
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .trim();
  const stats: About["stats"] = [];
  let alt: string[] = [];
  const found = { alt: [] as string[], tags: [] as string[], info: {} as About["info"] };

  // Leading star rating and year lines.
  for (;;) {
    const nl = text.indexOf("\n");
    const line = nl >= 0 ? text.slice(0, nl) : text;
    const star = STAR_LINE.exec(line);
    const year = YEAR_LINE.exec(line);
    if (star) {
      if (star[1]) stats.push({ label: "Rating", value: star[1] });
      if (star[2]) stats.push({ label: "Votes", value: star[2].replace(/\s+/g, "") });
    } else if (year) found.info.year = year[1];
    else if (!(line.trim() === "" && nl >= 0)) break;
    text = nl >= 0 ? text.slice(nl + 1) : "";
  }
  text = text.replace(NOTE_LINE, "").replace(LINKS_BLOCK, "\n");
  // Paragraph by paragraph: drop site ads, mine the "also known as… written by… is about…" blurb.
  text = text
    .split(/\n\s*\n/)
    .filter((p) => !AD_PARAGRAPH.some((re) => re.test(p)) && !takeBlurb(p, found))
    .join("\n\n");

  // "Rank: #11 • Rating: 9.76 • Bookmarks: 121.4K" at the start.
  for (let m = STAT.exec(text); m; m = STAT.exec(text)) {
    stats.push({ label: m[1].trim(), value: m[2].trim() });
    text = text.slice(m[0].length);
  }

  const taken = takeFacets(text, stats);
  text = taken.text;

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
  const altTitles = [...alt, ...found.alt.map((a) => a.trim()).filter((a) => a && a.length <= 150)].filter((a) => {
    const k = normalizeTitle(a) || a;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const tags = [...new Map(found.tags.map((t) => [t.toLowerCase(), t])).values()];
  // Markdown leftovers: [text](link) becomes text, and \[escaped\] brackets lose their backslashes.
  const body = text
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\\([\[\]*_()#>!`-])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { body, altTitles, stats, facets: taken.facets, tags, info: found.info };
}
