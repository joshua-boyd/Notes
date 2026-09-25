'use strict';

(() => {
  // ---------------------------------------------------------------------------
  // Constants. All drawing coordinates are stored in PDF points (1/72 inch), with
  // the origin at the page's top-left, so a page on screen and a page in the
  // exported PDF are the same thing.
  // ---------------------------------------------------------------------------

  const PAPER = { letter: [612, 792], a4: [595.28, 841.89] };
  const TEMPLATE_NAMES = { blank: 'Blank', lined: 'Lined', grid: 'Grid' };
  const TPL_COLOR = { lined: '#b4c3d6', grid: '#cfd7e3' };
  const TPL_WIDTH = 0.6;
  const LINE_GAP = 24, LINE_TOP = 72, LINE_BOTTOM = 36, GRID_GAP = 18;
  const HL_ALPHA = 0.35;
  const MAX_CANVAS_AREA = 16e6; // iPad Safari refuses canvases above ~16.7M pixels
  const BG_CACHE_MAX = 6;       // rendered PDF page images kept in memory
  const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const TOOLS = {
    pen: { colors: ['#1c1c1e', '#1f5fd6', '#d93025', '#188038', '#8e44ad'], sizes: [1.2, 2, 3.5] },
    hl: { colors: ['#ffd60a', '#7ee081', '#ff8fc7', '#7cc4ff'], sizes: [8, 14, 22] },
    eraser: { colors: [], sizes: [4, 9, 18] },
  };
  const PDFJS_DIR = new URL('vendor/pdfjs/', location.href).href;

  const $ = (s) => document.querySelector(s);
  const scroller = $('#scroller'), pagesEl = $('#pages'), addBar = $('#addBar');
  const titleEl = $('#title'), undoBtn = $('#undoBtn'), redoBtn = $('#redoBtn');
  const zoomLabel = $('#zoomLabel'), paperSel = $('#paperSel'), pdfBtn = $('#pdfBtn');
  const noteList = $('#noteList'), organizer = $('#organizer'), orgGrid = $('#orgGrid');

  const TRASH_SVG = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  const prefs = {
    tool: 'pen', color: { pen: 0, hl: 0 }, size: { pen: 1, hl: 1, eraser: 1 },
    finger: false, zoom: 1, tpl: 'blank', paper: 'letter',
  };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('pn-prefs') || '{}')); } catch {}
  const savePrefs = () => localStorage.setItem('pn-prefs', JSON.stringify(prefs));

  // ---------------------------------------------------------------------------
  // Storage (IndexedDB, in this browser on this device). Notes hold metadata and
  // page order; each page's strokes are a separate record, so saving only
  // rewrites the pages that changed. Imported PDFs are kept as files.
  // ---------------------------------------------------------------------------

  let conn = null;
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  function openDb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('pencil-notes', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages', { keyPath: 'id' }).createIndex('noteId', 'noteId');
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' }).createIndex('noteId', 'noteId');
      };
      r.onsuccess = () => res(conn = r.result);
      r.onerror = () => rej(r.error);
    });
  }

  function tx(stores, mode, fn) {
    return new Promise((res, rej) => {
      const t = conn.transaction(stores, mode);
      let out;
      t.oncomplete = () => res(out);
      t.onerror = t.onabort = () => rej(t.error);
      out = fn(t);
    });
  }

  const getAll = (store) => tx([store], 'readonly', (t) => reqP(t.objectStore(store).getAll()));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let notes = [];            // metadata for every note
  let note = null;           // the open note: { id, title, created, updated, paper, pages }
                             // page: { id, tpl, bg? } where bg = { file, index, w, h, m } for PDF pages
  let pageData = new Map();  // pageId -> { id, noteId, strokes: [{ t, c, w, pts: Float32Array[x,y,pressure,...] }] }
  const views = new Map();   // pageId -> on-screen page
  let undoStack = [], redoStack = [];
  const dirtyPages = new Set(), deletedPages = new Set();
  let metaDirty = false, saveTimer = 0;
  let pageCssW = 0;
  let active = null;         // the stroke or erase in progress

  const pageSize = (p) => (p.bg ? [p.bg.w, p.bg.h] : PAPER[note.paper] || PAPER.letter);

  // ---------------------------------------------------------------------------
  // Stroke geometry, shared by the screen renderer and the PDF writer so the two
  // always match. A stroke is smoothed with quadratic curves through the midpoints
  // of its samples; segment i only depends on samples i-1..i+1, so it can be drawn
  // the moment sample i+1 arrives and never needs redrawing.
  // ---------------------------------------------------------------------------

  const SEG = new Float64Array(6);
  function segment(P, n, i) {
    const b = i * 3;
    if (i === 0) { SEG[0] = P[0]; SEG[1] = P[1]; }
    else { SEG[0] = (P[b - 3] + P[b]) / 2; SEG[1] = (P[b - 2] + P[b + 1]) / 2; }
    if (i === n - 1) { SEG[4] = P[b]; SEG[5] = P[b + 1]; }
    else { SEG[4] = (P[b] + P[b + 3]) / 2; SEG[5] = (P[b + 1] + P[b + 4]) / 2; }
    if (i === 0 || i === n - 1) SEG[2] = NaN;
    else { SEG[2] = P[b]; SEG[3] = P[b + 1]; }
    return SEG;
  }

  function widthAt(s, P, i) {
    if (s.t === 'hl') return s.w;
    return Math.round(s.w * (0.4 + 1.2 * P[i * 3 + 2]) * 20) / 20;
  }

  // Emits the stroke as paths; consecutive segments of equal width share one path.
  function traceStroke(s, P, n, sink) {
    if (n === 0) return;
    if (n === 1) { sink.dot(P[0], P[1], widthAt(s, P, 0)); return; }
    let cur = -1;
    for (let i = 0; i < n; i++) {
      const o = segment(P, n, i);
      const w = widthAt(s, P, i);
      if (w !== cur) {
        if (cur >= 0) sink.stroke();
        sink.begin(w);
        sink.move(o[0], o[1]);
        cur = w;
      }
      if (o[2] !== o[2]) sink.line(o[4], o[5]);
      else sink.quad(o[2], o[3], o[4], o[5]);
    }
    sink.stroke();
  }

  function templateLines(tpl, W, H) {
    const out = [];
    if (tpl === 'lined') {
      for (let y = LINE_TOP; y <= H - LINE_BOTTOM; y += LINE_GAP) out.push([0, y, W, y]);
    } else if (tpl === 'grid') {
      const ox = (W % GRID_GAP) / 2, oy = (H % GRID_GAP) / 2;
      for (let x = ox; x <= W; x += GRID_GAP) out.push([x, 0, x, H]);
      for (let y = oy; y <= H; y += GRID_GAP) out.push([0, y, W, y]);
    }
    return out;
  }

  const BBOX = new WeakMap();
  function bbox(s) {
    let b = BBOX.get(s);
    if (!b) {
      const P = s.pts, pad = s.t === 'hl' ? s.w / 2 : s.w * 0.8;
      b = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < P.length; i += 3) {
        if (P[i] < b[0]) b[0] = P[i];
        if (P[i] > b[2]) b[2] = P[i];
        if (P[i + 1] < b[1]) b[1] = P[i + 1];
        if (P[i + 1] > b[3]) b[3] = P[i + 1];
      }
      b[0] -= pad; b[1] -= pad; b[2] += pad; b[3] += pad;
      BBOX.set(s, b);
    }
    return b;
  }

  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }

  function strokeHit(s, x, y, r) {
    const b = bbox(s);
    if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return false;
    const P = s.pts, n = P.length / 3, rr = r + (s.t === 'hl' ? s.w / 2 : s.w * 0.6);
    if (n === 1) return Math.hypot(x - P[0], y - P[1]) <= rr;
    for (let i = 0; i < n - 1; i++) {
      const b3 = i * 3;
      if (distToSeg(x, y, P[b3], P[b3 + 1], P[b3 + 3], P[b3 + 4]) <= rr) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Imported PDFs. pdf.js is only loaded once a note actually has PDF pages. Each
  // PDF page is drawn once into an image that is reused, so writing on top of it
  // costs the same as writing on a blank page.
  // ---------------------------------------------------------------------------

  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import('./vendor/pdfjs/pdf.min.mjs').then((m) => {
        m.GlobalWorkerOptions.workerSrc = PDFJS_DIR + 'pdf.worker.min.mjs';
        return m;
      });
      pdfjsPromise.catch(() => { pdfjsPromise = null; });
    }
    return pdfjsPromise;
  }

  async function openPdf(data) {
    const pdfjs = await loadPdfjs();
    return pdfjs.getDocument({
      data,
      cMapUrl: PDFJS_DIR + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: PDFJS_DIR + 'standard_fonts/',
      wasmUrl: PDFJS_DIR + 'wasm/',
      iccUrl: PDFJS_DIR + 'iccs/',
      isEvalSupported: false,
      enableXfa: false,
    }).promise;
  }

  const loadFile = (id) => tx(['files'], 'readonly', (t) => reqP(t.objectStore('files').get(id)));

  let pdfDocs = new Map(); // fileId -> Promise<PDFDocumentProxy>
  function getPdfDoc(fileId) {
    let p = pdfDocs.get(fileId);
    if (!p) {
      p = loadFile(fileId).then((rec) => {
        if (!rec) throw new Error('The PDF for this page is missing.');
        return openPdf(rec.data);
      });
      pdfDocs.set(fileId, p);
      p.catch(() => pdfDocs.delete(fileId));
    }
    return p;
  }

  async function renderPdfPage(bg, pxWidth) {
    const doc = await getPdfDoc(bg.file);
    const page = await doc.getPage(bg.index + 1);
    const viewport = page.getViewport({ scale: pxWidth / bg.w });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(viewport.width));
    c.height = Math.max(1, Math.round(viewport.height));
    await page.render({ canvas: c, viewport }).promise;
    return c;
  }

  let bgCache = new Map();  // pageId -> canvas holding the rendered PDF page
  const bgWanted = new Map(); // pageId -> pixel width needed
  let bgBusy = false;

  function queueBg(v) {
    bgWanted.set(v.id, v.canvas.width);
    pumpBg();
  }

  async function pumpBg() {
    if (bgBusy) return;
    bgBusy = true;
    try {
      while (bgWanted.size) {
        const [id, width] = bgWanted.entries().next().value;
        bgWanted.delete(id);
        const v = views.get(id);
        if (!v || !v.canvas || !v.page.bg) continue;
        const have = bgCache.get(id);
        if (have && have.width >= width * 0.98) continue;
        const forNote = note;
        let c;
        try { c = await renderPdfPage(v.page.bg, width); }
        catch (err) { console.error(err); continue; }
        if (note !== forNote) { c.width = 0; continue; }
        if (have) have.width = 0;
        bgCache.delete(id);
        bgCache.set(id, c);
        evictBg();
        if (v.canvas) requestRender(v);
      }
    } finally {
      bgBusy = false;
    }
  }

  function evictBg() {
    for (const [id, c] of bgCache) {
      if (bgCache.size <= BG_CACHE_MAX) break;
      const v = views.get(id);
      if (v && v.canvas) continue;
      c.width = 0;
      bgCache.delete(id);
    }
  }

  function resetPdfState() {
    for (const p of pdfDocs.values()) p.then((d) => d.loadingTask.destroy()).catch(() => {});
    pdfDocs = new Map();
    for (const c of bgCache.values()) c.width = 0;
    bgCache = new Map();
    bgWanted.clear();
  }

  // ---------------------------------------------------------------------------
  // Canvas rendering
  // ---------------------------------------------------------------------------

  function canvasSink(ctx) {
    return {
      begin(w) { ctx.beginPath(); ctx.lineWidth = w; },
      move(x, y) { ctx.moveTo(x, y); },
      line(x, y) { ctx.lineTo(x, y); },
      quad(cx, cy, x, y) { ctx.quadraticCurveTo(cx, cy, x, y); },
      stroke() { ctx.stroke(); },
      dot(x, y, w) { ctx.beginPath(); ctx.arc(x, y, w / 2, 0, Math.PI * 2); ctx.fill(); },
    };
  }

  function drawStroke(ctx, sink, s) {
    ctx.save();
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = ctx.fillStyle = s.c;
    if (s.t === 'hl') { ctx.globalAlpha = HL_ALPHA; ctx.globalCompositeOperation = 'multiply'; }
    traceStroke(s, s.pts, s.pts.length / 3, sink);
    ctx.restore();
  }

  // Draws a whole page (background, lines, strokes) into a canvas of any size.
  function paintPage(ctx, pxWidth, pxHeight, p, bgImage) {
    const [W, H] = pageSize(p);
    const k = pxWidth / W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, pxWidth, pxHeight);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    if (p.bg) {
      if (bgImage) ctx.drawImage(bgImage, 0, 0, W, H);
    } else {
      const lines = templateLines(p.tpl, W, H);
      if (lines.length) {
        ctx.beginPath();
        for (const [x0, y0, x1, y1] of lines) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
        ctx.lineWidth = TPL_WIDTH;
        ctx.strokeStyle = TPL_COLOR[p.tpl];
        ctx.stroke();
      }
    }
    const sink = canvasSink(ctx);
    const pd = pageData.get(p.id);
    if (pd) for (const s of pd.strokes) drawStroke(ctx, sink, s);
  }

  function renderPage(v) {
    let bg = null;
    if (v.page.bg) {
      bg = bgCache.get(v.id);
      if (!bg || bg.width < v.canvas.width * 0.98) queueBg(v);
    }
    paintPage(v.ctx, v.canvas.width, v.canvas.height, v.page, bg);
  }

  const pendingRender = new Set();
  let renderRaf = 0;
  function requestRender(v) {
    if (!v) return;
    pendingRender.add(v);
    if (renderRaf) return;
    renderRaf = requestAnimationFrame(() => {
      renderRaf = 0;
      for (const pv of pendingRender) if (pv.canvas) renderPage(pv);
      pendingRender.clear();
    });
  }

  // ---------------------------------------------------------------------------
  // Page views. Only pages near the viewport get a canvas; the rest are empty
  // boxes. This keeps memory flat and scrolling smooth however long a note gets.
  // ---------------------------------------------------------------------------

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = e.target._view;
      if (e.isIntersecting) mount(v);
      else if (!active || active.v !== v) unmount(v);
    }
  }, { root: scroller, rootMargin: '120% 0px 120% 0px' });

  // Safety net for the observer: when scrolling stops, free far-away canvases and
  // make sure every page in view has one. The unmount margin is wider than the
  // observer's so the two never fight over a page.
  let sweepTimer = 0;
  scroller.addEventListener('scroll', () => {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(sweep, 250);
  }, { passive: true });

  function sweep() {
    for (const v of views.values()) {
      if (active && active.v === v) continue;
      if (isNear(v, 1)) mount(v);
      else if (v.canvas && !isNear(v, 2)) unmount(v);
    }
  }

  // Is the page within `screens` screen-heights of the visible area?
  function isNear(v, screens) {
    const r = v.el.getBoundingClientRect(), s = scroller.getBoundingClientRect();
    return r.bottom > s.top - s.height * screens && r.top < s.bottom + s.height * screens;
  }

  function sizeCanvas(v) {
    const c = v.canvas;
    let r = window.devicePixelRatio || 1;
    if (v.cssW * v.cssH * r * r > MAX_CANVAS_AREA) r = Math.sqrt(MAX_CANVAS_AREA / (v.cssW * v.cssH));
    c.width = Math.round(v.cssW * r);
    c.height = Math.round(v.cssH * r);
    v.k = c.width / v.w;
  }

  function mount(v) {
    if (v.canvas) return;
    v.canvas = document.createElement('canvas');
    v.ctx = v.canvas.getContext('2d', { alpha: false, desynchronized: true });
    v.el.appendChild(v.canvas);
    sizeCanvas(v);
    renderPage(v);
  }

  function unmount(v) {
    if (!v.canvas) return;
    v.canvas.width = v.canvas.height = 0; // frees the bitmap right away on iOS
    v.canvas.remove();
    v.canvas = v.ctx = null;
  }

  function applySize(v) {
    [v.w, v.h] = pageSize(v.page);
    v.cssW = pageCssW;
    v.cssH = Math.round(pageCssW * v.h / v.w);
    v.el.style.width = v.foot.style.width = v.cssW + 'px';
    v.el.style.height = v.cssH + 'px';
  }

  function createView(page) {
    const wrap = document.createElement('div');
    wrap.className = 'pagewrap';
    const el = document.createElement('div');
    el.className = 'page';
    const foot = document.createElement('div');
    foot.className = 'page-foot';
    foot.innerHTML =
      '<span class="num"></span><span class="actions">' +
      '<span class="pdf-tag">PDF page</span>' +
      '<select title="Page style">' +
      Object.entries(TEMPLATE_NAMES).map(([k, n]) => `<option value="${k}">${n}</option>`).join('') +
      '</select>' +
      '<button class="ins" title="Insert a page below">+ Page</button>' +
      `<button class="del" title="Delete page" aria-label="Delete page">${TRASH_SVG}</button></span>`;
    wrap.append(el, foot);
    const v = { id: page.id, page, wrap, el, foot, canvas: null, ctx: null, k: 1, w: 0, h: 0, cssW: 0, cssH: 0 };
    el._view = v;
    applySize(v);

    foot.querySelector('select').addEventListener('change', (e) => {
      doAction({ t: 'tpl', pageId: v.id, from: v.page.tpl, to: e.target.value });
    });
    foot.querySelector('.ins').addEventListener('click', () => {
      addPages(note.pages.indexOf(v.page) + 1, [newBlankPage(v.page.bg ? prefs.tpl : v.page.tpl)]);
    });
    foot.querySelector('.del').addEventListener('click', () => deletePage(v.id));

    views.set(page.id, v);
    io.observe(el);
    return v;
  }

  function destroyView(v) {
    io.unobserve(v.el);
    unmount(v);
    v.wrap.remove();
    views.delete(v.id);
  }

  // Makes the page elements match note.pages, reusing existing ones.
  function syncViews() {
    const ids = new Set(note.pages.map((p) => p.id));
    for (const v of [...views.values()]) if (!ids.has(v.id)) destroyView(v);
    const n = note.pages.length;
    note.pages.forEach((p, i) => {
      const v = views.get(p.id) || createView(p);
      if (pagesEl.children[i] !== v.wrap) pagesEl.insertBefore(v.wrap, pagesEl.children[i]);
      v.foot.querySelector('.num').textContent = `Page ${i + 1} of ${n}`;
      const sel = v.foot.querySelector('select');
      sel.hidden = !!p.bg;
      sel.value = p.tpl;
      v.foot.querySelector('.pdf-tag').hidden = !p.bg;
      v.foot.querySelector('.del').disabled = n < 2;
    });
  }

  function layout() {
    const fit = Math.min(scroller.clientWidth - 32, 1000);
    pageCssW = Math.max(100, Math.round(fit * prefs.zoom));
    pagesEl.style.width = Math.max(scroller.clientWidth, pageCssW + 32) + 'px';
    addBar.style.width = pageCssW + 'px';
    for (const v of views.values()) {
      applySize(v);
      if (v.canvas) { sizeCanvas(v); renderPage(v); }
    }
    zoomLabel.textContent = Math.round(prefs.zoom * 100) + '%';
  }

  // Re-lays out while keeping the point under (ax, ay) fixed on screen.
  function relayout(ax, ay) {
    let anchor = null, best = Infinity;
    for (const v of views.values()) {
      const r = v.el.getBoundingClientRect();
      const d = ay < r.top ? r.top - ay : ay > r.bottom ? ay - r.bottom : 0;
      if (d < best) { best = d; anchor = { v, fx: (ax - r.left) / r.width, fy: (ay - r.top) / r.height }; }
      if (d === 0) break;
    }
    layout();
    if (anchor) {
      const r = anchor.v.el.getBoundingClientRect();
      scroller.scrollLeft += r.left + anchor.fx * r.width - ax;
      scroller.scrollTop += r.top + anchor.fy * r.height - ay;
    }
  }

  function scrollerCenter() {
    const r = scroller.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  function setZoom(z, ax, ay) {
    z = Math.min(3, Math.max(0.5, z));
    if (Math.abs(z - prefs.zoom) < 0.005) return;
    if (ax === undefined) [ax, ay] = scrollerCenter();
    prefs.zoom = z;
    savePrefs();
    relayout(ax, ay);
  }

  function scrollToPage(id) {
    const v = views.get(id);
    if (v) v.wrap.scrollIntoView({ block: 'start' });
  }

  // ---------------------------------------------------------------------------
  // Drawing input
  // ---------------------------------------------------------------------------

  let overlay = null;

  function canDraw(e) {
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'mouse') return e.button === 0;
    return e.pointerType === 'touch' && prefs.finger;
  }

  pagesEl.addEventListener('pointerdown', (e) => {
    if (active || !canDraw(e)) return;
    const el = e.target.closest('.page');
    if (!el) return;
    e.preventDefault();
    const v = el._view;
    mount(v);
    try { el.setPointerCapture(e.pointerId); } catch {}
    const rect = el.getBoundingClientRect();
    const tool = prefs.tool;
    const sc = rect.width / v.w;
    active = { id: e.pointerId, v, rect, sc, tool, minD2: (0.6 / sc) ** 2, lx: null, ly: null };
    if (tool === 'eraser') {
      active.r = TOOLS.eraser.sizes[prefs.size.eraser];
      active.removed = [];
    } else {
      active.s = { t: tool, c: TOOLS[tool].colors[prefs.color[tool]], w: TOOLS[tool].sizes[prefs.size[tool]], pts: null };
      active.pts = [];
      active.p = 0.5;
      if (tool === 'hl') startOverlay(v);
    }
    handleSample(e, true);
  });

  pagesEl.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== active.id) return;
    e.preventDefault();
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (list && list.length) for (const ce of list) handleSample(ce, false);
    else handleSample(e, false);
  });

  const endPointer = (e) => {
    if (!active || e.pointerId !== active.id) return;
    handleSample(e, true);
    finish();
  };
  pagesEl.addEventListener('pointerup', endPointer);
  pagesEl.addEventListener('pointercancel', endPointer);
  pagesEl.addEventListener('lostpointercapture', endPointer);

  // Safari: stop the Pencil from scrolling the page, while fingers still scroll.
  function stylusTouchGuard(selector, isBusy) {
    return (e) => {
      if (isBusy()) { e.preventDefault(); return; }
      if (!e.target.closest || !e.target.closest(selector)) return;
      for (const t of e.changedTouches) if (t.touchType === 'stylus') { e.preventDefault(); return; }
    };
  }
  const pageTouch = stylusTouchGuard('.page', () => !!active);
  pagesEl.addEventListener('touchstart', pageTouch, { passive: false });
  pagesEl.addEventListener('touchmove', pageTouch, { passive: false });

  function handleSample(e, force) {
    const a = active;
    const x = (e.clientX - a.rect.left) / a.sc;
    const y = (e.clientY - a.rect.top) / a.sc;
    if (a.tool === 'eraser') return eraseTo(x, y);
    const P = a.pts, n = P.length / 3;
    if (n) {
      const dx = x - P[P.length - 3], dy = y - P[P.length - 2];
      const d2 = dx * dx + dy * dy;
      if (d2 < a.minD2 && !(force && d2 > 0)) return;
    }
    // Pressure reads 0 on pen-up, so keep the last value there.
    const p = e.pointerType !== 'pen' ? 0.5 : e.pressure > 0 ? e.pressure : a.p;
    a.p = n ? a.p * 0.65 + p * 0.35 : p;
    P.push(x, y, Math.round(a.p * 1000) / 1000);
    const m = n + 1;
    if (a.tool === 'hl') requestOverlay();
    else if (m >= 2) drawLiveSeg(a, m - 2);
  }

  function prepCtx(v) {
    v.ctx.setTransform(v.k, 0, 0, v.k, 0, 0);
    v.ctx.globalAlpha = 1;
    v.ctx.globalCompositeOperation = 'source-over';
  }

  function drawLiveSeg(a, i) {
    const v = a.v;
    if (!v.canvas) return;
    const ctx = v.ctx, P = a.pts, n = P.length / 3;
    const o = segment(P, n, i);
    prepCtx(v);
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = a.s.c;
    ctx.lineWidth = widthAt(a.s, P, i);
    ctx.beginPath();
    ctx.moveTo(o[0], o[1]);
    if (o[2] !== o[2]) ctx.lineTo(o[4], o[5]);
    else ctx.quadraticCurveTo(o[2], o[3], o[4], o[5]);
    ctx.stroke();
  }

  // The highlighter is see-through, so its live stroke is drawn on a separate
  // layer (redrawn once per frame) and merged into the page when the pen lifts.
  function startOverlay(v) {
    if (!overlay) {
      overlay = document.createElement('canvas');
      overlay.className = 'overlay';
      overlay._ctx = overlay.getContext('2d');
    }
    if (overlay.width !== v.canvas.width || overlay.height !== v.canvas.height) {
      overlay.width = v.canvas.width;
      overlay.height = v.canvas.height;
    } else {
      overlay._ctx.setTransform(1, 0, 0, 1, 0, 0);
      overlay._ctx.clearRect(0, 0, overlay.width, overlay.height);
    }
    v.el.appendChild(overlay);
  }

  let overlayRaf = 0;
  function requestOverlay() {
    if (overlayRaf) return;
    overlayRaf = requestAnimationFrame(() => {
      overlayRaf = 0;
      const a = active;
      if (!a || a.tool !== 'hl') return;
      const ctx = overlay._ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      ctx.setTransform(a.v.k, 0, 0, a.v.k, 0, 0);
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.strokeStyle = ctx.fillStyle = a.s.c;
      traceStroke(a.s, a.pts, a.pts.length / 3, canvasSink(ctx));
    });
  }

  function eraseTo(x, y) {
    const a = active, r = a.r;
    const pd = pageData.get(a.v.id);
    const samples = [];
    if (a.lx === null) samples.push(x, y);
    else {
      const steps = Math.max(1, Math.ceil(Math.hypot(x - a.lx, y - a.ly) / (r * 0.5)));
      for (let i = 1; i <= steps; i++) samples.push(a.lx + (x - a.lx) * i / steps, a.ly + (y - a.ly) * i / steps);
    }
    a.lx = x; a.ly = y;
    let changed = false;
    for (let j = pd.strokes.length - 1; j >= 0; j--) {
      const s = pd.strokes[j];
      for (let k = 0; k < samples.length; k += 2) {
        if (strokeHit(s, samples[k], samples[k + 1], r)) {
          pd.strokes.splice(j, 1);
          a.removed.push({ stroke: s, index: j });
          changed = true;
          break;
        }
      }
    }
    if (changed) requestRender(a.v);
  }

  function finish() {
    const a = active;
    active = null;
    if (a.tool === 'eraser') {
      if (a.removed.length) {
        pushUndo({ t: 'erase', pageId: a.v.id, items: a.removed });
        touchPage(a.v.id);
      }
      return;
    }
    const P = a.pts, n = P.length / 3, s = a.s;
    if (!n) { if (overlay) overlay.remove(); return; }
    s.pts = Float32Array.from(P);
    if (a.tool === 'hl') {
      cancelAnimationFrame(overlayRaf);
      overlayRaf = 0;
      overlay.remove();
    }
    if (a.v.canvas) {
      if (a.tool === 'hl' || n === 1) { prepCtx(a.v); drawStroke(a.v.ctx, canvasSink(a.v.ctx), s); }
      else drawLiveSeg(a, n - 1);
    }
    pageData.get(a.v.id).strokes.push(s);
    pushUndo({ t: 'add', pageId: a.v.id, stroke: s });
    touchPage(a.v.id);
    if (!a.v.el.isConnected || !isNear(a.v, 2)) unmount(a.v);
  }

  // ---------------------------------------------------------------------------
  // Page operations, undo and redo. Every change is an action that can be applied
  // forwards or backwards.
  // ---------------------------------------------------------------------------

  const newBlankPage = (tpl) => ({ id: uid(), tpl });
  const emptyData = (p) => ({ id: p.id, noteId: note.id, strokes: [] });

  function addPages(index, pages, datas) {
    doAction({ t: 'insert', index, pages, data: datas || pages.map(emptyData) });
    if (!pages[0].bg) { prefs.tpl = pages[0].tpl; savePrefs(); }
    const v = views.get(pages[0].id);
    if (v && organizer.hidden) v.wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function deletePage(id) {
    if (note.pages.length < 2) return;
    const index = note.pages.findIndex((p) => p.id === id);
    doAction({ t: 'remove', index, pages: [note.pages[index]], data: [pageData.get(id)] });
  }

  function duplicatePage(id) {
    const index = note.pages.findIndex((p) => p.id === id);
    const src = note.pages[index];
    const copy = { ...src, id: uid() };
    addPages(index + 1, [copy], [{ id: copy.id, noteId: note.id, strokes: pageData.get(id).strokes.slice() }]);
    return copy.id;
  }

  function movePage(from, to) {
    if (to < 0 || to >= note.pages.length || to === from) return;
    doAction({ t: 'move', from, to });
  }

  function insertPages(index, pages, data) {
    note.pages.splice(index, 0, ...pages);
    data.forEach((d) => {
      pageData.set(d.id, d);
      deletedPages.delete(d.id);
      dirtyPages.add(d.id);
    });
    syncViews();
  }

  function removePages(pages) {
    for (const p of pages) {
      const i = note.pages.indexOf(p);
      if (i < 0) continue;
      note.pages.splice(i, 1);
      pageData.delete(p.id);
      dirtyPages.delete(p.id);
      deletedPages.add(p.id);
    }
    syncViews();
  }

  function doAction(a) {
    applyAction(a, false);
    pushUndo(a);
  }

  function applyAction(a, reverse) {
    const pd = a.pageId && pageData.get(a.pageId);
    switch (a.t) {
      case 'add':
        if (reverse) { const i = pd.strokes.lastIndexOf(a.stroke); if (i >= 0) pd.strokes.splice(i, 1); }
        else pd.strokes.push(a.stroke);
        break;
      case 'erase':
        if (reverse) for (let j = a.items.length - 1; j >= 0; j--) pd.strokes.splice(a.items[j].index, 0, a.items[j].stroke);
        else for (const it of a.items) { const i = pd.strokes.indexOf(it.stroke); if (i >= 0) pd.strokes.splice(i, 1); }
        break;
      case 'tpl': {
        const v = views.get(a.pageId);
        v.page.tpl = reverse ? a.from : a.to;
        v.foot.querySelector('select').value = v.page.tpl;
        break;
      }
      case 'insert':
        if (reverse) removePages(a.pages); else insertPages(a.index, a.pages, a.data);
        break;
      case 'remove':
        if (reverse) insertPages(a.index, a.pages, a.data); else removePages(a.pages);
        break;
      case 'move': {
        const [from, to] = reverse ? [a.to, a.from] : [a.from, a.to];
        const [p] = note.pages.splice(from, 1);
        note.pages.splice(to, 0, p);
        syncViews();
        break;
      }
    }
    metaDirty = true;
    if (a.pageId) {
      touchPage(a.pageId);
      const v = views.get(a.pageId);
      requestRender(v);
      if (organizer.hidden && !isNear(v, 0)) v.wrap.scrollIntoView({ block: 'center' });
    } else {
      note.updated = Date.now();
      scheduleSave();
    }
    if (!organizer.hidden) syncThumbs();
  }

  function pushUndo(a) {
    undoStack.push(a);
    if (undoStack.length > 500) undoStack.shift();
    redoStack = [];
    updateUndo();
  }

  function undo() {
    if (active || !undoStack.length) return;
    const a = undoStack.pop();
    applyAction(a, true);
    redoStack.push(a);
    updateUndo();
  }

  function redo() {
    if (active || !redoStack.length) return;
    const a = redoStack.pop();
    applyAction(a, false);
    undoStack.push(a);
    updateUndo();
  }

  function updateUndo() {
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
  }

  // ---------------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------------

  function touchPage(id) {
    dirtyPages.add(id);
    note.updated = Date.now();
    metaDirty = true;
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 700);
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    if (!note || (!metaDirty && !dirtyPages.size && !deletedPages.size)) return;
    const meta = note;
    const pages = [...dirtyPages].map((id) => pageData.get(id)).filter(Boolean);
    const dels = [...deletedPages];
    dirtyPages.clear(); deletedPages.clear(); metaDirty = false;
    try {
      await tx(['notes', 'pages'], 'readwrite', (t) => {
        t.objectStore('notes').put(meta);
        const ps = t.objectStore('pages');
        for (const p of pages) ps.put(p);
        for (const id of dels) ps.delete(id);
      });
    } catch (err) {
      console.error(err);
      if (meta === note) {
        pages.forEach((p) => dirtyPages.add(p.id));
        dels.forEach((id) => deletedPages.add(id));
        metaDirty = true;
        scheduleSave();
      }
    }
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  window.addEventListener('pagehide', flushSave);

  // ---------------------------------------------------------------------------
  // Notes
  // ---------------------------------------------------------------------------

  function makeNote(title, pages) {
    const now = Date.now();
    return { id: uid(), title, created: now, updated: now, paper: prefs.paper, pages };
  }

  async function saveNewNote(n) {
    await tx(['notes', 'pages'], 'readwrite', (t) => {
      t.objectStore('notes').put(n);
      for (const p of n.pages) t.objectStore('pages').put({ id: p.id, noteId: n.id, strokes: [] });
    });
    notes.push(n);
  }

  async function newNote() {
    await flushSave();
    const n = makeNote('', [newBlankPage(prefs.tpl)]);
    await saveNewNote(n);
    await openNote(n.id);
  }

  async function openNote(id) {
    await flushSave();
    const meta = notes.find((n) => n.id === id);
    const recs = await tx(['pages'], 'readonly', (t) => reqP(t.objectStore('pages').index('noteId').getAll(id)));
    closeOrganizer();
    for (const v of [...views.values()]) destroyView(v);
    resetPdfState();
    note = meta;
    pageData = new Map(recs.map((r) => [r.id, r]));
    for (const p of note.pages) if (!pageData.has(p.id)) pageData.set(p.id, emptyData(p));
    undoStack = []; redoStack = [];
    updateUndo();
    titleEl.value = note.title;
    paperSel.value = note.paper;
    syncViews();
    layout();
    scroller.scrollTop = 0;
    localStorage.setItem('pn-last', id);
    renderList();
  }

  async function deleteNote(id) {
    const n = notes.find((x) => x.id === id);
    if (!confirm(`Delete “${n.title || 'Untitled'}”? This can’t be undone.`)) return;
    if (note && note.id === id) { clearTimeout(saveTimer); dirtyPages.clear(); deletedPages.clear(); metaDirty = false; }
    await tx(['notes', 'pages', 'files'], 'readwrite', (t) => {
      t.objectStore('notes').delete(id);
      for (const name of ['pages', 'files']) {
        const store = t.objectStore(name);
        store.index('noteId').getAllKeys(id).onsuccess = (e) => { for (const k of e.target.result) store.delete(k); };
      }
    });
    notes = notes.filter((x) => x.id !== id);
    if (note && note.id === id) {
      note = null;
      if (notes.length) await openNote(sortedNotes()[0].id); else await newNote();
    }
    renderList();
  }

  const sortedNotes = () => notes.slice().sort((a, b) => b.updated - a.updated);

  function renderList() {
    noteList.textContent = '';
    for (const n of sortedNotes()) {
      const li = document.createElement('li');
      if (note && n.id === note.id) li.className = 'current';
      const d = new Date(n.updated);
      const today = d.toDateString() === new Date().toDateString();
      const when = today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString();
      li.innerHTML = `<div class="info"><div class="name"></div><div class="meta"></div></div>` +
        `<button title="Delete note" aria-label="Delete note">${TRASH_SVG}</button>`;
      li.querySelector('.name').textContent = n.title || 'Untitled';
      li.querySelector('.meta').textContent = `${when} · ${n.pages.length} page${n.pages.length === 1 ? '' : 's'}`;
      li.addEventListener('click', async (e) => {
        if (e.target.closest('button')) { await deleteNote(n.id); return; }
        closeSidebar();
        if (!note || n.id !== note.id) await openNote(n.id);
      });
      noteList.appendChild(li);
    }
  }

  const openSidebar = () => { renderList(); document.body.classList.add('side-open'); };
  const closeSidebar = () => document.body.classList.remove('side-open');

  let toastTimer = 0;
  function toast(msg, ms) {
    const el = $('#toast');
    clearTimeout(toastTimer);
    el.textContent = msg;
    el.hidden = !msg;
    if (msg && ms) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---------------------------------------------------------------------------
  // PDF import. The original file is stored once; each of its pages becomes a
  // note page that shows the PDF page underneath your writing.
  // ---------------------------------------------------------------------------

  function noteIsEmpty() {
    return note.pages.length === 1 && !note.pages[0].bg && !pageData.get(note.pages[0].id).strokes.length;
  }

  function askImportMode(name) {
    return new Promise((resolve) => {
      const dlg = $('#importDialog');
      $('#importMsg').textContent = `Import “${name}”`;
      const done = (v) => { dlg.close(); resolve(v); };
      $('#importNew').onclick = () => done('new');
      $('#importAppend').onclick = () => done('append');
      $('#importCancel').onclick = () => done(null);
      dlg.oncancel = () => resolve(null);
      dlg.showModal();
    });
  }

  async function importPdf(file) {
    const empty = noteIsEmpty();
    const mode = empty ? 'here' : await askImportMode(file.name);
    if (!mode) return;
    toast('Opening PDF…');
    let doc;
    const buf = await file.arrayBuffer();
    try {
      doc = await openPdf(buf.slice(0));
    } catch (err) {
      toast('');
      alert(err && err.name === 'PasswordException'
        ? 'This PDF is password protected. Remove the password first, then import it.'
        : 'Could not open this PDF: ' + (err && err.message));
      return;
    }
    const fileId = uid();
    const r2 = (n) => Math.round(n * 100) / 100;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      const vp = pg.getViewport({ scale: 1 });
      pages.push({ id: uid(), tpl: 'blank', bg: { file: fileId, index: i - 1, w: r2(vp.width), h: r2(vp.height), m: vp.transform.map((n) => Math.round(n * 1e6) / 1e6) } });
      pg.cleanup();
      if (i % 20 === 0) toast(`Reading page ${i} of ${doc.numPages}…`);
    }
    await doc.loadingTask.destroy();
    const title = file.name.replace(/\.pdf$/i, '');

    await flushSave();
    const target = mode === 'new' ? makeNote(title, pages) : note;
    await tx(['files'], 'readwrite', (t) => { t.objectStore('files').put({ id: fileId, noteId: target.id, name: file.name, data: buf }); });

    if (mode === 'new') {
      await saveNewNote(target);
      await openNote(target.id);
    } else if (mode === 'here') {
      // The note was empty: replace its blank page with the PDF's pages.
      const old = note.pages[0];
      removePages([old]);
      insertPages(0, pages, pages.map(emptyData));
      if (!note.title) { note.title = titleEl.value = title; }
      undoStack = []; redoStack = [];
      updateUndo();
      metaDirty = true;
      note.updated = Date.now();
      layout();
      await flushSave();
    } else {
      addPages(note.pages.length, pages);
      layout();
      scrollToPage(pages[0].id);
    }
    toast(`Imported ${pages.length} page${pages.length === 1 ? '' : 's'}`, 2500);
  }

  $('#importBtn').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { await importPdf(f); }
    catch (err) { console.error(err); toast(''); alert('Import failed: ' + err.message); }
  });

  // ---------------------------------------------------------------------------
  // PDF export (pdf-lib). Imported pages are copied from the original PDF as-is,
  // so their text stays sharp; your writing is added on top as vector paths
  // using the same geometry as the screen. One note page = one PDF page.
  // ---------------------------------------------------------------------------

  let pdfLibPromise = null;
  function loadPdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    if (!pdfLibPromise) {
      pdfLibPromise = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'vendor/pdf-lib/pdf-lib.min.js';
        s.onload = () => res(window.PDFLib);
        s.onerror = () => { pdfLibPromise = null; rej(new Error('Could not load the PDF writer.')); };
        document.head.appendChild(s);
      });
    }
    return pdfLibPromise;
  }

  const fmt = (n) => String(Math.round(n * 100) / 100);
  function rgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => fmt(c / 255)).join(' ');
  }

  function invert([a, b, c, d, e, f]) {
    const det = a * d - b * c;
    return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
  }

  function pdfSink(out) {
    let lx = 0, ly = 0;
    return {
      begin(w) { out.push(fmt(w) + ' w'); },
      move(x, y) { out.push(fmt(x) + ' ' + fmt(y) + ' m'); lx = x; ly = y; },
      line(x, y) { out.push(fmt(x) + ' ' + fmt(y) + ' l'); lx = x; ly = y; },
      quad(cx, cy, x, y) {
        out.push(`${fmt(lx + (cx - lx) * 2 / 3)} ${fmt(ly + (cy - ly) * 2 / 3)} ${fmt(x + (cx - x) * 2 / 3)} ${fmt(y + (cy - y) * 2 / 3)} ${fmt(x)} ${fmt(y)} c`);
        lx = x; ly = y;
      },
      stroke() { out.push('S'); },
      dot(x, y, w) { out.push(`${fmt(w)} w ${fmt(x)} ${fmt(y)} m ${fmt(x)} ${fmt(y)} l S`); },
    };
  }

  // Content stream for one page, drawn in top-left page coordinates. The first
  // `cm` maps those onto the PDF page (a y-flip for blank pages; for imported
  // pages the inverse of pdf.js's viewport, which also handles rotation/offsets).
  function pageContent(p, gsName) {
    const [W, H] = pageSize(p);
    const m = p.bg ? invert(p.bg.m) : [1, 0, 0, -1, 0, H];
    const out = [m.map((n) => String(Math.round(n * 1e6) / 1e6)).join(' ') + ' cm', '1 J 1 j'];
    if (!p.bg) {
      const lines = templateLines(p.tpl, W, H);
      if (lines.length) {
        out.push('q', rgb(TPL_COLOR[p.tpl]) + ' RG', fmt(TPL_WIDTH) + ' w');
        for (const [x0, y0, x1, y1] of lines) out.push(`${fmt(x0)} ${fmt(y0)} m ${fmt(x1)} ${fmt(y1)} l`);
        out.push('S', 'Q');
      }
    }
    for (const s of pageData.get(p.id).strokes) {
      const c = rgb(s.c);
      out.push('q', c + ' RG', c + ' rg');
      if (s.t === 'hl') out.push(`${gsName} gs`);
      traceStroke(s, s.pts, s.pts.length / 3, pdfSink(out));
      out.push('Q');
    }
    return out.join('\n');
  }

  async function buildPdf() {
    const { PDFDocument, PDFName } = await loadPdfLib();
    const doc = await PDFDocument.create();
    doc.setTitle(note.title || 'Untitled');
    doc.setProducer('Pencil Notes');
    doc.setCreator('Pencil Notes');
    const gsRef = doc.context.register(doc.context.obj({ Type: 'ExtGState', CA: HL_ALPHA, ca: HL_ALPHA, BM: 'Multiply' }));

    // Copy imported pages in one batch per source file so shared fonts and
    // images are only stored once.
    const copied = new Map(); // note page -> copied PDFPage
    const byFile = new Map();
    for (const p of note.pages) if (p.bg) (byFile.get(p.bg.file) || byFile.set(p.bg.file, []).get(p.bg.file)).push(p);
    for (const [fileId, list] of byFile) {
      const rec = await loadFile(fileId);
      if (!rec) throw new Error('An imported PDF is missing from this device.');
      const src = await PDFDocument.load(rec.data, { ignoreEncryption: true });
      const out = await doc.copyPages(src, list.map((p) => p.bg.index));
      list.forEach((p, i) => copied.set(p, out[i]));
    }

    for (const p of note.pages) {
      let page;
      if (p.bg) {
        page = doc.addPage(copied.get(p));
      } else {
        page = doc.addPage(pageSize(p));
      }
      const gsName = page.node.newExtGState('GH', gsRef); // also wraps existing content in q/Q
      page.node.addContentStream(doc.context.register(doc.context.flateStream(pageContent(p, gsName.toString()))));
    }
    const bytes = await doc.save();
    return new Blob([bytes], { type: 'application/pdf' });
  }

  const safeName = (s) => (s || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80) || 'Untitled';

  // Sharing needs a fresh tap, so the file is offered in a dialog once it's ready.
  function offerFile(blob, name) {
    const dlg = $('#fileDialog'), shareBtn = $('#fileShare');
    const file = new File([blob], name, { type: blob.type });
    $('#fileMsg').textContent = name;
    shareBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    shareBtn.onclick = async () => {
      try { await navigator.share({ files: [file], title: name }); dlg.close(); }
      catch (err) { if (err.name !== 'AbortError') alert('Sharing failed: ' + err.message); }
    };
    $('#fileDownload').onclick = () => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      dlg.close();
    };
    $('#fileClose').onclick = () => dlg.close();
    dlg.showModal();
  }

  pdfBtn.addEventListener('click', async () => {
    await flushSave();
    pdfBtn.disabled = true;
    pdfBtn.textContent = 'Exporting…';
    try { offerFile(await buildPdf(), safeName(note.title) + '.pdf'); }
    catch (err) { console.error(err); alert('PDF export failed: ' + err.message); }
    finally { pdfBtn.disabled = false; pdfBtn.textContent = 'Export PDF'; }
  });

  // ---------------------------------------------------------------------------
  // Page organizer: thumbnails of every page, drag to reorder.
  // ---------------------------------------------------------------------------

  const thumbs = new Map(); // pageId -> { el, frame, canvas, drawn }
  let selectedId = null;
  let thumbChain = Promise.resolve();

  const thumbIo = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const t = e.target._thumb;
      if (e.isIntersecting) drawThumb(t);
      else if (t.drawn) { t.canvas.width = t.canvas.height = 0; t.drawn = false; }
    }
  }, { root: orgGrid, rootMargin: '50% 0px 50% 0px' });

  function drawThumb(t) {
    if (t.drawn) return;
    t.drawn = true;
    const p = t.page;
    const [W, H] = pageSize(p);
    const pxW = Math.round((t.frame.clientWidth || 130) * Math.min(2, window.devicePixelRatio || 1));
    const pxH = Math.round(pxW * H / W);
    const paint = (bg) => {
      if (!t.drawn || organizer.hidden) return;
      t.canvas.width = pxW;
      t.canvas.height = pxH;
      paintPage(t.canvas.getContext('2d'), pxW, pxH, p, bg);
    };
    if (!p.bg) { paint(null); return; }
    const cached = bgCache.get(p.id);
    if (cached) { paint(cached); return; }
    paint(null);
    thumbChain = thumbChain.then(async () => {
      if (!t.drawn || organizer.hidden) return;
      try { const c = await renderPdfPage(p.bg, pxW); paint(c); c.width = 0; }
      catch (err) { console.error(err); }
    });
  }

  function createThumb(p) {
    const el = document.createElement('div');
    el.className = 'thumb';
    el.dataset.id = p.id;
    el.innerHTML = '<div class="tframe"><canvas></canvas></div><div class="tlabel"></div>';
    const t = { el, page: p, frame: el.firstChild, canvas: el.querySelector('canvas'), label: el.querySelector('.tlabel'), drawn: false };
    el._thumb = t;
    thumbs.set(p.id, t);
    thumbIo.observe(el);
    return t;
  }

  function syncThumbs() {
    const ids = new Set(note.pages.map((p) => p.id));
    for (const [id, t] of [...thumbs]) {
      if (!ids.has(id)) { thumbIo.unobserve(t.el); t.canvas.width = 0; t.el.remove(); thumbs.delete(id); }
    }
    if (selectedId && !ids.has(selectedId)) selectedId = null;
    note.pages.forEach((p, i) => {
      const t = thumbs.get(p.id) || createThumb(p);
      const [W, H] = pageSize(p);
      t.frame.style.aspectRatio = `${W} / ${H}`;
      t.label.textContent = String(i + 1);
      t.el.classList.toggle('selected', p.id === selectedId);
      if (orgGrid.children[i] !== t.el) orgGrid.insertBefore(t.el, orgGrid.children[i] || null);
    });
    updateOrgButtons();
  }

  function updateOrgButtons() {
    const i = selectedId ? note.pages.findIndex((p) => p.id === selectedId) : -1;
    $('#orgEarlier').disabled = i <= 0;
    $('#orgLater').disabled = i < 0 || i >= note.pages.length - 1;
    $('#orgDup').disabled = i < 0;
    $('#orgDel').disabled = i < 0 || note.pages.length < 2;
  }

  function select(id) {
    selectedId = id;
    for (const t of thumbs.values()) t.el.classList.toggle('selected', t.page.id === id);
    updateOrgButtons();
  }

  function openOrganizer() {
    if (active) return;
    selectedId = null;
    organizer.hidden = false;
    syncThumbs();
    // Start the grid near the page being looked at.
    let cur = null;
    for (const v of views.values()) if (isNear(v, 0)) { cur = v.id; break; }
    if (cur) thumbs.get(cur).el.scrollIntoView({ block: 'center' });
  }

  function closeOrganizer() {
    if (organizer.hidden) return;
    organizer.hidden = true;
    for (const t of thumbs.values()) { thumbIo.unobserve(t.el); t.canvas.width = 0; t.el.remove(); }
    thumbs.clear();
  }

  function openPage(id) {
    closeOrganizer();
    scrollToPage(id);
  }

  $('#orgBtn').addEventListener('click', openOrganizer);
  $('#orgDone').addEventListener('click', closeOrganizer);
  $('#orgEarlier').addEventListener('click', () => { const i = note.pages.findIndex((p) => p.id === selectedId); movePage(i, i - 1); });
  $('#orgLater').addEventListener('click', () => { const i = note.pages.findIndex((p) => p.id === selectedId); movePage(i, i + 1); });
  $('#orgDup').addEventListener('click', () => { select(duplicatePage(selectedId)); });
  $('#orgDel').addEventListener('click', () => deletePage(selectedId));

  // Dragging: pen and mouse drag right away; a finger has to press and hold
  // first, so a normal finger swipe still scrolls the grid.
  let drag = null;

  orgGrid.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.thumb');
    if (!el || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    drag = { id: el.dataset.id, el, pid: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, started: false, timer: 0, target: null };
    if (e.pointerType === 'touch') drag.timer = setTimeout(() => startDrag(), 350);
    else e.preventDefault();
  });

  orgGrid.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    const moved = Math.hypot(drag.x - drag.x0, drag.y - drag.y0);
    if (!drag.started) {
      if (drag.type === 'touch') { if (moved > 10) cancelDrag(); }
      else if (moved > 6) startDrag();
      return;
    }
    e.preventDefault();
    moveDrag();
  });

  orgGrid.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag;
    if (d.started) dropDrag();
    else {
      cancelDrag();
      if (Math.hypot(d.x - d.x0, d.y - d.y0) < 10) {
        if (selectedId === d.id) openPage(d.id); else select(d.id);
      }
    }
  });
  orgGrid.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.pid) cancelDrag(); });

  const gridTouch = stylusTouchGuard('.thumb', () => !!(drag && drag.started));
  orgGrid.addEventListener('touchstart', gridTouch, { passive: false });
  orgGrid.addEventListener('touchmove', gridTouch, { passive: false });
  orgGrid.addEventListener('contextmenu', (e) => e.preventDefault());

  function startDrag() {
    const d = drag;
    if (!d || d.started) return;
    d.started = true;
    try { d.el.setPointerCapture(d.pid); } catch {}
    select(d.id);
    const src = d.el.querySelector('canvas'), frame = d.el.querySelector('.tframe');
    const ghost = document.createElement('canvas');
    ghost.id = 'dragGhost';
    ghost.width = src.width || 1;
    ghost.height = src.height || 1;
    if (src.width) ghost.getContext('2d').drawImage(src, 0, 0);
    ghost.style.width = frame.clientWidth + 'px';
    ghost.style.height = frame.clientHeight + 'px';
    document.body.appendChild(ghost);
    d.ghost = ghost;
    d.el.classList.add('dragging');
    moveDrag();
    autoScroll();
  }

  function moveDrag() {
    const d = drag;
    d.ghost.style.left = d.x + 'px';
    d.ghost.style.top = d.y + 'px';
    if (d.target) d.target.el.classList.remove('drop-before', 'drop-after');
    d.target = null;
    const under = document.elementFromPoint(d.x, d.y);
    const el = under && under.closest && under.closest('.thumb');
    if (el && el !== d.el) {
      const r = el.getBoundingClientRect();
      const before = d.x < r.left + r.width / 2;
      el.classList.add(before ? 'drop-before' : 'drop-after');
      d.target = { el, before };
    }
  }

  function autoScroll() {
    if (!drag || !drag.started) return;
    const r = orgGrid.getBoundingClientRect(), edge = 70;
    let dy = 0;
    if (drag.y < r.top + edge) dy = -Math.ceil((r.top + edge - drag.y) / 5);
    else if (drag.y > r.bottom - edge) dy = Math.ceil((drag.y - (r.bottom - edge)) / 5);
    if (dy) { orgGrid.scrollTop += dy; moveDrag(); }
    requestAnimationFrame(autoScroll);
  }

  function dropDrag() {
    const d = drag;
    cancelDrag();
    if (!d.target) return;
    const from = note.pages.findIndex((p) => p.id === d.id);
    let to = note.pages.findIndex((p) => p.id === d.target.el.dataset.id) + (d.target.before ? 0 : 1);
    if (to > from) to--;
    movePage(from, to);
  }

  function cancelDrag() {
    const d = drag;
    if (!d) return;
    drag = null;
    clearTimeout(d.timer);
    if (d.ghost) d.ghost.remove();
    d.el.classList.remove('dragging');
    if (d.target) d.target.el.classList.remove('drop-before', 'drop-after');
  }

  // ---------------------------------------------------------------------------
  // Backup and restore (Safari can clear website storage, so keep a copy)
  // ---------------------------------------------------------------------------

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromBase64(str) {
    const s = atob(str), bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes.buffer;
  }

  $('#backupBtn').addEventListener('click', async () => {
    await flushSave();
    const [allNotes, allPages, allFiles] = await Promise.all([getAll('notes'), getAll('pages'), getAll('files')]);
    const round = (v) => Math.round(v * 100) / 100;
    const data = {
      app: 'pencil-notes', version: 2, notes: allNotes,
      pages: allPages.map((p) => ({ ...p, strokes: p.strokes.map((s) => ({ ...s, pts: Array.from(s.pts, round) })) })),
      files: allFiles.map((f) => ({ ...f, data: toBase64(f.data) })),
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    offerFile(blob, `pencil-notes-backup-${new Date().toISOString().slice(0, 10)}.json`);
  });

  $('#restoreBtn').addEventListener('click', () => $('#restoreInput').click());
  $('#restoreInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'pencil-notes') throw new Error('This is not a Pencil Notes backup.');
      if (!confirm(`Restore ${data.notes.length} note(s)? Notes with the same id will be replaced.`)) return;
      await flushSave();
      await tx(['notes', 'pages', 'files'], 'readwrite', (t) => {
        for (const n of data.notes) t.objectStore('notes').put(n);
        for (const p of data.pages) {
          t.objectStore('pages').put({ ...p, strokes: p.strokes.map((s) => ({ ...s, pts: Float32Array.from(s.pts) })) });
        }
        for (const fl of data.files || []) t.objectStore('files').put({ ...fl, data: fromBase64(fl.data) });
      });
      notes = await getAll('notes');
      note = null;
      await openNote(sortedNotes()[0].id);
      closeSidebar();
    } catch (err) {
      alert('Restore failed: ' + err.message);
    }
  });

  // ---------------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------------

  function renderToolbar() {
    for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === prefs.tool);
    const t = TOOLS[prefs.tool];
    const sw = $('#swatches');
    sw.textContent = '';
    t.colors.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'swatch' + (prefs.color[prefs.tool] === i ? ' on' : '');
      b.style.setProperty('--c', c);
      b.style.background = c;
      b.title = 'Color';
      b.addEventListener('click', () => { prefs.color[prefs.tool] = i; savePrefs(); renderToolbar(); });
      sw.appendChild(b);
    });
    sw.hidden = !t.colors.length;
    const sz = $('#sizes');
    sz.textContent = '';
    t.sizes.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = prefs.size[prefs.tool] === i ? 'on' : '';
      b.title = ['Thin', 'Medium', 'Thick'][i];
      const d = [4, 8, 13][i];
      b.innerHTML = `<span class="${prefs.tool === 'eraser' ? 'size-ring' : 'size-dot'}" style="width:${d}px;height:${d}px"></span>`;
      b.addEventListener('click', () => { prefs.size[prefs.tool] = i; savePrefs(); renderToolbar(); });
      sz.appendChild(b);
    });
    $('#fingerBtn').classList.toggle('on', prefs.finger);
    document.body.classList.toggle('finger', prefs.finger);
  }

  for (const b of document.querySelectorAll('[data-tool]')) {
    b.addEventListener('click', () => { prefs.tool = b.dataset.tool; savePrefs(); renderToolbar(); });
  }
  $('#fingerBtn').addEventListener('click', () => { prefs.finger = !prefs.finger; savePrefs(); renderToolbar(); });
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  $('#zoomIn').addEventListener('click', () => setZoom(ZOOMS.find((z) => z > prefs.zoom + 0.01) || 3));
  $('#zoomOut').addEventListener('click', () => setZoom([...ZOOMS].reverse().find((z) => z < prefs.zoom - 0.01) || 0.5));
  zoomLabel.addEventListener('click', () => setZoom(1));
  paperSel.addEventListener('change', () => {
    note.paper = prefs.paper = paperSel.value;
    savePrefs();
    metaDirty = true;
    scheduleSave();
    layout();
  });
  titleEl.addEventListener('input', () => { note.title = titleEl.value; metaDirty = true; scheduleSave(); });
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleEl.blur(); });
  $('#sideBtn').addEventListener('click', openSidebar);
  $('#backdrop').addEventListener('click', closeSidebar);
  $('#newNoteBtn').addEventListener('click', async () => { closeSidebar(); await newNote(); });
  addBar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]');
    if (b) addPages(note.pages.length, [newBlankPage(b.dataset.add)]);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target === titleEl) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); $('#zoomIn').click(); }
    else if (mod && e.key === '-') { e.preventDefault(); $('#zoomOut').click(); }
    else if (e.key === 'Escape' && !organizer.hidden) closeOrganizer();
  });

  // ---------------------------------------------------------------------------
  // Pinch to zoom (Safari gesture events; ctrl+wheel for trackpads elsewhere).
  // The pages are scaled with CSS while pinching, then re-rendered sharp at the end.
  // ---------------------------------------------------------------------------

  let pinch = null;
  document.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    if (active || !note || !organizer.hidden) return;
    let [x, y] = scrollerCenter();
    if (typeof e.clientX === 'number' && e.clientX) { x = e.clientX; y = e.clientY; }
    const r = pagesEl.getBoundingClientRect();
    pagesEl.style.transformOrigin = `${x - r.left}px ${y - r.top}px`;
    pinch = { z: prefs.zoom, s: 1, x, y };
  });
  document.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (!pinch) return;
    pinch.s = Math.min(3, Math.max(0.5, pinch.z * e.scale)) / pinch.z;
    pagesEl.style.transform = `scale(${pinch.s})`;
  });
  document.addEventListener('gestureend', (e) => {
    e.preventDefault();
    if (!pinch) return;
    pagesEl.style.transform = '';
    const p = pinch;
    pinch = null;
    setZoom(p.z * p.s, p.x, p.y);
  });

  let wheelZoom = null;
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (!wheelZoom) {
      wheelZoom = { f: 1, x: e.clientX, y: e.clientY };
      requestAnimationFrame(() => {
        const w = wheelZoom;
        wheelZoom = null;
        setZoom(prefs.zoom * w.f, w.x, w.y);
      });
    }
    wheelZoom.f *= Math.exp(-e.deltaY * 0.01);
  }, { passive: false });

  let resizeTimer = 0, lastWidth = 0;
  new ResizeObserver(() => {
    if (scroller.clientWidth === lastWidth) return;
    lastWidth = scroller.clientWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!note || !scroller.clientWidth) return;
      const r = scroller.getBoundingClientRect();
      relayout(r.left + r.width / 2, r.top + 1);
    }, 100);
  }).observe(scroller);

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  async function boot() {
    renderToolbar();
    updateUndo();
    try {
      await openDb();
    } catch (err) {
      alert('This browser won’t let the site store notes (private browsing?). ' + err.message);
      return;
    }
    notes = await getAll('notes');
    const last = localStorage.getItem('pn-last');
    if (!notes.length) await newNote();
    else await openNote(notes.some((n) => n.id === last) ? last : sortedNotes()[0].id);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  boot();
})();
