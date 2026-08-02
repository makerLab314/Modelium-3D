# Modelium 3D

One search field for three 3D model libraries: **Printables**, **MakerWorld** and
**Thingiverse**. Type once, get one merged and ranked list of results, each with
a picture. Clicking a result opens the original listing on the original site,
where the download lives. Modelium never hosts or mirrors model files.

This is a local web app. It ships with a small Node server because the three
sites cannot be queried from a browser directly (no CORS headers, one of them
needs an API token), and because the merging and ranking belong on one side of
the wire, not spread across three fetches in the page.

## Getting started

```bash
npm start
```

Then open <http://127.0.0.1:8787>. No dependencies to install, Node 20 or newer
is enough.

Two of the three sources work immediately. Thingiverse needs a free token, and
the app asks for it on first run: click **Settings**, paste the token, press
**Test** to confirm it works, then **Save**. It is written to `server/.env` and
picked up straight away ,  no restart, no environment variables to export.

To get the token: create a **Desktop** app at
<https://www.thingiverse.com/apps/create> and copy the **App Token**.

> Always start with `npm start`, not `node server/index.js`. Printables answers
> with an ~18 KB `Link` header and Node rejects responses over 16 KB of headers
> by default, so the start script passes `--max-http-header-size=65536`. If you
> start it the other way the app tells you, both in the terminal and in the page.

## How it works

```
browser  ──▶  /api/search?q=…&stream=1   (Server Sent Events)
                     │
                     ├── printables adapter  ──▶ printables.com
                     ├── makerworld adapter  ──▶ makerworld.com API
                     └── thingiverse adapter ──▶ api.thingiverse.com
                     │
                     ▼
              normalize ▸ fuse ▸ dedupe ▸ sort
```

All three sites are queried in parallel and every result is normalized into the
same shape, so a Printables `likesCount` and a MakerWorld `likeCount` end up in
the same field. Results stream to the page as each site answers, so a slow
source cannot hold up a fast one.

### Ranking

None of the three sites exposes a comparable relevance score, so the merge uses
**Reciprocal Rank Fusion**: each site's own ordering is trusted, and position
`n` contributes `1 / (k + n)`. On top of that come two signals we can compute
ourselves: how well the title matches the query, and how popular a model is
compared to the other hits from the *same* site (so the biggest library does not
automatically win every slot).

### Deduplication

Creators cross post. When the same title and author show up on more than one
site, the entries collapse into a single card that carries an "also on" link to
the other listing. Two entries from the *same* site are left alone: that is that
site's catalogue, not a duplicate to hide.

### Where the data comes from

| Source | Access | Notes |
| --- | --- | --- |
| Printables | Server rendered search page | Their GraphQL API has introspection disabled, but their SvelteKit page inlines the exact GraphQL response it rendered from. The adapter lifts that JSON back out, so it reads structured data rather than scraping markup. |
| MakerWorld | `api/v1/search-service/select/design2` | Public, no key. The older `select/design` still answers `200` but always with an empty list ,  worth knowing, because that failure looks exactly like "no results". |
| Thingiverse | `api.thingiverse.com` | Needs an app token, see above. |

These are unofficial endpoints. They can change without notice, which is why
each adapter is isolated: if one breaks, the other two keep working and the UI
says which one is down and why.

## Configuration

Everything is optional and has a working default. The common settings are in the
**Settings** panel; all of them can also be set in `server/.env` or as real
environment variables, which win over the file.

| Variable | Default | Meaning | In Settings |
| --- | --- | --- | --- |
| `THINGIVERSE_TOKEN` | empty | Enables the Thingiverse source | yes |
| `PER_SOURCE_LIMIT` | `36` | Results requested per site, per page | yes |
| `SOURCE_TIMEOUT_MS` | `12000` | Give up on a site after this long | yes |
| `HIDE_NSFW` | `true` | Drop models a site flagged as not safe for work | yes |
| `PROXY_IMAGES` | `true` | Serve result images through the local server | yes |
| `PORT` | `8787` | Server port (restart to apply) | yes |
| `HOST` | `127.0.0.1` | Bind address | no |
| `CACHE_TTL_MS` | `300000` | How long a search stays cached in memory | no |
| `CACHE_MAX_ENTRIES` | `200` | Cache size | no |
| `USER_AGENT` | a desktop Chrome string | Sent upstream | no |

