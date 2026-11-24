import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { props, theme, settings, exec, run, openOverlay, closeOverlay, shared, setShared, watchFolder, nextCommand } from "herdr";
import { basename, dirname, supported, openDocument, renderPage, sourceSignature, textPages, pruneCache } from "./documents.js";

const ACTIVE = "document-reader.active";
const GAP = 16;
let readerSequence = 0;

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export default class DocumentReader extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "reader";
    this.keyboard = cx.focus_handle();
    if (this.role === "help") {
      this.keyboard.focus();
      return;
    }
    if (this.role === "search") {
      this.input = InputState.new({ value: props()?.query ?? "", placeholder: "Search this document" });
      this.input.on("submit", (event) => this.submitSearch(event.shift ? -1 : 1));
      this.input.focus();
      cx.timer.after(300, () => this.input.focus());
      return;
    }

    this.readerId = props()?.pane ?? `document-reader-${++readerSequence}`;
    this.commandKey = `document-reader.command.${this.readerId}`;
    this.source = props()?.file;
    this.page = Math.max(1, Number(props()?.page) || 1);
    this.visiblePage = this.page;
    this.pageCount = 0;
    this.pages = new Map();
    this.inflight = new Set();
    this.ratio = 1.414;
    this.viewport = { width: 800, height: 600 };
    this.zoom = 1;
    this.fitMode = "page";
    this.pan = { x: 24, y: 24 };
    this.continuous = false;
    this.wheel = 0;
    this.lastWheelPage = 0;
    this.countPrefix = "";
    this.generation = 0;
    this.scroll = VirtualListScrollHandle.new();
    this.pageInput = InputState.new({ value: String(this.page), placeholder: "Page" });
    this.pageInput.on("submit", (_event, cx) => {
      const page = Number.parseInt(this.pageInput.value(), 10);
      if (Number.isFinite(page)) this.goTo(page, cx);
      this.keyboard.focus();
    });
    this.pageInput.on("focus", (_event, cx) => { this.editingPage = true; cx.notify(); });
    this.pageInput.on("blur", (_event, cx) => { this.editingPage = false; this.pageInput.set_value(String(this.page)); cx.notify(); });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.keyboard.focus();
        else this.command(command, cx);
      }
    });
    cx.timer.every(250, (cx) => this.pumpPages(cx));
    cx.timer.every(2000, (cx) => this.checkSource(cx));
    this.loadDocument(cx);
    this.startWatch(cx);
  }

  async close() {
    this.closed = true;
    this.generation++;
    if (this.readerId) {
      const active = { ...(shared(ACTIVE) ?? {}) };
      delete active[this.readerId];
      setShared(ACTIVE, active);
    }
    this.scroll?.release();
    this.pageInput?.release();
    this.input?.release();
  }

  submitSearch(direction) {
    const query = this.input.value().trim();
    if (!query) return;
    setShared(`document-reader.command.${props()?.readerId}`, { action: "search", query, direction, seq: Date.now() + Math.random() });
  }

  command(command, cx) {
    if (command.startsWith("search:")) {
      let query = command.slice(7);
      try { query = decodeURIComponent(query); } catch {}
      this.search(query, 1, cx);
    }
    else if (command === "next") this.nextPage(1, cx);
    else if (command === "prev" || command === "previous") this.nextPage(-1, cx);
    else if (command === "zoom-in") this.zoomAt(1.25, null, cx);
    else if (command === "zoom-out") this.zoomAt(1 / 1.25, null, cx);
    else if (command === "fit") this.fit("page", cx);
    else if (command === "fit-width") this.fit("width", cx);
    else if (command === "continuous") this.toggleContinuous(cx);
    else if (command === "reload") this.queueReload(cx, true);
    else if (command === "search") this.openSearch();
    else if (command === "search-next") this.stepSearch(1, cx);
    else if (command === "search-prev") this.stepSearch(-1, cx);
    else if (command === "help") this.openHelp();
    else if (command === "open") this.openExternal(cx);
  }

  registerActive() {
    setShared(ACTIVE, { ...(shared(ACTIVE) ?? {}), [this.readerId]: this.doc.key });
    pruneCache(new Set(Object.values(shared(ACTIVE) ?? {}))).catch(() => {});
  }

  async loadDocument(cx) {
    if (this.loadingDocument) {
      this.reloadAgain = true;
      return;
    }
    if (!this.source || !supported(this.source)) {
      this.error = "Choose a PDF, Word, Excel or PowerPoint document";
      cx.notify();
      return;
    }
    const generation = ++this.generation;
    this.loadingDocument = true;
    this.refreshing = Boolean(this.doc);
    if (!this.doc) this.error = null;
    cx.notify();
    try {
      const current = this.continuous ? this.visiblePage : this.page;
      const doc = await openDocument(this.source, props()?.on ?? null);
      const page = clamp(current, 1, doc.count);
      const first = await renderPage(doc, page, this.quality(doc));
      if (this.closed || generation !== this.generation) return;
      this.doc = doc;
      this.pageCount = doc.count;
      this.page = page;
      this.visiblePage = page;
      this.pages = new Map([[page, first]]);
      this.inflight.clear();
      this.ratio = first.height / first.width;
      this.pageInput.set_value(String(page));
      this.error = null;
      this.searchResults = [];
      this.searchMessage = "";
      this.pan = { x: 24, y: 24 };
      this.registerActive();
      this.scroll.scroll_to_item(page - 1, "top");
      this.pumpPages(cx);
    } catch (error) {
      if (generation === this.generation) {
        this.error = String(error?.message ?? error);
      }
    } finally {
      if (generation === this.generation) {
        this.loadingDocument = false;
        this.refreshing = false;
        cx.notify();
      }
      if ((this.reloadAgain || this.reloadQueued) && !this.closed) {
        this.reloadAgain = false;
        this.queueReload(cx);
      }
    }
  }

  queueReload(cx, immediate = false) {
    this.reloadQueued = true;
    if (this.reloadScheduled || this.loadingDocument) return;
    this.reloadScheduled = true;
    cx.timer.after(immediate ? 0 : 450, (cx) => {
      this.reloadScheduled = false;
      if (!this.reloadQueued || this.closed) return;
      this.reloadQueued = false;
      this.loadDocument(cx);
    });
  }

  async checkSource(cx) {
    if (!this.doc || this.checkingSource || this.loadingDocument || this.closed) return;
    this.checkingSource = true;
    try {
      const signature = await sourceSignature(this.source, this.doc.on);
      if (!this.closed && this.doc && signature !== this.doc.signature) this.queueReload(cx);
    } catch {
    } finally {
      this.checkingSource = false;
    }
  }

  startWatch(cx) {
    if (!this.source || props()?.on) return;
    const directory = dirname(this.source);
    const source = this.source;
    cx.spawn(async (cx) => {
      try {
        while (!this.closed && this.source === source) {
          const changed = await watchFolder(directory);
          if (this.closed || this.source !== source) return;
          if (!changed.length || changed.some((path) => path === source || path === directory)) this.queueReload(cx);
        }
      } catch {
      }
    });
  }

  quality(doc = this.doc) {
    return this.zoom > 1.75 ? 3600 : doc?.on ? 1400 : 1800;
  }

  ensurePage(page, cx) {
    if (!this.doc || page < 1 || page > this.pageCount) return;
    const quality = this.quality();
    const old = this.pages.get(page);
    const key = `${this.doc.key}:${page}:${quality}`;
    if ((old?.quality >= quality && !old.error) || this.inflight.has(key)) return;
    const doc = this.doc;
    const generation = this.generation;
    this.inflight.add(key);
    this.pages.set(page, { ...old, n: page, loading: true, error: null });
    cx.spawn(async (cx) => {
      try {
        const rendered = await renderPage(doc, page, quality);
        if (this.closed || generation !== this.generation || this.doc !== doc) return;
        this.pages.set(page, rendered);
      } catch (error) {
        if (generation === this.generation && this.doc === doc) {
          this.pages.set(page, { ...this.pages.get(page), n: page, loading: false, error: String(error?.message ?? error) });
        }
      } finally {
        this.inflight.delete(key);
        if (generation === this.generation) cx.notify();
      }
    });
  }

  pumpPages(cx) {
    if (!this.doc || this.loadingDocument || this.closed) return;
    const center = this.continuous ? this.visiblePage : this.page;
    for (let page = Math.max(1, center - 1); page <= Math.min(this.pageCount, center + 4); page++) this.ensurePage(page, cx);
  }

  goTo(page, cx) {
    if (!this.doc) return;
    const next = clamp(Math.round(page), 1, this.pageCount);
    this.page = next;
    this.visiblePage = next;
    this.pageInput.set_value(String(next));
    this.pan = { x: 24, y: 24 };
    this.wheel = 0;
    if (this.continuous) this.scroll.scroll_to_item(next - 1, "top");
    this.ensurePage(next, cx);
    this.pumpPages(cx);
    cx.notify();
  }

  nextPage(delta, cx) {
    const from = this.continuous ? this.visiblePage : this.page;
    this.goTo(from + delta, cx);
  }

  dimensions() {
    const entry = this.pages.get(this.page);
    const ratio = entry ? entry.height / entry.width : this.ratio;
    const width = Math.max(80, this.viewport.width - 48);
    const height = Math.max(80, this.viewport.height - 48);
    const w = this.fitMode === "width" ? width * this.zoom : Math.min(width, height / ratio) * this.zoom;
    return { width: w, height: w * ratio };
  }

  origin(size = this.dimensions()) {
    return {
      x: size.width > this.viewport.width ? this.pan.x : (this.viewport.width - size.width) / 2,
      y: size.height > this.viewport.height ? this.pan.y : (this.viewport.height - size.height) / 2,
    };
  }

  clampPan(pan, size = this.dimensions()) {
    return {
      x: size.width > this.viewport.width ? clamp(pan.x, this.viewport.width - size.width - 24, 24) : 24,
      y: size.height > this.viewport.height ? clamp(pan.y, this.viewport.height - size.height - 24, 24) : 24,
    };
  }

  zoomAt(factor, point, cx) {
    if (this.continuous) {
      this.zoom = clamp(this.zoom * factor, 0.25, 5);
      this.ensurePage(this.visiblePage, cx);
      this.scroll.scroll_to_item(this.visiblePage - 1, "top");
      cx.notify();
      return;
    }
    const before = this.dimensions();
    const origin = this.origin(before);
    this.zoom = clamp(this.zoom * factor, 0.25, 5);
    const after = this.dimensions();
    const at = point ?? { x: this.viewport.width / 2, y: this.viewport.height / 2 };
    const ratio = after.width / before.width;
    this.pan = this.clampPan({
      x: at.x - (at.x - origin.x) * ratio,
      y: at.y - (at.y - origin.y) * ratio,
    }, after);
    this.ensurePage(this.page, cx);
    cx.notify();
  }

  fit(mode, cx) {
    this.fitMode = mode;
    this.zoom = 1;
    this.pan = { x: 24, y: 24 };
    cx.notify();
  }

  panBy(x, y, cx) {
    this.pan = this.clampPan({ x: this.pan.x + x, y: this.pan.y + y });
    cx.notify();
  }

  toggleContinuous(cx) {
    if (this.continuous) {
      this.page = this.visiblePage;
      this.pageInput.set_value(String(this.page));
    }
    this.continuous = !this.continuous;
    this.pan = { x: 24, y: 24 };
    if (this.continuous) this.scroll.scroll_to_item(this.page - 1, "top");
    this.pumpPages(cx);
    cx.notify();
  }

  openSearch() {
    if (!this.doc) return;
    openOverlay({ mod: "document-reader", kind: "dialog", width: 540, height: 154, props: { role: "search", readerId: this.readerId, query: this.lastQuery ?? "" } });
  }

  openHelp() {
    openOverlay({ mod: "document-reader", kind: "dialog", width: 760, height: 500, props: { role: "help" } });
  }

  openExternal(cx) {
    if (!this.source) return;
    if (this.doc?.on || props()?.on) {
      this.externalError = "External open needs a local copy of this remote document";
      cx.notify();
      return;
    }
    this.externalError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = this.source.toLowerCase().endsWith(".pdf")
        ? await exec("zathura", ["--fork", this.source]).catch((error) => ({ code: -1, stderr: String(error) }))
        : await exec("libreoffice", [this.source]).catch((error) => ({ code: -1, stderr: String(error) }));
      this.externalError = r.code === 0 ? null : r.stderr || "Could not open the external application";
      cx.notify();
    });
  }

  search(query, direction, cx) {
    if (!this.doc || !query) return;
    if (query === this.lastQuery && this.searchResults?.length) {
      this.stepSearch(direction, cx);
      return;
    }
    const doc = this.doc;
    const generation = this.generation;
    this.lastQuery = query;
    this.searching = true;
    this.searchMessage = "Searching…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const pages = await textPages(doc);
        if (this.closed || generation !== this.generation || this.doc !== doc) return;
        const needle = query.toLocaleLowerCase();
        const results = [];
        let matches = 0;
        for (let i = 0; i < Math.min(doc.count, pages.length); i++) {
          const text = pages[i].toLocaleLowerCase();
          const count = text.split(needle).length - 1;
          if (count > 0) {
            results.push(i + 1);
            matches += count;
          }
        }
        this.searchResults = results;
        this.searchMatches = matches;
        if (!results.length) {
          this.searchMessage = "No matches";
        } else {
          const current = this.continuous ? this.visiblePage : this.page;
          let index = results.findIndex((page) => direction > 0 ? page >= current : page <= current);
          if (index < 0) index = direction > 0 ? 0 : results.length - 1;
          this.searchIndex = index;
          this.searchMessage = `${index + 1}/${results.length} matching pages · ${matches} matches`;
          this.goTo(results[index], cx);
        }
      } catch (error) {
        if (generation === this.generation) this.searchMessage = String(error?.message ?? error);
      } finally {
        this.searching = false;
        if (generation === this.generation) cx.notify();
      }
    });
  }

  stepSearch(direction, cx) {
    if (!this.searchResults?.length) {
      if (this.lastQuery) this.search(this.lastQuery, direction, cx);
      else this.openSearch();
      return;
    }
    this.searchIndex = ((this.searchIndex ?? 0) + direction + this.searchResults.length) % this.searchResults.length;
    this.searchMessage = `${this.searchIndex + 1}/${this.searchResults.length} matching pages · ${this.searchMatches} matches`;
    this.goTo(this.searchResults[this.searchIndex], cx);
  }

  key(event, cx) {
    if (this.editingPage) return false;
    const key = event.keystroke;
    if (event.modifiers.control || event.modifiers.platform || event.modifiers.alt) {
      if (key === "ctrl-d") this.nextPage(1, cx);
      else if (key === "ctrl-u") this.nextPage(-1, cx);
      else if (key === "ctrl-f") this.nextPage(1, cx);
      else if (key === "ctrl-b") this.nextPage(-1, cx);
      else return false;
      return true;
    }
    if (/^[1-9]$/.test(key)) {
      this.countPrefix += key;
      return true;
    }
    if (key === "0" && this.countPrefix) {
      this.countPrefix += "0";
      return true;
    }
    if (key === "g") {
      if (this.lastG && Date.now() - this.lastG < 800) {
        this.goTo(this.countPrefix ? Number(this.countPrefix) : 1, cx);
        this.countPrefix = "";
        this.lastG = null;
      } else this.lastG = Date.now();
      return true;
    }
    this.lastG = null;
    const count = this.countPrefix ? Number(this.countPrefix) : null;
    if (key === "shift-g") {
      this.goTo(count ?? this.pageCount, cx);
      this.countPrefix = "";
      return true;
    }
    if (["j", "down", "shift-j", "pagedown", "space"].includes(key)) this.nextPage(count ?? 1, cx);
    else if (["k", "up", "shift-k", "pageup", "shift-space"].includes(key)) this.nextPage(-(count ?? 1), cx);
    else if (key === "h" || key === "left") this.panBy(70, 0, cx);
    else if (key === "l" || key === "right") this.panBy(-70, 0, cx);
    else if (key === "+" || key === "=") this.zoomAt(1.25, null, cx);
    else if (key === "-") this.zoomAt(1 / 1.25, null, cx);
    else if (key === "0") this.fit("page", cx);
    else if (key === "a") this.fit("page", cx);
    else if (key === "s") this.fit("width", cx);
    else if (key === "c") this.toggleContinuous(cx);
    else if (key === "r" || key === "shift-r") this.queueReload(cx, true);
    else if (key === "o") this.openExternal(cx);
    else if (key === "n") this.stepSearch(1, cx);
    else if (key === "shift-n") this.stepSearch(-1, cx);
    else if (key === "/" || event.key_char === "/") this.openSearch();
    else if (key === "?" || event.key_char === "?") this.openHelp();
    else if (key === "q") {
      const pane = props()?.pane;
      if (pane) run("pane.close", { pane });
    } else if (key === "escape" && (this.searchMessage || this.countPrefix)) {
      this.searchMessage = "";
      this.searchResults = [];
      this.countPrefix = "";
    } else return false;
    this.countPrefix = "";
    return true;
  }

  button(id, label, action, tooltip, active = false, enabled = true) {
    const t = theme();
    return div().id(`dr-${this.readerId}-${id}`).h(26).px(8).flex_none().flex().items_center().justify_center().rounded(6)
      .bg(active ? t.selected : t.background).text_color(enabled ? (active ? t.foreground : t.muted) : t.dim).text_size(12)
      .when(Boolean(tooltip), (element) => element.tooltip(tooltip).accessibility_label(tooltip))
      .when(enabled, (element) => element.cursor_pointer().hover((state) => state.bg(t.hover).text_color(t.foreground)).on_click((_event, cx) => {
        cx.stop_propagation();
        this.keyboard.focus();
        action(cx);
      }))
      .child(label);
  }

  toolbar() {
    const t = theme();
    return h_flex().h(40).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border).overflow_x_scrollbar()
      .child(this.button("prev", "‹", (cx) => this.nextPage(-1, cx), "Previous page (k)", false, this.pageCount > 0))
      .child(div().w(58).h(26).px(5).flex_none().flex().items_center().rounded(6).border_1().border_color(this.editingPage ? t.accent : t.input).cursor_text()
        .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
        .child(Input.new(this.pageInput).w_full().text_size(12).text_color(t.foreground)))
      .child(div().flex_none().text_size(11.5).text_color(t.dim).child(`/ ${this.pageCount || "…"}`))
      .child(this.button("next", "›", (cx) => this.nextPage(1, cx), "Next page (j)", false, this.pageCount > 0))
      .child(div().w(8).flex_none())
      .child(this.button("zoom-out", "−", (cx) => this.zoomAt(1 / 1.25, null, cx), "Zoom out (-)", false, Boolean(this.doc)))
      .child(this.button("zoom", `${Math.round(this.zoom * 100)}%`, (cx) => this.fit("page", cx), "Fit page (0 / a)"))
      .child(this.button("zoom-in", "+", (cx) => this.zoomAt(1.25, null, cx), "Zoom in (+)", false, Boolean(this.doc)))
      .child(this.button("fit-width", "Width", (cx) => this.fit("width", cx), "Fit width (s)", this.fitMode === "width" && this.zoom === 1))
      .child(div().w(8).flex_none())
      .child(this.button("mode", this.continuous ? "Scroll" : "Page", (cx) => this.toggleContinuous(cx), "Toggle single-page / continuous (c)", this.continuous))
      .child(this.button("search", "Find", () => this.openSearch(), "Search (/); Herdr: Ctrl-Shift-F", false, Boolean(this.doc)))
      .child(this.button("reload", this.refreshing ? "Updating…" : "Reload", (cx) => this.queueReload(cx, true), "Reload latest file (r); Herdr: Ctrl-Shift-R", false, !this.loadingDocument))
      .child(this.button("open", this.doc?.kind === "pdf" ? "Zathura" : "LibreOffice", (cx) => this.openExternal(cx), "Open in the external application (o)", false, Boolean(this.doc)));
  }

  singlePage() {
    const t = theme();
    const entry = this.pages.get(this.page);
    const size = this.dimensions();
    const origin = this.origin(size);
    const oversized = size.width > this.viewport.width || size.height > this.viewport.height;
    return div().id(`dr-single-${this.readerId}`).size_full().relative().overflow_hidden().bg(t.canvas)
      .when(Boolean(entry?.path), (element) => element.child(image(entry.path).absolute().left(origin.x).top(origin.y).w(size.width).h(size.height).rounded(3).shadow_md()))
      .when(!entry?.path, (element) => element.child(div().m_auto().p(24).rounded(8).bg(t.surface).text_color(entry?.error ? t.ansi1 : t.dim).child(entry?.error || `Rendering page ${this.page}…`)))
      .when(oversized, (element) => element.cursor_grab())
      .when(this.dragging, (element) => element.cursor_grabbing())
      .on_hover((hovered, cx) => {
        if (!hovered && this.dragging) {
          this.dragging = false;
          cx.notify();
        }
      })
      .on_mouse_down("left", (event, cx) => {
        this.keyboard.focus();
        if (event.click_count === 2 && event.local_position) {
          if (this.zoom !== 1 || this.fitMode !== "page") this.fit("page", cx);
          else this.zoomAt(2, event.local_position, cx);
          return;
        }
        if (oversized) {
          this.dragging = { x: event.position.x, y: event.position.y };
          cx.notify();
        }
      })
      .on_mouse_up("left", (_event, cx) => { this.dragging = false; cx.notify(); })
      .on_mouse_move((event, cx) => {
        if (!this.dragging) return;
        const last = this.dragging;
        this.dragging = { x: event.position.x, y: event.position.y };
        this.panBy(event.position.x - last.x, event.position.y - last.y, cx);
      })
      .on_scroll_wheel((event, cx) => {
        cx.stop_propagation();
        if (event.modifiers.control || event.modifiers.platform) {
          if (Math.abs(event.delta.y) > 0) this.zoomAt(event.delta.y > 0 ? 1.08 : 1 / 1.08, event.local_position ?? null, cx);
          return;
        }
        const current = this.dimensions();
        const oversized = current.width > this.viewport.width || current.height > this.viewport.height;
        if (oversized || event.modifiers.shift) {
          this.panBy(event.modifiers.shift ? event.delta.y : event.delta.x, event.modifiers.shift ? 0 : event.delta.y, cx);
          return;
        }
        const now = Date.now();
        if (now - this.lastWheelPage < 250) return;
        this.wheel += event.delta.y;
        if (Math.abs(this.wheel) >= 45) {
          this.nextPage(this.wheel < 0 ? 1 : -1, cx);
          this.wheel = 0;
          this.lastWheelPage = now;
        }
      });
  }

  continuousPages() {
    const t = theme();
    const id = `dr-pages-${this.readerId}`;
    const width = Math.max(160, (this.viewport.width - 48) * this.zoom);
    const ratio = (page) => {
      const entry = this.pages.get(page);
      return entry ? entry.height / entry.width : this.ratio;
    };
    const height = (page) => width * ratio(page) + GAP;
    const row = (index) => {
      const page = index + 1;
      const entry = this.pages.get(page);
      return div().h(height(page)).w_full().flex().justify_center().pt(GAP)
        .child(entry?.path
          ? image(entry.path).w(width).h(width * ratio(page)).flex_none().rounded(3).shadow_md()
          : div().w(width).h(width * ratio(page)).flex_none().rounded(3).bg(t.surface).flex().items_center().justify_center().text_color(entry?.error ? t.ansi1 : t.dim).child(entry?.error || `Page ${page}`));
    };
    return v_flex().relative().flex_1().min_h(0).bg(t.canvas)
      .on_scroll_wheel((_event, cx) => cx.notify())
      .child(div().id(`${id}-x`).size_full().overflow_x_scrollbar()
        .child(v_flex().min_w(width + 48).h_full()
          .child(v_virtual_list(id, this.pageCount, Array.from({ length: this.pageCount }, (_, index) => height(index + 1)),
            (index) => `p${index}`,
            (range) => {
              this.visiblePage = range.start + 1;
              return Array.from({ length: range.end - range.start }, (_, offset) => row(range.start + offset));
            })
            .track_scroll(this.scroll).flex_1().min_h(0)
            .on_item_click((key, cx) => {
              this.page = Number(key.slice(1)) + 1;
              this.pageInput.set_value(String(this.page));
              this.keyboard.focus();
              cx.notify();
            }))))
      .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0());
  }

  reader(cx) {
    const pending = shared(this.commandKey);
    if (pending?.seq !== this.commandSeq) {
      this.commandSeq = pending?.seq;
      if (pending?.action === "search") this.search(pending.query, pending.direction, cx);
    }
    const t = theme();
    const body = !this.doc && this.loadingDocument
      ? div().m_auto().text_color(t.dim).child(this.source?.toLowerCase().endsWith(".pdf") ? "Opening PDF…" : "Converting document…")
      : !this.doc && this.error
        ? v_flex().m_auto().max_w(560).p(20).gap(12).child(div().text_color(t.ansi1).child(this.error)).child(this.button("retry", "Try again", (cx) => this.queueReload(cx, true), "Try again"))
        : this.continuous ? this.continuousPages() : this.singlePage();
    return v_flex().id(`document-reader-${this.readerId}`).size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .track_focus(this.keyboard).on_key_down((event, cx) => {
        if (this.key(event, cx)) {
          cx.stop_propagation();
          cx.notify();
        }
      })
      .on_mouse_down("left", () => this.keyboard.focus())
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13).child(basename(this.source ?? "Document Reader")))
        .when(this.refreshing, (element) => element.child(div().flex_none().text_size(11).text_color(t.working).child("Auto-refreshing…")))
        .child(this.button("help", "?", () => this.openHelp(), "Reader keys and mouse controls (?)")))
      .child(this.toolbar())
      .child(v_flex().flex_1().min_h(0).on_size_change((size, cx) => {
        const zoom = settings().zoom || 1;
        const next = { width: size.width / zoom, height: size.height / zoom };
        if (next.width !== this.viewport.width || next.height !== this.viewport.height) {
          this.viewport = next;
          this.pan = this.clampPan(this.pan);
          cx.notify();
        }
      }).child(body))
      .child(h_flex().min_h(24).flex_none().px(10).gap(10).items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child(div().child(this.continuous ? `Page ${this.visiblePage}/${this.pageCount} · continuous` : `Page ${this.page}/${this.pageCount} · single`))
        .child(div().flex_1().min_w(0).truncate().text_color(this.externalError || this.error || /no matches|could not|error/i.test(this.searchMessage ?? "") ? t.ansi1 : t.dim).child(this.externalError || (this.doc && this.error) || this.searchMessage || (this.countPrefix ? `Go to ${this.countPrefix}…` : "Auto-reload on · mouse wheel · ? for keys")))
        .child(div().child(this.doc ? `${this.doc.on ? `${this.doc.on} · ` : ""}${this.doc.kind} · ${Math.round(this.zoom * 100)}%` : "")));
  }

  searchDialog() {
    const t = theme();
    const close = () => closeOverlay(props()?.overlay);
    return v_flex().id("document-reader-search").w_full().p(18).gap(12).bg(t.popover).text_color(t.foreground)
      .child(div().font_semibold().text_size(15).child("Search document"))
      .child(Input.new(this.input).h(36).px(10).rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(13).text_color(t.foreground))
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().text_size(11).text_color(t.dim).child("Enter: next · Shift+Enter: previous · Esc: close"))
        .child(this.dialogButton("prev", "Previous", () => this.submitSearch(-1)))
        .child(this.dialogButton("next", "Next", () => this.submitSearch(1)))
        .child(this.dialogButton("close", "Close", close)));
  }

  dialogButton(id, label, action) {
    const t = theme();
    return div().id(`dr-dialog-${id}`).h(28).px(10).flex().items_center().rounded(6).bg(t.raised).cursor_pointer().text_size(12)
      .hover((state) => state.bg(t.hover)).on_click(action).child(label);
  }

  helpDialog() {
    const t = theme();
    const groups = [
      ["Navigate", [["j / ↓", "Next page"], ["k / ↑", "Previous page"], ["J / K", "Next / previous page"], ["Ctrl-d / Ctrl-u", "Half-screen down / up"], ["Ctrl-f / Ctrl-b", "Page down / up"], ["gg / G", "First / last page"], ["12G", "Go to page 12"], ["h / l", "Pan a zoomed page"], ["c", "Single-page / continuous"]]],
      ["Read", [["+ / -", "Zoom in / out"], ["0 / a", "Fit page"], ["s", "Fit width"], ["/", "Search"], ["n / N", "Next / previous match"], ["r / R", "Reload latest file"], ["o", "Open externally"], ["q", "Close reader"], ["?", "This help"]]],
      ["Mouse", [["Wheel", "Turn pages; scroll in continuous mode"], ["Ctrl + wheel", "Zoom around the pointer in single-page mode"], ["Drag", "Pan a zoomed page"], ["Double-click", "Fit page / 200% at pointer"], ["Toolbar", "Every action also works by mouse"]]],
      ["Herdr", [["Ctrl/Cmd/Alt shortcuts", "Left to Herdr"], ["Ctrl-Shift-F", "Search this document"], ["Ctrl-Shift-R", "Reload this document"], ["Ctrl-+ / Ctrl-0", "Herdr app zoom, unchanged"], ["Alt-h/j/k/l", "Herdr pane navigation, unchanged"], ["Ctrl-Shift-P", "Herdr command palette, unchanged"]]],
    ];
    const group = ([title, rows]) => v_flex().gap(5)
      .child(div().pb(3).text_size(11).font_semibold().text_color(t.accent).child(title.toUpperCase()))
      .children(rows.map(([key, description]) => h_flex().gap(10)
        .child(div().w(125).flex_none().font_family("JetBrains Mono").text_size(11).text_color(t.muted).child(key))
        .child(div().flex_1().text_size(11.5).text_color(t.foreground).child(description))));
    return v_flex().id("document-reader-help").track_focus(this.keyboard).on_key_down((event, cx) => {
      if (["escape", "q"].includes(event.key) || event.key_char === "?") {
        closeOverlay(props()?.overlay);
        cx.stop_propagation();
      }
    }).w_full().p(20).gap(12).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().font_semibold().text_size(16).child("Document Reader"))
        .child(this.dialogButton("help-close", "Close", () => closeOverlay(props()?.overlay))))
      .child(h_flex().items_start().gap(28)
        .child(v_flex().flex_1().gap(16).children(groups.slice(0, 2).map(group)))
        .child(v_flex().flex_1().gap(16).children(groups.slice(2).map(group))));
  }

  render(cx) {
    if (this.role === "help") return this.helpDialog();
    if (this.role === "search") return this.searchDialog();
    return this.reader(cx);
  }
}
