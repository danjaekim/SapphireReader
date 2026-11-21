import { useCallback, useEffect, useState } from "react";
import { queueDownloads, seriesDownloads, type DownloadState, type SeriesData } from "./api";

/** Download status of one series' chapters; refreshes every couple of seconds while anything is in progress. */
export function useSeriesDownloads(mangaId: number) {
  const [states, setStates] = useState<Record<number, DownloadState>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    seriesDownloads(mangaId).then(
      (r) => {
        if (cancelled) return;
        setStates(Object.fromEntries(r.items.map((d) => [d.chapterId, d])));
        if (r.items.some((d) => d.status === "queued" || d.status === "downloading")) {
          timer = window.setTimeout(() => setTick((t) => t + 1), 2000);
        }
      },
      () => {},
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mangaId, tick]);

  const download = useCallback(
    async (manga: SeriesData["manga"], chapters: { id: number; name: string; chapterNumber: number }[]) => {
      // Show them as queued straight away; the server confirms on the next refresh.
      setStates((s) => ({
        ...s,
        ...Object.fromEntries(
          chapters.filter((c) => s[c.id]?.status !== "done").map((c) => [c.id, { chapterId: c.id, status: "queued" as const, error: null }]),
        ),
      }));
      await queueDownloads(manga, chapters).catch(() => {});
      setTick((t) => t + 1);
    },
    [],
  );

  return { states, download };
}