`server/.env.example` documents the same list. Copy it to `server/.env` if you
prefer editing a file to using the panel ,  the format is identical, and the app
rewrites keys in place, so your comments survive.

`server/.env` is git-ignored. Tokens never leave your machine: the settings API
only answers requests coming from loopback with a local `Host` header, and
reading settings returns whether a secret is set plus its last four characters,
never the value.

## API

The same endpoint serves scripts and the page:

```
GET  /api/search?q=voronoi+lamp                      → JSON
GET  /api/search?q=voronoi+lamp&stream=1             → Server Sent Events
GET  /api/search?q=…&sources=printables,makerworld   → subset of sites
GET  /api/search?q=…&sort=relevance|popular|newest
GET  /api/search?q=…&page=2                          → next page from every site
GET  /api/sources                                    → registry and setup state
GET  /api/health                                     → version, header limit, sources
GET  /api/settings                                   → editable settings, secrets masked
PUT  /api/settings                                   → save settings (loopback only)
POST /api/settings/test?source=thingiverse           → try a source's credentials
GET  /img?u=<image url>                              → image proxy, allowlisted hosts
```

A result looks like this:

```json
{
  "id": "printables:3161",
  "source": "printables",
  "sourceLabel": "Printables",
  "title": "3D BENCHY",
  "url": "https://www.printables.com/model/3161-3d-benchy",
  "author": "Prusa Research",
  "authorUrl": "https://www.printables.com/@Prusa3D",
  "image": { "thumb": "/img?u=…", "full": "https://media.printables.com/…" },
  "stats": { "likes": 22108, "downloads": 551346, "rating": 4.94 },
  "publishedAt": "2019-05-23T11:24:37+00:00",
  "alsoOn": [],
  "score": 2.77
}
```

## Interface

The look is a drafting table, not a dashboard: warm paper, hairline rules,
monospaced part labels, and colour used only to identify a source. Light and
dark are both first class and follow the system setting until you override it.

Worth knowing:

- `/` jumps to the search field.
- Each source in the rail is a toggle *and* a status light: hollow while idle,
  pulsing while that site is being queried, filled with the hit count when it
  answered, crossed out when it failed.
- A source that failed explains itself above the results. If the reason is a
  missing token, the notice has a button that opens Settings.
- **Load more** fetches the next page from every selected site and appends it.
- Sort order, selected sources and the query live in the URL, so a search is
  shareable and survives a reload.
- Recent searches are kept in `localStorage` and nowhere else.

## Tests

```bash
npm test
```

Offline and fast. Covers the parts that would silently produce wrong results
rather than an obvious crash: the ranking and deduplication maths, the
Printables payload extraction, the MakerWorld adapter's "empty list, non-empty
total" case, the `.env` reader and writer, and the settings validation.

```bash
npm run test:live
```

The structure canary. This is the one that matters over time: it queries the
three sites for real and asserts they still return the fields the adapters
read ,  not which models come back, or how many. All three have broken silently
before, which is the failure this is built to catch.

GitHub Actions runs it daily (`.github/workflows/ci.yml`). It needs no secrets:
the Thingiverse checks skip themselves when `THINGIVERSE_TOKEN` is unset, and
add the token as a repository secret of that name if you want them to run. On
pull requests the job is `continue-on-error`, because a site being down is not a
reason to block a merge.

## Limits

- The endpoints are unofficial. Expect to fix an adapter now and then.
- MakerWorld sits behind a bot filter that reacts to the calling network. When
  it answers with an empty list next to a non-zero total the UI says the source
  was blocked rather than reporting zero results.
- Ranking is computed per page, so **Load more** appends a freshly fused page
  rather than re-ranking everything seen so far.
- The cache is in memory, so restarting the server empties it.
