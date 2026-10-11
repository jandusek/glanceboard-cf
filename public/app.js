const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};

let config = null; // working copy, edited in place
let saved = ""; // JSON of the last saved config
let defaults = null;
let state = null;
let displayUrl = "";
let displayToken = null;
let geminiKeySet = true;

// ─── API ─────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error ?? `Request failed with HTTP ${res.status}`);
  return body;
}
const send = (method, path, data = {}) =>
  api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

// ─── Helpers ─────────────────────────────────────

function toast(message, bad = false) {
  const t = $("#toast");
  t.textContent = message;
  t.classList.toggle("bad", bad);
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), bad ? 6000 : 2400);
}

const fmt = (opts, date = new Date()) => new Intl.DateTimeFormat(undefined, { timeZone: config.timezone, ...opts }).format(date);

function relativeDay(iso) {
  const day = (d) => fmt({ year: "numeric", month: "2-digit", day: "2-digit" }, d);
  const d = new Date(iso);
  const time = fmt({ hour: "numeric", minute: "2-digit" }, d);
  if (day(d) === day(new Date())) return `Today, ${time}`;
  if (day(d) === day(new Date(Date.now() - 86400000))) return `Yesterday, ${time}`;
  return `${fmt({ weekday: "short", day: "numeric", month: "short" }, d)}, ${time}`;
}

function localHour() {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: config.timezone, hour: "numeric", hourCycle: "h23" }).format(new Date()));
}

const hourLabel = (h) => new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2000, 0, 1, h));

function nextRun() {
  if (!config.schedule.length) return null;
  const now = localHour();
  const next = config.schedule.find((h) => h > now) ?? config.schedule[0];
  return `${next > now ? "Today" : "Tomorrow"}, ${hourLabel(next)}`;
}

function isDirty() {
  return JSON.stringify(config) !== saved;
}

function markDirty() {
  $("#savebar").hidden = !isDirty();
  if (!isDirty()) $("#save-error").hidden = true;
}

const PERSON_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></svg>';

function avatar(character, cls = "avatar") {
  const node = el("div", { className: cls });
  if (character.photo) node.append(el("img", { src: `/api/photo?key=${encodeURIComponent(character.photo)}`, alt: "" }));
  else node.innerHTML = PERSON_ICON;
  return node;
}

// ─── Router ──────────────────────────────────────

const ROUTES = ["overview", "prompt", "characters", "sources", "display"];
const TITLES = { overview: "Overview", prompt: "Prompt", characters: "Characters", sources: "Calendar & weather", display: "Display" };

