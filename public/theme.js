// Set the scheme before first paint so the page never flashes the wrong one.
//
// This lives in its own file rather than inline in the document so the server
// can send a Content-Security-Policy with a plain `script-src 'self'` — no
// nonce, no hash to keep in sync with the markup.
const stored = localStorage.getItem("modelium.theme");
const preferred = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
document.documentElement.dataset.theme = stored || preferred;
