import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The one-time claim window that lets a freshly started server be configured
 * over the network, without leaving that door open afterwards.
 *
 * In `server` mode the settings file is read-only: it holds an API token, and a
 * panel that can rewrite it is a remote control that no loopback heuristic can
 * defend once a reverse proxy is in front of it. But a container that can never
 * be configured through its own interface is a bad first run, so the window
 * exists — bounded three ways at once:
 *
 *   - it needs a claim token that is printed to stdout and nowhere else,
 *   - it closes for good on the first successful save,
 *   - it closes on a deadline regardless.
 *
 * The claim token is what makes this safe rather than a race. Without it the
 * window belongs to whoever polls the port first; with it, authorisation means
 * "can read the server's own log output", which is the operator by definition.
 */

export const STATES = Object.freeze({
  /** `local` mode — the loopback guard decides instead. */
  NOT_APPLICABLE: 'n/a',
  /** Turned off, or nowhere to persist a marker. Settings stay read-only. */
  DISABLED: 'disabled',
  /** Accepting one save from a caller holding the token. */
  OPEN: 'open',
  /** Deadline passed without a save. A restart legitimately reopens it. */
  EXPIRED: 'expired',
  /** Configured once already. Only a deleted marker file reopens this. */
  SEALED: 'sealed',
});

export const MARKER_NAME = '.modelium-setup-complete';

/** Enough that a fumbled paste is survivable, few enough to be no attack surface. */
const MAX_ATTEMPTS = 10;

/**
 * Compare in constant time without leaking the length.
 *
 * `timingSafeEqual` throws when the two buffers differ in size, which would be
 * both a crash and an oracle for the token's length. Hashing first makes every
 * comparison 32 bytes against 32 bytes.
 */
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

function directoryIsWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ mode: string, enabled?: boolean, windowMs?: number, envPath: string,
 *           now?: () => number }} options
 */
export function createSetupWindow({
  mode,
  enabled = true,
  windowMs = 15 * 60 * 1000,
  envPath,
  now = Date.now,
}) {
  const directory = path.dirname(envPath);
  const markerPath = path.join(directory, MARKER_NAME);

  let token = null;
  let deadline = 0;
  let attempts = 0;
  let state;

  if (mode !== 'server') {
    state = STATES.NOT_APPLICABLE;
  } else if (!enabled) {
    state = STATES.DISABLED;
  } else if (fs.existsSync(markerPath)) {
    state = STATES.SEALED;
  } else if (!directoryIsWritable(directory)) {
    // Nothing could be saved even if the window were open, and finding that out
    // *after* pasting a token is a worse first run than being told up front.
    state = STATES.DISABLED;
  } else {
    state = STATES.OPEN;
    token = crypto.randomBytes(32).toString('base64url');
    deadline = now() + windowMs;
  }

  /** Re-checked on every request, not only on a timer, so a suspended process cannot extend it. */
  function current() {
    if (state === STATES.OPEN && now() > deadline) {
      state = STATES.EXPIRED;
      token = null;
    }
    return state;
  }

  return {
    get state() {
      return current();
    },

    /** The token, for the startup banner. Returns null once it must not be shown again. */
    claimToken() {
      return current() === STATES.OPEN ? token : null;
    },

    /**
     * May this request write settings?
     * @returns {string|null} the reason it may not, or null when it may
     */
    authorize(req) {
      const now = current();

      if (now === STATES.NOT_APPLICABLE) return null;
      if (now === STATES.SEALED) {
        return 'Settings are read-only. Configure this server with environment variables.';
      }
      if (now === STATES.DISABLED) {
        return 'Settings are read-only in server mode. Configure with environment variables.';
      }
      if (now === STATES.EXPIRED) {
        return 'The setup window has closed. Restart the server to open it again.';
      }

      const offered = req.headers?.['x-modelium-setup-token'];
      if (sameToken(offered, token)) return null;

      attempts += 1;
      if (attempts >= MAX_ATTEMPTS) {
        state = STATES.SEALED;
        token = null;
        console.error('[setup] too many bad setup tokens — window closed for this process');
        return 'The setup window has closed after too many failed attempts.';
      }

      return 'Missing or invalid setup token. It is printed in the server log at startup.';
    },

    /**
     * Close the window for good. Called after a save actually succeeded — never
     * after a rejected value, or a typo would burn the one chance.
     */
    seal() {
      if (current() === STATES.NOT_APPLICABLE) return;

      state = STATES.SEALED;
      token = null;

      try {
        fs.writeFileSync(
          markerPath,
          `${JSON.stringify({ completedAt: new Date(now()).toISOString() }, null, 2)}\n`,
          { encoding: 'utf8', mode: 0o600 },
        );
      } catch (error) {
        // The process is sealed either way; it is only the persistence that
        // failed, so say what that means rather than pretending it worked.
        console.warn(
          `[setup] could not write ${markerPath} (${error.code ?? error.message}). ` +
            'The window is closed for this process but will reopen on restart. ' +
            'Set MODELIUM_SETUP=false to keep it closed.',
        );
      }
    },
  };
}
