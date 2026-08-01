# Modelium 3D

One search field for three 3D model libraries: **Printables**, **MakerWorld** and
**Thingiverse**. Type once, get one merged and ranked list of results, each with
a picture. Clicking a result opens the original listing on the original site,
where the download lives. Modelium never hosts or mirrors model files.

This is a local web app. It ships with a small Node server because the three
sites cannot be queried from a browser directly (no CORS headers, one of them
needs an API token), and because the merging and ranking belong on one side of
the wire, not spread across three fetches in the page.

```
npm start          # http://127.0.0.1:8787
```

No dependencies to install. Node 20 or newer is enough.

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
| MakerWorld | `api/v1/search-service/select/design` | Public, no key. Sits behind a bot filter that reacts to the calling network. |
| Thingiverse | `api.thingiverse.com` | Needs an app token, see below. |

These are unofficial endpoints. They can change without notice, which is why
each adapter is isolated: if one breaks, the other two keep working and the UI
says which one is down and why.

## Thingiverse token

Thingiverse rejects every unauthenticated API call and renders its search in the
browser, so there is nothing to read without a key. A token is free:

1. Go to <https://www.thingiverse.com/apps/create> and create a **Desktop** app.
2. Copy the **App Token**.
3. Start the server with it:

```
THINGIVERSE_TOKEN=your_token_here npm start
```

Without the token the other two sources still work and the UI shows a notice
explaining what is missing.

## Configuration

Every setting is an environment variable:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Server port |
| `HOST` | `127.0.0.1` | Bind address |
| `THINGIVERSE_TOKEN` | empty | Enables the Thingiverse source |
| `PER_SOURCE_LIMIT` | `36` | Results requested per site |
| `SOURCE_TIMEOUT_MS` | `12000` | Give up on a site after this long |
| `CACHE_TTL_MS` | `300000` | How long a search stays cached in memory |
| `PROXY_IMAGES` | `true` | Serve result images through the local server |
| `HIDE_NSFW` | `true` | Drop models a site flagged as not safe for work |

## API

The same endpoint serves scripts and the page:

```
GET /api/search?q=voronoi+lamp                      → JSON
GET /api/search?q=voronoi+lamp&stream=1             → Server Sent Events
GET /api/search?q=…&sources=printables,makerworld   → subset of sites
GET /api/search?q=…&sort=relevance|popular|newest
GET /api/sources                                    → registry and setup state
GET /img?u=<image url>                              → image proxy, allowlisted hosts
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
- Sort order, selected sources and the query live in the URL, so a search is
  shareable and survives a reload.
- Recent searches are kept in `localStorage` and nowhere else.

## Tests

```
npm test
```

The tests cover the parts that would silently produce wrong results rather than
an obvious crash: the ranking and deduplication maths, the Printables payload
extraction, and the source registry's failure handling.

## Limits of the prototype

- The endpoints are unofficial. Expect to fix an adapter now and then.
- MakerWorld's bot filter can answer with an empty result set instead of an
  error, depending on the network you run this from. The UI reports what the
  site returned, it does not guess.
- One page of results per source, no pagination yet.
- The cache is in memory, so restarting the server empties it.
