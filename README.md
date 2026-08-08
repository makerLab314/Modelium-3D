# Modelium 3D

[![npm](https://img.shields.io/npm/v/modelium-3d?color=%23cb3837&label=npm)](https://www.npmjs.com/package/modelium-3d)
[![CI](https://github.com/makerLab314/Modelium-3D/actions/workflows/ci.yml/badge.svg)](https://github.com/makerLab314/Modelium-3D/actions/workflows/ci.yml)
[![Container](https://img.shields.io/badge/ghcr.io-modelium--3d-blue)](https://github.com/makerLab314/Modelium-3D/pkgs/container/modelium-3d)
[![License](https://img.shields.io/badge/license-GPL--3.0-green)](LICENSE)

One search field for three 3D model libraries: **Printables**, **MakerWorld** and
**Thingiverse**. Type once, get one merged and ranked list of results, each with
a picture. Clicking a result opens the original listing on the original site,
where the download lives. Modelium never hosts or mirrors model files.

This is a local web app. It ships with a small Node server because the three
sites cannot be queried from a browser directly (no CORS headers, one of them
needs an API token), and because the merging and ranking belong on one side of
the wire, not spread across three fetches in the page.

```bash
npx modelium-3d
```

That is the whole quick start. Everything below is detail.

**Contents** · [Install](#install) · [First run](#first-run) ·
[Modes](#modes) · [Configuration](#configuration) · [Security](#security) ·
[How it works](#how-it-works) · [API](#api) · [Interface](#interface) ·
[Development](#development) · [Limits](#limits)

## Install

Six ways in. They all run the same code and differ in exactly two things: where
the settings file ends up, and whether the settings panel is allowed to write to
it. Pick by row.

| Method | Best for | Settings live in | Needs |
| --- | --- | --- | --- |
| [`npx`](#npx) | Trying it, once | OS config directory | Node ≥ 20.11 |
| [npm, global](#npm-global-install) | Using it on your own machine | OS config directory | Node ≥ 20.11 |
| [Docker](#docker) | A homelab box, always on | `/data` in a volume | Docker |
| [Home Assistant](#home-assistant) | An existing HA box, configured from its own UI | the add-on's `/data` | HA OS or Supervised |
| [From source](#from-source) | Changing the code | `server/.env` | Node ≥ 20.11, git |
| [Release tarball](#release-tarball) | No git, no registries | `server/.env` | Node ≥ 20.11 |

There are no dependencies to install in any of them. The `node_modules` folder
stays empty on purpose — the server is written against Node's standard library
alone, so `npm install` has nothing to fetch and nothing to audit.

### npx

```bash
npx modelium-3d
```

Opens a browser at <http://127.0.0.1:8787>. Nothing to clone, nothing left
behind but npm's own cache.

Your Thingiverse token is *not* part of that cache: it goes into your OS config
directory, so it survives both the cache being cleared and the next `npx` pulling
a newer version. Configure once, `npx` forever.

### npm, global install

```bash
npm install -g modelium-3d
modelium-3d
```

Same thing without the startup delay, and `modelium-3d` is on your `PATH`.

```bash
npm update -g modelium-3d      # upgrade
npm uninstall -g modelium-3d   # remove; the config directory stays
```

An upgrade replaces `node_modules/modelium-3d/` wholesale, which is precisely why
the settings do not live there. See [Where the token is stored](#where-the-token-is-stored).

### Docker

The image is published on every release and is public — no login, no checkout:

```bash
docker run -d --name modelium -p 127.0.0.1:8787:8787 -v modelium-data:/data ghcr.io/makerlab314/modelium-3d:latest
```

Tags are `latest` and one per release (`v0.5.1`). Pin the version if you would
rather decide when to upgrade.

The container runs in **server mode**: it binds every interface *inside* the
container, and its settings are read-only, configured through environment
variables — a panel that can rewrite an API token should not be something anyone
on the network can reach. [Modes](#modes) covers the one exception, which is how
the Thingiverse token gets in on the first run.

Note the `127.0.0.1:` in front of the port. Widen it deliberately: there is no
login, so on a flat home network `-p 8787:8787` means everyone on it.

For Compose, this is enough — save it as `docker-compose.yml` anywhere:

```yaml
services:
  modelium:
    image: ghcr.io/makerlab314/modelium-3d:latest
    container_name: modelium
    ports:
      - "127.0.0.1:8787:8787"
    volumes:
      - modelium-data:/data
    restart: unless-stopped
    init: true
    read_only: true
    tmpfs: [/tmp]
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]

volumes:
  modelium-data:
```

```bash
docker compose up -d
```

The `docker-compose.yml` **in this repository** is not that file: it also carries
`build: .`, so it compiles the image from the checkout instead of pulling it.
That is what you want when you are working on the code, and not what you want on
a server.

The volume holds `.env` and the setup marker. A named volume like the one above
is owned correctly out of the box; a bind mount needs `chown -R 1000:1000` first,
and the app will tell you so rather than failing quietly.

### Home Assistant

There is an add-on, in [`homeassistant/`](homeassistant/). Add this repository
under **Settings ▸ Add-ons ▸ Add-on Store ▸ ⋮ ▸ Repositories**:

```
https://github.com/makerLab314/Modelium-3D
```

Then install **Modelium 3D**, fill in the options, and start it. It listens on
port 8787 of the Home Assistant host, so every device on the network can reach
it — that is the point of running it there rather than on a laptop.

Home Assistant's options form replaces the Settings panel, which stays read-only
because the add-on runs in [`server` mode](#modes). The first-run window is
disabled outright: it exists so a container with no configuration interface can
still be given a token once, and here the configuration interface is the thing
installing it.

The add-on deliberately does **not** use ingress, so it is reachable directly
instead of only through the Home Assistant frontend. That is the trade-off you
are choosing: no Home Assistant login in front of it. [DOCS.md](homeassistant/DOCS.md)
spells out what that means.

### From source

```bash
git clone https://github.com/makerLab314/Modelium-3D
cd Modelium-3D
npm start
```

A checkout keeps its settings in `server/.env`, next to the code, which is where
they have always been. `npm run dev` is the same thing with `--watch`.

### Release tarball

Every [release](https://github.com/makerLab314/Modelium-3D/releases) carries a
plain `.tgz` of the same files — no git history, no tests, no CI config:

```bash
tar -xzf modelium-3d-0.5.1.tgz && cd package && node server/index.js
```

### Command line options

The `modelium-3d` command takes a few flags, which beat both the settings file
and the environment:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port <n>` | `8787` | Port to listen on |
| `--host <addr>` | `127.0.0.1` | Address to bind |
| `--mode <name>` | `local` | `local` or `server`, see [Modes](#modes) |
| `--config <dir>` | see below | Directory holding the `.env` file |
| `--no-open` | — | Do not open a browser |
| `--version` | — | Print the version and exit |
| `--help` | — | Print the options and exit |

```bash
npx modelium-3d --port 9000 --no-open
```

Starting from a checkout with `npm start` runs `server/index.js` directly and
takes no flags — use environment variables there.

## First run

Two of the three sources work immediately. Thingiverse rejects unauthenticated
API calls, so it needs a token. It is free:

1. Create a **Desktop** app at <https://www.thingiverse.com/apps/create>.
2. Copy the **App Token**.
3. In Modelium, click **Settings**, paste it, press **Test** to confirm it
   actually works, then **Save**.

It is picked up straight away — no restart, no environment variables to export.
Until then Thingiverse shows as unconfigured and the other two sources carry the
search.

In `server` mode the panel is read-only, so this flow works differently there:
see [the first-run window](#the-first-run-window).

### Where the token is stored

The settings panel always shows the exact path it is using. In order of
precedence:

| Condition | Path |
| --- | --- |
| `MODELIUM_ENV_FILE` set | that file |
| `MODELIUM_CONFIG_DIR` set | `<dir>/.env` — the container points this at `/data` |
| Running from a checkout | `server/.env` |
| Installed (npx or npm) | `~/.config/modelium-3d/.env`, or `%APPDATA%\modelium-3d\.env` |

The last two are the packaging half. An installed copy sits inside
`node_modules/`, which npm replaces wholesale on every upgrade and which may not
even be writable — a token saved there would quietly vanish. A checkout keeps the
behaviour it has always had.

The file is written atomically, set to `0600`, and git-ignored. The app rewrites
keys in place, so any comments you add survive.

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

### The first-run window

A fresh `server` mode instance would otherwise be impossible to configure through
its own interface. So it opens once: for 15 minutes, it accepts a single save
from whoever presents the claim token it printed at startup.

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
and configure only through the environment:

```bash
docker run -d --name modelium -p 127.0.0.1:8787:8787 \
  -e THINGIVERSE_TOKEN=… -e MODELIUM_SETUP=false \
  -v modelium-data:/data ghcr.io/makerlab314/modelium-3d:latest
```

## Configuration

Everything is optional and has a working default. The common settings are in the
**Settings** panel; all of them can also be set in the `.env` file or as real
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
editing a file to using the panel — the format is identical.

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
| Thingiverse | `api.thingiverse.com` | Needs an app token, see [First run](#first-run). |

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

## Development

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
three sites for real and asserts they still return the fields the adapters read
— not which models come back, or how many. All three have broken silently
before, which is the failure this is built to catch.

GitHub Actions runs it daily (`.github/workflows/ci.yml`). It needs no secrets:
the Thingiverse checks skip themselves when `THINGIVERSE_TOKEN` is unset, and
add the token as a repository secret of that name if you want them to run. On
pull requests the job is `continue-on-error`, because a site being down is not a
reason to block a merge.

```bash
npm run pack:check
```

Asserts what `npm publish` would actually upload, because shipping a `.env` with
a live token in it cannot be undone once it reaches the registry.

### Releasing

Bump the version in `package.json`, then tag it:

```bash
git tag v0.5.1 && git push --tags
```

`.github/workflows/release.yml` takes it from there: it checks the tag against
`package.json`, runs the tests and the package check, attaches a tarball to the
GitHub release, pushes the container image, and publishes to npm. There is no
`NPM_TOKEN` — npm authenticates through OIDC, minted per run and valid for
nothing else.

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

## License

[GPL-3.0](LICENSE).
