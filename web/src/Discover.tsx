import { useEffect, useRef, useState } from "react";
import { browse, discoverList, forYou, type SearchResult } from "./api";
import { GenrePicker } from "./GenrePicker";
import { Results } from "./Results";

type Mode = "For you" | "Popular" | "Latest";
const modes: Mode[] = ["For you", "Popular", "Latest"];

/** Browse without a search term: recommendations, each site's popular and latest lists, or genre filters. */
export function Discover({ adult = false }: { adult?: boolean }) {
  const [mode, setMode] = useState<Mode>("For you");
  const [genres, setGenres] = useState<string[]>([]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [note, setNote] = useState<string | undefined>();
  const [empty, setEmpty] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const runId = useRef(0);

  useEffect(() => {
    const id = ++runId.current;
    setBusy(true);
    setError(null);
    setResult(null);
    setNote(undefined);
    setEmpty(undefined);
    (async () => {
      try {
        let r: SearchResult;
        if (genres.length > 0) {
          const b = await browse(genres, "");
          if (b.skipped.length > 0) setNote(`Left out because they can't filter by every genre picked: ${b.skipped.join(", ")}.`);
          r = b;
        } else if (mode === "For you") {
          const f = await forYou(adult);
          if (f.because.length === 0) setEmpty(adult ? "Add a few 18+ series to your library and this page will start recommending similar ones. It never mixes with your regular recommendations." : "Add a few series to your library and Sapphire will start recommending similar ones here.");
          else setNote(`Because you like ${f.because.join(", ")}.`);
          r = { groups: f.groups, failed: [], searched: 0 };
        } else {
          r = await discoverList(mode === "Latest" ? "latest" : "popular", adult);
        }
        if (id === runId.current) setResult(r);
      } catch (err) {
        if (id === runId.current) setError(err instanceof Error ? err.message : "Couldn't load this.");
      } finally {
        if (id === runId.current) setBusy(false);
      }
    })();
  }, [mode, genres, adult]);

  return (
    <section>
      <div className="chips" role="tablist" aria-label="Discover">
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            className={`chip ${genres.length === 0 && mode === m ? "on" : ""}`}
            aria-selected={genres.length === 0 && mode === m}
            onClick={() => {
              setGenres([]);
              setMode(m);
            }}
          >
            {m}
          </button>
        ))}
      </div>
      <GenrePicker selected={genres} onChange={setGenres} />
      {error && <p className="bad">{error}</p>}
      {busy && <p className="muted">Asking your sources. This can take several seconds.</p>}
      {result && <Results result={result} note={note} empty={empty} lookups={false} />}
    </section>
  );
}
