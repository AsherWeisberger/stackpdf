/* StackPDF — merge and split PDFs entirely in this tab. */

function yieldToMain() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + " KB";
  return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
}

function uid() {
  return "f" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function isPdf(file) {
  if (!file) return false;
  if (file.type === "application/pdf") return true;
  return /\.pdf$/i.test(file.name);
}

function parseRanges(text, pageCount) {
  var raw = String(text || "").trim();
  if (!raw) throw new Error("Enter a page range.");
  var parts = raw.split(/[,;]/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!parts.length) throw new Error("Enter a page range.");
  var pages = [];
  var seen = {};
  function add(n) {
    if (!Number.isInteger(n) || n < 1 || n > pageCount) {
      throw new Error("Page " + n + " is out of range (1-" + pageCount + ").");
    }
    if (!seen[n]) { seen[n] = true; pages.push(n); }
  }
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    var single = part.match(/^(\d+)$/);
    var range = part.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (single) {
      add(Number(single[1]));
    } else if (range) {
      var a = Number(range[1]);
      var b = Number(range[2]);
      var step = a <= b ? 1 : -1;
      for (var n = a; step > 0 ? n <= b : n >= b; n += step) add(n);
    } else {
      throw new Error("Cannot parse \"" + part + "\".");
    }
  }
  if (!pages.length) throw new Error("Enter a page range.");
  return pages;
}

function compactRanges(pages) {
  if (!pages.length) return "";
  var s = pages.slice().sort(function (a, b) { return a - b; });
  var parts = [];
  var start = s[0];
  var prev = s[0];
  for (var i = 1; i <= s.length; i++) {
    if (i < s.length && s[i] === prev + 1) { prev = s[i]; continue; }
    parts.push(start === prev ? String(start) : start + "-" + prev);
    if (i < s.length) { start = prev = s[i]; }
  }
  return parts.join(", ");
}

var CRC_TABLE = (function () {
  var t = new Uint32Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  var c = 0xffffffff;
  for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(parts) {
  var total = 0;
  for (var i = 0; i < parts.length; i++) total += parts[i].length;
  var out = new Uint8Array(total);
  var off = 0;
  for (var j = 0; j < parts.length; j++) { out.set(parts[j], off); off += parts[j].length; }
  return out;
}

function u16(n) {
  var b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

function u32(n) {
  var b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function zipStore(files) {
  var encoder = new TextEncoder();
  var locals = [];
  var centrals = [];
  var offset = 0;
  for (var i = 0; i < files.length; i++) {
    var nameBytes = encoder.encode(String(files[i].name).replace(/\\/g, "/"));
    var data = files[i].data;
    var crc = crc32(data);
    var local = concatBytes([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBytes.length), u16(0), nameBytes, data
    ]);
    locals.push(local);
    centrals.push(concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), nameBytes
    ]));
    offset += local.length;
  }
  var central = concatBytes(centrals);
  var eocd = concatBytes([
    u32(0x06054b50), u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(central.length), u32(offset), u16(0)
  ]);
  return concatBytes(locals.concat([central, eocd]));
}

function lib() {
  var L = (typeof PDFLib !== "undefined") ? PDFLib : (typeof window !== "undefined" ? window.PDFLib : null);
  if (!L || !L.PDFDocument) throw new Error("pdf-lib failed to load.");
  return L;
}

async function mergePdfs(items, onProgress) {
  var PDFDocument = lib().PDFDocument;
  var out = await PDFDocument.create();
  var total = 0;
  for (var t = 0; t < items.length; t++) total += items[t].pageCount;
  var done = 0;
  var BATCH = 6;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (onProgress) onProgress({ phase: "read", file: item.name, done: done, total: total });
    var src = await PDFDocument.load(item.bytes.slice(), { ignoreEncryption: true, updateMetadata: false });
    var idxs = src.getPageIndices();
    for (var j = 0; j < idxs.length; j += BATCH) {
      var slice = idxs.slice(j, j + BATCH);
      var copied = await out.copyPages(src, Array.from(slice));
      for (var k = 0; k < copied.length; k++) out.addPage(copied[k]);
      done += slice.length;
      if (onProgress) onProgress({ phase: "merge", file: item.name, done: done, total: total });
      await yieldToMain();
    }
  }
  if (onProgress) onProgress({ phase: "save", file: "", done: total, total: total });
  try { out.setProducer("StackPDF"); out.setCreator("StackPDF"); } catch (e) {}
  return await out.save();
}

