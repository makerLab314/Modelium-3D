/**
 * Modelium 3D front end.
 *
 * The server streams the search over Server Sent Events, so the page is built
 * to grow: a source rail that reports live status, skeletons for the sites
 * that are still thinking, and a grid that is re-rendered every time a new
 * source lands and the merged ranking changes.
 */

import { createSettings } from "./settings.js";
import { NAVIGABLE, safeUrl } from "./url.js";

const el = {
  form: document.querySelector("[data-search-form]"),
  input: document.querySelector("[data-query-input]"),
  submit: document.querySelector("[data-submit]"),
  rail: document.querySelector("[data-source-rail]"),
  sort: document.querySelector("[data-sort]"),
  grid: document.querySelector("[data-grid]"),
  bar: document.querySelector("[data-results-bar]"),
  count: document.querySelector("[data-result-count]"),
  timing: document.querySelector("[data-result-timing]"),
  state: document.querySelector("[data-state]"),
  stateTitle: document.querySelector("[data-state-title]"),
  stateBody: document.querySelector("[data-state-body]"),
  recent: document.querySelector("[data-recent]"),
  recentItems: document.querySelector("[data-recent-items]"),
  colophon: document.querySelector("[data-colophon]"),
  themeToggle: document.querySelector("[data-theme-toggle]"),
  themeLabel: document.querySelector("[data-theme-label]"),
  setup: document.querySelector("[data-setup]"),
  setupTitle: document.querySelector("[data-setup-title]"),
  setupText: document.querySelector("[data-setup-text]"),
  setupDismiss: document.querySelector("[data-setup-dismiss]"),
  settingsBadge: document.querySelector("[data-settings-badge]"),
  more: document.querySelector("[data-more]"),
  moreButton: document.querySelector("[data-more-button]"),
  moreLabel: document.querySelector("[data-more-label]"),
};

const RECENT_KEY = "modelium.recent";
const SOURCES_KEY = "modelium.sources";
const THEME_KEY = "modelium.theme";
const SETUP_KEY = "modelium.setupDismissed";
const MAX_RECENT = 8;

const compact = new Intl.NumberFormat(undefined, { notation: "compact" });
const plain = new Intl.NumberFormat();

const state = {
  sources: [],
  enabled: new Set(),
  plates: new Map(),
  reports: new Map(),
  results: [],
  stream: null,
  query: "",
  page: 1,
  hasMore: false,
  health: null,
};

const settings = createSettings({ onSaved: onSettingsSaved });

init();

async function init() {
  syncThemeLabel();
  el.themeToggle.addEventListener("click", toggleTheme);
  el.form.addEventListener("submit", onSubmit);
  el.sort.addEventListener("change", () => {
    if (state.query) runSearch(state.query);
  });
  el.moreButton.addEventListener("click", loadMore);
  el.setupDismiss.addEventListener("click", () => {
    localStorage.setItem(SETUP_KEY, "1");
    el.setup.hidden = true;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey) return;
    if (document.activeElement?.matches("input, select, textarea")) return;
    event.preventDefault();
    el.input.focus();
    el.input.select();
  });

  await loadSources();
  renderRecent();
  restoreFromUrl();
}

/**
 * Saving a token can make a previously dead source live, so the rail is rebuilt
 * and the current search re-run rather than left showing the old failure.
 */
async function onSettingsSaved() {
  const enabledBefore = new Set(state.enabled);
  await loadSources();
  state.enabled = new Set([...enabledBefore].filter((id) => state.sources.some((s) => s.id === id)));
  if (!state.enabled.size) state.enabled = new Set(state.sources.map((source) => source.id));
  state.plates.forEach((plate, id) =>
    plate.button.setAttribute("aria-pressed", String(state.enabled.has(id))),
  );
  if (state.query) runSearch(state.query);
}

/* --- Sources ------------------------------------------------------------ */

async function loadSources() {
  try {
    const response = await fetch("/api/health");
    const payload = await response.json();
    state.health = payload;
    state.sources = payload.sources ?? [];
  } catch {
    state.health = null;
    state.sources = [];
  }

  renderSetup();

  const remembered = readJson(SOURCES_KEY);
  state.enabled = new Set(
    Array.isArray(remembered) && remembered.length
      ? remembered.filter((id) => state.sources.some((source) => source.id === id))
      : state.sources.map((source) => source.id),
  );
  if (!state.enabled.size) state.enabled = new Set(state.sources.map((s) => s.id));

  el.rail.replaceChildren(...state.sources.map(buildPlate));
  el.colophon.replaceChildren(...linkList(state.sources));
}

