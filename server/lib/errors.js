/**
 * Typed errors so the aggregator can tell the UI *why* a source is missing
 * instead of collapsing everything into a generic failure.
 */

export class SourceError extends Error {
  /**
   * @param {string} message human readable, shown in the UI
   * @param {'unavailable'|'needs-key'|'timeout'|'blocked'} kind
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