function route() {
  const name = location.hash.replace(/^#\/?/, "") || "overview";
  const page = ROUTES.includes(name) ? name : "overview";
  for (const section of $$(".page")) section.hidden = section.dataset.page !== page;
  for (const link of $$(".nav a")) {
    if (link.dataset.route === page) {
      link.setAttribute("aria-current", "page");
      link.scrollIntoView({ block: "nearest", inline: "nearest" }); // keeps the tab visible in the mobile tab bar
    }
    else link.removeAttribute("aria-current");
  }
  document.title = page === "overview" ? "Glanceboard" : `${TITLES[page]} – Glanceboard`;
  window.scrollTo(0, 0);
  if (page === "overview") { loadToday(); refreshState(); }
}

// ─── Overview ────────────────────────────────────

function renderPicture() {
  const view = $('input[name="view"]:checked').value;
  const img = $("#picture");
  const has = Boolean(state.lastGeneratedAt);
  img.hidden = !has;
  $("#picture-empty").hidden = has;
  if (has) {
    img.src = `/api/image/${view}.png?v=${encodeURIComponent(state.lastGeneratedAt)}`;
    img.classList.toggle("original", view === "original");
  }
  const modelId = state.lastModel ?? config.imageModel;
  const model = defaults.models.find((m) => m.id === modelId)?.name ?? modelId;
  $("#show-last-prompt").hidden = !(has && state.lastPrompt);
  const items = [
    ["Drawn", state.lastGeneratedAt ? relativeDay(state.lastGeneratedAt) : "Never"],
    ["Last check", state.lastRunAt ? relativeDay(state.lastRunAt) : "Never"],
    ["Model", model],
  ];
  $("#picture-meta").replaceChildren(...items.map(([k, v]) => el("div", {}, el("dt", { textContent: k }), el("dd", { textContent: v }))));
}

function renderStatus() {
  const next = nextRun();
  $("#overview-date").textContent = fmt({ weekday: "long", day: "numeric", month: "long" });

  const alert = $("#overview-alert");
  alert.hidden = !state.lastError;
  alert.textContent = state.lastError ? `The last run failed: ${state.lastError}` : "";

  const rows = [
    ["Next picture", next ?? "Only when you generate"],
    ["Drawing hours", config.schedule.length ? config.schedule.map(hourLabel).join(", ") : "None"],
    ["Last result", state.lastError ? "Failed" : state.lastSkipped ? "Unchanged, kept the picture" : state.lastGeneratedAt ? "New picture" : "No runs yet"],
  ];
  $("#schedule-summary").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));

  $("#sidebar-status").replaceChildren(
    el("span", { className: "label" }, "Next picture"),
    el("span", {}, el("span", { className: `status-dot${state.lastError ? " bad" : ""}` }), next ?? "Not scheduled"),
  );
}

// The cron draws new pictures while the dashboard sits open, so re-check the
// run state whenever the overview is in view rather than only at boot.
const overviewVisible = () => document.visibilityState === "visible" && !$('[data-page="overview"]').hidden;

function withKeyWarning(st) {
  if (!geminiKeySet && !st.lastError) st.lastError = "GEMINI_API_KEY isn't set. Add it with: wrangler secret put GEMINI_API_KEY";
  return st;
}

async function refreshState() {
  try {
    const next = withKeyWarning(await api("/api/state"));
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next;
    if (changed) { renderPicture(); renderStatus(); }
  } catch {
    // Keep showing what we have; the next check retries.
  }
}

async function loadToday() {
  const list = $("#today-events");
  try {
    const today = await api("/api/today");
    list.replaceChildren();
    if (today.calendarError) {
      list.append(el("li", { className: "error", textContent: `Couldn't read the calendar: ${today.calendarError}` }));
    } else if (!today.events.length) {
      list.append(el("li", { className: "muted", textContent: config.icalUrl ? "Nothing on the calendar today." : "No calendar connected yet." }));
    }
    for (const ev of today.events) {
      const guests = today.cast.filter((c) => c.reasons.includes(ev.summary)).map((c) => c.name);
      list.append(
        el("li", {},
          el("time", { textContent: ev.allDay ? "All day" : ev.time }),
          el("div", {},
            el("span", { className: "title", textContent: ev.summary }),
            ev.location ? el("span", { className: "sub", textContent: ev.location }) : null,
            guests.length ? el("span", { className: "sub", textContent: `With ${guests.join(" and ")}` }) : null,
          ),
        ),
      );
    }
    const chip = $("#weather-chip");
    chip.hidden = !today.weather;
    if (today.weather) chip.textContent = `${today.weather.emoji} ${today.weather.high}${today.weather.unit}, ${today.weather.condition}`;
  } catch (e) {
    list.replaceChildren(el("li", { className: "error", textContent: e.message }));
  }
}

