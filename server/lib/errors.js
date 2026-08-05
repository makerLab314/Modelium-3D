/**
 * Typed errors so the aggregator can tell the UI *why* a source is missing
 * instead of collapsing everything into a generic failure.
 */

export class SourceError extends Error {
  /**
   * @param {string} message human readable, shown in the UI
   * @param {'unavailable'|'needs-key'|'timeout'|'blocked'|'misconfigured'} kind
   */
  constructor(message, kind = 'unavailable') {
    super(message);
    this.name = 'SourceError';
    this.kind = kind;
  }
}

export class MissingCredentialsError extends SourceError {
  constructor(message, docsUrl) {
    super(message, 'needs-key');
    this.name = 'MissingCredentialsError';
    this.docsUrl = docsUrl;
  }
}

/**
 * An HTTP failure whose message is safe to show the caller.
 *
 * `expose` is the whole point: anything *without* it is answered with a generic
 * message, because the alternative is what the catch-all used to do — hand back
 * `error.message` verbatim, which for a filesystem error means posting an
 * absolute path to whoever asked.
 */
export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.expose = true;
  }
}

export const badRequest = (message) => new HttpError(400, message);
export const forbidden = (message) => new HttpError(403, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const tooManyRequests = (message) => new HttpError(429, message);