async function extractPages(bytes, pages1, onProgress) {
  var PDFDocument = lib().PDFDocument;
  var src = await PDFDocument.load(bytes.slice ? bytes.slice() : bytes, { ignoreEncryption: true, updateMetadata: false });
  var out = await PDFDocument.create();
  var zero = pages1.map(function (n) { return n - 1; });
  var BATCH = 6;
  for (var i = 0; i < zero.length; i += BATCH) {
    var slice = zero.slice(i, i + BATCH);
    var copied = await out.copyPages(src, Array.from(slice));
    for (var k = 0; k < copied.length; k++) out.addPage(copied[k]);
    if (onProgress) onProgress({ phase: "split", done: Math.min(i + slice.length, zero.length), total: zero.length });
    await yieldToMain();
  }
  try { out.setProducer("StackPDF"); out.setCreator("StackPDF"); } catch (e) {}
  return await out.save();
}

async function splitEveryPage(bytes, baseName, onProgress) {
  var PDFDocument = lib().PDFDocument;
  var src = await PDFDocument.load(bytes.slice ? bytes.slice() : bytes, { ignoreEncryption: true, updateMetadata: false });
  var n = src.getPageCount();
  var files = [];
  var pad = String(n).length;
  var stem = String(baseName || "page").replace(/\.pdf$/i, "");
  for (var i = 0; i < n; i++) {
    var out = await PDFDocument.create();
    var copied = await out.copyPages(src, [i]);
    out.addPage(copied[0]);
    var data = await out.save();
    files.push({
      name: stem + "-p" + String(i + 1).padStart(pad, "0") + ".pdf",
      data: data
    });
    if (onProgress) onProgress({ phase: "split", done: i + 1, total: n });
    await yieldToMain();
  }
  return { files: files, zip: n > 1 ? zipStore(files) : null };
}

function oddPages(n) {
  var a = [];
  for (var i = 1; i <= n; i += 2) a.push(i);
  return a;
}

function evenPages(n) {
  var a = [];
  for (var i = 2; i <= n; i += 2) a.push(i);
  return a;
}

var MAX_FILE_BYTES = 64 * 1024 * 1024;
var MAX_TOTAL_BYTES = 200 * 1024 * 1024;

function classifyPdfError(err) {
  var msg = err && err.message ? String(err.message) : "";
  if (/encrypt/i.test(msg)) return "This PDF is password-protected.";
  return "This PDF is damaged or unreadable.";
}

var StackPDF = {
  parseRanges: parseRanges,
  compactRanges: compactRanges,
  oddPages: oddPages,
  evenPages: evenPages,
  mergePdfs: mergePdfs,
  extractPages: extractPages,
  splitEveryPage: splitEveryPage,
  zipStore: zipStore
};

if (typeof window !== "undefined") window.StackPDF = StackPDF;
if (typeof module !== "undefined" && module.exports) module.exports = StackPDF;


if (typeof document !== "undefined") {
  bootUi();
}

