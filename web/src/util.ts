export function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

export function chapterText(n: number): string {
  return `Ch. ${Number.isInteger(n) ? n : n.toFixed(1)}`;
}

/** "today", "3 days ago", "2 weeks ago" within a month; a short date after that. */
/** "ON_HIATUS" / "On_hiatus" -> "On hiatus"; "PUBLISHING_FINISHED" -> "Publishing finished". */
export function statusLabel(raw: string): string {
  const s = raw.replace(/[_\s]+/g, " ").trim().toLowerCase();
  if (!s || s === "unknown") return "Unknown";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function chapterDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 31) return `${Math.floor(days / 7)} weeks ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
