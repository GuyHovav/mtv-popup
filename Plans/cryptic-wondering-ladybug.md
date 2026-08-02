# YouTube search (URL field does double duty)

## Context

Right now the only way to load a video is pasting a URL/ID — `UrlForm`
calls `parseVideoId(value)` and shows an error if it doesn't look like a
valid YouTube URL/ID. The ask: let that same field also work as a search
box — if the input isn't a URL, treat it as a search query and show
matching videos to pick from (confirmed: a results list, not
auto-playing the top hit).

This reuses almost everything already built for the Suggested Videos
feature: the same YouTube Data API v3 key, the same `search.list`
endpoint (just `q=` instead of `channelId=`), the same server dual-
entrypoint pattern, and the same video-card UI/click-to-load behavior
(`onSelect` → `handleSubmit`, no new "load video" logic needed here
either).

**Quota note:** `search.list` costs 100 units/call, same as suggestions —
already a known constraint (~90-100 loads/day on the free tier, no
caching in v1 per the earlier decision). Search adds more variable
load on top of that (a user might refine a query a few times), so this
plan deliberately makes search **explicit-submit only** (press
button/Enter), never live-as-you-type — firing a 100-unit call per
keystroke would burn through the daily quota almost immediately.

## Approach

### Server: extract a shared YouTube client, add `searchVideos`

`server/src/lib/suggestions.js` already has a private `youtubeFetch`
helper and inline result-mapping logic that a text-search function would
need to duplicate. Extract the shared bits into a new
**`server/src/lib/youtubeClient.js`**:
- `youtubeFetch(path)` — moved as-is from `suggestions.js` (API key
  injection, `AbortController` timeout, non-2xx/error handling → `null`).
- `hasYouTubeApiKey()` — small helper wrapping the `process.env.YOUTUBE_API_KEY` check, used by both files' short-circuit.
- `mapSearchItems(items, excludeVideoId)` — the `item → {videoId, title, thumbnailUrl, channelTitle}` mapping + filtering, extracted from `fetchSuggestedVideos`'s inline logic (identical shape, since both are `search.list` responses).

Update `suggestions.js` to import these instead of defining them locally
— behavior must stay byte-for-byte identical (re-verify against the real
API key after refactoring, same test used when this file was first
built).

**New `server/src/lib/search.js`**:
```js
export async function searchVideos(query) {
  if (!hasYouTubeApiKey()) return [];
  const trimmed = (query || '').trim().slice(0, MAX_QUERY_LEN); // 200 chars, same cap style as genius.js
  if (!trimmed) return [];
  try {
    const searchData = await youtubeFetch(`/search?part=snippet&q=${encodeURIComponent(trimmed)}&type=video&maxResults=10`);
    const items = searchData?.items;
    if (!Array.isArray(items)) return [];
    return mapSearchItems(items);
  } catch (err) {
    console.warn('Unexpected error searching videos:', err?.message || err);
    return [];
  }
}
```
No `videoDuration`/`order` filter here (unlike suggestions' channel
lookup) — a general search shouldn't silently exclude Shorts or sort
away relevance, since query intent is broader than "songs by one artist."

**New route files**, same dual-entrypoint pattern as `facts.js`/`suggestions.js`:
- `server/src/routes/search.js` — `GET /api/search?q=...`, 400 on
  missing/empty `q`, calls `searchVideos`, responds `{ results }`.
- `api/search.js` — identical logic, Vercel handler signature.
- `server/src/index.js` — mount `app.use('/api/search', searchRouter)`.

No new env var — reuses the existing `YOUTUBE_API_KEY`.

### Client: `UrlForm` detects mode, App.jsx reuses the suggestions UI pattern

**`client/src/components/UrlForm.jsx`** — branch on whether the input
parses as a video ID:
```js
function handleSubmit(e) {
  e.preventDefault();
  const trimmed = value.trim();
  if (!trimmed) {
    setError('Type a YouTube link or search for a video.');
    return;
  }
  const videoId = parseVideoId(trimmed);
  setError(null);
  if (videoId) {
    onSubmit(videoId);
  } else {
    onSearch(trimmed);
  }
}
```
New prop: `onSearch`. Also add a live (local, no network cost — just
regex) mode hint so the button reflects which action will happen:
```js
const looksLikeUrl = Boolean(parseVideoId(value));
// button label: disabled ? 'Loading…' : looksLikeUrl ? 'Pop it off' : 'Search'
```

