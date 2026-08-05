import { config } from './config.js';
import { createApp } from './app.js';
import { ENV_PATH } from './lib/env.js';
import { createSetupWindow, STATES } from './lib/setupWindow.js';
import { describeSources } from './sources/index.js';

/**
 * Refuse to run `local` mode on a non-loopback address.
 *
 * In `local` mode the settings panel may rewrite the token file because the
 * request provably came from this machine. That proof rests on the socket's peer
 * address — which a reverse proxy on the same host makes `127.0.0.1` for every
 * caller on earth. No heuristic recovers from that, so instead of guarding the
 * situation we make it unreachable: binding wider than loopback requires saying
 * `MODELIUM_MODE=server`, where settings are read-only to begin with.
 *
 * Fronting a loopback-bound server with nginx is the same hazard by another
 * route, which is why the message names it.
 */
function assertBindIsSafe() {
  if (config.mode === 'server') return;

  const loopback = ['127.0.0.1', '::1', 'localhost'];
  if (loopback.includes(config.host)) return;

  console.error(
    `\n  Refusing to start.\n\n` +
      `  HOST is ${config.host}, but the mode is "local", which lets the settings\n` +
      `  panel write the file holding your API token and trusts the connection's\n` +
      `  own address to decide who may do that. That check cannot survive being\n` +
      `  reachable from elsewhere — and it cannot survive a reverse proxy either,\n` +
      `  which makes every request look like it came from this machine.\n\n` +
      `  To share this server, run it in server mode:\n\n` +
      `      MODELIUM_MODE=server HOST=${config.host} npm start\n\n` +
      `  Settings are then read-only, configured with environment variables, with\n` +
      `  one setup window on first run.\n`,
  );
  process.exit(1);
}

assertBindIsSafe();

const setup = createSetupWindow({
  mode: config.mode,
  enabled: config.setupEnabled,
  windowMs: config.setupWindowMs,
  envPath: ENV_PATH,
});

const server = createApp({ setupWindow: setup });

/**
 * Slowloris budgets. `requestTimeout` bounds how long a *request* may take to
 * arrive, not how long a response may stream, so a long-lived SSE search is
 * unaffected.
 *
 * There is deliberately no `maxConnections`: it drops connections at the TCP
 * layer with no answer at all, and a grid of proxied thumbnails routinely opens
 * six per browser. The rate limiter is the control that belongs here.
 */
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 10_000;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Port ${config.port} is already in use. Either stop the other process or start with a different port:\n` +
        `  PORT=8788 npm start`,
    );
    process.exit(1);
  }
  if (error.code === 'EACCES') {
    console.error(`Not allowed to bind ${config.host}:${config.port}. Try a port above 1024.`);
    process.exit(1);
  }
  throw error;
});

server.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`\n  Modelium 3D  ·  http://${shown}:${config.port}  ·  ${config.mode} mode\n`);

  announceSetup();

  const missing = describeSources().filter((source) => !source.configured);
  if (missing.length) {
    console.log(
      `  ${missing.map((source) => source.label).join(', ')} needs a token — add it under Settings in the app.\n`,
    );
  }
});

/**
 * The one place the claim token is ever shown. It is not written to the settings
 * file, never returned by an endpoint and never logged again, so whoever can
 * read this output is the one who can configure the instance.
 */
function announceSetup() {
  if (config.mode !== 'server') return;

  const token = setup.claimToken();
  if (token) {
    const minutes = Math.round(config.setupWindowMs / 60_000);
    console.log(
      `  First run. Settings can be saved once, within ${minutes} minutes, using:\n\n` +
        `      ${token}\n\n` +
        `  Open the app, click Settings and paste it there. The window closes for\n` +
        `  good after the first successful save.\n`,
    );
    return;
  }

  const reason = {
    [STATES.SEALED]: 'already configured',
    [STATES.DISABLED]: 'disabled or no writable config directory',
    [STATES.EXPIRED]: 'window expired',
  }[setup.state];

  console.log(`  Settings are read-only (${reason}). Configure with environment variables.\n`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Do not let a held-open SSE stream block the exit.
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