function buildPlate(source) {
  const button = element("button", {
    class: "plate",
    type: "button",
    "data-source": source.id,
    "data-status": "idle",
    "aria-pressed": String(state.enabled.has(source.id)),
    title: source.configured
      ? `Include ${source.label} in the search`
      : `${source.label} needs a token — add one under Settings`,
  });

  const dot = element("span", { class: "plate__dot" });
  const name = element("span", { class: "plate__name" }, source.label);
  const count = element("span", { class: "plate__count", "data-empty": "true" }, "0");
  button.append(dot, name, count);

  button.addEventListener("click", () => {
    const next = !state.enabled.has(source.id);
    if (!next && state.enabled.size === 1) return; // never leave zero sources selected
    if (next) state.enabled.add(source.id);
    else state.enabled.delete(source.id);
    button.setAttribute("aria-pressed", String(next));
    localStorage.setItem(SOURCES_KEY, JSON.stringify([...state.enabled]));
    if (state.query) runSearch(state.query);
  });

  state.plates.set(source.id, { button, count });
  return button;
}

function setPlate(sourceId, status, count) {
  const plate = state.plates.get(sourceId);
  if (!plate) return;
  plate.button.dataset.status = status;
  plate.count.textContent = count > 0 ? plain.format(count) : "0";
  plate.count.dataset.empty = String(!count);
}

/**
 * One thing can be wrong before a single search runs: a source has no token.
 * Searching still works, so this is dismissible.
 */
function renderSetup() {
  const unconfigured = state.sources.filter((source) => !source.configured);

  el.settingsBadge.hidden = !unconfigured.length;
  el.setupDismiss.hidden = false;

  if (!unconfigured.length || localStorage.getItem(SETUP_KEY) === "1") {
    el.setup.hidden = true;
    return;
  }

  const names = unconfigured.map((source) => source.label).join(" and ");
  el.setup.hidden = false;
  el.setup.dataset.tone = "info";
  el.setupTitle.textContent = `${names} still needs a token`;
  el.setupText.textContent =
    `Searching works without it — you just get results from the other ${
      state.sources.length - unconfigured.length === 1 ? "site" : "sites"
    }. ` + "The token is free and is stored on this machine only.";
}

function linkList(sources) {
  const nodes = [];
  sources.forEach((source, index) => {
    if (index) nodes.push(document.createTextNode("  ·  "));
    nodes.push(
      element(
        "a",
        { href: source.homepage, target: "_blank", rel: "noopener noreferrer" },
        source.label,
      ),
    );
  });
  return nodes;
}

/* --- Search ------------------------------------------------------------- */

function onSubmit(event) {
  event.preventDefault();
  const query = el.input.value.trim();
  if (!query) {
    el.input.focus();
    return;
  }
  rememberQuery(query);
  runSearch(query);
}

function runSearch(query, { page = 1 } = {}) {
  state.stream?.close();
  state.query = query;
  state.page = page;

  // A fresh search replaces everything; "Load more" keeps what is on screen and
  // appends the next page underneath it.
  const append = page > 1;
  const kept = append ? state.results : [];
  if (!append) {
    state.reports.clear();
    state.results = [];
    state.hasMore = false;
  }

  el.input.value = query;
  el.submit.disabled = true;
  el.moreButton.disabled = true;
  el.moreLabel.textContent = append ? "Loading…" : "Load more";
  writeUrl(query);

  const selected = [...state.enabled];
  selected.forEach((id) => setPlate(id, "loading", append ? state.reports.get(id)?.count ?? 0 : 0));
  state.sources
    .filter((source) => !state.enabled.has(source.id))
    .forEach((source) => setPlate(source.id, "idle", 0));

  if (!append) {
    showSkeletons(selected.length);
    hideState();
    el.bar.hidden = false;
    el.count.textContent = "Searching";
    el.timing.textContent = selected.map((id) => labelOf(id)).join(" · ");
  }

  const params = new URLSearchParams({
    q: query,
    sort: el.sort.value,
    sources: selected.join(","),
    page: String(page),
    stream: "1",
  });

  const stream = new EventSource(`/api/search?${params}`);
  state.stream = stream;

  stream.addEventListener("source", (event) => {
    const report = JSON.parse(event.data);
    state.reports.set(report.source, report);
    setPlate(report.source, report.status === "ok" ? "ok" : report.status, report.count ?? 0);
  });

  stream.addEventListener("results", (event) => {
    const payload = JSON.parse(event.data);
    state.hasMore = Boolean(payload.hasMore);
    state.results = append ? concatUnique(kept, payload.results ?? []) : (payload.results ?? []);
    render();
  });

  stream.addEventListener("done", (event) => {
    const { tookMs } = JSON.parse(event.data);
    stream.close();
    state.stream = null;
    el.submit.disabled = false;
    render();
    const answered = [...state.reports.values()].filter((report) => report.status === "ok");
    const allCached = answered.length > 0 && answered.every((report) => report.cached);
    el.timing.textContent = allCached ? "from cache" : `${(tookMs / 1000).toFixed(1)}s`;
  });

  stream.onerror = () => {
    stream.close();
    state.stream = null;
    el.submit.disabled = false;
    el.moreButton.disabled = false;
    el.moreLabel.textContent = "Load more";
    if (!state.results.length) {
      el.grid.replaceChildren();
      showState(
        "The search could not be completed",
        "The local server stopped answering. Check the terminal where you started it, then try again.",
      );
    }
  };
}

