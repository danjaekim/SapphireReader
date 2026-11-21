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
  pauseMs?: number;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}): Promise<{ checked: number; failed: number[]; alerts: number }> {
  const { config, store, loadNumbers, notify, pauseMs = 3000, log } = opts;
  const failed: number[] = [];
  let alerts = 0;
  const items = store.library(true);
  for (const [i, item] of items.entries()) {
    if (i > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    try {
      const numbers = await loadNumbers(item.mangaId);
      store.setChapterNumbers(item.mangaId, numbers);
      const after = store.library(true).find((x) => x.mangaId === item.mangaId);
      const wasCaughtUp = item.unread === 0 && item.latestNumber !== null;
      const isNew = item.unread !== null && item.latestNumber !== null && !!after && after.latestNumber !== null && after.latestNumber > item.latestNumber;
      if (!isNew) continue;
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
      if (!notify || !wasCaughtUp) continue;
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
