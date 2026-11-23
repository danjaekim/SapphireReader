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
| `search.ts` | Source list and scopes (`inScope`, `scopedSources`), `searchAll`, `groupHits`, `interleaveGroups`, title keys and merge aliases (`normalizeTitle`, `rawTitleKey`, `displayTitle`, `primaryCover`, `primaryDescription`), `titleMatch` / `rankByQuery`, series details and chapter lists, reading order. |
| `browse.ts` | Genre browsing and sorting across sources: maps canonical genres and sort orders onto each source's own filters, text fallback, `orderGroups`. |
| `genres.ts` | Canonical genre keys and labels (`canonKey`, `canonLabel`) so spellings across sources match. |
| `discover.ts` | Popular/Latest lists, tag weights (`tagWeights`), Similar series, For you quick rows (`planShelves`, `recommendShelves`), format tags. |
| `deep.ts` | For you "Best matches" and "Your theme" rows (`findThemes`, `deepRecommendations`). |
| `alsoliked.ts` | AniList "Readers of X also liked" rows. |
| `ratings.ts` | AniList scores/popularity (and MangaUpdates fallback), cached in `anilist_meta` / `mu_meta`; `rankByAnilist` for rating/popular sorts. |
| `adult.ts` | `AdultGate`: PIN, unlock sessions (cookie `sapphire_18`, 2 h idle lock). |
| `adultcheck.ts` | Classifies series on mixed sources as adult: known tags, AniList's adult flag, then the source's tags. |
| `description.ts` | Splits a description into story, alternative titles, stats (incl. a leading `★★★★✬ 9.1 (89)` rating line), facets, `tags` and `info` (author, artist, status, year from a leading year line or a ToonGod-style "also known as… written by… is about X story" blurb). Drops upload/source notes, `Links:` lists, and site ad paragraphs ("Read the latest…", "Browse more than…", "Connect with X on Social Media"); unescapes Markdown. Strips `**bold**` and `#` heading marks first so labels like `**Alternative Names:**` are found. |
| `checker.ts` | The library check: re-reads chapter lists, records new chapters, pushes alerts for caught-up series. |
| `downloader.ts` | Saves chapters to the NAS one at a time; serves saved pages and covers. |
| `notify.ts` | ntfy client. |
| `tracker.ts` | AniList tracking (token, search, set progress). |
| `updater.ts`, `engineupdate.ts` | "Is a newer version out?" for the app (GHCR digests + commits) and the engine (GitHub releases); asking Watchtower to update. |
| `extensions.ts` | Install/update/remove extensions through the engine. |
| `backup.ts` | Daily database snapshot. |
| `test-engine.ts`, `*.test.ts` | Fake engine and vitest tests (web code is tested from here too, e.g. `titles.test.ts`). |

**Web (`web/src`)**