**`client/src/lib/api.js`** — add `searchVideos(query)`, a
`GET /api/search?q=...` call following the exact same never-throw
contract as `fetchSuggestions` (`{ results: [] }` on any failure).

**`client/src/components/SuggestedVideos.jsx`** — add an optional
`title` prop (default `'More like this'`), so the same component renders
both the existing channel-based suggestions row and search results with
a contextual heading (`Results for "query"`) — no new component needed,
this one's already exactly the right shape (thumbnail cards,
`onSelect(videoId)`).

**`client/src/App.jsx`**:
- New state: `searchResults` (`null` = no active search, array once a
  search resolves), `isSearching` (bool), `searchQuery` (string, for the
  results heading / "no results" message).
- `handleSearch(query)`: sets `searchQuery`, `isSearching(true)`, clears
  `searchResults`, calls `searchVideos(query)`, sets `searchResults` on
  resolve, `isSearching(false)`. Kept **decoupled from the main `status`
  state machine** — searching is an independent side-flow that ends with
  the user picking a video, which then goes through the existing
  `handleSubmit` pipeline unchanged.
- Clear `searchResults`/`searchQuery` back to `null`/`''` at the top of
  `handleSubmit` (so the results picker disappears once a video is
  actually chosen/loaded) and in `reset()`.
- Extend `isBusy` to include `isSearching`, so the form disables consistently during any async op (video load or search) — but `isSearching` never touches `status` itself.
- Render, as a new top-level child of `.app` right after `<UrlForm>`:
  ```jsx
  {isSearching && <p className="app__status">Searching…</p>}
  {searchResults && searchResults.length > 0 && (
    <SuggestedVideos title={`Results for "${searchQuery}"`} videos={searchResults} onSelect={handleSubmit} />
  )}
  {searchResults && searchResults.length === 0 && (
    <p className="app__status">No videos found for "{searchQuery}".</p>
  )}
  ```
  Passing `handleSubmit` directly as `onSelect` is what makes clicking a
  search result behave identically to pasting its URL — same reuse
  pattern as Suggested Videos.

**No CSS changes needed** — reusing `SuggestedVideos`/`suggestions.css`
as-is, and the landscape "cinema mode" selector
(`.app:has(.video-stage) > *:not(.video-stage)`) already auto-hides any
new top-level `.app` child, same as confirmed for the suggestions feature.

## Files touched

- `server/src/lib/youtubeClient.js` (new — extracted shared helper)
- `server/src/lib/suggestions.js` (refactored to use the shared helper, behavior unchanged)
- `server/src/lib/search.js` (new)
- `server/src/routes/search.js` (new)
- `api/search.js` (new)
- `server/src/index.js` (mount route)
- `client/src/lib/api.js` (`searchVideos`)
- `client/src/components/UrlForm.jsx` (branch to search, dynamic button label, `onSearch` prop)
- `client/src/components/SuggestedVideos.jsx` (add `title` prop)
- `client/src/App.jsx` (search state, `handleSearch`, render, cleanup)

## Verification

1. **Regression check on the refactor**: after extracting `youtubeClient.js`, re-run the exact real-key test already used for suggestions (`fetchSuggestedVideos('dQw4w9WgXcQ')`) and confirm identical output to before the refactor.
2. **Server, real key**: call `searchVideos('rick astley never gonna give you up')` directly, confirm sensible results including the actual video.
3. **Server, no key / empty query**: confirm `searchVideos` resolves to `[]` for a missing key and for an empty/whitespace-only query, with no network call in the missing-key case.
4. **Route parity**: diff `server/src/routes/search.js` vs `api/search.js` for logical equivalence, same check used for the other endpoint pairs.
5. **Browser end-to-end**: type a non-URL query into the field, confirm the button reads "Search," confirm results render with the right heading, click one, confirm it loads and plays exactly like a pasted URL (and that the results picker disappears once it does). Also confirm pasting an actual URL still works unchanged, and that an empty submit still shows a validation error instead of searching for `''`.
6. **Cinema-mode regression check**: confirm the search results row is hidden in landscape/cinema mode along with the rest of the UI (same structural CSS selector, no new rule needed).
