/*
 * MagicShop — canvas, layers, tools and Camera Raw adjustments.
 *
 * How it is organised:
 *  - `state` is plain JSON (document settings + a list of layers). It holds no
 *    pixels, so it is easy to copy for undo/redo, and later to send to other
 *    people for live teamwork.
 *  - A layer has a `type`: "image" (a photo), "text", "shape" or "path" (pen).
 *    Text, shapes and paths are saved as numbers and drawn fresh each time.
 *  - Image pixels live in the `images` map (image key -> picture). A picture is
 *    never changed. When pixels change (for example Delete inside an area
 *    selection), a new picture gets a new key and the layer points to it, so
 *    undo can simply point back to the old one.
 *  - Camera Raw sliders are saved as numbers on each photo layer (`layer.adjust`).
 *  - Which layers are selected is NOT part of `state`, so selecting is not an undo step.
 *  - Every change goes through `change()`, which records one undo step.
 */
(() => {
  'use strict';

  const MAX_DOC = 8000;      // biggest document side, in pixels
  const HANDLE_PX = 10;      // resize handle size, in screen pixels
  const MIN_LAYER = 10;      // smallest layer side, in document pixels
  const HISTORY_LIMIT = 100; // how many undo steps we keep
  const ZOOM_MIN = 0.02;
  const ZOOM_MAX = 8;
  const LINE_HEIGHT = 1.2;   // text line height, as a multiple of the font size

  // Biggest side (in pixels) used when processing a photo for each situation.
  const TIER_CAP = { live: 700, preview: 1600, export: 6000 };

  // ---------- Elements ----------

  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const workspace = $('workspace');
  const hint = $('hint');
  const layerList = $('layer-list');
  const opacity = $('opacity');
  const opacityOut = $('opacity-out');
  const zoomSlider = $('zoom-slider');
  const zoomLabel = $('zoom-label');
  const docSize = $('doc-size');
  const docName = $('doc-name');
  const fileInput = $('file-input');
  const undoBtn = $('btn-undo');
  const redoBtn = $('btn-redo');
  const newDialog = $('new-dialog');
  const fontsDialog = $('fonts-dialog');
  const toastEl = $('toast');
  const rulerX = $('ruler-x');
  const rulerY = $('ruler-y');
  const rawBody = $('raw-body');
  const rawEmpty = $('raw-empty');
  const rawLayerName = $('raw-layer-name');
  const autoBtn = $('btn-auto');
  const resetAdjustBtn = $('btn-reset-adjust');
  const compareBtn = $('btn-compare');
  const textEditor = $('text-editor');
  const toolOptions = $('tool-options');
  const designEmpty = $('design-empty');
  const designBody = $('design-body');

  // ---------- Icons used by code-built buttons ----------

  const svg = (inner) =>
    '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';

  const ICONS = {
    eye: svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: svg('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'),
    up: svg('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'),
    down: svg('<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>'),
    trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
    text: svg('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>'),
    shape: svg('<rect x="3" y="3" width="10" height="10" rx="1"/><circle cx="16" cy="16" r="5"/>'),
    path: svg('<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>'),
  };

  // ---------- Camera Raw: what the sliders are ----------

  const ADJUSTMENTS = [
    { group: 'Light', color: '#f4772e', items: [
      { key: 'exposure', label: 'Exposure', min: -100, max: 100 },
      { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
      { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
      { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
      { key: 'whites', label: 'Whites', min: -100, max: 100 },
      { key: 'blacks', label: 'Blacks', min: -100, max: 100 },
    ] },
    { group: 'Color', color: '#4f8cff', items: [
      // These two show the colors the slider moves toward (blue to yellow, green to magenta).
      { key: 'temperature', label: 'Temperature', min: -100, max: 100, gradient: '#3b82f6, #d4d4d8 50%, #f5c518' },
      { key: 'tint', label: 'Tint', min: -100, max: 100, gradient: '#22c55e, #d4d4d8 50%, #d946ef' },
      { key: 'vibrance', label: 'Vibrance', min: -100, max: 100 },
      { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
    ] },
    { group: 'Detail', color: '#8b5cf6', items: [
      { key: 'clarity', label: 'Clarity', min: -100, max: 100 },
      { key: 'sharpen', label: 'Sharpen', min: 0, max: 100 },
    ] },
    { group: 'Effects', color: '#14b8a6', items: [
      { key: 'vignette', label: 'Vignette', min: -100, max: 100 },
      { key: 'grain', label: 'Grain', min: 0, max: 100 },
    ] },
  ];

  const ADJUST_KEYS = ADJUSTMENTS.flatMap((g) => g.items.map((i) => i.key));
  const defaultAdjust = () => Object.fromEntries(ADJUST_KEYS.map((k) => [k, 0]));
  const isDefaultAdjust = (a) => ADJUST_KEYS.every((k) => !a[k]);

  // ---------- Fonts and starting styles for new things ----------

  const FONTS = [
    { name: 'Sans', family: 'system-ui, "Segoe UI", Arial, sans-serif' },
    { name: 'Serif', family: 'Georgia, "Times New Roman", serif' },
    { name: 'Mono', family: '"Courier New", Courier, monospace' },
    { name: 'Impact', family: 'Impact, "Arial Black", sans-serif' },
    { name: 'Rounded', family: '"Trebuchet MS", Verdana, sans-serif' },
    // These come from Google Fonts (loaded in index.html, so they need internet).
    { name: 'Inter', family: 'Inter, sans-serif' },
    { name: 'Poppins', family: 'Poppins, sans-serif' },
    { name: 'Montserrat', family: 'Montserrat, sans-serif' },
    { name: 'Raleway', family: 'Raleway, sans-serif' },
    { name: 'Oswald', family: 'Oswald, sans-serif' },
    { name: 'Anton', family: 'Anton, sans-serif' },
    { name: 'Bebas Neue', family: '"Bebas Neue", sans-serif' },
    { name: 'Playfair Display', family: '"Playfair Display", serif' },
    { name: 'Lobster', family: 'Lobster, cursive' },
    { name: 'Pacifico', family: 'Pacifico, cursive' },
    { name: 'Dancing Script', family: '"Dancing Script", cursive' },
    { name: 'Roboto Mono', family: '"Roboto Mono", monospace' },
  ];

  const extraFonts = [];     // fonts the user added (uploaded files or picked from their computer)
  let localFonts = null;     // family names found on this computer (after the user allows it)
  let fontPickerOnLayers = false;
  const allFonts = () => [...FONTS, ...extraFonts];
  const quoteFamily = (name) => '"' + name.replace(/["\\]/g, '') + '"';

  const SHAPES = [
    { value: 'rect', label: 'Rectangle' },
    { value: 'ellipse', label: 'Ellipse' },
    { value: 'triangle', label: 'Triangle' },
    { value: 'star', label: 'Star' },
  ];

  // What a new text / shape / path starts with. The options bar changes these.
  const defaults = {
    text: { font: FONTS[0].family, size: 72, weight: 400, italic: false, color: '#111111', align: 'left',
      letterSpacing: 0, lineHeight: 1.2, underline: false, strike: false, caps: false },
    shape: { shape: 'rect', fill: '#5b8cff', stroke: '', strokeWidth: 4, radius: 0 },
    path: { fill: '', stroke: '#111111', strokeWidth: 4 },
  };

  // ---------- State ----------

  let state = {
    doc: { name: 'Untitled artwork', width: 1200, height: 800, background: '#ffffff', transparent: false, autoSize: true },
    layers: [],        // index 0 = bottom layer
  };

  let sel = [];                 // ids of the selected layers (not part of undo)
  const images = new Map();     // image key -> HTMLImageElement or canvas
  const processed = new Map();  // "layerId|tier" -> { key, canvas } (Camera Raw results)
  let nextId = 1;
  let nextImg = 1;
  let viewScale = 1;
  let fitMode = true;
  let drag = null;
  let pendingBefore = null;     // snapshot taken when a slider starts moving
  let adjusting = false;        // true while a Camera Raw slider is being dragged
  let showOriginal = false;     // true while "Hold to compare" is pressed
  let activeTab = 'layers';
  let tool = 'select';
  let colors = { accent: '#5b8cff', rulerText: '#8f9bc6', rulerTick: '#3a4676' };
  let frame = 0;

  let editing = null;           // text being typed: { id, before, t }
  let editingId = null;         // this layer is hidden on the canvas while its text box is open
  let marq = null;              // area selection: { kind, x, y, w, h }
  let marqKind = 'rect';
  let band = null;              // box being dragged with the Select tool
  let penDraft = null;          // pen path being drawn: { pts, cur }

  const undoStack = [];
  const redoStack = [];

  const snapshot = () => JSON.stringify(state);
  const getLayer = (id) => state.layers.find((l) => l.id === id) || null;
  const selectedLayers = () => sel.map(getLayer).filter(Boolean);
  const selected = () => (sel.length === 1 ? getLayer(sel[0]) : null);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const srcW = (img) => img.naturalWidth || img.width;
  const srcH = (img) => img.naturalHeight || img.height;

  // ---------- History ----------

  function commit(before) {
    if (before === snapshot()) return;
    undoStack.push(before);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
    updateHistoryButtons();
  }

  // Run a change as one undo step, then redraw everything.
  function change(fn) {
    const before = snapshot();
    fn();
    commit(before);
    renderAll();
  }

  function applySnapshot(text) {
    state = JSON.parse(text);
    sel = sel.filter((id) => getLayer(id));
    renderAll();
  }

  function undo() {
    finishTextEdit();
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    applySnapshot(undoStack.pop());
  }

  function redo() {
    finishTextEdit();
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    applySnapshot(redoStack.pop());
  }

  function updateHistoryButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  // Sliders send many "input" events; we turn them into one undo step.
  function beginEdit() {
    if (pendingBefore === null) pendingBefore = snapshot();
  }

  function endEdit() {
    if (pendingBefore !== null) commit(pendingBefore);
    pendingBefore = null;
    adjusting = false;
    render();
    updateHistoryButtons();
  }

  function scheduleRender() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  }

  // ---------- Camera Raw: the pixel work ----------

  // Light is handled in "linear" space, like a real camera pipeline.
  const TO_LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) TO_LIN[i] = Math.pow(i / 255, 2.2);
  const FROM_LIN = new Float32Array(4097);
  for (let i = 0; i <= 4096; i++) FROM_LIN[i] = Math.pow(i / 4096, 1 / 2.2);
  const fromLin = (x) => FROM_LIN[x <= 0 ? 0 : x >= 1 ? 4096 : (x * 4096 + 0.5) | 0];

  const smooth = (a, b, x) => {
    const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
    return t * t * (3 - 2 * t);
  };

  // Same noise every time for the same pixel, so Grain does not shimmer.
  function hash(x, y) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // Fast blur: a running-sum box blur, done twice (close to a soft Gaussian).
  function boxBlurOnce(src, w, h, r) {
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    const win = 2 * r + 1;

    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = (r + 1) * src[row];
      for (let k = 1; k <= r; k++) sum += src[row + Math.min(k, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / win;
        sum += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
      }
    }

    for (let x = 0; x < w; x++) {
      let sum = (r + 1) * tmp[x];
      for (let k = 1; k <= r; k++) sum += tmp[Math.min(k, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / win;
        sum += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
      }
    }
    return out;
  }

  const blurPlane = (plane, w, h, r) => boxBlurOnce(boxBlurOnce(plane, w, h, r), w, h, r);

  // Edge-aware smoothing (a "guided filter"). It blurs flat areas but keeps strong edges sharp,
  // so Clarity adds punch without ugly glowing halos around edges.
  function guidedFilter(I, w, h, r, eps) {
    const n = I.length;
    const II = new Float32Array(n);
    for (let i = 0; i < n; i++) II[i] = I[i] * I[i];

    const meanI = boxBlurOnce(I, w, h, r);
    const meanII = boxBlurOnce(II, w, h, r);
    const a = new Float32Array(n);
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const variance = meanII[i] - meanI[i] * meanI[i];
      const ai = variance / (variance + eps);
      a[i] = ai;
      b[i] = meanI[i] * (1 - ai);
    }

    const meanA = boxBlurOnce(a, w, h, r);
    const meanB = boxBlurOnce(b, w, h, r);
    const q = new Float32Array(n);
    for (let i = 0; i < n; i++) q[i] = meanA[i] * I[i] + meanB[i];
    return q;
  }

  // S-curve around a pivot: g > 1 deepens shadows and lifts highlights (more contrast), g < 1 flattens
  function toneCurve(y, g, p) {
    if (y <= 0 || y >= 1) return y;
    if (g < 1) g = 1 / (2 - g);
    return y < p ? p * Math.pow(y / p, g) : 1 - (1 - p) * Math.pow((1 - y) / (1 - p), g);
  }

  function applyAdjustments(d, w, h, a) {
    // ----- Pass 1: color and tone, one pixel at a time -----
    const TK = 0.6, CK = 3; // tuned against Photoshop Camera Raw
    const exposureGain = Math.pow(2, a.exposure / 40); // +-100 = +-2 stops
    const rGain = (1 + (TK * a.temperature) / 100) * exposureGain;
    const bGain = (1 - (TK * a.temperature) / 100) * (1 + (0.3 * a.tint) / 100) * exposureGain;
    const gGain = (1 - (0.5 * a.tint) / 100) * exposureGain;

    const cg = 1 + (a.contrast / 100) * 0.84; // curve strength
    const cp = 0.5; // curve pivot
    const contrast = a.contrast ? cg : 1;
    const hl = (a.highlights / 100) * 0.15;
    const sh = (a.shadows / 100) * 0.35;
    const wh = (a.whites / 100) * 0.25;
    const bl = (a.blacks / 100) * 0.25;
    const tonal = a.contrast || a.highlights || a.shadows || a.whites || a.blacks;

    const satFactor = 1 + a.saturation / 100;
    const vib = (a.vibrance / 100) * 0.6;
    const colorOp = a.saturation || a.vibrance;

    for (let i = 0; i < d.length; i += 4) {
      let r = fromLin(TO_LIN[d[i]] * rGain);
      let g = fromLin(TO_LIN[d[i + 1]] * gGain);
      let b = fromLin(TO_LIN[d[i + 2]] * bGain);

      if (tonal) {
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        let y2 = y;
        if (contrast !== 1) y2 = toneCurve(y2, cg, cp);
        if (hl) y2 += hl * smooth(0.4, 1, y);
        if (sh) y2 += sh * (1 - smooth(0, 0.6, y));
        if (wh) y2 += wh * smooth(0.65, 1, y);
        if (bl) y2 += bl * (1 - smooth(0, 0.35, y));
        const dy = y2 - y;
        r = clamp(r + dy, 0, 1);
        g = clamp(g + dy, 0, 1);
        b = clamp(b + dy, 0, 1);
      }

      if (colorOp) {
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        let f = satFactor;
        if (vib) f *= 1 + vib * (1 - sat); // vibrance helps dull colors most
        r = y + (r - y) * f;
        g = y + (g - y) * f;
        b = y + (b - y) * f;
      }

      d[i] = r * 255 + 0.5;
      d[i + 1] = g * 255 + 0.5;
      d[i + 2] = b * 255 + 0.5;
    }

    // ----- Pass 2: detail and effects (need neighbouring pixels or position) -----
    if (!(a.clarity || a.sharpen || a.vignette || a.grain)) return;

    const n = w * h;
    const longSide = Math.max(w, h);
    let lum = null;
    let broad = null;
    let fine = null;

    if (a.clarity || a.sharpen) {
      lum = new Float32Array(n);
      for (let p = 0, i = 0; p < n; p++, i += 4) {
        lum[p] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      }
      if (a.clarity) broad = guidedFilter(lum, w, h, Math.max(4, Math.round(longSide * 0.02)), 0.012);
      if (a.sharpen) fine = blurPlane(lum, w, h, Math.max(1, Math.round(longSide * 0.0012)));
    }

    const clarityAmount = (a.clarity / 100) * CK;
    const sharpenAmount = (a.sharpen / 100) * 1.6;
    const vig = a.vignette / 100;
    const grain = (a.grain / 100) * 0.3;

    for (let y = 0, p = 0; y < h; y++) {
      const ny = ((y + 0.5) / h) * 2 - 1;
      for (let x = 0; x < w; x++, p++) {
        const i = p * 4;
        let r = d[i] / 255;
        let g = d[i + 1] / 255;
        let b = d[i + 2] / 255;

        if (lum) {
          const l = lum[p];
          let dy = 0;
          if (broad) dy += clarityAmount * (l - broad[p]) * 4 * l * (1 - l); // mid-tones only
          if (fine) dy += sharpenAmount * (l - fine[p]);
          r += dy;
          g += dy;
          b += dy;
        }

        if (vig) {
          const nx = ((x + 0.5) / w) * 2 - 1;
          const m = Math.pow((nx * nx + ny * ny) / 2, 1.5);
          if (vig < 0) {
            const f = 1 + 0.5 * vig * m;
            r *= f; g *= f; b *= f;
          } else {
            const k = 0.5 * vig * m;
            r += (1 - r) * k; g += (1 - g) * k; b += (1 - b) * k;
          }
        }

        if (grain) {
          const noise = (hash(x, y) - 0.5) * grain;
          r += noise; g += noise; b += noise;
        }

        d[i] = r * 255 + 0.5;
        d[i + 1] = g * 255 + 0.5;
        d[i + 2] = b * 255 + 0.5;
      }
    }
  }

  function processImage(img, adjust, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const data = g.getImageData(0, 0, w, h);
    applyAdjustments(data.data, w, h, adjust);
    g.putImageData(data, 0, 0);
    return c;
  }

  // How many pixels we need when we process this layer.
  function proxySize(layer, img, tier) {
    const nw = srcW(img);
    const nh = srcH(img);
    const need = Math.max(layer.width / nw, layer.height / nh); // never more detail than shown
    const s = Math.min(1, TIER_CAP[tier] / Math.max(nw, nh), need);
    return { w: Math.max(1, Math.round(nw * s)), h: Math.max(1, Math.round(nh * s)) };
  }

  // The thing to draw for a layer: the original image, or its Camera Raw version.
  function getDrawable(layer, tier) {
    const img = images.get(layer.img);
    if (!img) return null;
    if (isDefaultAdjust(layer.adjust)) return img;
    if (showOriginal && tier !== 'export' && sel.includes(layer.id)) return img;

    const size = proxySize(layer, img, tier);

    if (tier === 'export') {
      return processImage(img, layer.adjust, size.w, size.h); // full quality, not cached
    }

    const key = layer.img + JSON.stringify(layer.adjust) + '|' + size.w + 'x' + size.h;
    const slot = layer.id + '|' + tier;
    const hit = processed.get(slot);
    // While moving or resizing a layer we reuse the last result instead of redoing the work.
    if (hit && (hit.key === key || drag)) return hit.canvas;

    const result = processImage(img, layer.adjust, size.w, size.h);
    processed.set(slot, { key, canvas: result });
    return result;
  }

  // "Smart" Auto: look at the picture and suggest light settings.
  function computeAuto(img) {
    const s = Math.min(1, 256 / Math.max(srcW(img), srcH(img)));
    const w = Math.max(1, Math.round(srcW(img) * s));
    const h = Math.max(1, Math.round(srcH(img) * s));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;

    const hist = new Float64Array(256);
    let meanLin = 0;
    let count = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      const y = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
      hist[y]++;
      meanLin += TO_LIN[y];
      count++;
    }
    if (!count) return {};
    meanLin /= count;

    // 1. Exposure: move the average brightness toward a pleasant middle.
    const stops = clamp(Math.log2(0.2 / Math.max(meanLin, 0.002)), -1.5, 1.5);
    const gain = Math.pow(2, stops);

    // 2. Look at the brightness spread after that exposure.
    const mapped = new Float64Array(256);
    for (let i = 0; i < 256; i++) {
      const y2 = Math.min(1, Math.pow(TO_LIN[i] * gain, 1 / 2.2));
      mapped[Math.round(y2 * 255)] += hist[i];
    }
    const percentile = (p) => {
      let acc = 0;
      for (let i = 0; i < 256; i++) {
        acc += mapped[i];
        if (acc >= count * p) return i / 255;
      }
      return 1;
    };
    const p1 = percentile(0.01);
    const p10 = percentile(0.1);
    const p90 = percentile(0.9);
    const p99 = percentile(0.99);

    return {
      exposure: Math.round(clamp(stops * 50, -75, 75)),
      contrast: Math.round(clamp((0.9 - (p99 - p1)) * 60, 0, 30)),
      highlights: -Math.round(clamp((p90 - 0.82) * 300, 0, 60)),
      shadows: Math.round(clamp((0.22 - p10) * 250, 0, 50)),
      whites: Math.round(clamp((0.97 - p99) * 300, -50, 60)),
      blacks: Math.round(clamp((0.03 - p1) * 300, -60, 40)),
      vibrance: 15,
      clarity: 10,
    };
  }
  // ---------- Drawing layers ----------

  const measureCtx = document.createElement('canvas').getContext('2d');

  const fontString = (l) =>
    (l.italic ? 'italic ' : '') + (l.weight || 400) + ' ' + l.size + 'px ' + l.font;

  const textLines = (l) => String(l.text).split('\n').map((t) => (l.caps ? t.toUpperCase() : t));

  // Width of one line, with extra space between letters.
  function lineWidth(g, line, spacing) {
    if (!spacing) return g.measureText(line).width;
    if ('letterSpacing' in g) {
      g.letterSpacing = spacing + 'px';
      const w = g.measureText(line).width;
      g.letterSpacing = '0px';
      return w;
    }
    let w = 0;
    for (const ch of line) w += g.measureText(ch).width + spacing;
    return w;
  }

  // Works out how big a text layer is, from its words and style.
  function fitText(l) {
    measureCtx.font = fontString(l);
    const lines = textLines(l);
    let w = 0;
    for (const line of lines) w = Math.max(w, lineWidth(measureCtx, line, l.letterSpacing || 0));
    l.width = Math.max(Math.ceil(w), Math.round(l.size * 0.4));
    l.height = Math.round(lines.length * l.size * (l.lineHeight || LINE_HEIGHT));
  }

  function drawText(g, l) {
    g.font = fontString(l);
    g.fillStyle = l.color;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    const spacing = l.letterSpacing || 0;
    const lh = l.size * (l.lineHeight || LINE_HEIGHT);
    const thick = Math.max(1, l.size / 16);
    textLines(l).forEach((line, i) => {
      const w = lineWidth(g, line, spacing);
      const x0 = l.align === 'center' ? l.x + (l.width - w) / 2 : l.align === 'right' ? l.x + l.width - w : l.x;
      const y = l.y + i * lh + lh / 2;
      if ('letterSpacing' in g) {
        g.letterSpacing = spacing + 'px';
        g.fillText(line, x0, y);
        g.letterSpacing = '0px';
      } else if (spacing) {
        let x = x0;
        for (const ch of line) {
          g.fillText(ch, x, y);
          x += g.measureText(ch).width + spacing;
        }
      } else {
        g.fillText(line, x0, y);
      }
      if (l.underline) g.fillRect(x0, y + l.size * 0.38, w, thick);
      if (l.strike) g.fillRect(x0, y - thick / 2, w, thick);
    });
  }

  // The outline of a shape layer, in document coordinates.
  function shapePath(l) {
    const p = new Path2D();
    const { x, y, width: w, height: h } = l;
    if (l.shape === 'ellipse') {
      p.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else if (l.shape === 'triangle') {
      p.moveTo(x + w / 2, y);
      p.lineTo(x + w, y + h);
      p.lineTo(x, y + h);
      p.closePath();
    } else if (l.shape === 'star') {
      const raw = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 0.45 : 1;
        raw.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      const xs = raw.map((q) => q[0]);
      const ys = raw.map((q) => q[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      raw.forEach((q, i) => {
        const px = x + ((q[0] - minX) / (maxX - minX)) * w;
        const py = y + ((q[1] - minY) / (maxY - minY)) * h;
        if (i === 0) p.moveTo(px, py);
        else p.lineTo(px, py);
      });
      p.closePath();
    } else {
      const r = Math.min(l.radius || 0, w / 2, h / 2);
      if (r > 0 && p.roundRect) p.roundRect(x, y, w, h, r);
      else p.rect(x, y, w, h);
    }
    return p;
  }

  // The outline of a pen path. Its points are saved between 0 and 1 inside the layer box,
  // so moving and resizing the layer is just changing the box.
  function pathPath(l) {
    const p = new Path2D();
    const P = (n) => [l.x + n.x * l.width, l.y + n.y * l.height];
    const pts = l.points;
    if (!pts.length) return p;
    p.moveTo(...P(pts[0]));
    const seg = (a, b) => {
      if (!a.out && !b.in) {
        p.lineTo(...P(b));
      } else {
        p.bezierCurveTo(...P(a.out || a), ...P(b.in || b), ...P(b));
      }
    };
    for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
    if (l.closed && pts.length > 2) {
      seg(pts[pts.length - 1], pts[0]);
      p.closePath();
    }
    return p;
  }

  function paintVector(g, l) {
    const path = l.type === 'shape' ? shapePath(l) : pathPath(l);
    if (l.fill) {
      g.fillStyle = l.fill;
      g.fill(path);
    }
    if (l.stroke && l.strokeWidth > 0) {
      g.strokeStyle = l.stroke;
      g.lineWidth = l.strokeWidth;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.stroke(path);
    }
  }

  // ---------- Rotation helpers ----------

  const radOf = (l) => ((l.rotation || 0) * Math.PI) / 180;

  // Turns a point on the artwork into the layer's own (unrotated) frame, and back.
  function toLocal(l, p) {
    const th = radOf(l);
    const cx = l.x + l.width / 2;
    const cy = l.y + l.height / 2;
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: cx + dx * Math.cos(th) + dy * Math.sin(th), y: cy - dx * Math.sin(th) + dy * Math.cos(th) };
  }

  function fromLocal(l, q) {
    const th = radOf(l);
    const cx = l.x + l.width / 2;
    const cy = l.y + l.height / 2;
    const dx = q.x - cx;
    const dy = q.y - cy;
    return { x: cx + dx * Math.cos(th) - dy * Math.sin(th), y: cy + dx * Math.sin(th) + dy * Math.cos(th) };
  }

  // The box around a layer after it is turned.
  function layerBounds(l) {
    const pts = [
      fromLocal(l, { x: l.x, y: l.y }),
      fromLocal(l, { x: l.x + l.width, y: l.y }),
      fromLocal(l, { x: l.x, y: l.y + l.height }),
      fromLocal(l, { x: l.x + l.width, y: l.y + l.height }),
    ];
    const xs = pts.map((q) => q.x);
    const ys = pts.map((q) => q.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }

  const ROTATE_GAP = 28; // distance of the rotate handle above the layer, in screen pixels

  function rotateHandlePos(l) {
    return fromLocal(l, { x: l.x + l.width / 2, y: l.y - ROTATE_GAP / viewScale });
  }

  function drawLayer(g, l, tier, ignoreOpacity) {
    g.globalAlpha = ignoreOpacity ? 1 : l.opacity;
    const rot = l.rotation || 0;
    if (rot) {
      g.save();
      g.translate(l.x + l.width / 2, l.y + l.height / 2);
      g.rotate((rot * Math.PI) / 180);
      g.translate(-(l.x + l.width / 2), -(l.y + l.height / 2));
    }
    if (l.type === 'image') {
      const source = getDrawable(l, tier);
      if (source) g.drawImage(source, l.x, l.y, l.width, l.height);
    } else if (l.type === 'text') {
      drawText(g, l);
    } else {
      paintVector(g, l);
    }
    if (rot) g.restore();
    g.globalAlpha = 1;
  }

  // Paints the document (no selection handles). Used for the screen and for export.
  function paintDocument(g, forceOpaque, tier) {
    const { width, height, background, transparent } = state.doc;
    if (!transparent || forceOpaque) {
      g.fillStyle = transparent ? '#ffffff' : background;
      g.fillRect(0, 0, width, height);
    }
    for (const layer of state.layers) {
      if (!layer.visible) continue;
      if (g === ctx && layer.id === editingId) continue; // its text box is showing instead
      drawLayer(g, layer, tier, false);
    }
    g.globalAlpha = 1;
  }

  // ---------- Selection drawing ----------

  function handlePoints(l) {
    return [
      { name: 'nw', ...fromLocal(l, { x: l.x, y: l.y }) },
      { name: 'ne', ...fromLocal(l, { x: l.x + l.width, y: l.y }) },
      { name: 'sw', ...fromLocal(l, { x: l.x, y: l.y + l.height }) },
      { name: 'se', ...fromLocal(l, { x: l.x + l.width, y: l.y + l.height }) },
    ];
  }

  function unionBox(layers) {
    if (!layers.length) return null;
    const bs = layers.map(layerBounds);
    const x1 = Math.min(...bs.map((b) => b.x));
    const y1 = Math.min(...bs.map((b) => b.y));
    const x2 = Math.max(...bs.map((b) => b.x + b.width));
    const y2 = Math.max(...bs.map((b) => b.y + b.height));
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }

  function drawSelection() {
    const layers = selectedLayers().filter((l) => l.visible && l.id !== editingId);
    if (!layers.length) return;
    const s = 1 / viewScale;
    ctx.save();
    ctx.lineWidth = 2 * s;
    ctx.strokeStyle = colors.accent;

    for (const l of layers) {
      ctx.save();
      ctx.translate(l.x + l.width / 2, l.y + l.height / 2);
      ctx.rotate(radOf(l));
      ctx.strokeRect(-l.width / 2, -l.height / 2, l.width, l.height);
      if (layers.length === 1) {
        const size = HANDLE_PX * s;
        ctx.fillStyle = '#ffffff';
        for (const [cx, cy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const hx = (cx * l.width) / 2;
          const hy = (cy * l.height) / 2;
          ctx.fillRect(hx - size / 2, hy - size / 2, size, size);
          ctx.strokeRect(hx - size / 2, hy - size / 2, size, size);
        }
        // Rotate handle: a circle on a short line above the top edge.
        ctx.beginPath();
        ctx.moveTo(0, -l.height / 2);
        ctx.lineTo(0, -l.height / 2 - ROTATE_GAP * s);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, -l.height / 2 - ROTATE_GAP * s, (HANDLE_PX / 2) * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    if (layers.length > 1) {
      const u = unionBox(layers);
      ctx.setLineDash([6 * s, 4 * s]);
      ctx.strokeRect(u.x, u.y, u.width, u.height);
    }
    ctx.restore();
  }

  function regionPath(m) {
    const p = new Path2D();
    if (m.kind === 'ellipse') p.ellipse(m.x + m.w / 2, m.y + m.h / 2, m.w / 2, m.h / 2, 0, 0, Math.PI * 2);
    else p.rect(m.x, m.y, m.w, m.h);
    return p;
  }

  function drawOverlays() {
    drawSelection();
    const s = 1 / viewScale;

    if (band) {
      ctx.save();
      ctx.lineWidth = s;
      ctx.fillStyle = 'rgba(91, 140, 255, 0.15)';
      ctx.strokeStyle = colors.accent;
      ctx.fillRect(band.x, band.y, band.w, band.h);
      ctx.strokeRect(band.x, band.y, band.w, band.h);
      ctx.restore();
    }

    if (marq && marq.w > 0 && marq.h > 0) {
      // "Marching ants": a dashed line, white over black so it shows on any picture.
      const path = regionPath(marq);
      ctx.save();
      ctx.lineWidth = s;
      ctx.setLineDash([5 * s, 5 * s]);
      ctx.strokeStyle = '#000000';
      ctx.stroke(path);
      ctx.lineDashOffset = 5 * s;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke(path);
      ctx.restore();
    }

    if (penDraft) drawPenDraft();
  }

  function penPathOf(pts, cur) {
    const p = new Path2D();
    if (!pts.length) return p;
    p.moveTo(pts[0].x, pts[0].y);
    const seg = (a, b) => {
      if (!a.out && !b.in) p.lineTo(b.x, b.y);
      else {
        const c1 = a.out || a;
        const c2 = b.in || b;
        p.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
      }
    };
    for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
    if (cur) seg(pts[pts.length - 1], { x: cur.x, y: cur.y, in: null, out: null });
    return p;
  }

  function drawPenDraft() {
    const s = 1 / viewScale;
    const { pts, cur } = penDraft;
    ctx.save();
    ctx.lineWidth = Math.max(defaults.path.strokeWidth, 1);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = defaults.path.stroke || colors.accent;
    ctx.stroke(penPathOf(pts, null));
    // Thin guide line to where the mouse is.
    ctx.lineWidth = s;
    ctx.setLineDash([4 * s, 4 * s]);
    ctx.strokeStyle = colors.accent;
    if (cur && pts.length) ctx.stroke(penPathOf([pts[pts.length - 1]], cur));
    ctx.setLineDash([]);
    const size = 8 * s;
    pts.forEach((pt, i) => {
      for (const h of [pt.in, pt.out]) {
        if (!h) continue;
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(h.x, h.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(h.x, h.y, 3 * s, 0, Math.PI * 2);
        ctx.fillStyle = colors.accent;
        ctx.fill();
      }
      ctx.fillStyle = i === 0 ? colors.accent : '#ffffff';
      ctx.fillRect(pt.x - size / 2, pt.y - size / 2, size, size);
      ctx.strokeRect(pt.x - size / 2, pt.y - size / 2, size, size);
    });
    ctx.restore();
  }

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    paintDocument(ctx, false, adjusting ? 'live' : 'preview');
    drawOverlays();
  }

  // ---------- View: zoom and rulers ----------

  const zoomToSlider = (z) => Math.round((Math.log(z / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * 1000);
  const sliderToZoom = (v) => ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, v / 1000);

  function applyScale() {
    canvas.style.width = state.doc.width * viewScale + 'px';
    canvas.style.height = state.doc.height * viewScale + 'px';
    zoomLabel.textContent = Math.round(viewScale * 100) + '%';
    zoomSlider.value = String(zoomToSlider(viewScale));
    syncEditor();
  }

  function updateView() {
    applyScale();
    render();
    drawRulers();
  }

  // Extra empty room around the canvas, so you can move it around freely.
  function updatePadding() {
    workspace.style.setProperty('--pad-x', Math.round(workspace.clientWidth * 0.6) + 'px');
    workspace.style.setProperty('--pad-y', Math.round(workspace.clientHeight * 0.6) + 'px');
  }

  function centerView() {
    workspace.scrollLeft = (workspace.scrollWidth - workspace.clientWidth) / 2;
    workspace.scrollTop = (workspace.scrollHeight - workspace.clientHeight) / 2;
  }

  function fitToScreen() {
    const availW = Math.max(50, workspace.clientWidth - 64);
    const availH = Math.max(50, workspace.clientHeight - 64 - 80);
    viewScale = clamp(Math.min(availW / state.doc.width, availH / state.doc.height, 1), ZOOM_MIN, ZOOM_MAX);
    fitMode = true;
    applyScale();
    centerView();
  }

  // Zoom, keeping the spot under (clientX, clientY) where it is on screen.
  function setZoom(newScale, clientX, clientY) {
    const before = canvas.getBoundingClientRect();
    const docX = (clientX - before.left) / viewScale;
    const docY = (clientY - before.top) / viewScale;

    fitMode = false;
    viewScale = clamp(newScale, ZOOM_MIN, ZOOM_MAX);
    applyScale();

    const after = canvas.getBoundingClientRect();
    workspace.scrollLeft += after.left + docX * viewScale - clientX;
    workspace.scrollTop += after.top + docY * viewScale - clientY;
    render();
    drawRulers();
  }

  function zoomBy(factor) {
    const r = workspace.getBoundingClientRect();
    setZoom(viewScale * factor, r.left + r.width / 2, r.top + r.height / 2);
  }

  const RULER_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];

  function drawRuler(c, horizontal) {
    const cssW = c.clientWidth;
    const cssH = c.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);

    const wsRect = workspace.getBoundingClientRect();
    const cvRect = canvas.getBoundingClientRect();
    const origin = horizontal ? cvRect.left - wsRect.left : cvRect.top - wsRect.top;
    const length = horizontal ? cssW : cssH;

    const step = RULER_STEPS.find((s) => s * viewScale >= 70) || 10000;
    const minor = step / 5;
    const drawMinor = step >= 5 && minor * viewScale >= 6;
    const inc = drawMinor ? minor : step;

    const first = Math.floor(-origin / viewScale / inc) * inc;
    const last = (length - origin) / viewScale;

    g.strokeStyle = colors.rulerTick;
    g.fillStyle = colors.rulerText;
    g.font = '10px system-ui, sans-serif';
    g.lineWidth = 1;
    g.textBaseline = 'top';

    for (let v = first; v <= last; v += inc) {
      const pos = Math.round(origin + v * viewScale) + 0.5;
      const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
      const len = major ? 10 : 5;
      g.beginPath();
      if (horizontal) {
        g.moveTo(pos, cssH);
        g.lineTo(pos, cssH - len);
      } else {
        g.moveTo(cssW, pos);
        g.lineTo(cssW - len, pos);
      }
      g.stroke();

      if (major) {
        const label = String(Math.round(v));
        if (horizontal) {
          g.fillText(label, pos + 3, 3);
        } else {
          g.save();
          g.translate(3, pos - 3);
          g.rotate(-Math.PI / 2);
          g.fillText(label, 0, 0);
          g.restore();
        }
      }
    }
  }

  function drawRulers() {
    drawRuler(rulerX, true);
    drawRuler(rulerY, false);
  }
  // ---------- Small helpers for building controls ----------

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function seg(items, current, onPick) {
    const wrap = el('div', 'seg');
    for (const it of items) {
      const b = el('button', it.value === current ? 'on' : '', it.label);
      b.type = 'button';
      if (it.title) b.title = it.title;
      b.addEventListener('click', () => onPick(it.value));
      wrap.append(b);
    }
    return wrap;
  }

  function makeButton(className, icon, title, action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn ' + className;
    b.innerHTML = icon; // our own fixed icon strings only
    b.title = title;
    b.setAttribute('aria-label', title);
    b.dataset.action = action;
    return b;
  }

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    colors = {
      accent: cs.getPropertyValue('--accent').trim() || colors.accent,
      rulerText: cs.getPropertyValue('--ruler-text').trim() || colors.rulerText,
      rulerTick: cs.getPropertyValue('--ruler-tick').trim() || colors.rulerTick,
    };
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { toastEl.hidden = true; }, 4000);
  }

  // ---------- Layers panel ----------

  const typeLabel = (l) => (l.type === 'shape'
    ? SHAPES.find((s) => s.value === l.shape).label
    : l.type === 'path' ? 'Path' : l.type === 'text' ? 'Text' : 'Photo');

  const textName = (l) => (String(l.text).replace(/\s+/g, ' ').trim().slice(0, 24) || 'Text');

  function makeThumb(l) {
    if (l.type === 'image') {
      const c = document.createElement('canvas');
      c.width = 72;
      c.height = 72;
      c.className = 'thumb';
      const img = images.get(l.img);
      if (img) {
        const s = Math.min(72 / srcW(img), 72 / srcH(img));
        const w = srcW(img) * s;
        const h = srcH(img) * s;
        c.getContext('2d').drawImage(img, (72 - w) / 2, (72 - h) / 2, w, h);
      }
      return c;
    }
    const t = el('span', 'thumb type');
    t.innerHTML = ICONS[l.type]; // our own fixed icon strings only
    return t;
  }

  function renderPanel() {
    layerList.textContent = '';

    if (!state.layers.length) {
      layerList.append(el('li', 'empty', 'No layers yet'));
      return;
    }

    const top = state.layers.length - 1;
    for (let i = top; i >= 0; i--) {
      const l = state.layers[i];
      const li = document.createElement('li');
      li.className = 'layer' + (sel.includes(l.id) ? ' selected' : '') + (l.visible ? '' : ' is-hidden');
      li.dataset.id = l.id;

      const eye = makeButton('eye', l.visible ? ICONS.eye : ICONS.eyeOff, l.visible ? 'Hide layer' : 'Show layer', 'toggle');
      const name = el('span', 'name', l.name); // names are shown as text, never as HTML
      name.title = l.name;

      const up = makeButton('up', ICONS.up, 'Move layer up', 'up');
      up.disabled = i === top;
      const down = makeButton('down', ICONS.down, 'Move layer down', 'down');
      down.disabled = i === 0;
      const del = makeButton('delete', ICONS.trash, 'Delete layer', 'delete');

      li.append(eye, makeThumb(l), name, up, down, del);
      layerList.append(li);
    }
  }

  // Paints one slider: the number, and the coloured fill (from the middle for +/- sliders).
  // `gradient` (optional) shows a fixed color strip instead, like Temperature's blue-to-yellow.
  function paintRange(input, out, value, min, max, color, gradient) {
    input.value = String(value);
    if (gradient) {
      input.style.setProperty('--track', `linear-gradient(to right, ${gradient})`);
    } else {
      const pct = (v) => ((v - min) / (max - min)) * 100;
      const zero = pct(min < 0 ? 0 : min);
      const a = Math.min(zero, pct(value));
      const b = Math.max(zero, pct(value));
      input.style.setProperty(
        '--track',
        `linear-gradient(to right, var(--track-bg) 0 ${a}%, ${color} ${a}% ${b}%, var(--track-bg) ${b}% 100%)`
      );
    }
    if (out) out.textContent = String(value);
  }

  function renderOpacity() {
    const ls = selectedLayers();
    opacity.disabled = !ls.length;
    paintRange(opacity, opacityOut, ls.length ? Math.round(ls[0].opacity * 100) : 100, 0, 100, 'var(--accent)');
  }

  // Build the Camera Raw sliders once.
  const sliderRefs = {};
  function buildRawUI() {
    for (const group of ADJUSTMENTS) {
      const section = el('div', 'raw-group');
      section.append(el('h3', '', group.group));

      for (const item of group.items) {
        const row = el('div', 'slider-row');
        const head = el('div', 'slider-head');
        const label = el('label', '', item.label);
        label.htmlFor = 'adj-' + item.key;
        const out = el('output', 'chip chip-small', '0');

        const input = el('input', 'slider');
        input.type = 'range';
        input.id = 'adj-' + item.key;
        input.min = String(item.min);
        input.max = String(item.max);
        input.step = '1';
        input.value = '0';
        input.dataset.key = item.key;
        input.title = 'Double-click to reset';

        head.append(label, out);
        row.append(head, input);
        section.append(row);
        sliderRefs[item.key] = { input, out, item, color: group.color, gradient: item.gradient };
      }
      rawBody.append(section);
    }
  }

  // The photo layer the Camera Raw tab is working on (one selected photo), or null.
  function photo() {
    const l = selected();
    return l && l.type === 'image' ? l : null;
  }

  function renderAdjust() {
    const l = photo();
    rawEmpty.hidden = !!l;
    rawBody.hidden = !l;
    rawLayerName.textContent = l ? l.name : 'No photo selected';
    autoBtn.disabled = !l;
    resetAdjustBtn.disabled = !l;
    compareBtn.disabled = !l;
    if (!l) return;
    for (const key of ADJUST_KEYS) {
      const ref = sliderRefs[key];
      paintRange(ref.input, ref.out, l.adjust[key] || 0, ref.item.min, ref.item.max, ref.color, ref.gradient);
    }
  }

  // ---------- Style controls (used by the tool bar and the Design tab) ----------

  // Layers of this kind that are selected, or the starting style if none are.
  // `onLayers` false means the controls only change the starting style for new things.
  const styleTargets = (kind, onLayers) => (onLayers ? selectedLayers().filter((l) => l.type === kind) : []);
  const styleSource = (kind, onLayers) => styleTargets(kind, onLayers)[0] || defaults[kind];

  function syncEditor() {
    if (!editing) return;
    const l = getLayer(editing.id);
    if (!l) return;
    const st = textEditor.style;
    st.left = l.x * viewScale + 'px';
    st.top = l.y * viewScale + 'px';
    st.width = l.width * viewScale + 8 + 'px';
    st.height = l.height * viewScale + 'px';
    st.font = (l.italic ? 'italic ' : '') + l.weight + ' ' + l.size * viewScale + 'px/' + (l.lineHeight || LINE_HEIGHT) + ' ' + l.font;
    st.color = l.color;
    st.caretColor = l.color;
    st.textAlign = l.align;
    st.letterSpacing = (l.letterSpacing || 0) * viewScale + 'px';
    st.textTransform = l.caps ? 'uppercase' : 'none';
    st.textDecoration = [l.underline ? 'underline' : '', l.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
    st.transformOrigin = '50% 50%';
    st.transform = l.rotation ? 'rotate(' + l.rotation + 'deg)' : 'none';
  }

  // Changes a style. `live` is for color pickers (many events, one undo step).
  function setStyle(kind, props, live, onLayers) {
    if (props.font) document.fonts.load('400 20px ' + props.font).catch(() => {});
    if (!onLayers) Object.assign(defaults[kind], props);
    const targets = styleTargets(kind, onLayers);
    const apply = () => {
      for (const l of targets) {
        const oldName = kind === 'shape' ? typeLabel(l) : null;
        Object.assign(l, props);
        if (kind === 'shape' && l.name === oldName) l.name = typeLabel(l);
        if (kind === 'text') fitText(l);
      }
    };
    if (live) {
      if (targets.length) {
        beginEdit();
        apply();
        syncEditor();
        scheduleRender();
      }
    } else if (targets.length) {
      change(() => { apply(); });
      syncEditor();
    } else {
      renderToolOptions();
      renderDesign();
    }
  }

  function finishLive() {
    endEdit();
    renderAll();
  }

  function numberInput(value, min, max, onCommit) {
    const input = el('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.value = String(Math.round(value));
    input.addEventListener('change', () => {
      const v = clamp(Math.round(Number(input.value)), min, max);
      input.value = String(v);
      onCommit(v);
    });
    return input;
  }

  function colorInput(kind, key, optional, onLayers) {
    const val = styleSource(kind, onLayers)[key];
    const wrap = el('span', 'opt-field');
    const color = el('input');
    color.type = 'color';
    color.value = val || (key === 'stroke' ? '#111111' : '#5b8cff');
    let box = null;
    if (optional) {
      box = el('input');
      box.type = 'checkbox';
      box.checked = !!val;
      box.title = 'Turn on or off';
      wrap.append(box);
    }
    color.addEventListener('input', () => {
      if (box && !box.checked) box.checked = true;
      setStyle(kind, { [key]: color.value }, true, onLayers);
    });
    color.addEventListener('change', finishLive);
    if (box) box.addEventListener('change', () => setStyle(kind, { [key]: box.checked ? color.value : '' }, false, onLayers));
    wrap.append(color);
    return wrap;
  }

  // Returns [label, control] pairs for a kind of layer: 'text', 'shape' or 'path'.
  function styleFields(kind, onLayers) {
    const cur = styleSource(kind, onLayers);
    const out = [];
    if (kind === 'text') {
      const font = el('select');
      for (const f of allFonts()) {
        const o = el('option', '', f.name);
        o.value = f.family;
        o.style.fontFamily = f.family;
        font.append(o);
      }
      font.value = allFonts().some((f) => f.family === cur.font) ? cur.font : FONTS[0].family;
      font.addEventListener('change', () => setStyle('text', { font: font.value }, false, onLayers));
      const more = el('button', 'btn btn-small', 'More…');
      more.type = 'button';
      more.title = 'Upload a font, or use fonts from this computer';
      more.addEventListener('click', () => openFontPicker(onLayers));
      const fontWrap = el('span', 'opt-field');
      fontWrap.append(font, more);
      out.push(['Font', fontWrap]);
      out.push(['Size', numberInput(cur.size, 4, 1000, (v) => setStyle('text', { size: v }, false, onLayers))]);
      const flags = [
        ['B', 'Bold', cur.weight >= 700, () => ({ weight: cur.weight >= 700 ? 400 : 700 })],
        ['I', 'Italic', !!cur.italic, () => ({ italic: !cur.italic })],
        ['U', 'Underline', !!cur.underline, () => ({ underline: !cur.underline })],
        ['S', 'Strikethrough', !!cur.strike, () => ({ strike: !cur.strike })],
        ['AA', 'All capitals', !!cur.caps, () => ({ caps: !cur.caps })],
      ];
      const styleSeg = el('div', 'seg');
      for (const [label, title, on, change2] of flags) {
        const b = el('button', on ? 'on' : '', label);
        b.type = 'button';
        b.title = title;
        b.addEventListener('click', () => setStyle('text', change2(), false, onLayers));
        styleSeg.append(b);
      }
      out.push(['Style', styleSeg]);
      out.push(['Align', seg([
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Center' },
        { value: 'right', label: 'Right' },
      ], cur.align, (v) => setStyle('text', { align: v }, false, onLayers))]);
      out.push(['Letter space', numberInput(cur.letterSpacing || 0, -20, 200, (v) => setStyle('text', { letterSpacing: v }, false, onLayers))]);
      out.push(['Line height %', numberInput((cur.lineHeight || LINE_HEIGHT) * 100, 50, 300, (v) => setStyle('text', { lineHeight: v / 100 }, false, onLayers))]);
      out.push(['Color', colorInput('text', 'color', false, onLayers)]);
    } else if (kind === 'shape') {
      out.push(['Shape', seg(SHAPES.map((s) => ({ value: s.value, label: s.label })), cur.shape,
        (v) => setStyle('shape', { shape: v }, false, onLayers))]);
      out.push(['Fill', colorInput('shape', 'fill', true, onLayers)]);
      out.push(['Outline', colorInput('shape', 'stroke', true, onLayers)]);
      out.push(['Outline size', numberInput(cur.strokeWidth, 0, 200, (v) => setStyle('shape', { strokeWidth: v }, false, onLayers))]);
      if (cur.shape === 'rect') {
        out.push(['Corners', numberInput(cur.radius || 0, 0, 2000, (v) => setStyle('shape', { radius: v }, false, onLayers))]);
      }
    } else {
      out.push(['Line', colorInput('path', 'stroke', true, onLayers)]);
      out.push(['Line size', numberInput(cur.strokeWidth, 0, 200, (v) => setStyle('path', { strokeWidth: v }, false, onLayers))]);
      out.push(['Fill', colorInput('path', 'fill', true, onLayers)]);
    }
    return out;
  }

  // ---------- Font picker: upload a font file, or use fonts installed on this computer ----------

  const fontList = $('font-list');
  const fontSearch = $('font-search');
  const fontNote = $('font-note');

  function renderFontList() {
    const q = fontSearch.value.trim().toLowerCase();
    const items = [];
    const seen = new Set();
    for (const f of allFonts()) {
      items.push({ name: f.name, family: f.family });
      seen.add(f.name.toLowerCase());
    }
    for (const name of localFonts || []) {
      if (!seen.has(name.toLowerCase())) items.push({ name, family: quoteFamily(name) });
    }
    fontList.textContent = '';
    let shown = 0;
    for (const it of items) {
      if (q && !it.name.toLowerCase().includes(q)) continue;
      if (++shown > 400) break; // keep the list quick
      const li = document.createElement('li');
      const b = el('button', '', it.name);
      b.type = 'button';
      b.style.fontFamily = it.family;
      b.addEventListener('click', () => pickFont(it));
      li.append(b);
      fontList.append(li);
    }
    if (!shown) fontList.append(el('li', 'empty', 'No fonts match.'));
  }

  function pickFont(it) {
    if (!allFonts().some((f) => f.family === it.family)) extraFonts.push({ name: it.name, family: it.family });
    fontsDialog.close();
    setStyle('text', { font: it.family }, false, fontPickerOnLayers);
    renderToolOptions();
  }

  function openFontPicker(onLayers) {
    fontPickerOnLayers = onLayers;
    fontSearch.value = '';
    fontNote.textContent = localFonts
      ? localFonts.length + ' fonts found on this computer.'
      : 'Use the buttons to add your own fonts.';
    renderFontList();
    fontsDialog.showModal();
    fontSearch.focus();
  }

  fontSearch.addEventListener('input', renderFontList);

  $('btn-font-upload').addEventListener('click', () => $('font-file').click());

  $('font-file').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    let added = 0;
    for (const file of files) {
      const name = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'My font';
      try {
        const face = new FontFace(name, await file.arrayBuffer());
        await face.load();
        document.fonts.add(face);
        if (!extraFonts.some((f) => f.name === name)) extraFonts.push({ name, family: quoteFamily(name) });
        added++;
      } catch (err) {
        toast('Could not use "' + file.name + '". Try a .ttf, .otf or .woff file.');
      }
    }
    if (added) {
      fontNote.textContent = added + ' font' + (added > 1 ? 's' : '') + ' added. They stay until you close this page.';
      renderFontList();
      renderToolOptions();
      renderDesign();
    }
  });

  $('btn-font-local').addEventListener('click', async () => {
    if (!window.queryLocalFonts) {
      fontNote.textContent = 'This browser cannot list fonts on your computer. Chrome or Edge can. Or use "Upload font file".';
      return;
    }
    try {
      const list = await window.queryLocalFonts();
      localFonts = [...new Set(list.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
      fontNote.textContent = localFonts.length + ' fonts found on this computer.';
      renderFontList();
    } catch (err) {
      fontNote.textContent = 'Allow "Fonts" when the browser asks, then try again.';
    }
  });

  // ---------- Tool options bar ----------

  const ALIGNS = [
    { value: 'left', label: 'Left' },
    { value: 'hcenter', label: 'Center' },
    { value: 'right', label: 'Right' },
    { value: 'top', label: 'Top' },
    { value: 'vcenter', label: 'Middle' },
    { value: 'bottom', label: 'Bottom' },
  ];

  function alignSelected(mode) {
    const ls = selectedLayers();
    if (!ls.length) return;
    const box = ls.length > 1 ? unionBox(ls) : { x: 0, y: 0, width: state.doc.width, height: state.doc.height };
    change(() => {
      for (const l of ls) {
        const b = layerBounds(l);
        if (mode === 'left') l.x += box.x - b.x;
        else if (mode === 'hcenter') l.x += box.x + box.width / 2 - (b.x + b.width / 2);
        else if (mode === 'right') l.x += box.x + box.width - (b.x + b.width);
        else if (mode === 'top') l.y += box.y - b.y;
        else if (mode === 'vcenter') l.y += box.y + box.height / 2 - (b.y + b.height / 2);
        else if (mode === 'bottom') l.y += box.y + box.height - (b.y + b.height);
        l.x = Math.round(l.x);
        l.y = Math.round(l.y);
      }
    });
  }

  function actionButton(label, title, disabled, onClick) {
    const b = el('button', 'btn btn-small', label);
    b.type = 'button';
    b.title = title;
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderToolOptions() {
    toolOptions.textContent = '';
    const add = (n) => toolOptions.append(n);
    const field = (label, control) => {
      const f = el('span', 'opt-field');
      f.append(el('span', 'opt-label', label), control);
      add(f);
    };

    if (tool === 'select') {
      if (!sel.length) {
        add(el('span', 'opt-hint', 'Click a layer, or drag a box to pick several. Hold Shift to add more.'));
      } else {
        add(el('span', 'opt-label', sel.length > 1 ? 'Line up with each other' : 'Line up on the artwork'));
        add(seg(ALIGNS, null, alignSelected));
      }
    } else if (tool === 'marquee') {
      add(seg([{ value: 'rect', label: 'Rectangle' }, { value: 'ellipse', label: 'Ellipse' }], marqKind, (v) => {
        marqKind = v;
        if (marq) marq.kind = v;
        renderToolOptions();
        render();
      }));
      add(el('span', 'opt-sep'));
      const has = !!marq;
      add(actionButton('Copy to new layer', 'Copy the area to a new layer', !has, () => marqueeOp('copy')));
      add(actionButton('Cut to new layer', 'Move the area to a new layer', !has, () => marqueeOp('cut')));
      add(actionButton('Erase', 'Delete the pixels in the area (Delete key)', !has, () => marqueeOp('erase')));
      add(actionButton('Deselect', 'Remove the area (Esc)', !has, () => { marq = null; renderToolOptions(); render(); }));
      if (!has) add(el('span', 'opt-hint', 'Select a layer, then drag an area.'));
    } else if (tool === 'text') {
      for (const [label, control] of styleFields('text', !!editing)) field(label, control);
      add(el('span', 'opt-hint', 'Click the artwork to type.'));
    } else if (tool === 'shape') {
      for (const [label, control] of styleFields('shape', false)) field(label, control);
      add(el('span', 'opt-hint', 'Drag on the artwork. Hold Shift for an even shape.'));
    } else if (tool === 'pen') {
      for (const [label, control] of styleFields('path', false)) field(label, control);
      add(el('span', 'opt-hint', 'Click to add points. Drag to curve. Click the first point to close. Enter finishes.'));
    } else {
      add(el('span', 'opt-hint', 'Drag to move around the artwork.'));
    }
  }

  // ---------- Design tab ----------

  function propRow(label, control) {
    const row = el('div', 'field');
    row.append(el('span', 'field-label', label));
    const c = el('span', 'controls');
    c.append(control);
    row.append(c);
    return row;
  }

  function renderDesign() {
    const ls = selectedLayers();
    designEmpty.hidden = ls.length > 0;
    designBody.hidden = ls.length === 0;
    designEmpty.textContent = 'Select a layer to see its details.';
    designBody.textContent = '';
    if (!ls.length) return;

    if (ls.length > 1) {
      designBody.append(el('div', 'design-title', ls.length + ' layers selected'));
      designBody.append(el('p', 'tips', 'Pick one layer to change its details. With the Select tool you can line the layers up.'));
      return;
    }

    const l = ls[0];
    designBody.append(el('div', 'design-title', l.name));

    const setBox = (key) => (v) => change(() => { l[key] = v; });
    designBody.append(propRow('X', numberInput(l.x, -MAX_DOC * 2, MAX_DOC * 2, setBox('x'))));
    designBody.append(propRow('Y', numberInput(l.y, -MAX_DOC * 2, MAX_DOC * 2, setBox('y'))));
    if (l.type !== 'text') {
      designBody.append(propRow('Width', numberInput(l.width, MIN_LAYER, MAX_DOC * 2, setBox('width'))));
      designBody.append(propRow('Height', numberInput(l.height, MIN_LAYER, MAX_DOC * 2, setBox('height'))));
    }

    designBody.append(propRow('Rotate (°)', numberInput(l.rotation || 0, -180, 180, (v) => change(() => { l.rotation = v; }))));

    if (l.type === 'image') {
      designBody.append(el('p', 'tips', 'Open the Camera Raw tab to fix light and color on this photo.'));
    } else {
      for (const [label, control] of styleFields(l.type, true)) designBody.append(propRow(label, control));
    }
  }

  function renderSidePanels() {
    renderPanel();
    renderOpacity();
    renderAdjust();
    renderDesign();
    renderToolOptions();
  }

  function renderAll() {
    const d = state.doc;
    const resized = canvas.width !== d.width || canvas.height !== d.height;
    if (resized) {
      canvas.width = d.width;
      canvas.height = d.height;
    }
    canvas.classList.toggle('transparent', d.transparent);
    if (resized) fitToScreen();
    else applyScale();

    docSize.textContent = d.width + ' × ' + d.height;
    docName.textContent = d.name || 'Untitled artwork';
    render();
    renderSidePanels();
    updateHistoryButtons();
    hint.hidden = state.layers.length > 0;
    drawRulers();
  }

  function setTab(name) {
    activeTab = name;
    document.querySelectorAll('.tab').forEach((t) => {
      t.setAttribute('aria-selected', String(t.dataset.tab === name));
    });
    document.querySelectorAll('.rail-btn[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    $('tab-layers').hidden = name !== 'layers';
    $('tab-design').hidden = name !== 'design';
    $('tab-raw').hidden = name !== 'raw';
  }

  document.querySelectorAll('[data-tab]').forEach((el2) => {
    el2.addEventListener('click', () => setTab(el2.dataset.tab));
  });

  // ----- Layer actions -----

  function moveLayer(id, direction) {
    change(() => {
      const i = state.layers.findIndex((l) => l.id === id);
      const j = i + direction;
      if (i < 0 || j < 0 || j >= state.layers.length) return;
      [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
    });
  }

  function deleteLayers(ids) {
    finishTextEdit();
    change(() => {
      state.layers = state.layers.filter((l) => !ids.includes(l.id));
      sel = sel.filter((id) => !ids.includes(id));
    });
  }

  layerList.addEventListener('click', (e) => {
    const row = e.target.closest('.layer');
    if (!row) return;
    const id = row.dataset.id;
    const button = e.target.closest('button[data-action]');

    if (!button) {
      finishTextEdit();
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        sel = sel.includes(id) ? sel.filter((i) => i !== id) : [...sel, id];
      } else {
        sel = [id];
      }
      renderSidePanels();
      render();
      return;
    }

    switch (button.dataset.action) {
      case 'toggle':
        change(() => {
          const l = getLayer(id);
          if (l) l.visible = !l.visible;
        });
        break;
      case 'up': moveLayer(id, +1); break;
      case 'down': moveLayer(id, -1); break;
      case 'delete': deleteLayers([id]); break;
    }
  });

  // Opacity (for every selected layer)
  opacity.addEventListener('input', () => {
    const ls = selectedLayers();
    if (!ls.length) return;
    beginEdit();
    for (const l of ls) l.opacity = Number(opacity.value) / 100;
    paintRange(opacity, opacityOut, Number(opacity.value), 0, 100, 'var(--accent)');
    scheduleRender();
  });
  opacity.addEventListener('change', endEdit);

  // ----- Camera Raw controls -----

  rawBody.addEventListener('input', (e) => {
    const input = e.target.closest('input[data-key]');
    const l = photo();
    if (!input || !l) return;
    beginEdit();
    adjusting = true;
    const ref = sliderRefs[input.dataset.key];
    const value = Number(input.value);
    l.adjust[input.dataset.key] = value;
    paintRange(ref.input, ref.out, value, ref.item.min, ref.item.max, ref.color, ref.gradient);
    scheduleRender();
  });

  rawBody.addEventListener('change', (e) => {
    if (e.target.closest('input[data-key]')) endEdit();
  });

  // Double-click a slider to put it back to zero.
  rawBody.addEventListener('dblclick', (e) => {
    const input = e.target.closest('input[data-key]');
    const l = photo();
    if (!input || !l) return;
    beginEdit();
    l.adjust[input.dataset.key] = 0;
    const ref = sliderRefs[input.dataset.key];
    paintRange(ref.input, ref.out, 0, ref.item.min, ref.item.max, ref.color, ref.gradient);
    endEdit();
  });

  autoBtn.addEventListener('click', () => {
    const l = photo();
    const img = l && images.get(l.img);
    if (!img) return;
    const suggestion = computeAuto(img);
    change(() => Object.assign(l.adjust, suggestion));
  });

  resetAdjustBtn.addEventListener('click', () => {
    const l = photo();
    if (!l) return;
    change(() => { l.adjust = defaultAdjust(); });
  });

  // Hold to compare: shows the original while the button is pressed.
  function setCompare(on) {
    if (showOriginal === on) return;
    showOriginal = on;
    render();
  }
  compareBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    setCompare(true);
  });
  window.addEventListener('pointerup', () => setCompare(false));
  window.addEventListener('blur', () => setCompare(false));

  // ---------- Text typing ----------

  function startTextEdit(layer, before) {
    finishTextEdit();
    editing = { id: layer.id, before, t: performance.now() };
    editingId = layer.id;
    sel = [layer.id];
    textEditor.hidden = false;
    textEditor.value = layer.text;
    renderAll();
    syncEditor();
    setTimeout(() => {
      textEditor.focus();
      textEditor.setSelectionRange(textEditor.value.length, textEditor.value.length);
    }, 0);
  }

  function finishTextEdit() {
    if (!editing) return;
    const e = editing;
    editing = null;
    editingId = null;
    textEditor.hidden = true;
    const l = getLayer(e.id);
    if (l && !String(l.text).trim()) {
      state.layers = state.layers.filter((x) => x !== l);
      sel = sel.filter((id) => id !== l.id);
    }
    commit(e.before);
    renderAll();
  }

  textEditor.addEventListener('input', () => {
    if (!editing) return;
    const l = getLayer(editing.id);
    if (!l) return;
    l.text = textEditor.value;
    l.name = textName(l);
    fitText(l);
    syncEditor();
  });

  textEditor.addEventListener('blur', () => {
    if (editing && performance.now() - editing.t > 150) finishTextEdit();
  });

  textEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      finishTextEdit();
    }
  });

  // ---------- Mouse / touch on the canvas ----------

  function toDoc(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * canvas.width) / r.width,
      y: ((e.clientY - r.top) * canvas.height) / r.height,
    };
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function hitLayer(l, p0) {
    const p = l.rotation ? toLocal(l, p0) : p0;
    if (l.type === 'shape' || l.type === 'path') {
      const path = l.type === 'shape' ? shapePath(l) : pathPath(l);
      ctx.save();
      ctx.lineWidth = Math.max(l.stroke ? l.strokeWidth : 0, 10 / viewScale);
      const hit = (l.fill && ctx.isPointInPath(path, p.x, p.y)) || ctx.isPointInStroke(path, p.x, p.y);
      ctx.restore();
      return hit;
    }
    return p.x >= l.x && p.x <= l.x + l.width && p.y >= l.y && p.y <= l.y + l.height;
  }

  function hitTest(p, onlyType) {
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      if (!l.visible || (onlyType && l.type !== onlyType)) continue;
      if (hitLayer(l, p)) return l;
    }
    return null;
  }

  function handleAt(l, p) {
    const reach = (HANDLE_PX * 0.8) / viewScale;
    const r = rotateHandlePos(l);
    if (Math.abs(p.x - r.x) <= reach && Math.abs(p.y - r.y) <= reach) return 'rotate';
    for (const h of handlePoints(l)) {
      if (Math.abs(p.x - h.x) <= reach && Math.abs(p.y - h.y) <= reach) return h.name;
    }
    return null;
  }

  // Photos and text keep their shape when resized; shapes and paths stretch freely.
  // Holding Shift switches to the other way.
  function resizeLayer(l, p, shiftKey) {
    const o = drag.orig;
    const lockedByDefault = l.type === 'image' || l.type === 'text';
    const locked = lockedByDefault !== shiftKey || l.type === 'text';
    const sx = drag.handle.includes('e') ? 1 : -1;
    const sy = drag.handle.includes('s') ? 1 : -1;
    const th = ((o.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(th);
    const sin = Math.sin(th);

    // The corner opposite the handle stays where it is on the artwork.
    const ax = (-sx * o.width) / 2;
    const ay = (-sy * o.height) / 2;
    const cx0 = o.x + o.width / 2;
    const cy0 = o.y + o.height / 2;
    const A = { x: cx0 + ax * cos - ay * sin, y: cy0 + ax * sin + ay * cos };

    const dx = p.x - A.x;
    const dy = p.y - A.y;
    let w = Math.max(MIN_LAYER, sx * (dx * cos + dy * sin));
    let h = Math.max(MIN_LAYER, sy * (-dx * sin + dy * cos));

    if (locked) {
      const scale = Math.max(w / o.width, h / o.height, MIN_LAYER / o.width, MIN_LAYER / o.height);
      w = o.width * scale;
      h = o.height * scale;
    }

    if (l.type === 'text') {
      l.size = Math.max(4, Math.round(o.size * (w / o.width)));
      fitText(l);
    } else {
      l.width = Math.round(w);
      l.height = Math.round(h);
    }

    const ox = (sx * l.width) / 2;
    const oy = (sy * l.height) / 2;
    const cx = A.x + ox * cos - oy * sin;
    const cy = A.y + ox * sin + oy * cos;
    l.x = Math.round(cx - l.width / 2);
    l.y = Math.round(cy - l.height / 2);
  }

  // Turns the layer around its middle. Shift snaps to steps of 15 degrees.
  function rotateLayer(l, p, shiftKey) {
    const cx = l.x + l.width / 2;
    const cy = l.y + l.height / 2;
    const angle = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI;
    let r = drag.startRot + (angle - drag.startAngle);
    if (shiftKey) r = Math.round(r / 15) * 15;
    r = ((((r + 180) % 360) + 360) % 360) - 180;
    l.rotation = Math.round(r * 10) / 10;
  }

  function updateCursor(p) {
    if (tool !== 'select') return;
    const l = selected();
    let cursor = 'default';
    const handle = l && l.visible ? handleAt(l, p) : null;
    if (handle === 'rotate') cursor = 'grab';
    else if (handle) cursor = handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize';
    else if (hitTest(p)) cursor = 'move';
    canvas.style.cursor = cursor;
  }

  function selectionChanged() {
    renderSidePanels();
    render();
  }

  function startDrag(e, d) {
    canvas.setPointerCapture(e.pointerId);
    drag = d;
  }

  function downSelect(e, p) {
    const current = selected();
    const handle = current && current.visible ? handleAt(current, p) : null;
    if (handle === 'rotate') {
      const cx = current.x + current.width / 2;
      const cy = current.y + current.height / 2;
      startDrag(e, {
        mode: 'rotate',
        id: current.id,
        startRot: current.rotation || 0,
        startAngle: (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI,
        before: snapshot(),
      });
      return;
    }
    if (handle) {
      startDrag(e, {
        mode: 'resize',
        id: current.id,
        handle,
        orig: { x: current.x, y: current.y, width: current.width, height: current.height, size: current.size, rotation: current.rotation || 0 },
        before: snapshot(),
      });
      return;
    }

    const hit = hitTest(p);
    if (hit) {
      if (e.shiftKey && sel.includes(hit.id)) {
        sel = sel.filter((id) => id !== hit.id); // Shift + click on a picked layer drops it
        selectionChanged();
        return;
      }
      if (e.shiftKey) sel = [...sel, hit.id];
      else if (!sel.includes(hit.id)) sel = [hit.id];
      selectionChanged();
      startDrag(e, {
        mode: 'move',
        start: p,
        origs: selectedLayers().map((l) => ({ id: l.id, x: l.x, y: l.y })),
        before: snapshot(),
      });
      return;
    }

    const base = e.shiftKey ? sel.slice() : [];
    sel = base.slice();
    selectionChanged();
    startDrag(e, { mode: 'band', start: p, base });
  }

  function updateBand(p) {
    const s = drag.start;
    band = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
    const ids = state.layers
      .filter((l) => {
        if (!l.visible) return false;
        const b = layerBounds(l);
        return b.x < band.x + band.w && b.x + b.width > band.x && b.y < band.y + band.h && b.y + b.height > band.y;
      })
      .map((l) => l.id);
    const next = [...new Set([...drag.base, ...ids])];
    if (next.join() !== sel.join()) {
      sel = next;
      renderSidePanels();
    }
  }

  function downMarquee(e, p) {
    marq = { kind: marqKind, x: p.x, y: p.y, w: 0, h: 0 };
    startDrag(e, { mode: 'marq', start: p });
    render();
  }

  function updateMarquee(p, square) {
    const s = drag.start;
    let w = p.x - s.x;
    let h = p.y - s.y;
    if (square) {
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * m;
      h = Math.sign(h || 1) * m;
    }
    marq = { kind: marqKind, x: Math.min(s.x, s.x + w), y: Math.min(s.y, s.y + h), w: Math.abs(w), h: Math.abs(h) };
  }

  function downText(e, p) {
    const hit = hitTest(p, 'text');
    if (hit) {
      startTextEdit(hit, snapshot());
      return;
    }
    const before = snapshot();
    const l = {
      id: 'layer-' + nextId++,
      type: 'text',
      name: 'Text',
      text: '',
      ...defaults.text,
      x: Math.round(p.x),
      y: Math.round(p.y),
      width: 0,
      height: 0,
      opacity: 1,
      visible: true,
    };
    fitText(l);
    state.layers.push(l);
    startTextEdit(l, before);
  }

  function downShape(e, p) {
    const before = snapshot();
    const d = defaults.shape;
    const l = {
      id: 'layer-' + nextId++,
      type: 'shape',
      name: '',
      shape: d.shape,
      fill: d.fill,
      stroke: d.stroke,
      strokeWidth: d.strokeWidth,
      radius: d.radius,
      x: Math.round(p.x),
      y: Math.round(p.y),
      width: 1,
      height: 1,
      opacity: 1,
      visible: true,
    };
    l.name = typeLabel(l);
    state.layers.push(l);
    sel = [l.id];
    startDrag(e, { mode: 'shape', id: l.id, start: p, before });
    renderSidePanels();
    render();
  }

  function updateShape(l, p, square) {
    const s = drag.start;
    let w = p.x - s.x;
    let h = p.y - s.y;
    if (square) {
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * m;
      h = Math.sign(h || 1) * m;
    }
    l.x = Math.round(Math.min(s.x, s.x + w));
    l.y = Math.round(Math.min(s.y, s.y + h));
    l.width = Math.max(1, Math.round(Math.abs(w)));
    l.height = Math.max(1, Math.round(Math.abs(h)));
  }

  function downPen(e, p) {
    if (!penDraft) penDraft = { pts: [], cur: p };
    const pts = penDraft.pts;
    if (pts.length >= 3 && dist(p, pts[0]) < 8 / viewScale) {
      finishPen(true, true);
      return;
    }
    if (pts.length && dist(p, pts[pts.length - 1]) < 3 / viewScale) {
      finishPen(false, true); // clicking the last point again ends the line
      return;
    }
    const pt = { x: p.x, y: p.y, in: null, out: null };
    pts.push(pt);
    startDrag(e, { mode: 'penhandle', pt, start: p });
    render();
  }

  // Turns the points drawn with the pen into a path layer.
  function finishPen(closed, andSelect) {
    const d = penDraft;
    penDraft = null;
    if (!d || d.pts.length < 2) {
      render();
      return;
    }
    const pts = d.pts;
    const segs = [];
    for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]);
    if (closed) segs.push([pts[pts.length - 1], pts[0]]);

    // Find the box around the whole curve by sampling along it.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [a, b] of segs) {
      const c1 = a.out || a;
      const c2 = b.in || b;
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        const u = 1 - t;
        const x = u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x;
        const y = u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    const N = (q) => ({ x: (q.x - minX) / bw, y: (q.y - minY) / bh });
    const dflt = defaults.path;
    const layer = {
      id: 'layer-' + nextId++,
      type: 'path',
      name: 'Path',
      x: minX,
      y: minY,
      width: bw,
      height: bh,
      opacity: 1,
      visible: true,
      closed: !!closed,
      points: pts.map((q) => ({ ...N(q), in: q.in ? N(q.in) : null, out: q.out ? N(q.out) : null })),
      fill: dflt.fill,
      stroke: dflt.stroke,
      strokeWidth: dflt.strokeWidth,
    };
    change(() => {
      state.layers.push(layer);
      sel = [layer.id];
    });
    if (andSelect) setTool('select');
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    finishTextEdit();
    const p = toDoc(e);
    if (tool === 'select') downSelect(e, p);
    else if (tool === 'marquee') downMarquee(e, p);
    else if (tool === 'text') downText(e, p);
    else if (tool === 'shape') downShape(e, p);
    else if (tool === 'pen') downPen(e, p);
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = toDoc(e);
    if (!drag) {
      updateCursor(p);
      if (penDraft) {
        penDraft.cur = p;
        scheduleRender();
      }
      return;
    }

    if (drag.mode === 'move') {
      for (const o of drag.origs) {
        const l = getLayer(o.id);
        if (!l) continue;
        l.x = Math.round(o.x + (p.x - drag.start.x));
        l.y = Math.round(o.y + (p.y - drag.start.y));
      }
    } else if (drag.mode === 'resize') {
      const l = getLayer(drag.id);
      if (l) resizeLayer(l, p, e.shiftKey);
    } else if (drag.mode === 'rotate') {
      const l = getLayer(drag.id);
      if (l) rotateLayer(l, p, e.shiftKey);
    } else if (drag.mode === 'band') {
      updateBand(p);
    } else if (drag.mode === 'marq') {
      updateMarquee(p, e.shiftKey);
    } else if (drag.mode === 'shape') {
      const l = getLayer(drag.id);
      if (l) updateShape(l, p, e.shiftKey);
    } else if (drag.mode === 'penhandle') {
      if (dist(p, drag.start) > 3 / viewScale) {
        drag.pt.out = { x: p.x, y: p.y };
        drag.pt.in = { x: 2 * drag.pt.x - p.x, y: 2 * drag.pt.y - p.y };
      }
    }
    render();
  });

  function endDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;

    if (d.mode === 'move' || d.mode === 'resize' || d.mode === 'rotate') {
      commit(d.before);
      render(); // now redo Camera Raw at the new size
      renderDesign();
    } else if (d.mode === 'band') {
      band = null;
      renderSidePanels();
      render();
    } else if (d.mode === 'marq') {
      if (!marq || marq.w < 2 || marq.h < 2) marq = null;
      renderToolOptions();
      render();
    } else if (d.mode === 'shape') {
      const l = getLayer(d.id);
      if (l && (l.width < 4 || l.height < 4)) {
        // Just a click: make a normal-sized shape around the click point.
        l.width = 200;
        l.height = 200;
        l.x = Math.round(d.start.x - 100);
        l.y = Math.round(d.start.y - 100);
      }
      commit(d.before);
      setTool('select');
      renderAll();
    } else if (d.mode === 'penhandle') {
      render();
    }
  }

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // Double-click on text to edit it.
  canvas.addEventListener('dblclick', (e) => {
    if (tool !== 'select') return;
    const hit = hitTest(toDoc(e), 'text');
    if (hit) startTextEdit(hit, snapshot());
  });

  // ---------- Area selection: copy, cut, erase ----------

  // Draws a layer into its own canvas, at its real detail, so we can change its pixels.
  function rasterize(l) {
    let s = 1;
    if (l.type === 'image') {
      const img = images.get(l.img);
      s = clamp(srcW(img) / l.width, 0.05, 8);
    }
    let w = Math.max(1, Math.round(l.width * s));
    let h = Math.max(1, Math.round(l.height * s));
    const cap = Math.min(1, MAX_DOC / w, MAX_DOC / h);
    w = Math.max(1, Math.round(w * cap));
    h = Math.max(1, Math.round(h * cap));
    const sx = w / l.width;
    const sy = h / l.height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.setTransform(sx, 0, 0, sy, -l.x * sx, -l.y * sy);
    drawLayer(g, l, 'export', true);
    return { canvas: c, sx, sy };
  }

  function putPixels(l, c) {
    const key = 'img-' + nextImg++;
    images.set(key, c);
    l.type = 'image';
    l.img = key;
    l.adjust = defaultAdjust();
  }

  function marqueeOp(kind) {
    const l = selected();
    if (!marq) return;
    if (!l || !l.visible) {
      toast('Click a layer first, then pick an area on it.');
      return;
    }
    if (l.rotation) {
      toast('Set the rotation back to 0 first, then pick an area.');
      return;
    }
    const raster = rasterize(l);
    let copy = null;

    if (kind === 'copy' || kind === 'cut') {
      const x1 = Math.max(marq.x, l.x);
      const y1 = Math.max(marq.y, l.y);
      const x2 = Math.min(marq.x + marq.w, l.x + l.width);
      const y2 = Math.min(marq.y + marq.h, l.y + l.height);
      if (x2 - x1 < 1 || y2 - y1 < 1) {
        toast('That area does not touch the selected layer.');
        return;
      }
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round((x2 - x1) * raster.sx));
      out.height = Math.max(1, Math.round((y2 - y1) * raster.sy));
      const g = out.getContext('2d');
      g.setTransform(raster.sx, 0, 0, raster.sy, -x1 * raster.sx, -y1 * raster.sy);
      g.clip(regionPath(marq));
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(raster.canvas, -(x1 - l.x) * raster.sx, -(y1 - l.y) * raster.sy);
      copy = { canvas: out, x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }

    if (kind === 'cut' || kind === 'erase') {
      const g = raster.canvas.getContext('2d');
      g.setTransform(raster.sx, 0, 0, raster.sy, -l.x * raster.sx, -l.y * raster.sy);
      g.globalCompositeOperation = 'destination-out';
      g.fill(regionPath(marq));
    }

    change(() => {
      if (kind === 'cut' || kind === 'erase') putPixels(l, raster.canvas);
      if (copy) {
        const id = 'layer-' + nextId++;
        const key = 'img-' + nextImg++;
        images.set(key, copy.canvas);
        state.layers.push({
          id,
          type: 'image',
          img: key,
          name: l.name + (kind === 'cut' ? ' (cut)' : ' (copy)'),
          x: Math.round(copy.x),
          y: Math.round(copy.y),
          width: Math.max(1, Math.round(copy.width)),
          height: Math.max(1, Math.round(copy.height)),
          opacity: l.opacity,
          visible: true,
          adjust: defaultAdjust(),
        });
        sel = [id];
      }
    });
  }

  // ---------- Opening images ----------

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not open "' + file.name + '".'));
      };
      img.src = url;
    });
  }

  async function addImageFile(file) {
    let img;
    try {
      img = await loadImage(file);
    } catch (err) {
      toast(err.message);
      return;
    }
    if (!img.naturalWidth || !img.naturalHeight) {
      toast('"' + file.name + '" has no size, so it cannot be used.');
      return;
    }

    finishTextEdit();
    const id = 'layer-' + nextId++;
    const key = 'img-' + nextImg++;
    images.set(key, img);

    change(() => {
      const d = state.doc;
      let w = img.naturalWidth;
      let h = img.naturalHeight;

      if (state.layers.length === 0 && d.autoSize) {
        // First image into a fresh document: the document takes the image's size.
        const s = Math.min(1, MAX_DOC / w, MAX_DOC / h);
        w = Math.round(w * s);
        h = Math.round(h * s);
        d.width = w;
        d.height = h;
        d.autoSize = false;
      } else {
        // Otherwise shrink the image to fit inside the document if it is too big.
        const s = Math.min(1, d.width / w, d.height / h);
        w = Math.max(1, Math.round(w * s));
        h = Math.max(1, Math.round(h * s));
      }

      state.layers.push({
        id,
        type: 'image',
        img: key,
        name: file.name,
        x: Math.round((d.width - w) / 2),
        y: Math.round((d.height - h) / 2),
        width: w,
        height: h,
        opacity: 1,
        visible: true,
        adjust: defaultAdjust(),
      });
      sel = [id];
    });
  }

  async function addImageFiles(files) {
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        toast('"' + file.name + '" is not an image.');
        continue;
      }
      await addImageFile(file);
    }
  }

  $('btn-open').addEventListener('click', () => fileInput.click());
  $('rail-open').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    await addImageFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });

  workspace.addEventListener('dragover', (e) => {
    e.preventDefault();
    workspace.classList.add('dragging');
  });
  workspace.addEventListener('dragleave', (e) => {
    if (e.target === workspace) workspace.classList.remove('dragging');
  });
  workspace.addEventListener('drop', (e) => {
    e.preventDefault();
    workspace.classList.remove('dragging');
    addImageFiles(Array.from(e.dataTransfer.files));
  });

  // ---------- Create artwork ----------

  const PRESETS = [
    { name: 'Instagram post', w: 1080, h: 1080 },
    { name: 'Instagram story', w: 1080, h: 1920 },
    { name: 'Poster A4 (300 dpi)', w: 2480, h: 3508 },
    { name: 'Poster A3 (300 dpi)', w: 3508, h: 4961 },
    { name: 'YouTube thumbnail', w: 1280, h: 720 },
    { name: 'Wallpaper (Full HD)', w: 1920, h: 1080 },
    { name: 'LinkedIn banner', w: 1584, h: 396 },
  ];

  const presetGrid = $('preset-grid');
  const newName = $('new-name');
  const newWidth = $('new-width');
  const newHeight = $('new-height');

  function markPreset() {
    const w = Number(newWidth.value);
    const h = Number(newHeight.value);
    presetGrid.querySelectorAll('.preset').forEach((b) => {
      b.setAttribute('aria-pressed', String(Number(b.dataset.w) === w && Number(b.dataset.h) === h));
    });
  }

  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.dataset.w = String(p.w);
    b.dataset.h = String(p.h);
    const name = document.createElement('span');
    name.className = 'preset-name';
    name.textContent = p.name;
    const size = document.createElement('span');
    size.className = 'preset-size';
    size.textContent = p.w + ' × ' + p.h;
    b.append(name, size);
    presetGrid.append(b);
  }

  presetGrid.addEventListener('click', (e) => {
    const b = e.target.closest('.preset');
    if (!b) return;
    newWidth.value = b.dataset.w;
    newHeight.value = b.dataset.h;
    markPreset();
  });

  [newWidth, newHeight].forEach((input) => input.addEventListener('input', markPreset));

  $('btn-swap').addEventListener('click', () => {
    const w = newWidth.value;
    newWidth.value = newHeight.value;
    newHeight.value = w;
    markPreset();
  });

  $('btn-new').addEventListener('click', () => {
    newDialog.returnValue = ''; // so pressing Esc later does not repeat the last "Create"
    markPreset();
    newDialog.showModal();
    newName.select();
  });

  newDialog.addEventListener('close', () => {
    if (newDialog.returnValue !== 'create') return;
    const name = newName.value.trim().slice(0, 60) || 'Untitled artwork';
    const width = clamp(Math.round(Number(newWidth.value)) || 1200, 1, MAX_DOC);
    const height = clamp(Math.round(Number(newHeight.value)) || 800, 1, MAX_DOC);
    const background = $('new-bg').value || '#ffffff';
    const transparent = $('new-transparent').checked;

    change(() => {
      state.doc = { name, width, height, background, transparent, autoSize: false };
      state.layers = [];
      sel = [];
    });
    fitToScreen();
    render();
    drawRulers();
  });

  // ---------- Export ----------

  function exportImage() {
    const jpeg = $('export-format').value === 'jpeg';
    const type = jpeg ? 'image/jpeg' : 'image/png';

    const out = document.createElement('canvas');
    out.width = state.doc.width;
    out.height = state.doc.height;
    paintDocument(out.getContext('2d'), jpeg, 'export'); // JPG cannot be transparent

    out.toBlob((blob) => {
      if (!blob) {
        toast('Export failed. The image may be too large for this browser.');
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const base = (state.doc.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      link.download = (base || 'magicshop-export') + '.' + (jpeg ? 'jpg' : 'png');
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, type, 0.92);
  }

  // ---------- Toolbar ----------

  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  $('btn-export').addEventListener('click', () => { finishTextEdit(); exportImage(); });
  $('btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
  $('btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
  $('btn-fit').addEventListener('click', () => {
    fitToScreen();
    render();
    drawRulers();
  });

  zoomSlider.addEventListener('input', () => {
    const r = workspace.getBoundingClientRect();
    setZoom(sliderToZoom(Number(zoomSlider.value)), r.left + r.width / 2, r.top + r.height / 2);
  });

  workspace.addEventListener('scroll', drawRulers, { passive: true });

  // ---------- Tools, and moving around: pan tool, Space + drag, middle mouse ----------

  let spaceDown = false;
  let pan = null;

  const panReady = () => tool === 'hand' || spaceDown;
  const updatePanClasses = () => workspace.classList.toggle('pan-ready', panReady());

  function setTool(name) {
    if (name !== tool) {
      finishTextEdit();
      if (penDraft) finishPen(false, false);
      if (name !== 'marquee') marq = null;
    }
    tool = name;
    workspace.dataset.tool = name;
    canvas.style.cursor = '';
    document.querySelectorAll('.rail-btn[data-tool]').forEach((b) => {
      b.classList.toggle('tool-active', b.dataset.tool === name);
    });
    updatePanClasses();
    renderToolOptions();
    render();
  }

  document.querySelectorAll('.rail-btn[data-tool]').forEach((b) => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });

  // Capture phase: runs before the canvas gets the click, so panning never moves a layer.
  workspace.addEventListener('pointerdown', (e) => {
    const wantsPan = e.button === 1 || (e.button === 0 && panReady());
    if (!wantsPan) return;
    e.preventDefault();
    e.stopPropagation();
    pan = { x: e.clientX, y: e.clientY, left: workspace.scrollLeft, top: workspace.scrollTop };
    workspace.setPointerCapture(e.pointerId);
    workspace.classList.add('panning');
  }, true);

  workspace.addEventListener('pointermove', (e) => {
    if (!pan) return;
    workspace.scrollLeft = pan.left - (e.clientX - pan.x);
    workspace.scrollTop = pan.top - (e.clientY - pan.y);
  });

  function endPan() {
    pan = null;
    workspace.classList.remove('panning');
  }
  workspace.addEventListener('pointerup', endPan);
  workspace.addEventListener('pointercancel', endPan);

  // Stops the browser's own middle-click scrolling.
  workspace.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });

  // The mouse wheel only scrolls (up/down, and left/right with Shift).
  // Zooming needs Ctrl (or a pinch on a trackpad), or the + and - buttons and keys.
  workspace.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const dy = e.deltaY * (e.deltaMode === 1 ? 33 : 1);
    const factor = Math.abs(dy) >= 50 ? Math.pow(1.15, -Math.sign(dy)) : Math.exp(-dy * 0.01);
    setZoom(viewScale * clamp(factor, 0.5, 2), e.clientX, e.clientY);
  }, { passive: false });

  window.addEventListener('blur', () => {
    spaceDown = false;
    updatePanClasses();
  });

  // ---------- Keyboard ----------

  const TOOL_KEYS = { v: 'select', m: 'marquee', t: 'text', u: 'shape', p: 'pen', h: 'hand' };

  document.addEventListener('keydown', (e) => {
    if (newDialog.open || fontsDialog.open) return;
    const t = e.target;
    const typing =
      (t instanceof HTMLInputElement && t.type !== 'range') ||
      t instanceof HTMLSelectElement ||
      t instanceof HTMLTextAreaElement;
    if (typing) return;

    if (e.code === 'Space') {
      e.preventDefault(); // no page scrolling, and no accidental button press
      spaceDown = true;
      updatePanClasses();
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      redo();
    } else if (mod) {
      return;
    } else if (penDraft && e.key === 'Enter') {
      finishPen(false, true);
    } else if (penDraft && e.key === 'Escape') {
      penDraft = null;
      render();
    } else if (penDraft && e.key === 'Backspace') {
      e.preventDefault();
      penDraft.pts.pop();
      if (!penDraft.pts.length) penDraft = null;
      render();
    } else if (e.key === 'Escape') {
      if (marq) marq = null;
      else sel = [];
      renderSidePanels();
      render();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (tool === 'marquee' && marq) marqueeOp('erase');
      else if (sel.length) deleteLayers(sel.slice());
    } else if (e.key.startsWith('Arrow') && sel.length && !(t instanceof HTMLInputElement)) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      change(() => {
        for (const l of selectedLayers()) {
          l.x += dx;
          l.y += dy;
        }
      });
    } else if (key === ']') {
      zoomBy(1.25);
    } else if (key === '[') {
      zoomBy(0.8);
    } else if (key === '0') {
      fitToScreen();
      render();
      drawRulers();
    } else if (TOOL_KEYS[key]) {
      setTool(TOOL_KEYS[key]);
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    if (spaceDown) e.preventDefault(); // some browsers press a focused button on Space release
    spaceDown = false;
    updatePanClasses();
  });

  new ResizeObserver(() => {
    updatePadding();
    if (fitMode) {
      fitToScreen();
      render();
    }
    drawRulers();
    syncEditor();
  }).observe(workspace);

  // When a web font finishes loading, measure and draw the text again.
  document.fonts.addEventListener('loadingdone', () => {
    for (const l of state.layers) if (l.type === 'text') fitText(l);
    render();
    syncEditor();
  });

  // ---------- Start ----------

  readColors();
  buildRawUI();
  updatePadding();
  setTab('layers');
  setTool('select');
  renderAll();
})();