| File | What it does |
| --- | --- |
| `main.tsx`, `App.tsx` | Entry, shell (side menu on desktop; top bar, drawer and bottom tab bar on phones), routing, Settings page sections (theme, automation, hidden tags, favorite tags, notifications, backups, updates), `<Toaster/>`. |
| `route.ts` | Hash routes: `#/` pages (`home, search, library, discover, discover-18, downloads, updates, history, sources, status`=Settings), `#/series/:id`, `#/read/:id/:chapter`. |
| `api.ts` | Typed client for every endpoint, `thumbnailUrl` (with a cover version bump after merges). |
| `Home.tsx`, `Search.tsx`, `SearchStart.tsx`, `Library.tsx`, `Discover.tsx`, `Updates.tsx`, `History.tsx`, `Downloads.tsx`, `Sources.tsx`, `SeriesPage.tsx`, `Reader.tsx`, `Trackers.tsx`, `AdultLock.tsx` | The pages. |
| `Results.tsx` | The card grid used everywhere (lazy chapter lookups for near-screen cards, ratings badge, add-to-library, Not interested, Select mode). |
| `FilterBar.tsx`, `SortSelect.tsx`, `genres.ts` | Sticky filter bar: tabs, genre sheet, source sheet, sort. |
| `usePaged.ts` | Paged loading with an in-memory cache that restores lists and scroll on Back (`clearPagedCache`). |
| `shared.ts` | Library id cache and toggle, ratings batching, hidden-adult checks (`useHiddenAdult`, `resetHiddenCache`). |
| `titles.ts` | `tidyTitle`: display-only cleanup of doujin-style titles. |
| `offline.tsx`, `useDownloads.ts` | On-device offline chapters (Cache Storage, https only) and NAS downloads. |
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
| `tracker_links` | AniList links per series. |
| `title_alias`, `title_primary` | Manual merges (alias key → canonical key, with listing ids) and how a merged series is shown (name, cover listing, description listing). |
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
- **Series page**: two-column layout with blurred cover / AniList banner background, tidy title with
  full title and alternative names, ratings (AniList, site stats), description split into story and
  facets (description-derived tags, author, artist, status and year fill in only what the source's own
  fields lack; these tags are display-only and don't feed recommendations or filters), tags (star mode for favorite tags), chapters with multi-select (shift-click ranges, mark
  read/unread, download), "mark earlier chapters read?" prompt, "Also on" other sources with chapter
  counts and version tags, Similar series, AniList tracking, like, add to library with shelves,
  18+ marks, merge tools (merge by name or series number, unmerge, name/cover/description choice,
  version labels). On phones, once the title and Read button scroll out of view, a bar pinned to the
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
- **18+ mode** is behind a 4–8 digit PIN (`AdultGate`). Unlock is per browser (HttpOnly cookie),
  survives restarts, locks after 2 h idle; phones start locked on a fresh app open. Locked: no 18+
  sources, no 18+ series anywhere, Discover (18+) hidden. 18+ titles never appear in push
  notifications or tab titles.
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

### 5.3 Chapters, progress and "best source"

Chapter lists are cached 10 minutes. Progress and read marks are stored per listing, and read
chapter *numbers* are kept so they carry across sources (switching, merged copies). Cards look up
each source's latest chapter lazily (only near the screen, 4 at a time, 2 retries) and link to the
furthest-ahead listing.

### 5.4 Library check, alerts and automation

Every `CHECK_INTERVAL_HOURS` (6) the checker re-reads each library series (one at a time, paced),
records new chapters, and pushes an ntfy alert for series you were caught up on. After a check:
auto-switch offers (§5.7), auto-download of the next N unread chapters (default 3, 0–10), and
auto-delete of read NAS downloads (keeps the last one). Sources can be excluded from checks.

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

### 5.9 Updates and backups

Settings compares the running image with the newest on GHCR (by digest; commit label for the
version), and the engine with the newest Suwayomi release. Update now asks Watchtower over its HTTP
API; the engine updates only on request. The database is snapshotted daily (7 kept) and can be
downloaded from Settings.

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
- Tailscale HTTPS (`tailscale serve`) and `PUBLIC_URL` set to the https address: not confirmed done.
- GHCR package visibility: if private, Watchtower needs `/root/.docker/config.json` mounted.

**Deferred by Dan (revisit later)**
- Alert quiet hours / daily digest.
- MyAnimeList and MangaUpdates trackers (AniList is done).
- Exclude-per-tag and All/Any genre matching in filters.
- Status filter (needs per-series lookups).

**Not yet verified against live sources**
- For you deep rows and AniList "also liked" rows on real sources.
- Version-aware move offers and the "Also on" memory on Dan's real libraries.

## Keeping this document current

Any change to features, logic, data model, settings, endpoints, deployment or decisions must
update this document **in the same commit**: the relevant section, the code map or data model if
files or tables changed, and §7 (add new open questions, remove finished ones). Update the
"Last full audit" date when the whole document is re-checked against the code. When something
here turns out to be wrong, fix it rather than working around it.
