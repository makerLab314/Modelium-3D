# Modelium 3D

One search field for **Printables**, **MakerWorld** and **Thingiverse**. Type
once, get one merged and ranked list. Clicking a result opens the original
listing on the original site, where the download lives — Modelium never hosts or
mirrors model files.

## Installation

1. **Settings ▸ Add-ons ▸ Add-on Store ▸ ⋮ ▸ Repositories**, add
   `https://github.com/makerLab314/Modelium-3D`.
2. Install **Modelium 3D** from the store. The Supervisor builds it on your Home
   Assistant machine; it is one small npm package with no dependencies, so this
   is quick even on a Raspberry Pi.
3. Start it, then open `http://<your-home-assistant>:8787` from any device on
   your network.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `thingiverse_token` | empty | Enables the Thingiverse source |
| `per_source_limit` | `36` | Results requested per site, per page |
| `source_timeout_ms` | `12000` | Give up on a site after this long |
| `hide_nsfw` | `true` | Drop models a site flagged as not safe for work |
| `proxy_images` | `true` | Serve result images through the add-on |

Options take effect on restart.

Printables and MakerWorld work immediately. Thingiverse rejects unauthenticated
API calls, so it needs a token, which is free: create a **Desktop** app at
<https://www.thingiverse.com/apps/create>, copy the **App Token**, and paste it
into `thingiverse_token` above. Until then Thingiverse shows as unconfigured and
the other two sources carry the search.

The Settings panel inside the app is **read-only** here, and shows what is
configured rather than letting you change it. That is deliberate: the add-on runs
in server mode, where configuration comes from the environment, and Home
Assistant's own options form is that environment. Everything is set on this page.

## Before you expose it

**There is no login.** Anyone who can reach port 8787 can search with it. On a
normal home network that is every device on the network, which is usually the
point — but it is worth knowing rather than discovering.

The add-on reaches the network directly rather than through Home Assistant's
ingress, which is what makes it usable from a phone, a tablet or a second
computer without going through the Home Assistant app. The trade-off is that
Home Assistant's authentication is not in front of it. Do not port-forward it to
the internet.

What is *not* exposed: the Thingiverse token. In server mode, reading the
settings returns neither the token nor any part of it, nor the path of the file
holding it.

## Notes

- Configuration lives in the add-on's `/data`, and is backed up with Home
  Assistant's own backups.
- The add-on drops to an unprivileged user before the server starts. It is root
  only for as long as it takes to make `/data` writable.
- MakerWorld sits behind a bot filter that reacts to the calling network. When it
  answers with an empty list next to a non-zero total, the interface says the
  source was blocked rather than reporting zero results.
- The three upstream endpoints are unofficial and can change without notice. If
  one breaks, the other two keep working and the interface says which is down.

Full documentation, including the API and how the ranking works, is in the
[project README](https://github.com/makerLab314/Modelium-3D#readme).
