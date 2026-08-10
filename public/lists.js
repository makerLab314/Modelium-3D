/**
 * Watchlists.
 *
 * Deliberately local. This app has no accounts and the server keeps no state
 * beyond `server/.env`, so a list lives in this browser's localStorage and
 * nowhere else — nothing is sent anywhere when you save a model. That is also
 * the limitation: lists do not follow you to another browser, which is what the
 * export and import buttons are for.
 *
 * Each entry stores the whole card rather than a reference to it, because the
 * only way to resolve a reference would be to search all three sites again for
 * a model that may since have been taken down.
 */

import { NAVIGABLE, safeUrl } from "./url.js";

const KEY = "modelium.lists";
const VERSION = 1;

/**
 * localStorage is a handful of megabytes shared with everything else on this
 * origin, and a saved entry is roughly 300 bytes. These caps sit far below that
 * while being past any plausible use, so a write can fail on a full disk but
 * never because the feature ran away with itself.
 */
const MAX_LISTS = 24;
const MAX_ITEMS = 500;
const MAX_NAME = 60;

export function createLists({ onChange } = {}) {
  const dialog = document.querySelector("[data-lists-dialog]");
  const body = document.querySelector("[data-lists-body]");
  const rail = document.querySelector("[data-lists-rail]");
  const title = document.querySelector("[data-lists-title]");
  const status = document.querySelector("[data-lists-status]");
  const importInput = document.querySelector("[data-lists-import-input]");
  const promptForm = document.querySelector("[data-lists-prompt]");
  const promptInput = document.querySelector("[data-lists-input]");
  const renameButton = document.querySelector("[data-lists-rename]");
  const deleteButton = document.querySelector("[data-lists-delete]");

  let state = load();
  /** null, "create" or "rename" — which question the inline row is asking. */
  let asking = null;

  document.querySelectorAll("[data-lists-open]").forEach((button) => {
    button.addEventListener("click", open);
  });
  document.querySelectorAll("[data-lists-close]").forEach((button) => {
    button.addEventListener("click", () => dialog.close());
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => ask(null));

  document.querySelector("[data-lists-new]").addEventListener("click", () => ask("create"));
  renameButton.addEventListener("click", () => ask("rename"));
  deleteButton.addEventListener("click", deleteActive);
  document.querySelector("[data-lists-cancel]").addEventListener("click", () => ask(null));
  promptForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitPrompt();
  });

  document.querySelector("[data-lists-export]").addEventListener("click", exportAll);
  document.querySelector("[data-lists-import]").addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", importFile);

  /**
   * Another tab of the same app is the same lists. Without this, saving there
   * and switching back here shows a stale set and the next write here silently
   * overwrites it.
   */
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    state = load();
    if (dialog.open) render();
    onChange?.();
  });

  /* --- storage ---------------------------------------------------------- */

  function blank() {
    const first = { id: makeId(), name: "Saved", items: [] };
    return { version: VERSION, activeId: first.id, lists: [first] };
  }

  function load() {
    let raw;
    try {
      raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    } catch {
      raw = null;
    }
    return sanitize(raw) ?? blank();
  }

  /**
   * Everything here came out of storage, which another script on this origin —
   * or a hand-edited import — could have written. Nothing is trusted: unknown
   * shapes are dropped rather than repaired, so a corrupt entry costs one saved
   * model instead of breaking the panel.
   */
  function sanitize(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.lists)) return null;

    const lists = raw.lists
      .filter((list) => list && typeof list === "object")
      .slice(0, MAX_LISTS)
      .map((list) => ({
        id: typeof list.id === "string" && list.id ? list.id : makeId(),
        name: cleanName(list.name) || "Saved",
        items: Array.isArray(list.items) ? list.items.map(cleanItem).filter(Boolean).slice(0, MAX_ITEMS) : [],
      }));

    if (!lists.length) return null;

    const activeId = lists.some((list) => list.id === raw.activeId) ? raw.activeId : lists[0].id;
    return { version: VERSION, activeId, lists };
  }

  function cleanName(value) {
    return typeof value === "string" ? value.trim().slice(0, MAX_NAME) : "";
  }

  function cleanItem(item) {
    if (!item || typeof item !== "object") return null;
    if (typeof item.id !== "string" || !item.id) return null;

    // The link is what a click follows, so it goes through the same gate every
    // other URL in this app does.
    const url = safeUrl(item.url);
    if (!url) return null;

    const thumb = item.image?.thumb ? sameOriginRelative(item.image.thumb) : null;

    return {
      id: item.id,
      title: typeof item.title === "string" ? item.title.slice(0, 300) : "Untitled",
      url,
      author: typeof item.author === "string" ? item.author.slice(0, 120) : null,
      source: typeof item.source === "string" ? item.source.slice(0, 40) : "",
      sourceLabel: typeof item.sourceLabel === "string" ? item.sourceLabel.slice(0, 40) : "",
      image: thumb ? { thumb } : null,
      stats: item.stats && typeof item.stats === "object" ? item.stats : {},
      savedAt: typeof item.savedAt === "number" ? item.savedAt : Date.now(),
    };
  }

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch {
      // A full quota is the realistic failure. Say so rather than losing the
      // save without a word.
      setStatus("Could not save — this browser's storage is full.", "error");
      return false;
    }
  }

  function commit() {
    const ok = persist();
    if (dialog.open) render();
    onChange?.();
    return ok;
  }

  /* --- reading ---------------------------------------------------------- */

  function activeList() {
    return state.lists.find((list) => list.id === state.activeId) ?? state.lists[0];
  }

  /** Which lists a model is on, by name — what the card's tooltip says. */
  function listsFor(itemId) {
    return state.lists.filter((list) => list.items.some((entry) => entry.id === itemId));
  }

  function isSaved(itemId) {
    return listsFor(itemId).length > 0;
  }

  function total() {
    return state.lists.reduce((sum, list) => sum + list.items.length, 0);
  }

  /* --- writing ---------------------------------------------------------- */

  /**
   * Save into the active list, or — if the model is already on any list at all —
   * take it off all of them. A second click on a filled marker has to undo the
   * first one, whichever list it landed in.
   */
  function toggle(item) {
    const entry = cleanItem({ ...item, savedAt: Date.now() });
    if (!entry) return false;

    if (isSaved(entry.id)) {
      state.lists.forEach((list) => {
        list.items = list.items.filter((saved) => saved.id !== entry.id);
      });
      commit();
      return false;
    }

    const list = activeList();
    if (list.items.length >= MAX_ITEMS) {
      setStatus(`"${list.name}" is full at ${MAX_ITEMS} models.`, "error");
      return false;
    }

    list.items = [entry, ...list.items];
    return commit();
  }

  function remove(listId, itemId) {
    const list = state.lists.find((entry) => entry.id === listId);
    if (!list) return;
    list.items = list.items.filter((entry) => entry.id !== itemId);
    commit();
  }

  function moveTo(fromId, itemId, toId) {
    if (fromId === toId) return;
    const from = state.lists.find((list) => list.id === fromId);
    const to = state.lists.find((list) => list.id === toId);
    if (!from || !to) return;

    const entry = from.items.find((item) => item.id === itemId);
    if (!entry) return;
    if (to.items.some((item) => item.id === itemId)) {
      from.items = from.items.filter((item) => item.id !== itemId);
      commit();
      return;
    }
    if (to.items.length >= MAX_ITEMS) {
      setStatus(`"${to.name}" is full at ${MAX_ITEMS} models.`, "error");
      return;
    }

    from.items = from.items.filter((item) => item.id !== itemId);
    to.items = [entry, ...to.items];
    commit();
  }

  /** Open, switch or close the inline name row. */
  function ask(mode) {
    if (mode === "create" && state.lists.length >= MAX_LISTS) {
      setStatus(`That is the ${MAX_LISTS} list limit.`, "error");
      return;
    }

    asking = mode;
    promptForm.hidden = !mode;
    deleteButton.dataset.confirming = "false";
    deleteButton.textContent = "Delete";

    if (!mode) return;
    promptInput.value = mode === "rename" ? activeList().name : "";
    promptInput.placeholder = mode === "rename" ? "New name" : "Name for the new list";
    promptInput.focus();
    promptInput.select();
  }

  function submitPrompt() {
    const name = cleanName(promptInput.value);
    if (!name) {
      setStatus("A list needs a name.", "error");
      return;
    }

    if (asking === "rename") {
      activeList().name = name;
      ask(null);
      commit();
      return;
    }

    const list = { id: makeId(), name, items: [] };
    state.lists = [...state.lists, list];
    state.activeId = list.id;
    ask(null);
    if (commit()) setStatus(`Created "${name}".`);
  }

  /**
   * Two clicks, because there is no undo and the second click is the only thing
   * standing between a full list and an empty one. An untouched list has nothing
   * to lose, so that one goes on the first click.
   */
  function deleteActive() {
    const list = activeList();

    if (list.items.length && deleteButton.dataset.confirming !== "true") {
      deleteButton.dataset.confirming = "true";
      deleteButton.textContent = `Delete ${list.items.length}?`;
      setStatus(`Click again to delete "${list.name}" and everything on it.`, "error");
      return;
    }

    state.lists = state.lists.filter((entry) => entry.id !== list.id);
    // There is always a list. Deleting the last one leaves a fresh empty one
    // rather than a panel with nothing to show and no way back.
    if (!state.lists.length) state = blank();
    if (!state.lists.some((entry) => entry.id === state.activeId)) {
      state.activeId = state.lists[0].id;
    }
    ask(null);
    if (commit()) setStatus(`Deleted "${list.name}".`);
  }

  function select(listId) {
    state.activeId = listId;
    ask(null);
    commit();
  }

  /* --- export and import ------------------------------------------------ */

  function exportAll() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "modelium-lists.json";
    link.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${total()} saved ${total() === 1 ? "model" : "models"}.`);
  }

  /**
   * Merge rather than replace: an import is almost always a second machine's
   * lists, and overwriting would quietly discard whatever is already here.
   * Lists are matched by name, and a model already on a list is not duplicated.
   */
  async function importFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    let incoming;
    try {
      incoming = sanitize(JSON.parse(await file.text()));
    } catch {
      incoming = null;
    }
    if (!incoming) {
      setStatus("That file is not a Modelium list export.", "error");
      return;
    }

    let added = 0;
    for (const list of incoming.lists) {
      let target = state.lists.find((entry) => entry.name === list.name);
      if (!target) {
        if (state.lists.length >= MAX_LISTS) break;
        target = { id: makeId(), name: list.name, items: [] };
        state.lists = [...state.lists, target];
      }
      for (const item of list.items) {
        if (target.items.length >= MAX_ITEMS) break;
        if (target.items.some((entry) => entry.id === item.id)) continue;
        target.items = [...target.items, item];
        added += 1;
      }
    }

    if (commit()) setStatus(`Imported ${added} new ${added === 1 ? "model" : "models"}.`);
  }

  /* --- rendering -------------------------------------------------------- */

  function open() {
    setStatus("");
    dialog.showModal();
    render();
  }

  function render() {
    const list = activeList();

    rail.replaceChildren(
      ...state.lists.map((entry) => {
        const button = el(
          "button",
          {
            class: "list-tab",
            type: "button",
            "aria-pressed": String(entry.id === state.activeId),
          },
          "",
        );
        button.append(
          el("span", { class: "list-tab__name" }, entry.name),
          el("span", { class: "list-tab__count" }, String(entry.items.length)),
        );
        button.addEventListener("click", () => select(entry.id));
        return button;
      }),
    );

    title.replaceChildren(
      el("span", { class: "lists__name" }, list.name),
      el(
        "span",
        { class: "lists__meta" },
        `${list.items.length} ${list.items.length === 1 ? "model" : "models"}`,
      ),
    );

    // Deleting the only empty list would just make another empty one.
    deleteButton.disabled = state.lists.length === 1 && !list.items.length;

    if (!list.items.length) {
      body.replaceChildren(
        el(
          "p",
          { class: "lists__empty" },
          "Nothing saved here yet. Use the bookmark on any result to add it to this list.",
        ),
      );
      return;
    }

    body.replaceChildren(...list.items.map((item) => row(list, item)));
  }

  function row(list, item) {
    const entry = el("div", { class: "saved", "data-source": item.source });

    const figure = el("div", { class: "saved__figure" });
    if (item.image?.thumb) {
      const img = el("img", { src: item.image.thumb, alt: "", loading: "lazy", decoding: "async" });
      img.addEventListener("error", () => img.remove());
      figure.append(img);
    }

    const text = el("div", { class: "saved__text" });
    const link = el(
      "a",
      { class: "saved__title", href: item.url, target: "_blank", rel: "noopener noreferrer" },
      item.title,
    );
    text.append(link);
    text.append(
      el(
        "p",
        { class: "saved__meta" },
        item.author ? `${item.sourceLabel} · by ${item.author}` : item.sourceLabel,
      ),
    );

    const actions = el("div", { class: "saved__actions" });

    if (state.lists.length > 1) {
      const move = el("select", { class: "saved__move", "aria-label": `Move "${item.title}" to another list` });
      move.append(el("option", { value: "" }, "Move to…"));
      state.lists
        .filter((other) => other.id !== list.id)
        .forEach((other) => move.append(el("option", { value: other.id }, other.name)));
      move.addEventListener("change", () => {
        if (move.value) moveTo(list.id, item.id, move.value);
      });
      actions.append(move);
    }

    const drop = el("button", { class: "saved__remove", type: "button" }, "Remove");
    drop.addEventListener("click", () => remove(list.id, item.id));
    actions.append(drop);

    entry.append(figure, text, actions);
    return entry;
  }

  function setStatus(message, tone = "info") {
    status.textContent = message;
    status.dataset.tone = tone;
  }

  return {
    open,
    toggle,
    isSaved,
    listsFor,
    total,
    activeName: () => activeList().name,
  };
}

/* --- helpers ------------------------------------------------------------ */

function el(tag, attributes = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
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

function makeId() {
  return `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Keep a thumbnail on this origin stored as a path, not as a full URL.
 *
 * With image proxying on, `thumb` is `/img?u=…` on this server. safeUrl resolves
 * that against the current page, so saving from http://localhost:8787 would
 * write an absolute localhost URL into storage — and the same list opened later
 * from a LAN address, or exported to another machine, would point every
 * thumbnail at a server that is not there.
 */
function sameOriginRelative(value) {
  const safe = safeUrl(value);
  if (!safe) return null;

  const url = new URL(safe);
  return url.origin === location.origin ? `${url.pathname}${url.search}` : safe;
}
