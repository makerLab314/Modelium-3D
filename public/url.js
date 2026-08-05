/**
 * Every URL rendered by this app comes from somewhere else: model links and
 * author pages are whatever the three sites put in their responses. Thingiverse
 * hands back `public_url` verbatim, so a `javascript:` value would run on click
 * — same origin as the settings panel.
 *
 * Setting an attribute is not enough to trigger that; navigating to it is. This
 * is the one gate both `element()` and `node()` route href and src through.
 */
export function safeUrl(value) {
  if (typeof value !== "string" || !value) return null;

  try {
    const url = new URL(value, location.href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Attributes whose value the browser will follow. */
export const NAVIGABLE = new Set(["href", "src", "action", "formaction", "poster"]);