async function generateNow() {
  if (isDirty() && !(await save())) return;
  const button = $("#generate");
  button.disabled = true;
  button.replaceChildren(el("span", { className: "spinner" }), "Generating…");
  try {
    state = (await send("POST", "/api/generate")).state;
    toast("New picture is ready.");
  } catch (e) {
    state = await api("/api/state");
    toast(`Generation failed: ${e.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = "Generate now";
    renderPicture();
    renderStatus();
  }
}

function showLastPrompt() {
  $("#prompt-sheet-title").textContent = "Prompt used for this picture";
  $("#prompt-warnings").hidden = true;
  const model = defaults.models.find((m) => m.id === state.lastModel)?.name ?? state.lastModel ?? "Not recorded";
  const facts = [["Drawn", relativeDay(state.lastGeneratedAt)], ["Model", model]];
  $("#prompt-facts").replaceChildren(...facts.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));
  $("#prompt-output").textContent = state.lastPrompt;
  $("#prompt-sheet").showModal();
}

async function showPrompt(template) {
  const sheet = $("#prompt-sheet");
  $("#prompt-sheet-title").textContent = "Prompt preview";
  $("#prompt-output").textContent = config.polish ? "Building the prompt and asking Workers AI…" : "Building the prompt…";
  $("#prompt-warnings").hidden = true;
  $("#prompt-facts").replaceChildren();
  sheet.showModal();
  try {
    const r = await send("POST", "/api/preview", template === undefined ? {} : { prompt: template });
    $("#prompt-output").textContent = r.prompt;
    const facts = [
      ["Events", String(r.events.length)],
      ["Characters", r.cast.length ? r.cast.map((c) => c.name).join(", ") : "None today"],
      ["Scene", r.polished?.scene || "Not written"],
    ];
    $("#prompt-facts").replaceChildren(...facts.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));
    const warnings = $("#prompt-warnings");
    warnings.replaceChildren(...r.warnings.map((w) => el("li", { textContent: w })));
    warnings.hidden = !r.warnings.length;
  } catch (e) {
    $("#prompt-output").textContent = `Couldn't build the prompt: ${e.message}`;
  }
}

// ─── Prompt page ─────────────────────────────────

function renderPromptPage() {
  $("#prompt-text").value = config.prompt || defaults.prompt;
  $("#placeholder-list").replaceChildren(
    ...defaults.placeholders.map((p) => {
      const b = el("button", { type: "button" },
        el("span", { className: "ph", textContent: `{{${p.name}}}` }),
        el("span", { className: "ph-desc", textContent: p.meaning }));
      b.addEventListener("click", () => insertAtCursor($("#prompt-text"), `{{${p.name}}}`));
      return el("li", {}, b);
    }),
  );
  fillSelect($("#image-model"), defaults.models, config.imageModel);
  fillSelect($("#text-model"), defaults.textModels, config.textModel);
  $("#setting").value = config.setting ?? "";
  $("#polish").checked = config.polish;
  $("#text-model-field").hidden = !config.polish;
}

function fillSelect(select, options, value) {
  const list = options.some((o) => o.id === value) ? options : [...options, { id: value, name: value }];
  select.replaceChildren(...list.map((o) => el("option", { value: o.id, textContent: o.name })));
  select.value = value;
}

function insertAtCursor(textarea, text) {
  const { selectionStart: a, selectionEnd: b, value } = textarea;
  textarea.value = value.slice(0, a) + text + value.slice(b);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = a + text.length;
  textarea.dispatchEvent(new Event("input"));
}

// ─── Characters ──────────────────────────────────

let editing = null; // character open in the sheet

function renderCharacters() {
  const grid = $("#character-grid");
  grid.replaceChildren(
    ...config.characters.map((c) => {
      const card = el("button", { type: "button", className: "character-card" },
        avatar(c),
        el("span", {},
          el("span", { className: "name", textContent: c.name || "Unnamed" }),
          c.description ? el("span", { className: "desc", textContent: c.description }) : null,
          el("span", {
            className: `badge${c.inclusion === "always" ? " accent" : ""}`,
            textContent: c.inclusion === "always" ? "Every day" : "When mentioned",
          }),
        ),
      );
      card.addEventListener("click", () => openCharacter(c));
      return el("li", {}, card);
    }),
  );
  $("#characters-empty").hidden = config.characters.length > 0;
}

function openCharacter(character) {
  editing = character;
  $("#cs-name").value = character.name;
  $("#cs-aliases").value = character.aliases.join(", ");
  $("#cs-description").value = character.description;
  $(`input[name="cs-inclusion"][value="${character.inclusion}"]`).checked = true;
  $(`input[name="cs-gender"][value="${character.gender ?? ""}"]`).checked = true;
  $("#cs-birthday").value = character.birthday ?? "";
  renderAgeField();
  renderAliasHelp();
  $("#character-sheet-title").textContent = character.name || "New character";
  renderSheetPhoto();
  $("#character-sheet").showModal();
}

function renderAliasHelp() {
  $("#cs-aliases-help").textContent = editing.inclusion === "mentioned"
    ? "Separate names with commas. An event using any of these names brings them into the picture."
    : "Separate names with commas. Tells the image model who an event like \"Shopping with Mum\" is about.";
}

/** With a birthday the age is worked out on the server each day, so the field just shows it. */
function renderAgeField() {
  const age = $("#cs-age");
  const fromBirthday = /^\d{4}-\d{2}-\d{2}$/.test(editing.birthday ?? "");
  age.disabled = fromBirthday;
  if (fromBirthday) {
    const [y, m, d] = editing.birthday.split("-").map(Number);
    const now = new Date();
    const had = now.getMonth() + 1 > m || (now.getMonth() + 1 === m && now.getDate() >= d);
    age.value = String(Math.max(0, now.getFullYear() - y - (had ? 0 : 1)));
  } else {
    age.value = editing.age ?? "";
  }
  $("#cs-age-help").textContent = fromBirthday
    ? "Worked out from the birthday."
    : "Helps the image model draw them at the right age.";
}

function renderSheetPhoto() {
  $("#cs-photo").replaceWith(Object.assign(avatar(editing, "avatar avatar-lg"), { id: "cs-photo" }));
  $("#cs-remove-photo").hidden = !editing.photo;
}

function closeCharacter() {
  // A character abandoned before it got a name isn't worth keeping.
  if (editing && !editing.name.trim()) config.characters = config.characters.filter((c) => c !== editing);
  editing = null;
  renderCharacters();
  markDirty();
}

function bindCharacterSheet() {
  const sheet = $("#character-sheet");
  const update = (fn) => { fn(editing); renderCharacters(); markDirty(); };
  $("#cs-name").addEventListener("input", (e) => update((c) => { c.name = e.target.value; $("#character-sheet-title").textContent = c.name || "New character"; }));
  $("#cs-aliases").addEventListener("input", (e) => update((c) => { c.aliases = e.target.value.split(",").map((a) => a.trim()).filter(Boolean); }));
  $("#cs-description").addEventListener("input", (e) => update((c) => { c.description = e.target.value; }));
  $$('input[name="cs-gender"]').forEach((r) => r.addEventListener("change", () => update((c) => { c.gender = r.value; })));
  $("#cs-birthday").addEventListener("change", (e) => update((c) => { c.birthday = e.target.value; renderAgeField(); }));
  $("#cs-age").addEventListener("input", (e) => update((c) => {
    const n = Number.parseInt(e.target.value, 10);
    c.age = Number.isFinite(n) ? n : null;
  }));
  $$('input[name="cs-inclusion"]').forEach((r) => r.addEventListener("change", () => update((c) => {
    c.inclusion = r.value;
    renderAliasHelp();
  })));
  $("#cs-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const field = $(".photo-field");
    field.classList.add("busy");
    try {
      const { photo } = await api(`/api/characters/${editing.id}/photo`, { method: "PUT", headers: { "content-type": file.type }, body: file });
      update((c) => { c.photo = photo; });
      renderSheetPhoto();
    } catch (err) {
      toast(err.message, true);
    } finally {
      field.classList.remove("busy");
    }
  });
  $("#cs-remove-photo").addEventListener("click", () => { update((c) => { c.photo = null; }); renderSheetPhoto(); });
  $("#cs-delete").addEventListener("click", () => {
    config.characters = config.characters.filter((c) => c !== editing);
    editing = null;
    sheet.close();
  });
  sheet.addEventListener("close", closeCharacter);
}