function bootUi() {
  var items = [];
  var selectedId = null;
  var busy = false;
  var toastTimer = 0;
  var sort = null;
  var knownIds = {};
  var lastGridId = null;
  var leaving = {};

  function prefersReduced() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function replayStage(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    if (prefersReduced()) return;
    void el.offsetWidth;
    el.classList.add(cls);
  }

  var ICON = {
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M6 13l6 6 6-6"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-9" stroke="currentColor" fill="none"/></svg>'
  };

  var els = {
    stage: document.getElementById("stage"),
    empty: document.getElementById("empty"),
    work: document.getElementById("work"),
    stack: document.getElementById("stack"),
    pagesPanel: document.getElementById("pagesPanel"),
    pagesTitle: document.getElementById("pagesTitle"),
    pagesSub: document.getElementById("pagesSub"),
    pageGrid: document.getElementById("pageGrid"),
    progress: document.getElementById("progress"),
    progressLabel: document.getElementById("progressLabel"),
    progressBar: document.getElementById("progressBar"),
    progressTrack: document.getElementById("progressTrack"),
    fileHint: document.getElementById("fileHint"),
    mergeHint: document.getElementById("mergeHint"),
    splitHint: document.getElementById("splitHint"),
    mergeBtn: document.getElementById("mergeBtn"),
    extractBtn: document.getElementById("extractBtn"),
    everyBtn: document.getElementById("everyBtn"),
    rangeInput: document.getElementById("rangeInput"),
    fileInput: document.getElementById("fileInput"),
    topMeta: document.getElementById("topMeta"),
    chooseBtn: document.getElementById("chooseBtn"),
    addBtn: document.getElementById("addBtn"),
    allPagesBtn: document.getElementById("allPagesBtn"),
    clearPagesBtn: document.getElementById("clearPagesBtn"),
    oddPagesBtn: document.getElementById("oddPagesBtn"),
    evenPagesBtn: document.getElementById("evenPagesBtn"),
    toast: document.getElementById("toast"),
    dock: document.getElementById("dock")
  };

  function okItems() { return items.filter(function (it) { return it.status === "ok"; }); }
  function selected() { return items.find(function (it) { return it.id === selectedId && it.status === "ok"; }) || null; }

  function setHint(el, text, err) {
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-err", !!err);
  }

  function showToast(text) {
    if (!els.toast) return;
    els.toast.hidden = !text;
    els.toast.textContent = text || "";
    clearTimeout(toastTimer);
    if (text) {
      toastTimer = setTimeout(function () {
        els.toast.hidden = true;
      }, 5200);
    }
  }

  function showProgress(on, label, done, total) {
    els.progress.hidden = !on;
    if (!on) return;
    els.progressLabel.textContent = label || "Working";
    var pct;
    if (!total || total < 1) pct = 8;
    else if (done <= 0) pct = 6;
    else if (done >= total) pct = 100;
    else pct = Math.max(6, Math.min(96, Math.round((done / total) * 100)));
    els.progressBar.style.width = pct + "%";
    els.progressTrack.setAttribute("aria-valuenow", String(pct));
    els.progressTrack.setAttribute("aria-label", label || "Working");
  }

  function downloadBytes(bytes, name, type) {
    var blob = new Blob([bytes], { type: type || "application/pdf" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function currentRangePages() {
    var sel = selected();
    if (!sel) return [];
    try { return parseRanges(els.rangeInput.value, sel.pageCount); }
    catch (e) { return []; }
  }

  function iconBtn(svg, title, cls, fn, disabled) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "icon-btn" + (cls ? " " + cls : "");
    b.innerHTML = svg;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.disabled = !!disabled;
    b.addEventListener("click", function (ev) { ev.stopPropagation(); fn(); });
    return b;
  }

  function render() {
    if (sort) return;
    var ok = okItems();
    var totalPages = ok.reduce(function (s, it) { return s + it.pageCount; }, 0);
    var totalBytes = ok.reduce(function (s, it) { return s + it.size; }, 0);
    var hasFiles = items.length > 0;
    var reduce = prefersReduced();
    var firstRects = {};
    if (!reduce) {
      els.stack.querySelectorAll(".card").forEach(function (c) {
        firstRects[c.dataset.id] = c.getBoundingClientRect();
      });
    }

    var showingWork = hasFiles && els.work.hidden;
    var showingEmpty = !hasFiles && els.empty.hidden;
    els.empty.hidden = hasFiles;
    els.work.hidden = !hasFiles;
    els.dock.hidden = !hasFiles;
    if (showingWork) {
      replayStage(els.work, "is-enter-stage");
      replayStage(els.dock, "is-enter-stage");
    }
    if (showingEmpty) replayStage(els.empty, "is-enter-stage");

    els.topMeta.textContent = ok.length
      ? (ok.length + (ok.length === 1 ? " file" : " files") + " · " + totalPages + " pages")
      : (items.length ? "Reading…" : "");

    els.stack.replaceChildren();
    items.forEach(function (it, idx) {
      var card = document.createElement("article");
      var isNew = !knownIds[it.id];
      knownIds[it.id] = true;
      card.className = "card" + (it.id === selectedId ? " is-on" : "") + (it.status === "error" ? " is-error" : "") + (isNew && !reduce ? " is-enter" : "");
      card.dataset.id = it.id;
      if (isNew && !reduce) {
        card.addEventListener("animationend", function () { card.classList.remove("is-enter"); }, { once: true });
      }
      card.setAttribute("role", "listitem");
      card.setAttribute("aria-selected", it.id === selectedId ? "true" : "false");
      card.tabIndex = 0;

      var handle = document.createElement("button");
      handle.type = "button";
      handle.className = "handle";
      handle.dataset.handle = "1";
      handle.setAttribute("aria-label", "Reorder " + it.name);
      handle.innerHTML = "<span></span><span></span><span></span>";

      var preview = document.createElement("div");
      preview.className = "card-preview";
      preview.setAttribute("aria-hidden", "true");
      preview.innerHTML = "<i></i><i></i>";

      var copy = document.createElement("div");
      copy.className = "card-copy";
      var h = document.createElement("h3");
      h.textContent = it.name;
      h.title = it.name;
      var meta = document.createElement("p");
      if (it.status === "reading") meta.textContent = "Reading…";
      else if (it.status === "error") meta.textContent = it.error || "Unreadable";
      else {
        meta.textContent = it.pageCount + (it.pageCount === 1 ? " page" : " pages") + " · " + formatBytes(it.size);
        if (it.id === selectedId) {
          var tag = document.createElement("span");
          tag.className = "sel-tag";
          tag.textContent = "Selected";
          meta.appendChild(tag);
        }
      }
      copy.appendChild(h);
      copy.appendChild(meta);

      var actions = document.createElement("div");
      actions.className = "card-actions";
      actions.appendChild(iconBtn(ICON.up, "Move up", "", function () { move(idx, idx - 1); }, idx === 0 || busy));
      actions.appendChild(iconBtn(ICON.down, "Move down", "", function () { move(idx, idx + 1); }, idx === items.length - 1 || busy));
      actions.appendChild(iconBtn(ICON.x, "Remove " + it.name, "danger", function () { removeAt(idx); }, busy));

      card.appendChild(handle);
      card.appendChild(preview);
      card.appendChild(copy);
      card.appendChild(actions);
      card.addEventListener("click", function (ev) {
        if (ev.target.closest(".handle") || ev.target.closest(".card-actions")) return;
        select(it.id);
      });
      card.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          select(it.id);
        }
      });
      els.stack.appendChild(card);
    });

    if (!reduce) {
      els.stack.querySelectorAll(".card").forEach(function (c) {
        if (c.classList.contains("is-enter")) return;
        var f = firstRects[c.dataset.id];
        if (!f) return;
        var last = c.getBoundingClientRect();
        var dy = f.top - last.top;
        if (Math.abs(dy) < 0.5) return;
        c.animate(
          [{ transform: "translateY(" + dy + "px)" }, { transform: "translateY(0)" }],
          { duration: 480, easing: "cubic-bezier(0.22, 1.2, 0.36, 1)" }
        );
      });
    }
    var live = {};
    items.forEach(function (it) { live[it.id] = true; });
    Object.keys(knownIds).forEach(function (id) { if (!live[id]) delete knownIds[id]; });

    var errCount = items.filter(function (it) { return it.status === "error"; }).length;
    if (!items.length) setHint(els.fileHint, "", false);
    else if (errCount) setHint(els.fileHint, errCount + (errCount === 1 ? " file" : " files") + " couldn’t be read.", true);
    else setHint(els.fileHint, "This tab only.", false);

    els.mergeBtn.disabled = busy || ok.length < 2;
    els.mergeBtn.textContent = ok.length >= 2 ? ("Merge " + ok.length) : "Merge";
    els.mergeBtn.title = ok.length < 2 ? "Add at least two PDFs to merge." : ("Combine " + ok.length + " files · " + totalPages + " pages");
    setHint(els.mergeHint, ok.length >= 2 ? (ok.length + " files · " + totalPages + " pages → stackpdf-merged.pdf") : "", false);

    var sel = selected();
    var picked = [];
    var rangeOk = false;
    if (sel) {
      try {
        picked = parseRanges(els.rangeInput.value, sel.pageCount);
        rangeOk = picked.length > 0;
        setHint(els.splitHint, "Extract " + picked.length + (picked.length === 1 ? " page" : " pages") + " from " + sel.name + ".", false);
      } catch (e) {
        setHint(els.splitHint, els.rangeInput.value.trim() ? e.message : (sel.pageCount + " pages in " + sel.name + "."), !!els.rangeInput.value.trim());
      }
    } else {
      setHint(els.splitHint, "Select a file to extract pages.", false);
    }

    els.everyBtn.disabled = busy || !sel;
    els.everyBtn.textContent = sel ? ("Every page · " + sel.pageCount) : "Every page";
    els.extractBtn.disabled = busy || !sel || !rangeOk;
    els.extractBtn.textContent = rangeOk ? ("Extract " + picked.length) : "Extract";

    syncChips(sel, picked);
    renderGrid();
  }

  function syncChips(sel, picked) {
    var allOn = false, oddOn = false, evenOn = false;
    if (sel && picked && picked.length) {
      var all = [];
      for (var i = 1; i <= sel.pageCount; i++) all.push(i);
      allOn = compactRanges(picked) === compactRanges(all);
      oddOn = compactRanges(picked) === compactRanges(oddPages(sel.pageCount));
      evenOn = compactRanges(picked) === compactRanges(evenPages(sel.pageCount));
    }
    els.allPagesBtn.classList.toggle("is-on", allOn);
    els.oddPagesBtn.classList.toggle("is-on", oddOn);
    els.evenPagesBtn.classList.toggle("is-on", evenOn);
    els.allPagesBtn.setAttribute("aria-pressed", allOn ? "true" : "false");
    els.oddPagesBtn.setAttribute("aria-pressed", oddOn ? "true" : "false");
    els.evenPagesBtn.setAttribute("aria-pressed", evenOn ? "true" : "false");
  }

  function renderGrid() {
    var sel = selected();
    els.pagesPanel.hidden = !sel;
    els.pageGrid.replaceChildren();
    if (!sel) { lastGridId = null; return; }
    var picked = [];
    try { picked = parseRanges(els.rangeInput.value, sel.pageCount); } catch (e) { picked = []; }
    var set = {};
    picked.forEach(function (n) { set[n] = true; });
    els.pagesTitle.textContent = "Pages";
    els.pagesSub.textContent = picked.length
      ? (picked.length + " of " + sel.pageCount + " selected")
      : ("Tap pages in " + sel.name);
    var fresh = sel.id !== lastGridId;
    lastGridId = sel.id;
    if (fresh) {
      els.pagesPanel.classList.remove("is-fresh");
      if (!prefersReduced()) {
        void els.pagesPanel.offsetWidth;
        els.pagesPanel.classList.add("is-fresh");
      }
    } else {
      els.pagesPanel.classList.remove("is-fresh");
    }
    var maxShow = 80;
    var n, show = Math.min(sel.pageCount, maxShow);
    for (n = 1; n <= show; n++) {
      var leaf = leafBtn(n, !!set[n], sel.pageCount);
      if (fresh) leaf.style.setProperty("--i", String(Math.min(n - 1, 24)));
      els.pageGrid.appendChild(leaf);
    }
    if (sel.pageCount > maxShow) {
      els.pagesSub.textContent = (picked.length ? (picked.length + " selected") : "Select pages") + " · first " + maxShow + " shown, use range for the rest";
    }
  }

  function leafBtn(n, on, total) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "leaf" + (on ? " is-on" : "");
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.setAttribute("aria-label", "Page " + n + " of " + total + (on ? ", selected" : ""));
    var sheet = document.createElement("span");
    sheet.className = "leaf-sheet";
    var band = document.createElement("span");
    band.className = "leaf-band";
    var rules = document.createElement("span");
    rules.className = "leaf-rules";
    rules.setAttribute("aria-hidden", "true");
    rules.innerHTML = "<i></i><i></i><i></i><i></i>";
    var check = document.createElement("span");
    check.className = "leaf-check";
    check.innerHTML = ICON.check;
    sheet.appendChild(band);
    sheet.appendChild(rules);
    sheet.appendChild(check);
    var cap = document.createElement("span");
    cap.className = "leaf-cap";
    cap.textContent = String(n);
    b.appendChild(sheet);
    b.appendChild(cap);
    b.addEventListener("click", function () { togglePage(n); });
    return b;
  }

  function togglePage(n) {
    var sel = selected();
    if (!sel) return;
    var cur;
    try { cur = parseRanges(els.rangeInput.value, sel.pageCount); }
    catch (e) { cur = []; }
    var idx = cur.indexOf(n);
    if (idx >= 0) cur.splice(idx, 1);
    else cur.push(n);
    els.rangeInput.value = compactRanges(cur);
    render();
  }

  function setPages(pages) {
    els.rangeInput.value = compactRanges(pages);
    render();
  }

  function select(id) {
    var switching = selectedId !== id;
    selectedId = id;
    var sel = selected();
    if (sel && switching) {
      try { parseRanges(els.rangeInput.value, sel.pageCount); }
      catch (e) { els.rangeInput.value = "1-" + sel.pageCount; }
      if (!els.rangeInput.value.trim()) els.rangeInput.value = "1-" + sel.pageCount;
    }
    render();
  }

  function move(from, to) {
    if (to < 0 || to >= items.length) return;
    var it = items.splice(from, 1)[0];
    items.splice(to, 0, it);
    render();
  }

  function finishRemove(id) {
    var i = items.findIndex(function (it) { return it.id === id; });
    if (i < 0) return;
    var gone = items.splice(i, 1)[0];
    delete leaving[id];
    delete knownIds[id];
    if (gone && gone.id === selectedId) {
      var next = items.find(function (it) { return it.status === "ok"; });
      selectedId = next ? next.id : null;
    }
    render();
  }

  function removeAt(idx) {
    var gone = items[idx];
    if (!gone) return;
    if (leaving[gone.id]) return;
    var card = els.stack.querySelector('.card[data-id="' + gone.id + '"]');
    if (card && !prefersReduced() && !sort) {
      leaving[gone.id] = true;
      card.classList.add("is-leave");
      card.style.pointerEvents = "none";
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        finishRemove(gone.id);
      }
      card.addEventListener("animationend", finish, { once: true });
      setTimeout(finish, 340);
      return;
    }
    finishRemove(gone.id);
  }

  function indexFromPoint(clientY) {
    var cards = els.stack.querySelectorAll(".card");
    var i, rect, best = cards.length;
    for (i = 0; i < cards.length; i++) {
      rect = cards[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) { best = i; break; }
    }
    return Math.max(0, Math.min(items.length - 1, best === cards.length ? items.length - 1 : best));
  }

  function onSortDown(ev) {
    if (busy) return;
    var handle = ev.target.closest("[data-handle]");
    if (!handle) return;
    var card = handle.closest("[data-id]");
    if (!card) return;
    var id = card.dataset.id;
    var from = items.findIndex(function (x) { return x.id === id; });
    if (from < 0) return;
    ev.preventDefault();
    try { handle.setPointerCapture(ev.pointerId); } catch (e) {}
    card.classList.add("is-lift");
    sort = { id: id, from: from, pointerId: ev.pointerId, startY: ev.clientY };
  }

  function onSortMove(ev) {
    if (!sort || ev.pointerId !== sort.pointerId) return;
    ev.preventDefault();
    var to = indexFromPoint(ev.clientY);
    if (to === sort.from) return;
    var moved = items.splice(sort.from, 1)[0];
    items.splice(to, 0, moved);
    sort.from = to;
    var cards = Array.prototype.slice.call(els.stack.querySelectorAll(".card"));
    var orderIds = items.map(function (it) { return it.id; });
    cards.sort(function (a, b) {
      return orderIds.indexOf(a.dataset.id) - orderIds.indexOf(b.dataset.id);
    });
    cards.forEach(function (c) { els.stack.appendChild(c); });
  }

  function onSortUp(ev) {
    if (!sort || ev.pointerId !== sort.pointerId) return;
    var card = els.stack.querySelector('.card[data-id="' + sort.id + '"]');
    if (card) card.classList.remove("is-lift");
    sort = null;
    render();
  }

  async function addFiles(fileList) {
    var incoming = Array.prototype.slice.call(fileList || []);
    var files = incoming.filter(isPdf);
    var skipped = incoming.length - files.length;
    if (!files.length) {
      showToast("Only PDF files are accepted.");
      setHint(els.fileHint, "Only PDF files are accepted.", true);
      return;
    }
    if (skipped) showToast("Skipped " + skipped + (skipped === 1 ? " file that isn’t a PDF." : " files that aren’t PDFs."));
    if (typeof PDFLib === "undefined") {
      showToast("pdf-lib failed to load.");
      return;
    }
    var existing = items.reduce(function (s, it) { return s + (it.size || 0); }, 0);
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var it = { id: uid(), name: file.name, size: file.size, pageCount: 0, bytes: null, status: "reading", error: "" };
      if (file.size > MAX_FILE_BYTES) {
        it.status = "error";
        it.error = "Too large (" + formatBytes(file.size) + "). Max " + formatBytes(MAX_FILE_BYTES) + " per file.";
        items.push(it);
        render();
        continue;
      }
      if (existing + file.size > MAX_TOTAL_BYTES) {
        it.status = "error";
        it.error = "Would exceed the " + formatBytes(MAX_TOTAL_BYTES) + " tab limit.";
        items.push(it);
        render();
        continue;
      }
      items.push(it);
      if (!selectedId) selectedId = it.id;
      render();
      try {
        var buf = await file.arrayBuffer();
        var bytes = new Uint8Array(buf);
        var doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
        var n = doc.getPageCount();
        if (!n) throw new Error("This PDF has no pages.");
        it.bytes = bytes;
        it.pageCount = n;
        it.status = "ok";
        existing += file.size;
        if (it.id === selectedId && !els.rangeInput.value.trim() && n) {
          els.rangeInput.value = "1-" + n;
        }
      } catch (err) {
        it.status = "error";
        it.error = classifyPdfError(err);
        if (/no pages/i.test(err && err.message ? err.message : "")) it.error = "This PDF has no pages.";
        if (selectedId === it.id) {
          var nxt = items.find(function (x) { return x.status === "ok"; });
          selectedId = nxt ? nxt.id : null;
        }
      }
      render();
      await yieldToMain();
    }
  }

  async function runBusy(label, fn) {
    if (busy) return;
    busy = true;
    render();
    showProgress(true, label, 0, 1);
    try { await fn(); }
    catch (err) {
      var msg = (err && err.message) ? err.message : "Something failed.";
      if (/encrypt/i.test(msg)) msg = "This PDF is password-protected.";
      setHint(els.splitHint, msg, true);
      showToast(msg);
    }
    busy = false;
    showProgress(false);
    render();
  }

  function onProg(p) {
    var label = "Working";
    if (p.phase === "read") label = "Reading " + p.file;
    else if (p.phase === "merge") label = "Merging " + (p.file || "") + " · " + p.done + "/" + p.total + " pages";
    else if (p.phase === "split") label = "Splitting · " + p.done + "/" + p.total + " pages";
    else if (p.phase === "save") label = "Writing PDF";
    showProgress(true, label, p.done, p.total || 1);
  }

  els.mergeBtn.addEventListener("click", function () {
    runBusy("Merging", async function () {
      var bytes = await mergePdfs(okItems(), onProg);
      downloadBytes(bytes, "stackpdf-merged.pdf", "application/pdf");
    });
  });

  els.extractBtn.addEventListener("click", function () {
    var sel = selected();
    if (!sel) return;
    runBusy("Extracting", async function () {
      var pages = parseRanges(els.rangeInput.value, sel.pageCount);
      var bytes = await extractPages(sel.bytes, pages, onProg);
      var name = sel.name.replace(/\.pdf$/i, "") + "-extract.pdf";
      downloadBytes(bytes, name, "application/pdf");
    });
  });

  els.everyBtn.addEventListener("click", function () {
    var sel = selected();
    if (!sel) return;
    runBusy("Splitting pages", async function () {
      var result = await splitEveryPage(sel.bytes, sel.name.replace(/\.pdf$/i, ""), onProg);
      if (result.files.length === 1) {
        downloadBytes(result.files[0].data, result.files[0].name, "application/pdf");
      } else {
        downloadBytes(result.zip, sel.name.replace(/\.pdf$/i, "") + "-pages.zip", "application/zip");
      }
    });
  });

  els.rangeInput.addEventListener("input", function () { render(); });
  els.allPagesBtn.addEventListener("click", function () {
    var sel = selected();
    if (!sel) return;
    els.rangeInput.value = sel.pageCount ? ("1-" + sel.pageCount) : "";
    render();
  });
  els.clearPagesBtn.addEventListener("click", function () {
    els.rangeInput.value = "";
    render();
  });
  els.oddPagesBtn.addEventListener("click", function () {
    var sel = selected();
    if (!sel) return;
    setPages(oddPages(sel.pageCount));
  });
  els.evenPagesBtn.addEventListener("click", function () {
    var sel = selected();
    if (!sel) return;
    setPages(evenPages(sel.pageCount));
  });

  function pick() { els.fileInput.click(); }
  els.chooseBtn.addEventListener("click", function (ev) { ev.stopPropagation(); pick(); });
  els.addBtn.addEventListener("click", pick);
  els.empty.addEventListener("click", function (ev) {
    if (ev.target.closest("button")) return;
    pick();
  });
  els.fileInput.addEventListener("change", function () {
    addFiles(els.fileInput.files);
    els.fileInput.value = "";
  });

  els.stack.addEventListener("pointerdown", onSortDown);
  els.stack.addEventListener("pointermove", onSortMove);
  els.stack.addEventListener("pointerup", onSortUp);
  els.stack.addEventListener("pointercancel", onSortUp);

  ["dragenter", "dragover"].forEach(function (type) {
    els.stage.addEventListener(type, function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      els.stage.classList.add("is-drag");
    });
  });
  ["dragleave", "drop"].forEach(function (type) {
    els.stage.addEventListener(type, function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (type === "dragleave" && ev.target !== els.stage && !els.stage.contains(ev.relatedTarget)) return;
      els.stage.classList.remove("is-drag");
    });
  });
  els.stage.addEventListener("drop", function (ev) {
    var dt = ev.dataTransfer;
    if (dt && dt.files && dt.files.length) addFiles(dt.files);
  });
  document.addEventListener("dragover", function (ev) { ev.preventDefault(); });
  document.addEventListener("drop", function (ev) { ev.preventDefault(); });

  document.addEventListener("keydown", function (ev) {
    if (busy) return;
    var tag = (ev.target && ev.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if ((ev.key === "Delete" || ev.key === "Backspace") && selectedId) {
      var idx = items.findIndex(function (it) { return it.id === selectedId; });
      if (idx >= 0) { ev.preventDefault(); removeAt(idx); }
    }
    if (ev.key === "ArrowUp" && selectedId && (ev.metaKey || ev.altKey)) {
      var i1 = items.findIndex(function (it) { return it.id === selectedId; });
      if (i1 > 0) { ev.preventDefault(); move(i1, i1 - 1); }
    }
    if (ev.key === "ArrowDown" && selectedId && (ev.metaKey || ev.altKey)) {
      var i2 = items.findIndex(function (it) { return it.id === selectedId; });
      if (i2 >= 0 && i2 < items.length - 1) { ev.preventDefault(); move(i2, i2 + 1); }
    }
  });

  function bindPress(btn) {
    if (!btn) return;
    btn.addEventListener("pointerdown", function () {
      if (btn.disabled) return;
      btn.classList.add("is-press");
    });
    ["pointerup", "pointercancel", "pointerleave", "blur"].forEach(function (type) {
      btn.addEventListener(type, function () { btn.classList.remove("is-press"); });
    });
  }
  bindPress(els.chooseBtn);
  bindPress(els.mergeBtn);
  bindPress(els.extractBtn);

  if (typeof PDFLib === "undefined") {
    showToast("pdf-lib failed to load.");
    setHint(els.fileHint, "pdf-lib failed to load.", true);
  }
  render();
}
