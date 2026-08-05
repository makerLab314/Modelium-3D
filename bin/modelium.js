#!/usr/bin/env node

/**
 * The command line front door, so `npx modelium-3d` works without a checkout.
 *
 * Everything it does is translate flags into environment variables *before*
 * importing the server, because config.js reads the environment at import time
 * and lib/env.js only fills variables that are still empty — so a flag beats
 * the settings file, which is what someone typing `--port` expects.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const HELP = `
  modelium-3d — one search box for Printables, MakerWorld and Thingiverse

  Usage
    modelium-3d [options]

  Options
    --port <n>        Port to listen on                  (default 8787)
    --host <addr>     Address to bind                    (default 127.0.0.1)
    --mode <name>     local | server                     (default local)
    --config <dir>    Directory holding the .env file
    --no-open         Do not open a browser
    --version         Print the version and exit
    --help            Print this and exit

  Modes
    local   Binds loopback. The settings panel can save your API token,
            because the request provably came from this machine.
    server  For a shared instance or a container. Settings are read-only and
            come from environment variables, with one setup window on first run.

  Examples
    modelium-3d --port 9000
    MODELIUM_MODE=server HOST=0.0.0.0 modelium-3d
`;

const FLAGS = {
  '--port': 'PORT',
  '--host': 'HOST',
  '--mode': 'MODELIUM_MODE',
  '--config': 'MODELIUM_CONFIG_DIR',
};

function parse(argv) {
  const options = { open: true };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];

    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--version' || flag === '-v') return { version: true };
    if (flag === '--no-open') {
      options.open = false;
      continue;
    }

    const variable = FLAGS[flag];
    if (!variable) return { error: `Unknown option ${flag}` };

    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) {
      return { error: `${flag} needs a value` };
    }
    process.env[variable] = value;
  }

  return options;
}

const options = parse(process.argv.slice(2));

if (options.error) {
  console.error(`${options.error}\nRun with --help to see the options.`);
  process.exit(1);
}
if (options.help) {
  console.log(HELP);
  process.exit(0);
}
if (options.version) {
  console.log(createRequire(import.meta.url)('../package.json').version);
  process.exit(0);
}

const { config } = await import('../server/config.js');

if (options.open && config.mode === 'local' && shouldOpen()) {
  // After the listen callback has had a chance to run, so a failure to bind
  // does not leave a browser tab pointed at nothing.
  setTimeout(() => openBrowser(`http://${config.host}:${config.port}`), 400).unref();
}

await import('../server/index.js');

/** Only when there is a person at a terminal to see it. */
function shouldOpen() {
  return Boolean(process.stdout.isTTY) && !process.env.CI && !process.env.SSH_CONNECTION;
}

/**
 * No shell anywhere: `cmd /c start` would interpret `&` in the URL, which is a
 * command injection surface for no benefit. These three take the URL as an
 * argument instead.
 */
function openBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Headless, no desktop, no handler — the URL is in the banner anyway.
  }
}