// ─── Calendar & weather ──────────────────────────

function renderSources() {
  $("#ical-url").value = config.icalUrl;
  $("#timezone").value = config.timezone;
  $("#empty-weekday").value = config.emptyDay.weekday;
  $("#empty-weekend").value = config.emptyDay.weekend;
  $(`input[name="unit"][value="${config.tempUnit}"]`).checked = true;
  $("#location-current").textContent = config.location
    ? `Using ${config.location.name} (${config.location.latitude.toFixed(2)}, ${config.location.longitude.toFixed(2)}).`
    : "No location set, so the picture won't include weather.";
}

function bindLocationSearch() {
  const input = $("#location-query");
  const list = $("#location-results");
  let timer;
  let results = [];
  let active = -1;

  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
  const choose = (place) => {
    const name = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
    config.location = { name, latitude: place.latitude, longitude: place.longitude };
    if (place.timezone && config.timezone !== place.timezone && !config.icalUrl) config.timezone = place.timezone;
    input.value = "";
    close();
    renderSources();
    markDirty();
  };
  const show = (items) => {
    list.replaceChildren(...items);
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };
  const highlight = () => $$("li[role=option]", list).forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
      url.search = new URLSearchParams({ name: q, count: "6", language: (navigator.language || "en").slice(0, 2) });
      try {
        const data = await (await fetch(url)).json();
        results = data.results ?? [];
        if (!results.length) return show([el("li", { className: "muted", textContent: "No places found" })]);
        active = -1;
        show(results.map((p, i) => {
          const li = el("li", { role: "option", id: `loc-${i}` },
            el("span", { textContent: [p.name, p.admin1, p.country].filter(Boolean).join(", ") }),
            el("small", { textContent: p.timezone ?? "" }));
          li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(p); });
          return li;
        }));
      } catch {
        show([el("li", { className: "muted", textContent: "Place search isn't responding" })]);
      }
    }, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden || !results.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      highlight();
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 100));
}

