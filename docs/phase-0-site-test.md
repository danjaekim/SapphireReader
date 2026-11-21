# Phase 0 site test checklist

Goal: confirm which of your sites work through Keiyoushi extensions on the NAS, and whether
the Cloudflare solver is needed. Results decide which sources Sapphire supports in Phase 1.

## Extensions available (checked against the Keiyoushi index on 2026-11-21)

| Your site | Keiyoushi extension | Version | Notes |
| --- | --- | --- | --- |
| asurascans.com | Asura Scans | 1.6.72 | Ignore "Comic Asura" and "Asuratoons (unoriginal)"; those are other sites. |
| manhuaus.com | ManhuaUS | 1.6.65 | |
| ww3.mangafreak.me | Mangafreak | 1.6.2 | |
| mangafire.to | MangaFire | 1.6.38 | Multi-language extension; use its English source. |
| toongod.org | ToonGod | 1.6.65 | 18+ site. Ignore "ToonGod (Unoriginal)" (toongod.cc). |
| katamanga.com | **none found** | | Needs a custom adapter later, or skip it. MangaKatana is a different site. |

Extras worth installing while you test: MangaDex, Webtoons.com, MANGA Plus and Weeb Central
all have Keiyoushi extensions too.

## For each source, test

Pick one title you actually read on that site.

1. **Search** finds it.
2. **Chapter list** shows the latest chapter you'd expect (compare with the site).
3. **Open the latest chapter**: all pages load, in order, without broken images.
4. **Open an old chapter** (around chapter 1) to check the archive works.
5. **Latest / popular** browse tabs load.

## Results

Fill this in as you go. "Cloudflare" = did you see a Cloudflare or "verify you are human" error?

| Source | Search | Chapters | Latest ch. pages | Old ch. pages | Browse | Cloudflare? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Asura Scans | Pass | Pass | Pass | Pass | Pass | No | |
| ManhuaUS | Pass | Pass | Pass | Pass | Pass | No | |
| Mangafreak | Pass | Pass | Pass | Pass | Pass | No | |
| MangaFire | Pass | Pass | Pass | Pass | Pass | No | |
| ToonGod | Pass | Pass | Pass | Pass | Pass | No | |

Tested by Dan on 2026-11-21 on the DXP2800: all five sources work (search, chapters,
reading, filters). No Cloudflare errors. Some sources load a little slowly.

## Is the Cloudflare solver needed?

The engine also has its own built-in browser (KCEF) that some extensions use for
Cloudflare. To see whether the separate solver earns its memory:

1. Stop the `sapphire-flaresolverr` container.
2. Re-run search and latest chapter for any source that had Cloudflare trouble.
3. If everything still works, we can drop the solver from the stack.

## Memory

| Container | Idle RAM | RAM while reading |
| --- | --- | --- |
| sapphire-engine | 827 MB | |
| sapphire-flaresolverr | 218 MB | |
| sapphire-ntfy | 24 MB | |

## Phase 0 is done when

- At least 4 of your 5 extension-backed sites pass all five checks.
- The stack's day-to-day RAM fits comfortably in the DXP2800's 8 GB alongside UGOS.
- A test notification reaches your phone through ntfy.
