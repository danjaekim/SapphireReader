# Sapphire: how it works

The living reference for Sapphire's architecture, features, logic and decisions, plus a running
list of open questions and tasks. **Read this first** before changing anything, and **update it in
the same commit** as any change to features, logic, data, settings or decisions (see
[Keeping this document current](#keeping-this-document-current)).

Last full audit: 2026-11-22.

---

## 1. What Sapphire is

A personal, self-hosted manga / manhwa / manhua reader, named after Dan's cat (cat logo and
branding). One user (Dan), one household. It runs as a Docker stack on a NAS and is used as a web
app (installable PWA) on PC, phone and tablet, with reading progress shared across devices.

Goals, in Dan's words: read from the free sites he already uses, always from whichever source is
furthest ahead; resume anywhere; get alerts for new chapters of series he's caught up on; discover
new series with sorting, filters, recommendations and "similar to this"; and keep 18+ content in a
separate, PIN-protected mode that never mixes with the regular side.

Sources come from community Keiyoushi (Mihon/Tachiyomi) extensions. Sapphire ships no sources.

## 2. Deployment and environment

| Piece | Where |
| --- | --- |
| NAS | UGREEN DXP2800 (Intel N100, ~8 GB RAM), 1 TB M.2 for Docker (volume2). Managed with the UGOS Docker app ("Project" pointing at `/volume2/docker/sapphire/deploy`). No git on the NAS. |
| Stack | [`deploy/docker-compose.yml`](../deploy/docker-compose.yml): `sapphire` (this app, port 8080), `engine` (Suwayomi-Server, headless), `flaresolverr` (Cloudflare solver), `ntfy` (push), `watchtower` (updates the app) and `watchtower-engine` (updates the engine on request only). |
| Remote access | Tailscale as a whole-NAS container in host network mode ([`deploy/docker-compose.tailscale.yml`](../deploy/docker-compose.tailscale.yml)). HTTPS through `tailscale serve` (README has the steps). Any published NAS port is reachable over the tailnet at `http://<nas-name>:<port>`. |
| Image | Built by GitHub Actions ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) on every push to `main`, published to `ghcr.io/danjaekim/sapphire:latest`. Watchtower pulls it every 6 h, or at once through Settings > Update now. |
| Repo | github.com/danjaekim/SapphireReader (public, so the version check needs no token). |
| Data | `DATA_DIR` (`/data` in the image): `app/sapphire.db` (SQLite through `node:sqlite`), `app/backups` (daily snapshots, newest 7 kept), downloaded chapters and covers. |

Workflow decisions: changes go straight to `main` (no PRs). Commit messages end with the
co-author and session lines the session asks for. Never put credentials, PINs or tokens in the
repo or in notes.

Environment variables are documented in [`server/src/config.ts`](../server/src/config.ts) and the
compose file: `ENGINE_URL/USER/PASSWORD`, `NTFY_URL/TOPIC/USER/PASSWORD`, `PUBLIC_URL` (where taps
on alerts go; should be the Tailscale https address), `CHECK_INTERVAL_HOURS` (6), `UPDATE_URL/TOKEN`
(Watchtower), `ENGINE_UPDATE_URL/TOKEN` (engine Watchtower), `UPDATE_REPO`, `UPDATE_GITHUB_TOKEN`,
`UPDATE_IMAGE`.

## 3. Architecture

```
browser (React PWA, hash routes)  --HTTP JSON-->  Sapphire server (Fastify, Node 22)
                                                     |  SQLite (node:sqlite) = all of Sapphire's own state
                                                     |  GraphQL + file proxy
                                                     v
                                               Suwayomi engine (headless) --> FlareSolverr --> sites
                                                     ^ runs Keiyoushi extensions
Sapphire server --> ntfy (push)    --> AniList / MangaUpdates (ratings, recommendations, tracking)
                --> Watchtower(s) (updates)   --> GHCR / GitHub (version checks)
```

- **The engine is only a runtime for extensions.** Sapphire keeps its own library, progress,
  read marks, downloads, settings and recommendations. It never uses the engine's library, UI or
  update checks (`UPDATE_INTERVAL=0`). Covers and pages are proxied through Sapphire so devices
  never talk to the engine. Engine port 4567 is still published (Phase 0 leftover; see open items).
- **One process serves everything.** The server serves the built web app from `WEB_DIR` and the
  API under `/api`. A service worker (web) caches the app shell and offline chapters.
- **Series identity.** A *listing* is one series on one source, identified by the engine's manga id
  (`mangaId`, the number in `#/series/1234`). Listings are grouped into one *series* by a normalized
  title key (`normalizeTitle`: lowercase, accents and punctuation stripped, `&` → `and`), with
  manual merges applied as aliases (see §5.6). Search results, "Also on", library matching,
  progress carry-over and recommendations all use that key.

### 3.1 Code map

**Server (`server/src`)**