// ─── Display ─────────────────────────────────────

function renderDisplay() {
  $("#display-url").value = displayUrl;
  $("#display-url-token").hidden = Boolean(displayToken);
  $("#display-token-field").hidden = !displayToken;
  $("#display-token").value = displayToken ?? "";
  $("#battery").checked = config.battery;
  $("#schedule").replaceChildren(
    ...Array.from({ length: 24 }, (_, h) => {
      const b = el("button", { type: "button", textContent: String(h).padStart(2, "0") });
      b.setAttribute("aria-label", hourLabel(h));
      b.setAttribute("aria-pressed", String(config.schedule.includes(h)));
      b.addEventListener("click", () => {
        config.schedule = config.schedule.includes(h)
          ? config.schedule.filter((x) => x !== h)
          : [...config.schedule, h].sort((x, y) => x - y);
        b.setAttribute("aria-pressed", String(config.schedule.includes(h)));
        markDirty();
        renderStatus();
      });
      return b;
    }),
  );
}

// ─── Wiring ──────────────────────────────────────

function renderAll() {
  renderPromptPage();
  renderCharacters();
  renderSources();
  renderDisplay();
  renderPicture();
  renderStatus();
  markDirty();
}

function bindInputs() {
  const bind = (sel, apply, event = "input") => $(sel).addEventListener(event, (e) => { apply(e.target); markDirty(); });
  bind("#prompt-text", (t) => { config.prompt = t.value.trim() === defaults.prompt.trim() ? "" : t.value; });
  bind("#setting", (t) => { config.setting = t.value; });
  bind("#image-model", (t) => { config.imageModel = t.value; renderPicture(); }, "change");
  bind("#text-model", (t) => { config.textModel = t.value; }, "change");
  bind("#polish", (t) => { config.polish = t.checked; $("#text-model-field").hidden = !t.checked; }, "change");
  bind("#ical-url", (t) => { config.icalUrl = t.value.trim(); });
  bind("#timezone", (t) => { config.timezone = t.value.trim(); });
  bind("#empty-weekday", (t) => { config.emptyDay.weekday = t.value; });
  bind("#empty-weekend", (t) => { config.emptyDay.weekend = t.value; });
  bind("#battery", (t) => { config.battery = t.checked; }, "change");
  $$('input[name="unit"]').forEach((r) => r.addEventListener("change", () => { config.tempUnit = r.value; markDirty(); }));
  $$('input[name="view"]').forEach((r) => r.addEventListener("change", renderPicture));

  $("#reset-prompt").addEventListener("click", () => {
    $("#prompt-text").value = defaults.prompt;
    config.prompt = "";
    markDirty();
  });
  $("#preview-prompt").addEventListener("click", () => showPrompt($("#prompt-text").value));
  $("#show-prompt").addEventListener("click", () => showPrompt());
  $("#show-last-prompt").addEventListener("click", showLastPrompt);
  $("#generate").addEventListener("click", generateNow);
  $("#add-character").addEventListener("click", () => {
    const c = {
      id: crypto.randomUUID(), name: "", aliases: [], inclusion: "always", description: "", photo: null,
      gender: "", age: null, birthday: "",
    };
    config.characters.push(c);
    openCharacter(c);
    $("#cs-name").focus();
  });
  $("#copy-url").addEventListener("click", async () => {
    await navigator.clipboard.writeText(displayUrl);
    toast("Picture URL copied.");
  });
  $("#copy-token").addEventListener("click", async () => {
    await navigator.clipboard.writeText(displayToken);
    toast("Access token copied.");
  });
  $("#save").addEventListener("click", save);
  $("#discard").addEventListener("click", () => { config = JSON.parse(saved); renderAll(); });
  for (const dialog of $$("dialog")) {
    $$("[data-close]", dialog).forEach((b) => b.addEventListener("click", () => dialog.close()));
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  }
  bindCharacterSheet();
  bindLocationSearch();
  window.addEventListener("hashchange", route);
  document.addEventListener("visibilitychange", () => { if (overviewVisible()) refreshState(); });
  window.addEventListener("pageshow", (e) => { if (e.persisted && overviewVisible()) refreshState(); });
  setInterval(() => { if (overviewVisible()) refreshState(); }, 60_000);
  window.addEventListener("beforeunload", (e) => { if (isDirty()) e.preventDefault(); });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s" && isDirty()) { e.preventDefault(); save(); }
  });
}

async function save() {
  const button = $("#save");
  button.disabled = true;
  $("#save-error").hidden = true;
  try {
    config = (await send("PUT", "/api/config", config)).config;
    saved = JSON.stringify(config);
    renderAll();
    toast("Changes saved.");
    if (!$('[data-page="overview"]').hidden) loadToday();
    return true;
  } catch (e) {
    $("#save-error").textContent = e.message;
    $("#save-error").hidden = false;
    return false;
  } finally {
    button.disabled = false;
  }
}

async function boot() {
  const [settings, st] = await Promise.all([api("/api/config"), api("/api/state")]);
  defaults = settings.defaults;
  config = settings.config;
  saved = JSON.stringify(config);
  displayUrl = settings.displayUrl;
  displayToken = settings.displayToken;
  geminiKeySet = settings.geminiKeySet;
  state = withKeyWarning(st);

  $("#timezones").replaceChildren(...Intl.supportedValuesOf("timeZone").map((tz) => el("option", { value: tz })));
  bindInputs();
  renderAll();
  route();
}

boot().catch((e) => {
  $(".content").replaceChildren(el("div", { className: "alert", textContent: `The dashboard couldn't load: ${e.message}` }));
});
