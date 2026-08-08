# Changelog

The add-on version tracks the Modelium release it installs, so the notes below
cover only what changed about the add-on itself. Application changes are in the
[project releases](https://github.com/makerLab314/Modelium-3D/releases).

## 0.5.1

- First add-on release. Runs the server on port 8787, reachable from the whole
  network.
- Options for the Thingiverse token, per-source limit, timeout, NSFW filtering
  and image proxying.
- Watchdog on `/api/health`, so the Supervisor restarts it if it stops answering.