| File | What it does |
| --- | --- |
| `index.ts` | Starts the app; schedules the library check every `CHECK_INTERVAL_HOURS` and daily backups. |
| `app.ts` | `buildApp`: every API route, caching, 18+ gating, merges and versions, For you caching, auto-switch, auto-download/delete. The big one. |
| `store.ts` | `Store`: the SQLite schema (created and migrated in the constructor) and every query. |
| `config.ts` | Environment → `Config`. |
| `engine.ts` | GraphQL client for the engine; file downloads; engine version. |
| `search.ts` | Source list and scopes (`inScope`, `scopedSources`), `searchAll`, `groupHits`, `interleaveGroups`, title keys and merge aliases (`normalizeTitle`, `rawTitleKey`, `displayTitle`, `primaryCover`, `primaryDescription`), `titleMatch` / `rankByQuery`, series details and chapter lists (live, and the engine's saved copy: `fetchStoredManga`, `fetchStoredChapters`), reading order. |
| `browse.ts` | Genre browsing and sorting across sources: maps canonical genres and sort orders onto each source's own filters, text fallback, `orderGroups`. |
| `genres.ts` | Canonical genre keys and labels (`canonKey`, `canonLabel`) so spellings across sources match. |
| `discover.ts` | Popular/Latest lists, tag weights (`tagWeights`), Similar series, For you quick rows (`planShelves`, `recommendShelves`), format tags. |
| `deep.ts` | For you "Best matches" and "Your theme" rows (`findThemes`, `deepRecommendations`). |
| `alsoliked.ts` | AniList "Readers of X also liked" rows. |
| `ratings.ts` | AniList scores/popularity (and MangaUpdates fallback), cached in `anilist_meta` / `mu_meta`; `rankByAnilist` for rating/popular sorts. |
| `passkeys.ts` | `Passkeys`: Face ID / fingerprint unlock for 18+ mode on `@simplewebauthn/server` (registration and login options, verification, one-use challenges). |
| `adult.ts` | `AdultGate`: PIN, unlock sessions (cookie `sapphire_18`, 2 h idle lock). |
| `adultcheck.ts` | Classifies series on mixed sources as adult: known tags, AniList's adult flag, then the source's tags. |
| `description.ts` | Splits a description into story, alternative titles, stats (incl. a leading `★★★★✬ 9.1 (89)` rating line), facets, `tags` and `info` (author, artist, status, year from a leading year line or a ToonGod-style "also known as… written by… is about X story" blurb). Drops upload/source notes, `Links:` lists, and site ad paragraphs ("Read the latest…", "Browse more than…", "Connect with X on Social Media"); unescapes Markdown. Strips `**bold**` and `#` heading marks first so labels like `**Alternative Names:**` are found. |
| `checker.ts` | The library check: re-reads chapter lists, records new chapters, pushes alerts for caught-up series. |
| `downloader.ts` | Saves chapters to the NAS one at a time; serves saved pages and covers. |
| `notify.ts` | ntfy client. |
| `tracker.ts` | AniList tracking (token, search, set progress). |
| `bakatags.ts` | MangaBaka tag vectors, cosine, taste vector, `boostFrom`. |
| `mergehints.ts` | Suggested merges: `splitVersion` ("X (Uncensored)" → base + label), `suggestMerges` (pairs by same MangaBaka entry or same base name), `pairKey`. |
| `mangabaka.ts` | MangaBaka client on the **v1** API (`search`, `series`, `similar`, `byTag`) (v2 records have no tags and no plain title; verified live Nov 23) (spaced calls: search 2.5s apart, others 0.5s), tolerant parsing of `tags_v2` (name, path, weight, genre, spoiler), content rating, provider ids; `findOnBaka` matching. |
| `updater.ts`, `engineupdate.ts` | "Is a newer version out?" for the app (GHCR digests + commits) and the engine (GitHub releases); asking Watchtower to update. |
| `extensions.ts` | Install/update/remove extensions through the engine. |
| `backup.ts` | Daily database snapshot. |
| `test-engine.ts`, `*.test.ts` | Fake engine and vitest tests (web code is tested from here too, e.g. `titles.test.ts`). |

**Web (`web/src`)**

| File | What it does |
| --- | --- |
| `main.tsx`, `App.tsx` | Entry, shell (side menu on desktop; top bar, drawer and bottom tab bar on phones), routing, Settings page sections (theme, automation, hidden tags, favorite tags, notifications, backups, updates), `<Toaster/>`. |
| `route.ts` | Hash routes: `#/` pages (`home, search, library, discover, discover-18, downloads, updates, history, sources, status`=Settings, `merges`), `#/series/:id`, `#/read/:id/:chapter`. |
| `offlineLock.ts` | 18+ unlock with no NAS: local PIN hash, passkey ids, last known lock state. |
| `connection.ts` | Online/offline state (`apiFetch`, `useOffline`), the offline progress queue and its flush. |
| `api.ts` | Typed client for every endpoint, `thumbnailUrl` (with a cover version bump after merges). |
| `Home.tsx`, `Search.tsx`, `SearchStart.tsx`, `Library.tsx`, `Discover.tsx`, `Updates.tsx`, `History.tsx`, `Downloads.tsx`, `Sources.tsx`, `SeriesPage.tsx`, `Reader.tsx`, `Trackers.tsx`, `AdultLock.tsx` (PIN pad, Face ID button and setup), `passkey.ts` (browser side of passkeys), `Merges.tsx` | The pages. `Merges.tsx` also exports `CompareSheet`, the side-by-side compare used before any suggested merge. |
| `Results.tsx` | The card grid used everywhere (lazy chapter lookups for near-screen cards, ratings badge, add-to-library, Not interested, Select mode). |
| `FilterBar.tsx`, `SortSelect.tsx`, `genres.ts` | Sticky filter bar: tabs, genre sheet, source sheet, sort. |
| `usePaged.ts` | Paged loading with an in-memory cache that restores lists and scroll on Back (`clearPagedCache`), one-page-ahead prefetch and background cover warming (`warmCovers`). |
| `shared.ts` | Library id cache and toggle, ratings batching, hidden-adult checks (`useHiddenAdult`, `resetHiddenCache`). |
| `titles.ts` | `tidyTitle`: display-only cleanup of doujin-style titles. |
| `offline.tsx`, `useDownloads.ts` | On-device offline chapters (Cache Storage, https only), `saveManyOffline`, auto-remove setting, `OfflineHome`; NAS downloads. |
| `toast.tsx` | `toast()` / `toastError()` confirmations. |
| `update.tsx`, `theme.ts`, `util.ts`, `Loading.tsx`, `styles.css` | Update cards, light/dark/auto theme, helpers, spinner, all styles (CSS variables for both themes). |

### 3.2 Data model (SQLite tables in `store.ts`)

| Table | Holds |
| --- | --- |
| `library` | Library series: manga id, source, title, adult flag, genres, known chapter numbers, last check. |
| `progress`, `chapters_read`, `read_numbers` | Place in each series (chapter, page, offset), read chapter ids, read chapter numbers (carried across sources). |
| `updates` | New chapters found by checks (Updates page, alerts). |
| `downloads` | NAS downloads and their status. |
| `categories`, `library_categories` | Library shelves. |
| `switch_offers` | "Move to X?" offers (kind `ahead` / `other-version` / `back`, `to_version`), dismissals. |
| `settings` | Key/value settings: `automation`, `hidden_tags`, `favorite_tags`, `favorite_tags.adult`, `adult_pin`, `adult_sessions`, `source_adult`, `source_nocheck`, `anilist_token`/`anilist_user`, per-device and per-series reader prefs, `autoswitch.checked.<id>`. |
| `series_meta` | Title/source/adult of every series opened (History). |
| `series_tags` | Tags seen per listing (tag statistics, Similar, For you, hidden tags). |
| `series_adult`, `adult_override` | Adult classification of mixed-source series; per-title manual marks (1 = 18+, 0 = not 18+). |
| `source_health` | Per-source success/failure and timing (Sources page). |
| `anilist_meta`, `mu_meta` | Cached AniList and MangaUpdates ratings. |
| `mb_links` | MangaBaka entry per title key (`mb_id` null = not found), `manual` flag, cached series JSON (`data`), `fetched_at`. |
| `tracker_links` | AniList links per series. |
| `title_alias`, `title_primary` | Manual merges (alias key → canonical key, with listing ids) and how a merged series is shown (name, cover listing, description listing). |
| `adult_passkeys` | Passkeys that can unlock 18+ mode: credential id, public key, signature counter, transports, name. Public keys only. |
| `merge_dismissed` | Suggested-merge pairs answered "Not the same" (`pair` = sorted title keys), never suggested again. |
| `listing_versions`, `version_prefs` | Version labels per listing (Uncensored, Censored…) and the preferred version per series. |
| `seen_listings` | Listings found together as "Also on", so each copy lists the others. |
| `likes`, `not_interested` | Likes (count toward For you) and "Not interested" (never suggested; tags count against). |
| `rec_cache` | Saved For you answers per kind and page. |

Schema changes are made in the `Store` constructor with `CREATE TABLE IF NOT EXISTS` and guarded
`ALTER TABLE ... ADD COLUMN` (try/catch), so old databases upgrade on start. Keep it that way.

## 4. Features (what the user sees)

- **Home**: Continue reading, new chapters for caught-up series, Recommended for you.
- **Search**: across all in-scope sources; results grouped per series and ranked by how well the
  title matches the query, then number of sources, then each site's own order interleaved
  (`rankByQuery`). Sort (best match, popular, latest, rating, newest, A–Z), stackable genre filter,
  source filter, recent searches and browse-by-genre when empty.
- **Series page layout (Nov 23 tidy-up)**: the intro card holds title, alt names, ratings (plus a version
  chip), description, then one tag row (source tags filled, MangaBaka core/defining outlined, capped at
  ~16 with "+N more" opening all incl. minor; ☆ Favorites toggles star mode), facets, and the MangaBaka 18+
  question. Rarely used controls (18+ mark, version label, merged names/unmerge, name/cover/description,
  merge, MangaBaka match) live in a **Manage** sheet (⋯ button beside Like; Like and Manage are icon-only on
  phones). The left column keeps cover, counts, info list, Also on and tracking. Also on rows: source name over its
  version chip, latest chapter right-aligned; a source further ahead shows its chapter in the accent color
  with a "+N" badge (chapters ahead of this listing) instead of a separate "further ahead" tag.
- **Series page**: two-column layout with blurred cover / AniList banner background, tidy title with
  full title and alternative names, ratings (AniList, site stats), description split into story and
  facets (description-derived tags, author, artist, status and year fill in only what the source's own
  fields lack; these tags are display-only and don't feed recommendations or filters), tags (star mode for favorite tags), chapters with multi-select (shift-click ranges, mark
  read/unread, download), "mark earlier chapters read?" prompt, "Also on" other sources with chapter
  counts and version tags, Similar series, AniList tracking, like, add to library with shelves,
  18+ marks, merge tools (merge by name or series number, unmerge, name/cover/description choice,
  version labels), detailed MangaBaka tags with a match picker (§5.10). On phones, once the title and Read button scroll out of view, a bar pinned to the
  top (back, cover, title, Start reading / Continue) slides in (`pinBar` in `SeriesPage.tsx`, portaled to
  `body` so it sits above the top bar).
- **Reader**: scroll (webtoon) or paged mode (LTR/RTL), per device with fallback to shared prefs,
  remembers place to the pixel, bottom bar on phones, end-of-chapter screen with next chapter and
  like, offline pages when saved on device.
- **Library**: shelves as a tab row, sorts (recent, most unread, A–Z), unread counts, caught-up
  states.
- **Discover / Discover (18+)**: For you, Popular, Latest, Top rated, Newest, A–Z, genre filters
  with sort, source filter, Select mode to mark many series 18+ / not 18+ at once.
- **Updates**: new chapters, "Check now", and move offers (see §5.7).
- **History**: everything opened, filterable, removable.
- **Suggested merges** (nav, route `merges`): pairs of listings that look like one series (§5.6), each with
  **Compare & merge** and **Not the same**. The series page shows the same kind of pair above Similar
  ("Same series, another listing?") when Similar finds it.
- **Downloads**: NAS downloads per series and chapters saved on this device.
- **Sources**: install/update/remove extensions, health and speed per source, mark a source 18+ or
  not, skip a source in checks, genre support per source.
- **Settings** (route `status`): theme (auto/light/dark), automation (auto-download next N
  chapters, auto-switch offers, auto-delete read downloads), hidden tags, favorite tags (regular and
  18+), notifications test, backups download, app and engine versions with Update now buttons.
- **Toasts** confirm actions (marks, merges, multi-chapter marks, moves, removals, extension and
  source changes, For you refresh, card add/remove with Undo).
- **PWA**: installable, PNG icons, service worker; offline chapters need https (Tailscale serve).

## 5. Logic and decisions

### 5.1 Sources, scopes and 18+

- Only English and multi-language sources are used. The same site installed twice is shown once.
- **Scopes**: `safe` (non-18+ sources), `adult` (18+ sources), `all`. Requests use `all` when 18+
  mode is unlocked, else `safe`. A source's 18+ flag comes from the extension unless Dan overrides
  it on the Sources page (`source_adult`).
- **Debug mode (Dan, Nov 24, "more incognito")** is the user-facing name of the 18+ mode toggle (menu row)
  and its PIN/Face ID dialog only (`AdultLock.tsx`); everything else, in the app and in this document,
  still says 18+. While it's off, the Sources page hides installed extensions whose sources are all 18+
  (an extension with any regular source stays); they come back when it's on.
- **18+ mode** is behind a 4–8 digit PIN (`AdultGate`). Unlock is per browser (HttpOnly cookie),
  survives restarts, locks after 2 h idle; phones start locked on a fresh app open. Locked: no 18+
  sources, no 18+ series anywhere, Discover (18+) hidden. 18+ titles never appear in push
  notifications or tab titles.
- **Face ID unlock** (`passkeys.ts`, `passkey.ts`, Dan Nov 23, 18+ only for now): a passkey (WebAuthn, platform
  authenticator, user verification required) turns on 18+ mode instead of the PIN. Setup is in the 18+
  dialog while it's on ("Set up Face ID on this device", also Remove); adding or removing needs 18+ already
  on, so the PIN stays the root of trust and the fallback. Unlock: `POST /api/adult/passkey/login/options`
  then `/login/verify` → same session cookie as the PIN. Endpoints: `GET /api/adult/passkeys`,
  `POST /api/adult/passkey/register/{options,verify}`, `DELETE /api/adult/passkeys/:id`;
  `/api/adult` also says `passkey: true` when one exists: opening the 18+ lock then asks for Face ID at
  once (Dan, Nov 23), with the PIN pad and a "Use Face ID" button underneath if it's cancelled. Login asks
  only for on-device (`internal`) passkeys, so phones skip the "use another device" choice. Passkeys only
  work over https or localhost: the server takes the page's `Origin` header as origin and its hostname as the
  relying-party id and refuses plain http (`PUBLIC_URL` is not checked: it's often still the LAN address), so use the Tailscale
  https address (a passkey made on one address doesn't work on another). Challenges last 5 minutes, one use.
  Not covered: locking the whole app (still the open app-password question).
- **Mixed sources** (regular sources with some adult series): series are classified by
  `classifyAdult` (cached tags → AniList adult flag → source tags) and hidden while locked.
- **Manual marks** per title (`adult_override`): "18+" moves a series to the 18+ side everywhere;
  "not 18+" shows a series from an 18+ source on the regular side (locked search also searches 18+
  sources for those titles). Marking not 18+ needs 18+ unlocked. Bulk marks from Discover's Select
  mode use `PUT /api/adult-marks`.
- The 18+ side has its own library section, Discover page, favorite tags and recommendations; the
  two never mix.

### 5.2 Search, grouping and ranking

`searchAll` asks every in-scope source in parallel (8 s timeout each), groups hits by title key
(`groupHits`, merged series shown with their primary name/cover), interleaves the sites' lists rank
by rank, then `rankByQuery` orders by title match: exact (100) > starts with query (80) > phrase
(60) > all words (40) > some words (<30); ties go to more sources, then site order. Sorting other
than best match goes through each source's own sort filter (`browse.ts`); sources without that
sort are listed as unsorted. Ratings sorts use AniList (`rankByAnilist`).

Loading more (Search and Discover grids; Dan, Nov 24: "load more is slow", both the next page and its
covers). A page waits on every source it asks (10 s cap each), then AniList ranking, so `usePaged` asks for
the next page as soon as the current one is shown and holds it; scrolling within 2.5 screens of the end
(`rootMargin: 0 0 250% 0`, was 600px) appends it, usually at once, and asks for the one after. Costs one
extra page request per list opened even if you never scroll. When a page arrives (page 1 too) its covers
are loaded in the background (`warmCovers`: low priority, 4 at a time, each URL once per tab), so they're
in the browser cache (`max-age=3600`) before their cards are near. Skeleton cards stand at the end of the
grid while more exist, and covers fade in over their placeholder instead of drawing in pieces.
The next-page placeholders sit in the grid itself (`SkeletonCard`), counted from the grid's measured column
count so they finish the last partial row and add one more row; a cover still loading shimmers in its card
(`.gridCover:has(img.loading)`), so half-loaded cards look alive.
First loads show skeletons too (Dan, Nov 24): Search and Discover show the status line over a grid of
placeholder cards (`SkeletonResults` in `Results.tsx`), For you shows placeholder shelves (`SkeletonShelves`),
and its "Best matches" and "Readers also liked" rows show placeholder cards while they're worked out.

### 5.3 Chapters, progress and "best source"

Chapter lists are cached 10 minutes. Progress and read marks are stored per listing, and read
chapter *numbers* are kept so they carry across sources (switching, merged copies). Cards look up
each source's latest chapter lazily (only near the screen, 4 at a time, 2 retries) and link to the
furthest-ahead listing.

A chapter counts as read when the reader saves it as finished: in scroll mode when the last page's bottom
is in view (saved at once, not on the 2-second scroll save), in paged mode on the last page or end
screen, and always when you go on with "Next" from the end. Leaving a chapter for another one saves your
place first. (Fix, Nov 23: before this, moving to the next chapter within 2 seconds of reaching the end
dropped the save, so chapters read straight through were often left unread and their downloads kept.)

Series page loading (Dan, Nov 24: "very slow", asked for progressive loading). The live answer
(`GET /api/manga/:id`) waits on the source site for the chapter list (`fetchChapters`, up to 30 s), so the
page loads in steps:
1. A skeleton in the page's own layout (cover, title, chips, chapter rows) instead of a spinner.
2. `GET /api/manga/:id/saved`: what the engine saved last time (`manga { initialized }` plus
   `chapters(condition: {mangaId})`, no source site), or the chapter list fetched in the last 10 minutes.
   Same shape as the live answer plus `saved: true`; it skips the live answer's bookkeeping (chapter
   numbers, read carry-over). 404 when the engine has nothing.
3. The live answer replaces it. While it's coming the chapter heading says "Checking <source> for new
   chapters…" (skeleton rows if the saved copy had no chapters). If the live answer fails after a saved copy
   showed, the page stays up with a note and Try again instead of the error screen.
Coming back to a series in the same tab shows its last live answer at once (memory only, never 18+ ones)
while the live one reloads. Server side, `detailsFor` answers from the engine's saved details when the
series has been filled in before and refreshes from the source behind it (stale-while-revalidate; `fresh`
callers such as the library check still wait for the source), and `listSources` is kept for a minute
instead of being asked twice per page. Similar shows skeleton cards while it searches. Assumes the
engine's GraphQL has `manga.initialized` and top-level `chapters(condition)`; if not, the saved step 404s
and the page behaves as before.

### 5.4 Library check, alerts and automation

Every `CHECK_INTERVAL_HOURS` (6) the checker re-reads each library series (one at a time, paced),
records new chapters, and pushes an ntfy alert for series you were caught up on. After a check:
auto-switch offers (§5.7), auto-download of the next N unread chapters (default 3, 0–10), and
auto-delete of read NAS downloads (keeps the last one). Sources can be excluded from checks.

**Chapters out on another source first** (Dan, Nov 23): for a series you're caught up on, the check also
reads the chapter lists of its other listings Sapphire already knows (`seen_listings` for its name and
merged names, i.e. what "Also on" found; no new searches; up to 4, sources in its 18+ scope, sharing ≥60% of
chapter numbers). If one has a chapter past yours, it adds an Updates entry for *that* listing
(`updates.elsewhere = 1`, tag "not on your source yet", Open goes to that listing) and pushes "Chapter N is
out on X (not on Y yet)" once per new number (`elsewhere.<mangaId>` setting = highest announced). When your
own source later gets that chapter it's a normal update but no second push. Series you're behind on aren't
looked up elsewhere. Separate from move offers (§5.7), which still search and ask before moving.

### 5.5 Recommendations

- **Taste** per side: library series (weighted by reading and recency) and likes, plus favorite tags
  as a stand-in series (`FAVORITES_ID = -1`, weight 6). Tag weights come from how common each tag is
  across seen series (rare tags say more); format tags are ignored; hidden tags never seed or show.
- **Quick rows** (`/api/for-you`): `planShelves` picks tag pairs that describe parts of your library
  ("Because you read X"), searches them per source, falls back to other mixes then single tags,
  nudged by AniList score.
- **Deep rows** (`/api/for-you/deep`): "Best matches" (a wide pool ranked by full tag list fit) and
  up to 3 "Your theme" rows (tag combos shared by 2+ of your series). Built for many-tag 18+ series.
- **AniList rows** (`/api/for-you/also-liked`): "Readers of X also liked", found on your sources by
  exact name.
- **Not interested** never suggests a series again and counts its tags against.
- **Similar** on the series page: by the series' most telling tags, both together then one.
  Content rating (Dan, Nov 24): an explicit series (MangaBaka erotica/pornographic, else 18+ source or
  mark) only suggests explicit series, and any other series never suggests explicit ones. A suggestion's
  rating comes from its MangaBaka record where known, else any listing on an 18+ source, marked or
  classified 18+, or tagged Adult/Hentai/Smut/Erotica/Uncensored on its source (`groupRatings`); for an
  explicit series, suggestions of unknown rating are left out.
- **Caching** (decision, Nov 22): answers are saved in `rec_cache` per kind and side. They are
  reused while the taste key (likes/library weights, favorite tags, library size) is unchanged, for
  up to 24 h. When the taste changes they rebuild on the next visit, but no sooner than 3 h after the
  last build (`REC_MIN_GAP_MS`); meanwhile the page says "taste changed since" and offers
  **Refresh** (`?refresh=1`). Not interested, hidden tags, owned series and 18+ marks are filtered
  at read time, so they never force a rebuild. Empty answers are never saved; failed rebuilds fall
  back to the last answer. Merges still clear all saved answers.

### 5.6 Titles, merges and display

- `tidyTitle` (web, display only) cleans doujin-style names: drops `[circle]`, `{group}`, tags like
  `[English]`/`[Digital]`, trailing notes like "Uncensored", and keeps the most English of
  "A | B" names. The full title still drives search, matching and sorting, and is shown under the
  heading. Long names in row headings and subtitles are shortened with an ellipsis.
- **Merges** (`title_alias`): any listing name can be merged into a series' canonical key, so
  differently named listings count as one series everywhere (search, Also on, library, progress
  carry-over, recommendations). Merge search finds listings by name or by series number / pasted
  `/series/1234` address and leaves out the series itself and what's already merged.
- **Display choice** (`title_primary`): name, cover and description can each come from any merged
  listing (Edit name, cover & description sheet). The description is read live from the chosen
  listing (falls back to the opened one's). Unmerging a listing the display used resets the display.
  Covers redirect to the chosen listing (`?raw=1` skips that for previews).
- **Suggested merges** (`mergehints.ts`, `GET /api/merge-suggestions`, `POST /api/merge-suggestions/dismiss
  {key} | {a, b}`): from every known listing (`knownListings`: opened, library, seen together), pairs that
  match the same MangaBaka entry (listed first) or have the same name once a version word is taken off
  ("Uncensored", "Censored", "Raw", "Colored"/"Full color", "Official"; bracketed or trailing). A plain
  base group alone isn't a pair. Already merged listings share a key so never pair; dismissed pairs stay
  gone; 18+ listings are left out while 18+ is locked. Similar also splits such listings out of its
  groups into `sameSeries` for the series-page prompt. Nothing merges without a tap.
- **Compare before merging** (`CompareSheet`): both listings side by side (cover, full source title,
  source, chapter count and latest, recent scanlators, description excerpt) plus an optional page
  preview from the newest chapter number both have (stepping pages in sync), so quality or censorship
  can be judged. Dan picks which listing is **main** (default: the plainly named one, else the one with
  more chapters) and each side's version label (prefilled from its set version or its name's version
  word), then Merge calls the merge endpoint on the main listing and sets changed labels. Decision (Dan,
  Nov 23): never merge a suggestion without seeing this compare first.
- **Also on** remembers listings found together (`seen_listings`) so each copy lists the others even
  when a site's own search can't find them by another site's name.

### 5.7 Versions and move offers

- Each listing can carry a version label (Uncensored, Censored, Colored, Raw, Official or custom).
  A series can prefer one; with no choice, a listing labeled "Uncensored" is preferred.
- **Auto-switch** (only for caught-up library series, at most every 20 h each) searches every
  merged name, keeps listings sharing ≥70% of chapter numbers, and asks first (never moves
  silently):
  - `back`: reading a non-preferred version and the preferred one has caught up → offer to move back;
  - `ahead`: same version further ahead elsewhere → "Move to X?";
  - `other-version`: only another version has newer chapters → "Continue in the Censored version?".
- Accepting moves the library entry, read chapters (by number), place and shelves. Declining hides
  the offer until that source gets even further ahead. Changing labels drops pending offers.

### 5.8 Downloads and offline

NAS downloads (one chapter at a time) read without the source; covers are saved too. On-device
offline chapters use Cache Storage and the service worker, and only work over https.

**Offline mode on phones** (Dan, Nov 23, all four parts):
- *Detection* (`connection.ts`): every API call goes through `apiFetch`; a failed connection, or a response
  the service worker answered from its cache (it adds `x-sapphire-offline: 1`), marks the app offline.
  `/api/health` is pinged every 15 s while offline (and on the browser's `online` event or the app
  becoming visible) to come back.
- *Offline home* (`OfflineHome` in `offline.tsx`): while offline, an amber bar shows and every page except
  Downloads (and series pages, filtered to that series) shows what's saved on this device, grouped by series,
  with "Read Chapter N" for the first one not read here. 18+ series are listed only if 18+ mode was on;
  saves from before offline mode are back-filled with the 18+ flag and chapter number when online.
- *Progress while offline*: `saveProgress` queues saves in localStorage (`sapphire.pending`: the latest
  place per series plus every finished chapter, each once) and remembers finished chapters locally
  (`sapphire.readHere`). The queue is sent in order when the NAS is back; a newer online save for a series
  drops its queued place first. Offline progress can overwrite a place set later on another device.
- *Saving many*: series page "📱 Save next 5 to phone" (unread from your place on) and "Save to phone" for
  ticked chapters (`saveManyOffline`); rows show 📱 when saved here.
- *Tidy*: moving forward from a finished chapter removes its copy on this device (toggle on Downloads ›
  On this device, `sapphire.offline.autoRemove`, default on). Offline, the reader's previous/next skip to
  chapters saved here, and the end screen says when none are left.
- *18+ offline* (`offlineLock.ts`, Dan Nov 23): with no NAS the phone checks the lock itself, since it only
  guards what's saved there. The PIN is checked against a PBKDF2-SHA256 hash (310k rounds, random salt) kept
  in localStorage after the PIN last worked online (5 wrong tries → 5-minute wait); Face ID asks for this
  site's passkey with user verification and accepts it if the authenticator data shows the same site and
  the UV flag (no signature check: there's no NAS to issue a challenge). Passkey ids are learned when Face ID
  is set up or used, and replaced by the NAS's list whenever the 18+ dialog opens online. The last known
  "PIN set / Face ID set up" is kept so the lock looks right offline. Setting or changing the PIN needs the
  NAS. An offline unlock (`AdultState.offline`) ends when the NAS is back; its own lock decides again.
  Trade-off: someone who could read the phone's app storage could brute-force a short PIN's hash offline.
- Limits: the app must be opened online once after an update for the phone to pick it up. Auto-delete removes downloaded chapters once they're read (finished in the reader or marked read by
hand), except the chapter your place is on; finishing or marking also tops up auto-download.

### 5.9 Updates and backups

Settings compares the running image with the newest on GHCR (by digest; commit label for the
version), and the engine with the newest Suwayomi release. Update now asks Watchtower over its HTTP
API; the engine updates only on request. The database is snapshotted daily (7 kept) and can be
downloaded from Settings.

### 5.10 MangaBaka (detailed tags)

- Why: source tags are often generic. MangaBaka (api.mangabaka.org, public, no key; CC BY-NC-SA,
  credited on the page) has nested tags weighted per series (core, defining, recurrent, incidental) and
  a content rating (safe, suggestive, erotica, pornographic; sexual content only).
- Matching (`findOnBaka`): searches the shown title, source title, merged names and description alt
  names (max 3 searches). A result with the same AniList id (tracker link, else `anilist_meta`) wins; else
  an exact normalized title/alt-title match, rejected if it points at a different AniList entry. Near
  misses never match.
- Cache: per title key in `mb_links`; a match is re-read after 14 days, a miss retried after 7. Manual
  picks (or "It isn't on MangaBaka") stick until "Find it automatically". If MangaBaka is unreachable the
  last known data is served (`status: "unavailable"`).
- Display (Dan, Nov 23: matching and display first): the series page loads it after the page. It shows
  core and defining tags the source's list lacks as outlined chips, minor ones behind "+N minor", and
  spoiler tags never (dropped server-side). A credit line shows the content rating when it isn't safe,
  plus "Wrong match?" / "Find it", which opens a picker sheet (search by name, address or number).
- Endpoints: `GET/PUT/DELETE /api/manga/:id/mangabaka` (`?refresh=1`; PUT `{mbId}` or `{mbId: null}`),
  `GET /api/mangabaka/search?q=`.
- Recommendations (`bakatags.ts`; Dan's go, Nov 23): a series' MangaBaka tags become a vector: core 3,
  defining 2, recurrent 1, incidental 0.35, unweighted 0.5; genres x0.3; spoilers dropped. Each tag gives its
  ancestors 0.35 per level (never the top-level bucket like "Themes"). Similarity is cosine.
  - Taste: liked series' vectors summed by liking weight (not-interested ones at -0.8). For you and the deep
    rows multiply each candidate's fit by `boostFrom(cosine)`: 1 with no data, 0.85 to 1.65 with data, so
    having data is not itself a bonus. Candidates still come from source genre browsing; MangaBaka only re-ranks.
  - Similar (rebuilt Nov 24 at Dan's ask, "match on the detailed tags"): the candidate pool is MangaBaka's
    own similar list (`GET /v1/series/{id}/similar`, +0.1 head start since it also weighs author/relations)
    plus the series carrying this one's most telling tags (4, or 5 for explicit series; core, then defining,
    then recurrent; rarer first by `series_count`; no genres, spoilers or broad tags: demographics like
    Seinen, Male/Female Lead, Adult/Smut-style labels, any tag on over 15,000 series), one
    `GET /v1/series/search?tag=ID&limit=50` each, cached a week as `mb_tag.<id>`. For an explicit series the
    search adds `content_rating=<its rating>` (cached as `mb_tag.<id>.<rating>`), since unfiltered pools were
    mostly safe titles that the rating gate then dropped (Dan, Nov 24: "very thin"). Every candidate is ranked
    by cosine of its whole weighted tag vector against this series (kept above 0.12), held to the same content
    rating, and the best are looked for on your sources (4 at a time; best 30 stopping at 12, or best 60
    stopping at 16 for explicit series; `findOnSources`, cached a week under `baka_match.*`). The genre-based
    results follow, boosted by closeness, minus any MangaBaka knows are unrelated (cosine < 0.08). "Matched
    mostly on" names this series' specific tags (broad ones left out) the found ones share most. First open of
    a series costs 4 to 5 tag searches (2.5 s apart) plus source searches; later opens reuse the caches.
    `GET /api/manga/:id/similar?debug=1` skips the hour cache and adds `debug` (MangaBaka id/rating, tags
    searched, pool size, candidates ranked/tried/found, genre results found/kept) for checking on the NAS.
    MangaBaka records saved before tag ids were kept (all tags lack `id`) are fetched again on the next
    lookup (at most hourly), since without ids no tag searches can run (Dan's debug output, Nov 24: `telling: []`).
    (Multi-tag search can't do AND: repeated `tag=` keeps only the first, commas match nothing; checked live
    Nov 23. Whether v1 search honours `content_rating` is not yet checked live; if ignored, nothing is lost.)
  - Background lookups (`enrichBaka`): liked series and up to 20 candidates per For you / deep / Similar
    build are looked up one at a time; tag-search results are cached too. The For you and deep cache keys
    include how many liked series have MangaBaka tags, so new tags bring a rebuild (within the 3h gap rule).
- 18+ offer: a series MangaBaka rates erotica or pornographic that isn't 18+ (and not marked not 18+)
  shows "Move it to 18+?" with Mark as 18+ / Keep it here. Keep marks it not 18+, or when 18+ mode is
  locked remembers the answer on that device (localStorage `bakaAdultKept.<id>`).

## 6. Testing and running

- `cd server && npm ci && npx vitest run`: all server tests (and web logic like `titles.ts`).
- `cd web && npx tsc --noEmit -p .`: type check the web app.
- Local run: `cd server && npm run dev` and `cd web && npm run dev`.
- The cloud sandbox can't reach the manga sites; UI changes are checked against a fake engine
  (a harness that builds the app with a stubbed `fetchImpl` and drives it with Playwright).

## 7. Open questions and tasks

Keep this list current: add items when they come up, remove them when done or dropped.

**Waiting on Dan**
- Add an app password and close the engine port (4567 still published from Phase 0)? Asked, no
  answer yet.
- Discover: keep Popular/Latest/Top rated/Newest/A–Z as tabs, or one "Browse" tab with a Sort
  dropdown? Offered, no answer yet.
- Tailscale HTTPS works (Dan, Nov 23). `PUBLIC_URL` may still be the LAN http address; set it to the https
  address so notification taps open over https.
- GHCR package visibility: if private, Watchtower needs `/root/.docker/config.json` mounted.

**Deferred by Dan (revisit later)**
- Alert quiet hours / daily digest.
- MyAnimeList and MangaUpdates trackers (AniList is done).
- Exclude-per-tag and All/Any genre matching in filters.
- Status filter (needs per-series lookups).

**Not yet verified against live sources**
- Suggested merges and the compare sheet on Dan's real listings (page previews depend on the sources serving pages).
- MangaBaka: effect of the re-ranking on real For you rows, and the new Similar, not yet judged by Dan.
- For you deep rows and AniList "also liked" rows on real sources.
- Version-aware move offers and the "Also on" memory on Dan's real libraries.

## Keeping this document current

Any change to features, logic, data model, settings, endpoints, deployment or decisions must
update this document **in the same commit**: the relevant section, the code map or data model if
files or tables changed, and §7 (add new open questions, remove finished ones). Update the
"Last full audit" date when the whole document is re-checked against the code. When something
here turns out to be wrong, fix it rather than working around it.
