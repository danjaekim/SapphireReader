import type { Config } from "./config.js";
import type { Notifier } from "./notify.js";
import type { Store } from "./store.js";

const chapterWord = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * Re-reads every library series from its source and sends a push for each series you were
 * caught up on that now has a newer chapter. Series are checked one at a time, with a pause
 * between them, so the source sites aren't hit all at once.
 */
export async function checkLibrary(opts: {
  config: Config;
  store: Store;
  loadNumbers: (mangaId: number) => Promise<number[]>;
  notify: Notifier | null;
  /**
   * The same series on your other sources (Also on, merged listings) with their chapter numbers, for
   * series you're caught up on: a chapter out there first gets an update and an alert too.
   */
  elsewhere?: (mangaId: number, ownNumbers: number[]) => Promise<{ mangaId: number; sourceName: string; numbers: number[] }[]>;
  pauseMs?: number;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}): Promise<{ checked: number; failed: number[]; alerts: number }> {
  const { config, store, loadNumbers, notify, elsewhere, pauseMs = 3000, log } = opts;
  const failed: number[] = [];
  let alerts = 0;
  const items = store.library(true);
  for (const [i, item] of items.entries()) {
    if (i > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    /** Looks at the series' other sources; returns 1 if an alert went out. */
    const checkElsewhere = async (ownLatest: number, ownNumbers: number[]): Promise<number> => {
      const seenKey = `elsewhere.${item.mangaId}`;
      const announced = Number(store.getSetting(seenKey) ?? "-1");
      const others = await elsewhere!(item.mangaId, ownNumbers).catch(() => []);
      let best: { mangaId: number; sourceName: string; latest: number; count: number } | null = null;
      for (const o of others) {
        const latest = Math.max(-1, ...o.numbers);
        if (latest > ownLatest && latest > announced && (!best || latest > best.latest)) {
          best = { mangaId: o.mangaId, sourceName: o.sourceName, latest, count: o.numbers.filter((n) => n > ownLatest).length };
        }
      }
      if (!best) return 0;
      store.setSetting(seenKey, String(best.latest));
      store.addUpdate({ mangaId: best.mangaId, title: item.title, sourceName: best.sourceName, adult: item.adult, latestNumber: best.latest, newCount: best.count, caughtUp: true, elsewhere: true });
      if (!notify) return 0;
      try {
        await notify({
          title: item.adult ? "Sapphire" : item.title,
          message: item.adult
            ? "New chapter on another source in your 18+ library"
            : `Chapter ${chapterWord(best.latest)} is out on ${best.sourceName}${item.sourceName ? ` (not on ${item.sourceName} yet)` : ""}`,
          click: config.publicUrl ? `${config.publicUrl}/#/series/${best.mangaId}` : undefined,
        });
        return 1;
      } catch (err) {
        log?.warn(err, "couldn't send the push notification");
        return 0;
      }
    };
    try {
      const numbers = await loadNumbers(item.mangaId);
      store.setChapterNumbers(item.mangaId, numbers);
      const after = store.library(true).find((x) => x.mangaId === item.mangaId);
      const wasCaughtUp = item.unread === 0 && item.latestNumber !== null;
      const isNew = item.unread !== null && item.latestNumber !== null && !!after && after.latestNumber !== null && after.latestNumber > item.latestNumber;
      // Highest chapter already announced from another source, so it isn't announced twice.
      const seenKey = `elsewhere.${item.mangaId}`;
      const announced = Number(store.getSetting(seenKey) ?? "-1");
      if (!isNew) {
        if (elsewhere && after && after.unread === 0 && after.latestNumber !== null) {
          alerts += await checkElsewhere(after.latestNumber, numbers);
        }
        continue;
      }
      const fresh = numbers.filter((n) => n > item.latestNumber!).length;
      store.addUpdate({
        mangaId: item.mangaId,
        title: item.title,
        sourceName: item.sourceName,
        adult: item.adult,
        latestNumber: after!.latestNumber!,
        newCount: fresh,
        caughtUp: wasCaughtUp,
      });
      if (!notify || !wasCaughtUp || announced >= after!.latestNumber!) continue;
      try {
        await notify({
          // Titles from the 18+ library stay out of lock-screen notifications.
          title: item.adult ? "Sapphire" : item.title,
          message: item.adult
            ? "New chapter in your 18+ library"
            : fresh > 1
              ? `${fresh} new chapters, latest Ch. ${chapterWord(after!.latestNumber!)}`
              : `Chapter ${chapterWord(after!.latestNumber!)} is out`,
          click: config.publicUrl ? `${config.publicUrl}/#/series/${item.mangaId}` : undefined,
        });
        alerts++;
      } catch (err) {
        log?.warn(err, "couldn't send the push notification");
      }
    } catch (err) {
      log?.warn(err, `couldn't check series ${item.mangaId}`);
      failed.push(item.mangaId);
    }
  }
  return { checked: items.length, failed, alerts };
}
