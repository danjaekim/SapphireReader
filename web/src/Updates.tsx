import { useEffect, useState } from "react";
import { tidyTitle } from "./titles";
import { toast, toastError } from "./toast";
import { acceptSwitch, dismissSwitch, refreshLibrary, switchOffers, thumbnailUrl, updatesFeed, type SwitchOffer, type UpdateRow } from "./api";
import { navigate, seriesHref } from "./route";
import { ago, chapterText } from "./util";

/** New chapters found in your library, newest first. */
export function Updates() {
  const [items, setItems] = useState<UpdateRow[] | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const load = () =>
    updatesFeed().then(
      (r) => {
        setItems(r.items);
        setChecked(r.lastCheckedAt);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load updates."),
    );
  const [offers, setOffers] = useState<SwitchOffer[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const loadOffers = () => switchOffers().then(setOffers, () => {});
  useEffect(() => {
    void load();
    void loadOffers();
  }, []);

  async function move(o: SwitchOffer) {
    setBusy(o.mangaId);
    try {
      const { mangaId } = await acceptSwitch(o.mangaId);
      navigate(seriesHref(mangaId));
      toast(`Moved to ${o.toSourceName ?? "the other source"}${o.toVersion ? ` (${o.toVersion})` : ""}. Your place came along.`);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Couldn't move it.");
      setBusy(null);
    }
  }
  async function notNow(o: SwitchOffer) {
    setOffers((list) => list.filter((x) => x.mangaId !== o.mangaId));
    await dismissSwitch(o.mangaId).catch(() => loadOffers());
  }

  async function check() {
    setChecking(true);
    await refreshLibrary().catch(() => {});
    await Promise.all([load(), loadOffers()]);
    setChecking(false);
  }

  return (
    <section>
      <p className="muted">
        New chapters for series in your library. Last checked {ago(checked)}.{" "}
        <button type="button" className="linkish" onClick={check} disabled={checking}>
          {checking ? "Checking sources…" : "Check now"}
        </button>
      </p>
      {offers.length > 0 && (
        <ul className="feed offers" aria-label="Sources that are further ahead">
          {offers.map((o) => (
            <li key={o.mangaId} className="feedRow offerRow">
              <img src={thumbnailUrl(o.mangaId)} alt="" width={44} height={60} loading="lazy" />
              <div className="info">
                {o.kind === "back" ? (
                  <>
                    <strong>Back to {o.toVersion ?? "your preferred version"} for {tidyTitle(o.title)}?</strong>
                    <div className="muted small">
                      {o.toSourceName ?? "Another source"} ({o.toVersion ?? "preferred"}) has caught up, with up to {chapterText(o.toLatest)}. Your place and read chapters come along.
                    </div>
                  </>
                ) : o.kind === "other-version" ? (
                  <>
                    <strong>Continue {tidyTitle(o.title)} in the {o.toVersion ?? "other"} version?</strong>
                    <div className="muted small">
                      Chapters after {chapterText(o.fromLatest)} are only out in the {o.toVersion ?? "other"} version so far ({o.toSourceName ?? "another source"}, up to {chapterText(o.toLatest)}).
                      {" "}Your place comes along, and Sapphire offers to move you back once {o.fromVersion ?? "your version"} catches up.
                    </div>
                  </>
                ) : (
                  <>
                    <strong>Move {tidyTitle(o.title)} to {o.toSourceName ?? "another source"}?</strong>
                    <div className="muted small">
                      It has up to {chapterText(o.toLatest)}; {o.fromSourceName ?? "your current source"} stops at {chapterText(o.fromLatest)}. Your place and read chapters come along.
                    </div>
                  </>
                )}
                <div className="offerActions">
                  <button type="button" className="button small" disabled={busy !== null} onClick={() => void move(o)}>
                    {busy === o.mangaId ? "Moving…" : "Move"}
                  </button>
                  <button type="button" className="button small secondary" disabled={busy !== null} onClick={() => void notNow(o)}>Not now</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="bad">{error}</p>}
      {items && items.length === 0 && <p className="muted">Nothing new yet. Sapphire checks your library every few hours.</p>}
      <ul className="feed">
        {(items ?? []).map((u, i) => (
          <li key={`${u.mangaId}-${i}`} className="feedRow">
            <img src={thumbnailUrl(u.mangaId)} alt="" width={44} height={60} loading="lazy" />
            <div className="info">
              <a href={seriesHref(u.mangaId)} className="libTitle">{tidyTitle(u.title)}</a>
              <span> · {chapterText(u.latestNumber)}{u.newCount > 1 ? ` (+${u.newCount})` : ""}</span>
              <div className="muted small">
                {u.sourceName ?? "source"} · {ago(u.detectedAt)}
                {u.elsewhere ? <span className="tag caughtTag">not on your source yet</span> : u.caughtUp && <span className="tag caughtTag">you were caught up</span>}
              </div>
            </div>
            <a className="button small" href={seriesHref(u.mangaId)}>Open</a>
          </li>
        ))}
      </ul>
    </section>
  );
}
