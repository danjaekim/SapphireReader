/**
 * Readable titles for series named the doujin way, e.g.
 * "[Circle (Artist)] Romaji Title | English Title [English] {Group} [Decensored] [Digital]".
 *
 * Only titles that look like that are touched (they start with a bracket, or carry [tags], {groups},
 * a " | " between names, or a word like Uncensored). From those it drops the bracketed tags, the
 * circle/artist up front, trailing notes like "(Artist)" or "Uncensored", and when there are two
 * names ("A | B" or "A / B") keeps the one that reads most like English. Ordinary titles come back
 * unchanged, and the full title is still used for search, matching and sorting.
 */

const NOTE_WORDS =
  "uncensored|decensored|censored|digital|english|eng|colou?red|colou?rized|full colou?r|textless|raw|uncen|hd|ongoing|complete|one ?shot|oneshot";
const NOTE = new RegExp(`^(?:${NOTE_WORDS})$`, "i");
const TRAILING_NOTE = new RegExp(`[\\s,;:-]+(?:${NOTE_WORDS})\\.?$`, "i");
const PAREN_NOTE = new RegExp(`\\(\\s*(?:${NOTE_WORDS})\\s*\\)`, "gi");
const HAS_PAREN_NOTE = new RegExp(PAREN_NOTE.source, "i");

/** Common English words; a name with more of these is the English one. */
const ENGLISH = new Set(
  "the a an with is are was be my me mine her his him she he you your i in on of and for who that this into by when what it its can will not but from at as all how why after before about our we they their them now new never love girl boy wife sister brother mother teacher student".split(" "),
);
/** Japanese words written in Latin letters (romaji) that show up in titles; a name with these is the Japanese one. */
const ROMAJI = new Set(
  "wa no ni wo ga de mo ka ya yo ne na da desu shite suru kuru natta naru kara made toka dake tte chan kun senpai sensei kouhai boku ore watashi atashi kanojo kare onii onee nee nii mono koto hito chuu choukyou ecchi sukebe kimi anata oshiego otouto imouto tsuma haha musume".split(" "),
);

function englishness(name: string): number {
  let score = 0;
  for (const w of name.toLowerCase().split(/[^a-z']+/)) {
    const word = w.replace(/'s$/, "");
    if (ENGLISH.has(word)) score++;
    if (ROMAJI.has(word)) score--;
  }
  return score;
}

/** Whether a title has the doujin-style clutter this cleans up. */
export function looksCluttered(title: string): boolean {
  return /^\s*[[(（【]/.test(title) || /[[{【].*[\]}】]/.test(title) || /\s\|\s/.test(title) || TRAILING_NOTE.test(title.trim()) || HAS_PAREN_NOTE.test(title);
}

function tidyName(name: string): string {
  let s = name.replace(PAREN_NOTE, " ").replace(/\s+/g, " ").trim();
  // Notes and "(Artist)" at the end, as many as there are.
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(TRAILING_NOTE, "").replace(/\s*\([^()]*\)\s*$/, "").replace(/[\s,;:|/-]+$/, "").trim();
    if (NOTE.test(s)) s = "";
  }
  return s.replace(/\.{3,}$/, "…");
}

export function tidyTitle(title: string): string {
  if (!title || !looksCluttered(title)) return title;
  let s = title
    .replace(/\[[^\]]*\]|\{[^}]*\}|【[^】]*】/g, " ")
    // An event or circle in parentheses before the title, e.g. "(C99)".
    .replace(/^\s*(?:[(（][^)）]*[)）]\s*)+/, " ")
    .replace(/\s+/g, " ")
    .trim();
  const names = s
    .split(/\s+\|\s+|\s+\/\s+/)
    .map(tidyName)
    .filter((n) => n.length > 0);
  if (names.length === 0) return title;
  // The most English-looking name; on a tie, the last ("Japanese | English" is the usual order)
  // unless only the first is free of romaji.
  let best = names[names.length - 1];
  let bestScore = englishness(best);
  for (const n of names) {
    const sc = englishness(n);
    if (sc > bestScore) {
      best = n;
      bestScore = sc;
    }
  }
  s = best;
  return s.length > 0 ? s : title;
}
