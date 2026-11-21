type FetchLike = typeof fetch;

const ANILIST = "https://graphql.anilist.co";

export interface TrackerMatch {
  mediaId: number;
  title: string;
  chapters: number | null;
  status: string | null;
  cover: string | null;
}

async function anilist<T>(
  query: string,
  variables: Record<string, unknown>,
  token: string | null,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const res = await fetchImpl(ANILIST, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || json.errors?.length || !json.data) {
    throw new Error(json.errors?.[0]?.message ?? `AniList answered ${res.status}`);
  }
  return json.data;
}

/** Checks a token and returns the AniList user name it belongs to. */
export async function anilistViewer(token: string, fetchImpl?: FetchLike): Promise<string> {
  const data = await anilist<{ Viewer: { name: string } }>("query { Viewer { name } }", {}, token, fetchImpl);
  return data.Viewer.name;
}

export async function anilistSearch(title: string, fetchImpl?: FetchLike): Promise<TrackerMatch[]> {
  const data = await anilist<{
    Page: { media: { id: number; title: { romaji: string | null; english: string | null }; chapters: number | null; status: string | null; coverImage: { medium: string | null } }[] };
  }>(
    `query ($q: String) { Page(perPage: 8) { media(search: $q, type: MANGA, sort: SEARCH_MATCH) {
       id title { romaji english } chapters status coverImage { medium } } } }`,
    { q: title },
    null,
    fetchImpl,
  );
  return data.Page.media.map((m) => ({
    mediaId: m.id,
    title: m.title.english ?? m.title.romaji ?? `#${m.id}`,
    chapters: m.chapters,
    status: m.status,
    cover: m.coverImage.medium,
  }));
}

/** Sets how many chapters you've read on AniList. Whole chapters only; AniList has no half chapters. */
export async function anilistSetProgress(
  token: string,
  mediaId: number,
  chapter: number,
  fetchImpl?: FetchLike,
): Promise<void> {
  await anilist(
    `mutation ($mediaId: Int, $progress: Int) {
       SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: CURRENT) { id progress }
     }`,
    { mediaId, progress: Math.floor(chapter) },
    token,
    fetchImpl,
  );
}
