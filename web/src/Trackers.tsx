import { useEffect, useState, type FormEvent } from "react";
import {
  anilistMatches,
  connectAnilist,
  disconnectAnilist,
  linkAnilist,
  trackers,
  tracking,
  unlinkAnilist,
  type TrackerLink,
  type TrackerMatch,
  type TrackerState,
} from "./api";

/** Connect AniList with a personal access token. */
export function TrackerSettings() {
  const [state, setState] = useState<TrackerState | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    trackers().then(setState, () => {});
  }, []);

  async function connect(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setState(await connectAnilist(token.trim()));
      setToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect.");
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  return (
    <section className="card">
      <h3>Trackers</h3>
      {state.anilist.connected ? (
        <p>
          <span className="dot good" /> AniList connected as {state.anilist.user}.{" "}
          <button type="button" className="linkish" onClick={async () => setState(await disconnectAnilist())}>
            Disconnect
          </button>
        </p>
      ) : (
        <form onSubmit={connect}>
          <p className="muted">
            Finished chapters update your AniList progress automatically for series you link. To connect: create an API client at
            anilist.co/settings/developer (any name, redirect URL <code>https://anilist.co/api/v2/oauth/pin</code>), open
            <code> https://anilist.co/api/v2/oauth/authorize?client_id=YOUR_ID&amp;response_type=token</code>, approve, and paste the token
            you get back (it's the long value after <code>access_token=</code> in the address bar).
          </p>
          <div className="searchbar">
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="AniList token" aria-label="AniList token" />
            <button type="submit" disabled={busy || token.trim().length < 20}>{busy ? "Checking…" : "Connect"}</button>
          </div>
          {error && <p className="bad">{error}</p>}
        </form>
      )}
    </section>
  );
}

/** On a series page: link the series to its AniList entry. Shows nothing until AniList is connected. */
export function TrackerLinkCard({ mangaId, title }: { mangaId: number; title: string }) {
  const [connected, setConnected] = useState(false);
  const [link, setLink] = useState<TrackerLink | null>(null);
  const [matches, setMatches] = useState<TrackerMatch[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLink(null);
    setMatches(null);
    trackers().then((t) => setConnected(t.anilist.connected), () => {});
    tracking(mangaId).then((t) => setLink(t.anilist), () => {});
  }, [mangaId]);

  async function find() {
    setBusy(true);
    setMatches((await anilistMatches(title).catch(() => ({ matches: [] }))).matches);
    setBusy(false);
  }

  if (!connected) return null;
  return (
    <div className="card">
      <h3>AniList</h3>
      {link ? (
        <p>
          Tracking as <strong>{link.title}</strong>. Finished chapters update your list.{" "}
          <button type="button" className="linkish" onClick={async () => { await unlinkAnilist(mangaId); setLink(null); }}>
            Unlink
          </button>
        </p>
      ) : matches === null ? (
        <button type="button" className="button small secondary" onClick={find} disabled={busy}>
          {busy ? "Searching…" : "Link to AniList"}
        </button>
      ) : matches.length === 0 ? (
        <p className="muted">No matches on AniList.</p>
      ) : (
        <ul className="extList">
          {matches.map((m) => (
            <li key={m.mediaId} className="extRow">
              <span>
                {m.title} <span className="muted">{m.chapters ? `${m.chapters} ch.` : m.status?.toLowerCase()}</span>
              </span>
              <button
                type="button"
                className="button small"
                onClick={async () => setLink((await linkAnilist(mangaId, m.mediaId, m.title)).anilist)}
              >
                Link
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
