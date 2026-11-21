export type SortKey = "relevance" | "popular" | "latest" | "rating" | "newest" | "az";

export const SORT_LABELS: Record<SortKey, string> = {
  relevance: "Best match",
  popular: "Most popular",
  latest: "Recently updated",
  rating: "Top rated",
  newest: "Newest",
  az: "A–Z",
};

export function sortFrom(v: string | null, fallback: SortKey = "relevance"): SortKey {
  return v && v in SORT_LABELS ? (v as SortKey) : fallback;
}

/** Each site sorts its own results; Sapphire merges them rank by rank. */
export function SortSelect({ value, onChange, options = Object.keys(SORT_LABELS) as SortKey[] }: {
  value: SortKey;
  onChange: (s: SortKey) => void;
  options?: SortKey[];
}) {
  return (
    <label className="sort-select">
      <span>Sort</span>
      <select value={value} onChange={(e) => onChange(e.target.value as SortKey)}>
        {options.map((k) => (
          <option key={k} value={k}>{SORT_LABELS[k]}</option>
        ))}
      </select>
    </label>
  );
}

/** "MangaFire and Asura can't sort that way, so their results are in their usual order." */
export function unsortedNote(names: string[] | undefined): string | undefined {
  if (!names || names.length === 0) return undefined;
  const list = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
  return `${list} can't sort that way, so ${names.length === 1 ? "its" : "their"} results are in the site's usual order.`;
}
