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

var StackPDF = {
  parseRanges: parseRanges,
  compactRanges: compactRanges,
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
  var dragFrom = null;

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
    fileList: document.getElementById("fileList"),
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
    clearPagesBtn: document.getElementById("clearPagesBtn")
  };

  function okItems() { return items.filter(function (it) { return it.status === "ok"; }); }
  function selected() { return items.find(function (it) { return it.id === selectedId && it.status === "ok"; }) || null; }

  function setHint(el, text, err) {
    el.textContent = text;
    el.classList.toggle("is-err", !!err);
  }

  function showProgress(on, label, done, total) {
    els.progress.hidden = !on;
    if (!on) return;
    els.progressLabel.textContent = label || "Working";
    var pct = total ? Math.round((done / total) * 100) : 0;
    els.progressBar.style.width = pct + "%";
    els.progressTrack.setAttribute("aria-valuenow", String(pct));
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

  function render() {
    var ok = okItems();
    var totalPages = ok.reduce(function (s, it) { return s + it.pageCount; }, 0);
    var totalBytes = ok.reduce(function (s, it) { return s + it.size; }, 0);
    els.topMeta.textContent = ok.length
      ? (ok.length + (ok.length === 1 ? " file" : " files") + " · " + totalPages + " pp · " + formatBytes(totalBytes))
      : "";

    els.empty.hidden = items.length > 0;
    els.work.hidden = items.length === 0;

    els.fileList.replaceChildren();
    items.forEach(function (it, idx) {
      var li = document.createElement("li");
      li.className = "file" + (it.id === selectedId ? " is-on" : "") + (it.status === "error" ? " is-error" : "");
      li.draggable = true;
      li.dataset.id = it.id;

      var grip = document.createElement("span");
      grip.className = "grip";
      grip.title = "Drag to reorder";

      var name = document.createElement("div");
      name.className = "file-name";
      name.textContent = it.name;
      name.title = it.name;

      var pages = document.createElement("div");
      pages.className = "file-pages";
      pages.textContent = it.status === "reading" ? "…" : (it.status === "error" ? "err" : it.pageCount + " pp");

      var row = document.createElement("div");
      row.className = "file-row";
      var size = document.createElement("span");
      size.className = "file-size";
      size.textContent = it.status === "error" ? (it.error || "Unreadable") : formatBytes(it.size);

      function icon(label, title, cls, fn, disabled) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "icon-btn" + (cls ? " " + cls : "");
        b.textContent = label;
        b.title = title;
        b.disabled = !!disabled;
        b.addEventListener("click", function (ev) { ev.stopPropagation(); fn(); });
        return b;
      }
      row.appendChild(size);
      row.appendChild(icon("↑", "Move up", "", function () { move(idx, idx - 1); }, idx === 0));
      row.appendChild(icon("↓", "Move down", "", function () { move(idx, idx + 1); }, idx === items.length - 1));
      row.appendChild(icon("×", "Remove", "danger", function () { removeAt(idx); }));

      li.appendChild(grip);
      li.appendChild(name);
      li.appendChild(pages);
      li.appendChild(row);
      li.addEventListener("click", function () { select(it.id); });
      li.addEventListener("dragstart", function (ev) {
        dragFrom = it.id;
        li.classList.add("is-drag");
        ev.dataTransfer.effectAllowed = "move";
        try { ev.dataTransfer.setData("text/plain", it.id); } catch (e) {}
      });
      li.addEventListener("dragend", function () { dragFrom = null; li.classList.remove("is-drag"); });
      li.addEventListener("dragover", function (ev) { ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; });
      li.addEventListener("drop", function (ev) {
        ev.preventDefault();
        var fromId = dragFrom || (ev.dataTransfer && ev.dataTransfer.getData("text/plain"));
        if (!fromId || fromId === it.id) return;
        var from = items.findIndex(function (x) { return x.id === fromId; });
        var to = items.findIndex(function (x) { return x.id === it.id; });
        if (from < 0 || to < 0) return;
        var moved = items.splice(from, 1)[0];
        items.splice(to, 0, moved);
        render();
      });
      els.fileList.appendChild(li);
    });

    if (!items.length) setHint(els.fileHint, "Drop or add PDFs to start.", false);
    else if (ok.length !== items.length) setHint(els.fileHint, "One or more files could not be read.", true);
    else setHint(els.fileHint, "Drag to reorder. Click a file to split it.", false);

    els.mergeBtn.disabled = busy || ok.length < 2;
    if (ok.length < 2) setHint(els.mergeHint, "Add at least two PDFs to merge.", false);
    else setHint(els.mergeHint, ok.length + " files · " + totalPages + " pages → stackpdf-merged.pdf", false);

    var sel = selected();
    els.everyBtn.disabled = busy || !sel;
    var rangeOk = false;
    if (!sel) {
      setHint(els.splitHint, "Select a file, then pages or a range.", false);
    } else {
      try {
        var r = parseRanges(els.rangeInput.value, sel.pageCount);
        rangeOk = r.length > 0;
        setHint(els.splitHint, "Extract " + r.length + " page" + (r.length === 1 ? "" : "s") + " from " + sel.name + ".", false);
      } catch (e) {
        setHint(els.splitHint, els.rangeInput.value.trim() ? e.message : ("Selected " + sel.name + " · " + sel.pageCount + " pages."), !!els.rangeInput.value.trim());
      }
    }
    els.extractBtn.disabled = busy || !sel || !rangeOk;

    els.stack.replaceChildren();
    items.forEach(function (it, idx) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sheet" + (it.id === selectedId ? " is-on" : "");
      var ord = document.createElement("span");
      ord.className = "sheet-ord";
      ord.textContent = String(idx + 1).padStart(2, "0");
      var body = document.createElement("div");
      var nm = document.createElement("div");
      nm.className = "sheet-name";
      nm.textContent = it.name;
      var meta = document.createElement("div");
      meta.className = "sheet-meta";
      meta.textContent = it.status === "ok" ? (it.pageCount + " pages · " + formatBytes(it.size)) : (it.status === "reading" ? "Reading…" : (it.error || "Unreadable"));
      body.appendChild(nm);
      body.appendChild(meta);
      var ticks = document.createElement("div");
      ticks.className = "ticks";
      if (it.status === "ok") {
        var show = Math.min(it.pageCount, 24);
        for (var t = 0; t < show; t++) {
          var tick = document.createElement("span");
          tick.className = "tick";
          ticks.appendChild(tick);
        }
        if (it.pageCount > 24) {
          var more = document.createElement("span");
          more.className = "tick is-more";
          more.textContent = "+" + (it.pageCount - 24);
          ticks.appendChild(more);
        }
      }
      btn.appendChild(ord);
      btn.appendChild(body);
      btn.appendChild(ticks);
      btn.addEventListener("click", function () { select(it.id); });
      els.stack.appendChild(btn);
    });

    renderGrid();
  }

  function renderGrid() {
    var sel = selected();
    els.pagesPanel.hidden = !sel;
    els.pageGrid.replaceChildren();
    if (!sel) return;
    els.pagesTitle.textContent = "Pages";
    var picked = [];
    try { picked = parseRanges(els.rangeInput.value, sel.pageCount); } catch (e) { picked = []; }
    var set = {};
    picked.forEach(function (n) { set[n] = true; });
    els.pagesSub.textContent = sel.name + " · " + (picked.length ? (picked.length + " selected") : "click to select");
    for (var n = 1; n <= sel.pageCount; n++) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pg" + (set[n] ? " is-on" : "");
      b.textContent = String(n);
      b.addEventListener("click", (function (page) {
        return function () { togglePage(page); };
      })(n));
      els.pageGrid.appendChild(b);
    }
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

  function select(id) {
    selectedId = id;
    var sel = selected();
    if (sel) {
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

  function removeAt(idx) {
    var gone = items.splice(idx, 1)[0];
    if (gone && gone.id === selectedId) {
      var next = items.find(function (it) { return it.status === "ok"; });
      selectedId = next ? next.id : null;
    }
    render();
  }

  async function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(isPdf);
    if (!files.length) {
      setHint(els.fileHint, "Only PDF files are accepted.", true);
      return;
    }
    if (typeof PDFLib === "undefined") {
      setHint(els.fileHint, "pdf-lib failed to load.", true);
      return;
    }
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var it = { id: uid(), name: file.name, size: file.size, pageCount: 0, bytes: null, status: "reading", error: "" };
      items.push(it);
      if (!selectedId) selectedId = it.id;
      render();
      try {
        var buf = await file.arrayBuffer();
        var bytes = new Uint8Array(buf);
        var doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
        it.bytes = bytes;
        it.pageCount = doc.getPageCount();
        it.status = "ok";
        if (it.id === selectedId && !els.rangeInput.value.trim() && it.pageCount) {
          els.rangeInput.value = "1-" + it.pageCount;
        }
      } catch (err) {
        it.status = "error";
        it.error = "Could not read this PDF";
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
      setHint(els.splitHint, (err && err.message) ? err.message : "Something failed.", true);
    }
    busy = false;
    showProgress(false);
    render();
  }

  function onProg(p) {
    var label = "Working";
    if (p.phase === "read") label = "Reading " + p.file;
    else if (p.phase === "merge") label = "Merging " + p.file + " · " + p.done + "/" + p.total;
    else if (p.phase === "split") label = "Splitting · " + p.done + "/" + p.total;
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
      downloadBytes(bytes, "stackpdf-extract.pdf", "application/pdf");
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
        downloadBytes(result.zip, "stackpdf-pages.zip", "application/zip");
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

  function pick() { els.fileInput.click(); }
  els.chooseBtn.addEventListener("click", function (ev) { ev.stopPropagation(); pick(); });
  els.addBtn.addEventListener("click", pick);
  els.empty.addEventListener("click", function (ev) {
    if (ev.target === els.chooseBtn) return;
    pick();
  });
  els.fileInput.addEventListener("change", function () {
    addFiles(els.fileInput.files);
    els.fileInput.value = "";
  });

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
      if (type === "dragleave" && ev.target !== els.stage) return;
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
  });

  if (typeof PDFLib === "undefined") {
    setHint(els.fileHint, "pdf-lib failed to load.", true);
  }
  render();
}