function loadMore() {
  if (!state.query || state.stream) return;
  runSearch(state.query, { page: state.page + 1 });
}

/** Later pages can repeat a hit the previous page already showed. */
function concatUnique(existing, incoming) {
  const seen = new Set(existing.map((item) => item.id));
  return [...existing, ...incoming.filter((item) => !seen.has(item.id))];
}

/* --- Rendering ---------------------------------------------------------- */

function render() {
  const notices = buildNotices();
  const cards = state.results.map((item, index) => buildCard(item, index + 1));

  el.grid.replaceChildren(...cards);
  el.bar.hidden = false;

  const done = !state.stream;
  const total = state.results.length;

  el.count.replaceChildren(
    element("strong", {}, plain.format(total)),
    document.createTextNode(total === 1 ? " model" : " models"),
    document.createTextNode(done ? "" : " so far"),
  );

  const container = el.grid.parentElement;
  container.querySelectorAll(".notice").forEach((node) => node.remove());
  notices.reverse().forEach((notice) => container.insertBefore(notice, el.grid));

  el.more.hidden = !(done && total > 0 && state.hasMore);
  el.moreButton.disabled = false;
  el.moreLabel.textContent = "Load more";

  if (done && !total) {
    const failed = [...state.reports.values()].filter((report) => report.status !== "ok");
    const answered = state.reports.size - failed.length;
    showState(
      answered ? "No models found" : "No site could be reached",
      answered
        ? `Nothing matched "${state.query}" on the ${answered === 1 ? "site that answered" : "sites that answered"}. Try a shorter or more common term.`
        : "Every selected source failed. The notices above say what each one reported.",
    );
  } else {
    hideState();
  }
}

function buildCard(item, index) {
  const card = element("a", {
    class: "card",
    href: item.url,
    target: "_blank",
    rel: "noopener noreferrer",
    "data-source": item.source,
  });

  const figure = element("figure", { class: "card__figure" });
  if (item.image?.thumb) {
    const img = element("img", {
      src: item.image.thumb,
      alt: item.title,
      loading: "lazy",
      decoding: "async",
    });
    img.addEventListener("load", () => img.classList.add("is-loaded"));
    img.addEventListener("error", () => img.remove());
    figure.append(img);
  }
  figure.append(
    element("span", { class: "card__tab" }, item.sourceLabel),
    element("span", { class: "card__index" }, String(index).padStart(2, "0")),
  );

  const body = element("div", { class: "card__body" });
  body.append(element("h3", { class: "card__title" }, item.title));

  if (item.author) {
    body.append(element("p", { class: "card__author" }, `by ${item.author}`));
  }

  if (item.alsoOn?.length) {
    const also = element("p", { class: "card__also" }, "");
    also.append(element("span", {}, "also on"));
    item.alsoOn.forEach((other) => {
      const link = element(
        "a",
        { href: other.url, target: "_blank", rel: "noopener noreferrer" },
        other.sourceLabel,
      );
      link.addEventListener("click", (event) => event.stopPropagation());
      also.append(link);
    });
    body.append(also);
  }

  const stats = buildStats(item);
  if (stats) body.append(stats);

  card.append(figure, body);
  return card;
}

const ICONS = {
  likes: "M10 16.5 4.2 11a3.6 3.6 0 0 1 5.1-5.1l.7.7.7-.7A3.6 3.6 0 0 1 15.8 11L10 16.5Z",
  downloads: "M10 3v9m0 0 3.4-3.4M10 12 6.6 8.6M4 15.5h12",
  rating: "m10 3 2.2 4.5 5 .7-3.6 3.5.9 4.9L10 14.3l-4.5 2.3.9-4.9L2.8 8.2l5-.7L10 3Z",
};

function buildStats(item) {
  const entries = [];
  if (item.stats?.likes) entries.push(["likes", compact.format(item.stats.likes), "likes"]);
  if (item.stats?.downloads) {
    entries.push(["downloads", compact.format(item.stats.downloads), "downloads"]);
  }
  if (item.stats?.rating) entries.push(["rating", item.stats.rating.toFixed(1), "rating"]);
  if (!entries.length) return null;

  const row = element("div", { class: "card__stats" });
  entries.slice(0, 3).forEach(([icon, value, title]) => {
    const stat = element("span", { class: "card__stat", title });
    stat.append(svgIcon(ICONS[icon]), document.createTextNode(value));
    row.append(stat);
  });
  return row;
}

