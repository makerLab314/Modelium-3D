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

Pick whichever fits. All three run the same code; they differ only in where the
settings live and who can change them.

### Try it

```bash
npx modelium-3d
```

Opens a browser at <http://127.0.0.1:8787>. Nothing to install, nothing to clone,
Node 20 or newer is enough. `--port`, `--host` and `--no-open` are there if you
need them; `--help` lists the rest.

### On a homelab

```bash
docker compose up -d
```

The container runs in **server mode**: it binds every interface, and its settings
are read-only, with configuration coming from environment variables, because a panel
that can rewrite an API token should not be a thing anyone on the network can
reach. See [Modes](#modes) below for the one exception, which is how you get a
Thingiverse token in there on the first run.

`docker-compose.yml` publishes on `127.0.0.1` by default. Widen it deliberately:
there is no login.

### From the source

```bash
git clone https://github.com/makerLab314/Modelium-3D
cd Modelium-3D
npm start
```

No dependencies to install. If you would rather not have a git repository, every
[release](https://github.com/makerLab314/Modelium-3D/releases) carries a plain
tarball of the same files.

### The Thingiverse token

Two of the three sources work immediately. Thingiverse needs a free token, and
the app asks for it on first run: click **Settings**, paste the token, press
**Test** to confirm it works, then **Save**. It is picked up straight away, with
no restart and no environment variables to export.

To get one: create a **Desktop** app at
<https://www.thingiverse.com/apps/create> and copy the **App Token**.

Where it is stored depends on how you started the app, and the Settings panel shows
the exact path. A checkout keeps it in `server/.env`; an installed copy uses your
OS config directory (`~/.config/modelium-3d/` or `%APPDATA%\modelium-3d\`), since
`node_modules` is replaced on every upgrade; the container uses `/data`.

## Modes

`MODELIUM_MODE` decides who may change the settings, and it is the one setting
worth understanding before exposing this to a network.

| | `local` (default) | `server` |
| --- | --- | --- |
| Binds | `127.0.0.1` | `0.0.0.0` |
| Reading settings | yes | yes, without the file path or any part of the token |
| Writing settings | from this machine | environment variables only, plus one first-run window |

In `local` mode the settings panel may write your token because the request
provably came from this machine. That proof is the connection's own address,
which a reverse proxy on the same host turns into `127.0.0.1` for every caller on
earth. There is no heuristic that survives that, so the app refuses to start in
`local` mode on anything but a loopback address rather than pretending otherwise.
If something sits in front of it, use `server` mode.

**The first-run window.** A fresh `server` mode instance would otherwise be
impossible to configure through its own interface. So it opens once: for 15
minutes, it accepts a single save from whoever presents the claim token it printed
at startup.

```bash
docker logs modelium      # the token is in here, once
```

Paste it into the Settings panel, save, and the window closes for good. A marker
in `/data` keeps it closed across restarts. It also closes on the deadline, after
ten wrong tokens, or if the config directory is not writable (in which case it
never opens at all, and says so). The token is never written to disk, never
returned by any endpoint, and never logged twice.

That means anyone who can read the container's logs during those 15 minutes can
claim the instance. That is the operator, by definition, but it is worth knowing
rather than discovering. Set `MODELIUM_SETUP=false` to skip the window entirely
and configure only through the environment.

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
| Printables | `api.printables.com/graphql/`, field `searchPrints2` | No key, and no allowlist of permitted queries. Introspection is off, so the field names come from the site's own bundles rather than from the schema. Replaced an earlier approach that lifted the payload out of the rendered search page: 17 KB instead of 730, and no `Link` header large enough to need a Node startup flag. |
| MakerWorld | `api/v1/search-service/select/design2` | Public, no key. The older `select/design` still answers `200` but always with an empty list, which is worth knowing, because that failure looks exactly like "no results". |
| Thingiverse | `api.thingiverse.com` | Needs an app token, see above. |

Note what "no key" does not mean. PrusaSlicer and Prusa's firmware are open
source; printables.com is not, and neither of the first two endpoints is
documented or promised to anyone. They are the ones each site's own frontend
calls. That makes them cleaner to read than scraped markup, not more official,
which is what `npm run test:live` is for.

Printables renamed `club` to `premium` at some point before this was written.
Nothing announced it; the query simply started failing. That is the shape these
breakages take.

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
| `HOST` | loopback, or `0.0.0.0` in server mode | Bind address | no |
| `MODELIUM_MODE` | `local` | `local` or `server`, see [Modes](#modes) | no |
| `MODELIUM_CONFIG_DIR` | see above | Directory holding `.env` and the setup marker | no |
| `MODELIUM_ENV_FILE` | none | An explicit settings file, overriding the directory | no |
| `MODELIUM_SETUP` | `true` | Whether the first-run window may open at all | no |
| `MODELIUM_SETUP_WINDOW_MS` | `900000` | How long it stays open | no |
| `MODELIUM_RATE_LIMIT` | on in server mode | `off` disables it | no |
| `CACHE_TTL_MS` | `300000` | How long a search stays cached in memory | no |
| `CACHE_MAX_ENTRIES` | `200` | Cache size | no |
| `USER_AGENT` | a desktop Chrome string | Sent upstream | no |

`server/.env.example` documents the same list. Copy it into place if you prefer
editing a file to using the panel: the format is identical, and the app rewrites
keys in place, so your comments survive. The file is written atomically and set
to `0600`, and it is git-ignored.

## Security

Worth stating plainly, because this ships as a server:

- **There is no login.** `server` mode changes who may *write* settings, not who
  may search. Anyone who can reach the port can use it. Put it behind something
  if that matters.
- **Tokens do not leave the machine.** Reading settings reports whether a secret
  is set and its last four characters; in `server` mode not even that, nor the
  file's path.
- **The image proxy is not an open relay.** Seven CDN hosts are allowed, matched
  by exact hostname, and every redirect hop is re-checked against the same list:
  the allowlist is not just applied to the URL you hand it. What comes back is
  typed from its own first bytes rather than from the upstream's `Content-Type`,
  so a file uploaded as HTML or SVG cannot be served as script on this origin.
- **`X-Forwarded-For` is never read**, anywhere. It is set by whatever is in front
  of the server, which in the worst case is the caller.
- Every response carries a strict `Content-Security-Policy`, `nosniff`, and
  `frame-ancestors 'none'`. No CORS headers are sent, deliberately: another origin
  can cause a request but can never read the answer.

Found something? Open an issue, or, if it is sensitive, use GitHub's private
vulnerability reporting on this repository.

## API

The same endpoint serves scripts and the page:

```
GET  /api/search?q=voronoi+lamp                      → JSON
GET  /api/search?q=voronoi+lamp&stream=1             → Server Sent Events
GET  /api/search?q=…&sources=printables,makerworld   → subset of sites
GET  /api/search?q=…&sort=relevance|popular|newest
GET  /api/search?q=…&page=2                          → next page from every site
GET  /api/sources                                    → registry and setup state
GET  /api/health                                     → version, mode, setup state, sources
GET  /api/settings                                   → editable settings, secrets masked
PUT  /api/settings                                   → save settings (see Modes)
POST /api/settings/test?source=thingiverse           → try a credential, saved or not
POST /api/setup/finish                               → close the first-run window early
GET  /img?u=<image url>                              → image proxy, allowlisted hosts
```

Writes to `/api/settings` need an `X-Modelium-Settings: 1` header. That is the
CSRF control: another origin cannot set a custom header without a preflight, and
this server answers none.

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
rather than an obvious crash: the ranking and deduplication maths, both search
adapters, the MakerWorld "empty list, non-empty total" case, the `.env` reader
and writer, and the settings validation.

The security-relevant half is pinned separately, because those are the failures
that look like nothing at all until they matter: the image proxy's per-hop
allowlist and byte-level type detection, the settings guard's whole matrix
(loopback, DNS rebinding, spoofed `X-Forwarded-For`, missing CSRF header), and
the setup window's state machine, including that a wrong token of the wrong
length is refused rather than throwing.

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
  was blocked rather than reporting zero results. This is also the reason not to
  run this on a VPS: a datacentre address is what those filters are aimed at. A
  homelab keeps a residential one.
- Ranking is computed per page, so **Load more** appends a freshly fused page
  rather than re-ranking everything seen so far.
- Printables is always queried by best match and sorted locally, because rank
  fusion only works while all three lists mean the same thing by "first". Its API
  does offer `latest`, `popular` and `rating` if that changes.
- The cache is in memory, so restarting the server empties it.
- Two processes sharing one config directory would race on the settings file.
  Saves are serialized within a process; across processes they are not.