const NOTICE_HEADS = {
  "needs-key": (label) => `${label} is not set up yet`,
  timeout: (label) => `${label} took too long`,
  blocked: (label) => `${label} turned us away`,
  misconfigured: (label) => `${label} cannot be queried by this server`,
};

function buildNotices() {
  return [...state.reports.values()]
    .filter((report) => report.status !== "ok")
    .map((report) => {
      const notice = element("div", { class: "notice", "data-kind": report.status });
      const head = NOTICE_HEADS[report.status] ?? ((label) => `${label} unavailable`);

      notice.append(
        element("span", { class: "notice__head" }, head(report.sourceLabel)),
        element("span", {}, report.message ?? "The site did not answer."),
      );

      // A missing token is the one failure the user can fix from here.
      if (report.status === "needs-key") {
        const action = element("button", { class: "notice__action", type: "button" }, "Open settings");
        action.addEventListener("click", () => settings.open());
        notice.append(action);
      } else if (report.docsUrl) {
        const line = element("span", {});
        line.append(
          document.createTextNode("More at "),
          element(
            "a",
            { href: report.docsUrl, target: "_blank", rel: "noopener noreferrer" },
            report.docsUrl,
          ),
        );
        notice.append(line);
      }

      return notice;
    });
}

function showSkeletons(sourceCount) {
  const cards = Array.from({ length: Math.min(12, sourceCount * 4) }, () => {
    const skeleton = element("div", { class: "skeleton" });
    skeleton.append(
      element("div", { class: "skeleton__figure" }),
      element("div", { class: "skeleton__line" }),
      element("div", { class: "skeleton__line skeleton__line--short" }),
    );
    return skeleton;
  });
  el.grid.replaceChildren(...cards);
  el.grid.parentElement.querySelectorAll(".notice").forEach((node) => node.remove());
  el.more.hidden = true;
}

function showState(title, body) {
  el.stateTitle.textContent = title;
  el.stateBody.textContent = body;
  el.state.hidden = false;
}

function hideState() {
  el.state.hidden = true;
}

/* --- Recent searches, URL and theme ------------------------------------- */

function rememberQuery(query) {
  const previous = readJson(RECENT_KEY) ?? [];
  const next = [query, ...previous.filter((entry) => entry !== query)].slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  renderRecent();
}

function renderRecent() {
  const entries = readJson(RECENT_KEY) ?? [];
  el.recent.hidden = entries.length === 0;
  el.recentItems.replaceChildren(
    ...entries.map((entry) => {
      const chip = element("button", { class: "chip", type: "button" }, entry);
      chip.addEventListener("click", () => {
        el.input.value = entry;
        rememberQuery(entry);
        runSearch(entry);
      });
      return chip;
    }),
  );
}

function writeUrl(query) {
  const params = new URLSearchParams({ q: query, sort: el.sort.value });
  if (state.enabled.size !== state.sources.length) {
    params.set("sources", [...state.enabled].join(","));
  }
  history.replaceState(null, "", `?${params}`);
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  const query = params.get("q")?.trim();
  const sort = params.get("sort");
  if (sort && [...el.sort.options].some((option) => option.value === sort)) {
    el.sort.value = sort;
  }

  const wanted = (params.get("sources") ?? "")
    .split(",")
    .filter((id) => state.sources.some((source) => source.id === id));
  if (wanted.length) {
    state.enabled = new Set(wanted);
    state.plates.forEach((plate, id) =>
      plate.button.setAttribute("aria-pressed", String(state.enabled.has(id))),
    );
  }

  if (query) {
    el.input.value = query;
    runSearch(query);
  } else {
    el.input.focus();
  }
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  syncThemeLabel();
}

function syncThemeLabel() {
  el.themeLabel.textContent =
    document.documentElement.dataset.theme === "dark" ? "Dark" : "Light";
}

/* --- Small helpers ------------------------------------------------------ */

function element(tag, attributes = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;

    // Anything the browser would navigate to is checked here rather than at each
    // call site, because the URLs come from three remote APIs and only one of
    // them is built by us.
    if (NAVIGABLE.has(key)) {
      const safe = safeUrl(value);
      if (safe) node.setAttribute(key, safe);
      continue;
    }

    node.setAttribute(key, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgIcon(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

function labelOf(sourceId) {
  return state.sources.find((source) => source.id === sourceId)?.label ?? sourceId;
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
