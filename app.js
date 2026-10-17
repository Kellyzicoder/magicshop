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
  const blendSelect = $('blend');
  const zoomSlider = $('zoom-slider');
  const zoomLabel = $('zoom-label');
  const exportScope = $('export-scope');
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
    { value: 'diamond', label: 'Diamond' },
    { value: 'pentagon', label: 'Pentagon' },
    { value: 'hexagon', label: 'Hexagon' },
    { value: 'heart', label: 'Heart' },
    { value: 'arrow', label: 'Arrow' },
    { value: 'plus', label: 'Plus' },
    { value: 'bubble', label: 'Speech bubble' },
    { value: 'line', label: 'Line' },
  ];

  // Blend modes a layer can use (the value is the browser's own name for it).
  const BLENDS = [
    { value: 'normal', label: 'Normal' },
    { value: 'multiply', label: 'Multiply' },
    { value: 'screen', label: 'Screen' },
    { value: 'overlay', label: 'Overlay' },
    { value: 'soft-light', label: 'Soft light' },
    { value: 'hard-light', label: 'Hard light' },
    { value: 'darken', label: 'Darken' },
    { value: 'lighten', label: 'Lighten' },
    { value: 'color-dodge', label: 'Color dodge' },
    { value: 'color-burn', label: 'Color burn' },
    { value: 'difference', label: 'Difference' },
    { value: 'exclusion', label: 'Exclusion' },
    { value: 'hue', label: 'Hue' },
    { value: 'saturation', label: 'Saturation' },
    { value: 'color', label: 'Color' },
    { value: 'luminosity', label: 'Luminosity' },
  ];

  // What a new text / shape / path starts with. The options bar changes these.
  const defaults = {
    text: { font: FONTS[0].family, size: 72, weight: 400, italic: false, color: '#111111', align: 'left',
      letterSpacing: 0, lineHeight: 1.2, underline: false, strike: false, caps: false },
    shape: { shape: 'rect', fill: '#5b8cff', stroke: '', strokeWidth: 4, radius: 0, dash: 'solid',
      gkind: '', gc1: '#ff7a59', gc2: '#5b8cff', gangle: 90, gfade: false },
    path: { fill: '', stroke: '#111111', strokeWidth: 4, dash: 'solid',
      gkind: '', gc1: '#ff7a59', gc2: '#5b8cff', gangle: 90, gfade: false },
  };

  // Colors and options for the painting tools.
  const paint = { fg: '#111111', bg: '#ffffff' };
  const brushOpts = { brush: { size: 40, hardness: 60, opacity: 100 }, eraser: { size: 60, hardness: 90, opacity: 100 } };
  const bucketOpts = { tolerance: 32, contiguous: true, opacity: 100 };
  const gradientOpts = { kind: 'linear', fade: false };
  const CROP_RATIOS = [
    { value: 'free', label: 'Free' },
    { value: '1', label: '1:1' },
    { value: '4/3', label: '4:3' },
    { value: '3/2', label: '3:2' },
    { value: '16/9', label: '16:9' },
    { value: '4/5', label: '4:5' },
    { value: '9/16', label: '9:16' },
  ];

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
  let cropBox = null;           // crop box being set: { x, y, w, h }
  let cropTarget = 'canvas';    // 'canvas' or 'layer'
  let cropLayerId = null;
  let cropRatio = 'free';
  let warpMode = 'distort';     // 'skew', 'perspective' or 'distort'
  let hoverPt = null;           // where the mouse is (for the brush circle)
  let gradDraft = null;         // gradient line being dragged
  let sampleCanvas = null;      // the finished artwork, for the eyedropper
  const swatchInputs = { fg: null, bg: null };

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
    if (images.size > 24) gcImages();
  }

  // Painting makes a new picture for every stroke. Throw away the ones no undo step can reach.
  function gcImages() {
    const used = new Set();
    const scan = (text) => { for (const m of text.matchAll(/"img":"(img-\d+)"/g)) used.add(m[1]); };
    scan(snapshot());
    undoStack.forEach(scan);
    redoStack.forEach(scan);
    if (pendingBefore) scan(pendingBefore);
    for (const key of [...images.keys()]) if (!used.has(key)) images.delete(key);
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

  // Corner points (0 to 1 inside the box) for the straight-edged shapes.
  const UNIT_POLYS = (() => {
    const fit = (raw) => {
      const xs = raw.map((q) => q[0]);
      const ys = raw.map((q) => q[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      return raw.map((q) => [(q[0] - minX) / (maxX - minX), (q[1] - minY) / (maxY - minY)]);
    };
    const regular = (n) => fit(Array.from({ length: n }, (_, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      return [Math.cos(a), Math.sin(a)];
    }));
    return {
      diamond: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
      pentagon: regular(5),
      hexagon: fit(Array.from({ length: 6 }, (_, i) => [Math.cos((i * Math.PI) / 3), Math.sin((i * Math.PI) / 3)])),
      arrow: [[0, 0.3], [0.6, 0.3], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.7], [0, 0.7]],
      plus: [[0.35, 0], [0.65, 0], [0.65, 0.35], [1, 0.35], [1, 0.65], [0.65, 0.65], [0.65, 1],
        [0.35, 1], [0.35, 0.65], [0, 0.65], [0, 0.35], [0.35, 0.35]],
    };
  })();

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
    } else if (UNIT_POLYS[l.shape]) {
      UNIT_POLYS[l.shape].forEach((q, i) => {
        if (i === 0) p.moveTo(x + q[0] * w, y + q[1] * h);
        else p.lineTo(x + q[0] * w, y + q[1] * h);
      });
      p.closePath();
    } else if (l.shape === 'heart') {
      const P = (u, v) => [x + u * w, y + v * h];
      p.moveTo(...P(0.5, 0.25));
      p.bezierCurveTo(...P(0.5, 0.25), ...P(0.42, 0), ...P(0.2, 0));
      p.bezierCurveTo(...P(0, 0), ...P(0, 0.25), ...P(0, 0.25));
      p.bezierCurveTo(...P(0, 0.45), ...P(0.2, 0.65), ...P(0.5, 1));
      p.bezierCurveTo(...P(0.8, 0.65), ...P(1, 0.45), ...P(1, 0.25));
      p.bezierCurveTo(...P(1, 0.25), ...P(1, 0), ...P(0.8, 0));
      p.bezierCurveTo(...P(0.58, 0), ...P(0.5, 0.25), ...P(0.5, 0.25));
      p.closePath();
    } else if (l.shape === 'bubble') {
      const bh = h * 0.8;
      const r = Math.min(w, bh) * 0.18;
      if (p.roundRect) p.roundRect(x, y, w, bh, r);
      else p.rect(x, y, w, bh);
      const tail = new Path2D();
      tail.moveTo(x + w * 0.18, y + bh - 1);
      tail.lineTo(x + w * 0.12, y + h);
      tail.lineTo(x + w * 0.42, y + bh - 1);
      tail.closePath();
      p.addPath(tail);
    } else if (l.shape === 'line') {
      p.moveTo(x, y);
      p.lineTo(x + w, y + h);
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

  const withAlpha = (hex, a) => {
    const [r, g, b] = hexToRgb(hex);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  };

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // A gradient across the layer's box. Drawn with the Gradient tool it has its own
  // start and end points; otherwise it runs along `gangle` (0 = left to right, 90 = top to bottom).
  function makeGradient(g, l) {
    const { x, y, width: w, height: h } = l;
    const c2 = l.gfade ? withAlpha(l.gc1, 0) : l.gc2;
    let grad;
    if (l.gx1 != null) {
      const x1 = x + l.gx1 * w, y1 = y + l.gy1 * h, x2 = x + l.gx2 * w, y2 = y + l.gy2 * h;
      grad = l.gkind === 'radial'
        ? g.createRadialGradient(x1, y1, 0, x1, y1, Math.max(1, Math.hypot(x2 - x1, y2 - y1)))
        : g.createLinearGradient(x1, y1, x2, y2);
    } else if (l.gkind === 'radial') {
      grad = g.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(1, Math.hypot(w, h) / 2));
    } else {
      const a = ((l.gangle == null ? 90 : l.gangle) * Math.PI) / 180;
      const dx = Math.cos(a), dy = Math.sin(a);
      const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
      const cx = x + w / 2, cy = y + h / 2;
      grad = g.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
    }
    grad.addColorStop(0, l.gc1 || '#000000');
    grad.addColorStop(1, c2 || '#ffffff');
    return grad;
  }

  const DASHES = { solid: [], dashed: [3, 2], dotted: [0.1, 2] };

  function paintVector(g, l) {
    const path = l.type === 'shape' ? shapePath(l) : pathPath(l);
    if (l.gkind && l.shape !== 'line') {
      g.fillStyle = makeGradient(g, l);
      g.fill(path);
    } else if (l.fill && l.shape !== 'line') {
      g.fillStyle = l.fill;
      g.fill(path);
    }
    if (l.stroke && l.strokeWidth > 0) {
      g.strokeStyle = l.stroke;
      g.lineWidth = l.strokeWidth;
      g.lineJoin = 'round';
      g.lineCap = l.dash === 'dotted' ? 'round' : (l.shape === 'line' ? 'round' : 'butt');
      const unit = (l.dash === 'dotted' ? 1 : 1) * l.strokeWidth;
      g.setLineDash((DASHES[l.dash] || []).map((n) => Math.max(0.1, n * unit)));
      g.stroke(path);
      g.setLineDash([]);
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
    const pts = (l.warp ? quadCorners(l) : [
      { x: l.x, y: l.y }, { x: l.x + l.width, y: l.y },
      { x: l.x, y: l.y + l.height }, { x: l.x + l.width, y: l.y + l.height },
    ]).map((q) => fromLocal(l, q));
    const xs = pts.map((q) => q.x);
    const ys = pts.map((q) => q.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }

  const ROTATE_GAP = 28; // distance of the rotate handle above the layer, in screen pixels

  function rotateHandlePos(l) {
    return fromLocal(l, { x: l.x + l.width / 2, y: l.y - ROTATE_GAP / viewScale });
  }

  // ----- Skew / perspective / distort -----
  // A bent layer remembers how far each corner moved: l.warp = [topLeft, topRight, bottomRight,
  // bottomLeft], each [x, y] as a fraction of the layer's width and height. All zeros = not bent.

  const NO_WARP = () => [[0, 0], [0, 0], [0, 0], [0, 0]];

  // The four corners of the bent layer, in its own (not turned) frame.
  function quadCorners(l) {
    const w = l.warp || NO_WARP();
    const X = l.x, Y = l.y, W = l.width, H = l.height;
    return [
      { x: X + w[0][0] * W, y: Y + w[0][1] * H },
      { x: X + W + w[1][0] * W, y: Y + w[1][1] * H },
      { x: X + W + w[2][0] * W, y: Y + H + w[2][1] * H },
      { x: X + w[3][0] * W, y: Y + H + w[3][1] * H },
    ];
  }

  // Maps a point in the unit square onto a four-corner shape (a "homography": it keeps
  // straight lines straight, and gives true perspective).
  function quadMap(q) {
    const [p0, p1, p2, p3] = q;
    const sx = p0.x - p1.x + p2.x - p3.x;
    const sy = p0.y - p1.y + p2.y - p3.y;
    let a, b, c, d, e, f, gg = 0, hh = 0;
    if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
      a = p1.x - p0.x; b = p3.x - p0.x; c = p0.x;
      d = p1.y - p0.y; e = p3.y - p0.y; f = p0.y;
    } else {
      const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
      const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
      gg = (sx * dy2 - dx2 * sy) / den;
      hh = (dx1 * sy - sx * dy1) / den;
      a = p1.x - p0.x + gg * p1.x; b = p3.x - p0.x + hh * p3.x; c = p0.x;
      d = p1.y - p0.y + gg * p1.y; e = p3.y - p0.y + hh * p3.y; f = p0.y;
    }
    return (u, v) => {
      const k = gg * u + hh * v + 1;
      return [(a * u + b * v + c) / k, (d * u + e * v + f) / k];
    };
  }

  // Draws a picture triangle onto a triangle of the page (the browser can only stretch
  // triangles, so we cut the bent picture into many small ones).
  function drawTriangle(g, img, s0, s1, s2, d0, d1, d2) {
    const [u0, v0] = s0, [u1, v1] = s1, [u2, v2] = s2;
    const [x0, y0] = d0, [x1, y1] = d1, [x2, y2] = d2;
    const delta = u0 * v1 + v0 * u2 + u1 * v2 - v1 * u2 - v0 * u1 - u0 * v2;
    if (Math.abs(delta) < 1e-9) return;
    // Pull the triangle out a little so neighbours overlap and no thin lines show between them.
    const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3;
    const grow = (x, y) => {
      const dx = x - cx, dy = y - cy, len = Math.hypot(dx, dy) || 1;
      return [x + (dx / len) * 1.0, y + (dy / len) * 1.0];
    };
    g.save();
    g.beginPath();
    const a = grow(x0, y0), b = grow(x1, y1), c = grow(x2, y2);
    g.moveTo(a[0], a[1]);
    g.lineTo(b[0], b[1]);
    g.lineTo(c[0], c[1]);
    g.closePath();
    g.clip();
    g.transform(
      (x0 * v1 + v0 * x2 + x1 * v2 - v1 * x2 - v0 * x1 - x0 * v2) / delta,
      (y0 * v1 + v0 * y2 + y1 * v2 - v1 * y2 - v0 * y1 - y0 * v2) / delta,
      (u0 * x1 + x0 * u2 + u1 * x2 - x1 * u2 - x0 * u1 - u0 * x2) / delta,
      (u0 * y1 + y0 * u2 + u1 * y2 - y1 * u2 - y0 * u1 - u0 * y2) / delta,
      (u0 * v1 * x2 + v0 * x1 * u2 + x0 * u1 * v2 - x0 * v1 * u2 - v0 * u1 * x2 - u0 * x1 * v2) / delta,
      (u0 * v1 * y2 + v0 * y1 * u2 + y0 * u1 * v2 - y0 * v1 * u2 - v0 * u1 * y2 - u0 * y1 * v2) / delta
    );
    g.drawImage(img, 0, 0);
    g.restore();
  }

  function drawWarped(g, source, l, tier) {
    const map = quadMap(quadCorners(l));
    const sw = srcW(source), sh = srcH(source);
    const n = drag && drag.mode === 'warp' ? 8 : tier === 'export' ? 28 : 16;
    const fx = !!l.flipX, fy = !!l.flipY;
    const src = (u, v) => [(fx ? 1 - u : u) * sw, (fy ? 1 - v : v) * sh];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const u0 = i / n, u1 = (i + 1) / n, v0 = j / n, v1 = (j + 1) / n;
        const A = map(u0, v0), B = map(u1, v0), C = map(u1, v1), D = map(u0, v1);
        drawTriangle(g, source, src(u0, v0), src(u1, v0), src(u1, v1), A, B, C);
        drawTriangle(g, source, src(u0, v0), src(u1, v1), src(u0, v1), A, C, D);
      }
    }
  }

  // `plain` draws the layer with no opacity and no blend mode (used when copying its pixels).
  function drawLayer(g, l, tier, plain) {
    const m = l.mask && l.mask.on !== false ? images.get(l.mask.img) : null;
    if (m) drawMasked(g, l, tier, plain, m);
    else drawLayerRaw(g, l, tier, plain);
  }

  // ----- Layer masks -----
  // A mask is a hidden picture on a layer: where it is solid the layer shows, where it is clear the
  // layer is hidden. It lives in the layer's own space, so it moves, resizes and turns with the layer.

  let maskTmp = null;

  function drawMasked(g, l, tier, plain, m) {
    const b = layerBounds(l);
    const x0 = Math.max(0, Math.floor(b.x) - 3), y0 = Math.max(0, Math.floor(b.y) - 3);
    const x1 = Math.min(state.doc.width, Math.ceil(b.x + b.width) + 3), y1 = Math.min(state.doc.height, Math.ceil(b.y + b.height) + 3);
    const W = x1 - x0, H = y1 - y0;
    if (W < 1 || H < 1) return;
    if (!maskTmp) maskTmp = document.createElement('canvas');
    maskTmp.width = W;
    maskTmp.height = H;
    const t = maskTmp.getContext('2d');
    t.translate(-x0, -y0);
    drawLayerRaw(t, l, tier, true);
    t.globalCompositeOperation = 'destination-in';
    const rot = l.rotation || 0;
    const warped = l.type === 'image' && l.warp;
    const flipped = (l.flipX || l.flipY) && !warped;
    t.save();
    if (rot || flipped) {
      t.translate(l.x + l.width / 2, l.y + l.height / 2);
      if (rot) t.rotate((rot * Math.PI) / 180);
      if (flipped) t.scale(l.flipX ? -1 : 1, l.flipY ? -1 : 1);
      t.translate(-(l.x + l.width / 2), -(l.y + l.height / 2));
    }
    t.drawImage(m, l.x, l.y, l.width, l.height);
    t.restore();
    g.globalAlpha = plain ? 1 : l.opacity;
    g.globalCompositeOperation = !plain && l.blend && l.blend !== 'normal' ? l.blend : 'source-over';
    g.drawImage(maskTmp, 0, 0, W, H, x0, y0, W, H);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  function drawLayerRaw(g, l, tier, plain) {
    g.globalAlpha = plain ? 1 : l.opacity;
    g.globalCompositeOperation = !plain && l.blend && l.blend !== 'normal' ? l.blend : 'source-over';
    const rot = l.rotation || 0;
    const warped = l.type === 'image' && l.warp;
    const flipped = (l.flipX || l.flipY) && !warped; // a bent picture mirrors its own pixels instead
    const moved = rot || flipped;
    if (moved) {
      g.save();
      g.translate(l.x + l.width / 2, l.y + l.height / 2);
      if (rot) g.rotate((rot * Math.PI) / 180);
      if (flipped) g.scale(l.flipX ? -1 : 1, l.flipY ? -1 : 1);
      g.translate(-(l.x + l.width / 2), -(l.y + l.height / 2));
    }
    if (l.type === 'image') {
      const source = getDrawable(l, tier);
      if (source) {
        if (warped) drawWarped(g, source, l, tier);
        else g.drawImage(source, l.x, l.y, l.width, l.height);
      }
    } else if (l.type === 'text') {
      drawText(g, l);
    } else {
      paintVector(g, l);
    }
    if (moved) g.restore();
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  // Paints the document (no selection handles). Used for the screen and for export.
  // ----- Mask tools -----

  let maskEditId = null; // the layer whose mask is being painted on

  const maskEditing = () => {
    const l = selected();
    return !!(l && l.mask && maskEditId === l.id);
  };

  function newMaskCanvas(l, fill) {
    const sc = Math.min(1, 2048 / Math.max(l.width, l.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(l.width * sc));
    c.height = Math.max(1, Math.round(l.height * sc));
    if (fill) {
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, c.width, c.height);
    }
    return c;
  }

  function copyCanvas(src) {
    const c = document.createElement('canvas');
    c.width = srcW(src);
    c.height = srcH(src);
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  // Gives the layer a new copy of its mask (so Undo can go back to the old one) and returns it.
  function freshMask(l) {
    const c = copyCanvas(images.get(l.mask.img));
    const key = 'img-' + nextImg++;
    images.set(key, c);
    l.mask.img = key;
    return c;
  }

  function setMask(l, canvas) {
    const key = 'img-' + nextImg++;
    images.set(key, canvas);
    l.mask = { img: key, on: true };
  }

  function addMask(kind) {
    const l = selected();
    if (!l) { toast('Click a layer first.'); return; }
    if (l.mask) return;
    let c;
    if (kind === 'selection') {
      if (!marq || marq.w < 2 || marq.h < 2) { toast('Pick an area with the Marquee tool first.'); return; }
      c = newMaskCanvas(l, false);
      const g = c.getContext('2d');
      maskTransform(g, l, c);
      g.fillStyle = '#ffffff';
      g.fill(regionPath(marq));
    } else {
      c = newMaskCanvas(l, kind !== 'hide');
    }
    change(() => { setMask(l, c); });
    maskEditId = l.id;
    renderSidePanels();
    toast(kind === 'hide' ? 'Mask added. It hides everything: paint white to show.' : 'Mask added. Paint black to hide, white to show.');
  }

  function invertMask() {
    const l = selected();
    if (!l || !l.mask) return;
    const old = images.get(l.mask.img);
    const c = document.createElement('canvas');
    c.width = srcW(old);
    c.height = srcH(old);
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(old, 0, 0);
    change(() => { setMask(l, c); });
  }

  function toggleMask() {
    const l = selected();
    if (!l || !l.mask) return;
    change(() => { l.mask.on = l.mask.on === false; });
  }

  function removeMask() {
    const l = selected();
    if (!l || !l.mask) return;
    if (maskEditId === l.id) maskEditId = null;
    change(() => { l.mask = null; });
  }

  // Sets g up so drawing in canvas (document) coordinates lands on the mask picture.
  function maskTransform(g, l, c) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.scale(c.width / l.width, c.height / l.height);
    g.translate(-l.x, -l.y);
    const cx = l.x + l.width / 2, cy = l.y + l.height / 2;
    g.translate(cx, cy);
    g.scale(l.flipX ? -1 : 1, l.flipY ? -1 : 1);
    g.rotate(-((l.rotation || 0) * Math.PI) / 180);
    g.translate(-cx, -cy);
  }

  // A point on the canvas -> a point on the mask picture.
  function docToMask(l, c, p) {
    const q = l.rotation ? toLocal(l, p) : { x: p.x, y: p.y };
    if (l.flipX) q.x = 2 * l.x + l.width - q.x;
    if (l.flipY) q.y = 2 * l.y + l.height - q.y;
    return { x: ((q.x - l.x) * c.width) / l.width, y: ((q.y - l.y) * c.height) / l.height };
  }

  const lumaOf = (hex) => {
    const [r, g, b] = hexToRgb(hex);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };

  // ---------- Artboards ----------
  // With "Artboards" ticked, the canvas is a big pasteboard holding several pages. A layer belongs
  // to the artboard its centre is on, and is cut off at that artboard's edge.

  const AB_MARGIN = 200;
  const AB_GAP = 80;
  let activeAbId = null;
  let abSelected = false;   // the artboard itself (not a layer on it) is selected

  const abList = () => state.artboards || [];
  const isMulti = () => !!(state.doc.multi && abList().length);
  const getAb = (id) => abList().find((a) => a.id === id) || null;
  const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

  function abAt(p) {
    const list = abList();
    for (let i = list.length - 1; i >= 0; i--) if (inRect(p, list[i])) return list[i];
    return null;
  }

  function abOf(l) {
    if (!isMulti()) return null;
    const b = layerBounds(l);
    return abAt({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  }

  function activeAb() {
    if (!isMulti()) return null;
    return getAb(activeAbId) || abList()[0];
  }

  // The page new things go on: the active artboard, or the whole canvas.
  function workRect() {
    const a = activeAb();
    return a ? { x: a.x, y: a.y, width: a.width, height: a.height } : { x: 0, y: 0, width: state.doc.width, height: state.doc.height };
  }

  // Makes the pasteboard just big enough for every artboard, with room around.
  function fitPasteboard() {
    const list = abList();
    if (!list.length) return;
    const d = state.doc;
    d.width = clamp(Math.max(...list.map((a) => a.x + a.width)) + AB_MARGIN, 1, MAX_DOC);
    d.height = clamp(Math.max(...list.map((a) => a.y + a.height)) + AB_MARGIN, 1, MAX_DOC);
  }

  const PASTEBOARD = '#3a3f4d';

  function paintArtboardBg(g, a, forceOpaque) {
    if (a.transparent && !forceOpaque) {
      if (g !== ctx) return; // downloads keep it see-through
      const s = 16;
      for (let y = 0; y < a.height; y += s) {
        for (let x = 0; x < a.width; x += s) {
          g.fillStyle = ((x + y) / s) % 2 ? '#c9ccd3' : '#ffffff';
          g.fillRect(a.x + x, a.y + y, Math.min(s, a.width - x), Math.min(s, a.height - y));
        }
      }
    } else {
      g.fillStyle = a.transparent ? '#ffffff' : a.background;
      g.fillRect(a.x, a.y, a.width, a.height);
    }
  }

  function paintLayers(g, tier, only) {
    for (const layer of state.layers) {
      if (!layer.visible) continue;
      if (g === ctx && layer.id === editingId) continue; // its text box is showing instead
      if (only && !only(layer)) continue;
      drawLayer(g, layer, tier, false);
    }
    g.globalAlpha = 1;
  }

  function paintDocument(g, forceOpaque, tier) {
    const { width, height, background, transparent } = state.doc;
    if (isMulti()) {
      g.fillStyle = PASTEBOARD;
      g.fillRect(0, 0, width, height);
      for (const a of abList()) paintArtboardBg(g, a, forceOpaque);
      const owners = new Map(state.layers.map((l) => [l.id, abOf(l)]));
      // layers, in order; each one is cut off at its own artboard
      for (const layer of state.layers) {
        const a = owners.get(layer.id);
        g.save();
        if (a) {
          g.beginPath();
          g.rect(a.x, a.y, a.width, a.height);
          g.clip();
        }
        if (layer.visible && !(g === ctx && layer.id === editingId)) drawLayer(g, layer, tier, false);
        g.restore();
      }
      g.globalAlpha = 1;
      return;
    }
    if (!transparent || forceOpaque) {
      g.fillStyle = transparent ? '#ffffff' : background;
      g.fillRect(0, 0, width, height);
    }
    paintLayers(g, tier);
  }

  // One artboard on its own (for download).
  function paintArtboard(g, a, forceOpaque, tier) {
    g.save();
    g.translate(-a.x, -a.y);
    g.beginPath();
    g.rect(a.x, a.y, a.width, a.height);
    g.clip();
    paintArtboardBg(g, a, forceOpaque);
    paintLayers(g, tier, (l) => abOf(l) === a);
    g.restore();
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
      if (l.warp && l.type === 'image') {
        ctx.save();
        ctx.setLineDash([5 * s, 4 * s]);
        ctx.beginPath();
        quadCorners(l).forEach((c, i) => {
          const px = c.x - (l.x + l.width / 2), py = c.y - (l.y + l.height / 2);
          if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        });
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
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
    if (m.kind === 'path') return m.path;
    if (m.kind === 'ellipse') p.ellipse(m.x + m.w / 2, m.y + m.h / 2, m.w / 2, m.h / 2, 0, 0, Math.PI * 2);
    else p.rect(m.x, m.y, m.w, m.h);
    return p;
  }

  function drawOverlays() {
    drawSelection();
    drawArtboardOverlay();
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
      const path = marq.outline || regionPath(marq);
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
    if (tool === 'crop' && cropBox) drawCropOverlay();
    if (tool === 'warp') drawWarpOverlay();
    drawPaintOverlays();
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
    positionFloatBar();
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
    if (isMulti()) workspace.scrollTop -= 40; // keep the artboard names clear of the tool bar
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

      if (isMulti()) {
        const a = abOf(l);
        const tag = el('span', 'ab-tag', a ? a.name : 'off page');
        tag.title = 'Artboard this layer is on';
        name.append(tag);
      }
      li.append(eye, makeThumb(l));
      if (l.mask) {
        const mb = el('button', 'mask-thumb' + (maskEditId === l.id ? ' editing' : '') + (l.mask.on === false ? ' off' : ''));
        mb.type = 'button';
        mb.dataset.action = 'mask';
        mb.title = maskEditId === l.id ? 'Painting on the mask (click to paint on the layer instead)' : 'Click to paint on the mask';
        const mc = document.createElement('canvas');
        mc.width = 36;
        mc.height = 36;
        const mg = mc.getContext('2d');
        mg.fillStyle = '#000';
        mg.fillRect(0, 0, 36, 36);
        const im = images.get(l.mask.img);
        if (im) {
          const sc = Math.min(36 / srcW(im), 36 / srcH(im));
          const w = srcW(im) * sc, h = srcH(im) * sc;
          mg.drawImage(im, (36 - w) / 2, (36 - h) / 2, w, h);
        }
        mb.append(mc);
        li.append(mb);
      }
      li.append(name, up, down, del);
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
    blendSelect.disabled = !ls.length;
    blendSelect.value = ls.length ? (ls[0].blend || 'normal') : 'normal';
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
        if (kind === 'shape' && props.shape === 'line') {
          if (!l.stroke) l.stroke = l.fill || '#111111';
          if (!(l.strokeWidth >= 1)) l.strokeWidth = 4;
        }
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
      const pick = el('select');
      for (const sh of SHAPES) {
        const o = el('option', '', sh.label);
        o.value = sh.value;
        pick.append(o);
      }
      pick.value = cur.shape;
      pick.addEventListener('change', () => setStyle('shape', { shape: pick.value }, false, onLayers));
      out.push(['Shape', pick]);
      if (cur.shape !== 'line') {
        out.push(['Fill', colorInput('shape', 'fill', true, onLayers)]);
        out.push(...gradientFields('shape', cur, onLayers));
      }
      out.push(['Outline', colorInput('shape', 'stroke', true, onLayers)]);
      out.push(['Outline size', numberInput(cur.strokeWidth, 0, 200, (v) => setStyle('shape', { strokeWidth: v }, false, onLayers))]);
      out.push(['Outline style', seg(DASH_ITEMS, cur.dash || 'solid', (v) => setStyle('shape', { dash: v }, false, onLayers))]);
      if (cur.shape === 'rect') {
        out.push(['Corners', numberInput(cur.radius || 0, 0, 2000, (v) => setStyle('shape', { radius: v }, false, onLayers))]);
      }
    } else {
      out.push(['Line', colorInput('path', 'stroke', true, onLayers)]);
      out.push(['Line size', numberInput(cur.strokeWidth, 0, 200, (v) => setStyle('path', { strokeWidth: v }, false, onLayers))]);
      out.push(['Line style', seg(DASH_ITEMS, cur.dash || 'solid', (v) => setStyle('path', { dash: v }, false, onLayers))]);
      out.push(['Fill', colorInput('path', 'fill', true, onLayers)]);
      out.push(...gradientFields('path', cur, onLayers));
    }
    return out;
  }

  const DASH_ITEMS = [
    { value: 'solid', label: 'Solid' },
    { value: 'dashed', label: 'Dashed' },
    { value: 'dotted', label: 'Dotted' },
  ];

  // Gradient fill controls for shapes and paths.
  function gradientFields(kind, cur, onLayers) {
    const out = [];
    out.push(['Gradient', seg([
      { value: '', label: 'Off' }, { value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' },
    ], cur.gkind || '', (v) => setStyle(kind, { gkind: v }, false, onLayers))]);
    if (cur.gkind) {
      out.push(['Color 1', colorInput(kind, 'gc1', false, onLayers)]);
      out.push(['Color 2', colorInput(kind, 'gc2', false, onLayers)]);
      out.push(['Fade out', seg([{ value: 'no', label: 'Off' }, { value: 'yes', label: 'On' }], cur.gfade ? 'yes' : 'no',
        (v) => setStyle(kind, { gfade: v === 'yes' }, false, onLayers))]);
      if (cur.gkind === 'linear') {
        out.push(['Angle (°)', numberInput(cur.gangle == null ? 90 : cur.gangle, -360, 360,
          (v) => setStyle(kind, { gangle: v, gx1: null, gy1: null, gx2: null, gy2: null }, false, onLayers))]);
      }
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

  // Align buttons drawn as little pictures (a line with two bars), so the bar stays short.
  const ALIGN_SHAPES = {
    left: '<path d="M3 3v14"/><rect x="5.5" y="5" width="11" height="4" rx="1" fill="currentColor" stroke="none"/><rect x="5.5" y="11" width="7" height="4" rx="1" fill="currentColor" stroke="none"/>',
    hcenter: '<path d="M10 3v14"/><rect x="4" y="5" width="12" height="4" rx="1" fill="currentColor" stroke="none"/><rect x="6" y="11" width="8" height="4" rx="1" fill="currentColor" stroke="none"/>',
    right: '<path d="M17 3v14"/><rect x="3.5" y="5" width="11" height="4" rx="1" fill="currentColor" stroke="none"/><rect x="7.5" y="11" width="7" height="4" rx="1" fill="currentColor" stroke="none"/>',
    top: '<path d="M3 3h14"/><rect x="5" y="5.5" width="4" height="11" rx="1" fill="currentColor" stroke="none"/><rect x="11" y="5.5" width="4" height="7" rx="1" fill="currentColor" stroke="none"/>',
    vcenter: '<path d="M3 10h14"/><rect x="5" y="4" width="4" height="12" rx="1" fill="currentColor" stroke="none"/><rect x="11" y="6" width="4" height="8" rx="1" fill="currentColor" stroke="none"/>',
    bottom: '<path d="M3 17h14"/><rect x="5" y="3.5" width="4" height="11" rx="1" fill="currentColor" stroke="none"/><rect x="11" y="7.5" width="4" height="7" rx="1" fill="currentColor" stroke="none"/>',
  };
  const ALIGN_NAMES = { left: 'Line up left', hcenter: 'Line up centre (left to right)', right: 'Line up right', top: 'Line up top', vcenter: 'Line up middle (top to bottom)', bottom: 'Line up bottom' };

  function alignIcons(target) {
    const wrap = el('div', 'seg');
    for (const a of ALIGNS) {
      const b = el('button');
      b.type = 'button';
      b.innerHTML = '<svg class="ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' + ALIGN_SHAPES[a.value] + '</svg>'; // our own fixed icon strings only
      b.title = ALIGN_NAMES[a.value] + ' on ' + target;
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => alignSelected(a.value));
      wrap.append(b);
    }
    return wrap;
  }

  function alignSelected(mode) {
    const ls = selectedLayers();
    if (!ls.length) return;
    const box = ls.length > 1 ? unionBox(ls) : (abOf(ls[0]) || { x: 0, y: 0, width: state.doc.width, height: state.doc.height });
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
    if (maskEditing() && (tool === 'brush' || tool === 'eraser' || tool === 'gradient')) {
      add(el('span', 'opt-chip', 'Painting on the mask'));
      add(el('span', 'opt-hint', tool === 'eraser' ? 'Hides' : 'Black hides, white shows'));
      add(el('span', 'opt-sep'));
    }
    const field = (label, control) => {
      const f = el('span', 'opt-field');
      f.append(el('span', 'opt-label', label), control);
      add(f);
    };

    if (tool === 'select') {
      if (!sel.length) {
        add(el('span', 'opt-hint', isMulti()
          ? 'Click a layer, or an artboard’s name to pick it. Alt + drag the name to copy it. Use the + buttons to add one.'
          : 'Click a layer, or drag a box to pick several. Hold Shift to add more.'));
      } else {
        const alignTip = sel.length > 1 ? 'each other' : 'the artwork';
        add(el('span', 'opt-label', 'Align'));
        add(alignIcons(alignTip));
        add(el('span', 'opt-sep'));
        add(actionButton('Flip ↔', 'Flip left to right', false, () => flipSelected('x')));
        add(actionButton('Flip ↕', 'Flip top to bottom', false, () => flipSelected('y')));
      }
    } else if (tool === 'wand') {
      wandOptions(add);
    } else if (tool === 'marquee') {
      add(seg([{ value: 'rect', label: 'Rectangle' }, { value: 'ellipse', label: 'Ellipse' }], marqKind, (v) => {
        marqKind = v;
        if (marq && marq.kind !== 'path') marq.kind = v;
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
    } else if (tool === 'crop') {
      const l = selected();
      const photoOk = !!(l && l.type === 'image');
      add(el('span', 'opt-label', 'Crop'));
      add(seg([{ value: 'canvas', label: 'Canvas' }, ...(photoOk ? [{ value: 'layer', label: 'Selected photo' }] : [])],
        cropTarget, (v) => { cropTarget = v; initCrop(true); renderToolOptions(); render(); }));
      add(el('span', 'opt-sep'));
      const ratio = el('select');
      for (const r of CROP_RATIOS) {
        const o = el('option', '', r.label);
        o.value = r.value;
        ratio.append(o);
      }
      ratio.value = cropRatio;
      ratio.title = 'Shape of the crop';
      ratio.addEventListener('change', () => {
        cropRatio = ratio.value;
        const r = cropRatioValue();
        if (r && cropBox) fitCropRatio(cropBox, r, cropBounds());
        render();
      });
      field('Shape', ratio);
      add(actionButton('Apply crop', 'Crop now (Enter)', !cropBox, applyCrop));
      add(actionButton('Reset', 'Start over (Esc)', !cropBox, () => { initCrop(true); render(); }));
      add(el('span', 'opt-hint', 'Drag the handles. Enter applies.'));
    } else if (tool === 'brush' || tool === 'eraser') {
      const o = brushOpts[tool];
      if (tool === 'brush') add(paintSwatches());
      field('Size', numberInput(o.size, 1, 1000, (v) => { o.size = v; render(); }));
      field('Hardness', numberInput(o.hardness, 0, 100, (v) => { o.hardness = v; }));
      field('Opacity', numberInput(o.opacity, 1, 100, (v) => { o.opacity = v; }));
      add(el('span', 'opt-hint', tool === 'brush' ? 'Paint on the selected photo, or on a new Paint layer.' : 'Rub out pixels on the selected layer.'));
    } else if (tool === 'bucket') {
      add(paintSwatches());
      field('Match', numberInput(bucketOpts.tolerance, 0, 255, (v) => { bucketOpts.tolerance = v; }));
      add(seg([{ value: 'yes', label: 'Touching only' }, { value: 'no', label: 'Whole layer' }], bucketOpts.contiguous ? 'yes' : 'no',
        (v) => { bucketOpts.contiguous = v === 'yes'; renderToolOptions(); }));
      field('Opacity', numberInput(bucketOpts.opacity, 1, 100, (v) => { bucketOpts.opacity = v; }));
      add(el('span', 'opt-hint', 'Click to fill similar colors on the selected layer.'));
    } else if (tool === 'gradient') {
      add(paintSwatches());
      add(seg([{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }], gradientOpts.kind,
        (v) => { gradientOpts.kind = v; renderToolOptions(); }));
      add(seg([{ value: 'no', label: 'Two colors' }, { value: 'yes', label: 'Fade out' }], gradientOpts.fade ? 'yes' : 'no',
        (v) => { gradientOpts.fade = v === 'yes'; renderToolOptions(); }));
      add(el('span', 'opt-hint', maskEditing() ? 'Drag across the layer to fade the mask.' : 'Drag across the artwork. It becomes its own layer.'));
    } else if (tool === 'eyedropper') {
      add(paintSwatches());
      add(el('span', 'opt-hint', 'Click to pick a color. Alt + click sets the second color.'));
    } else if (tool === 'cutout') {
      cutoutOptions(add);
    } else if (tool === 'artboard') {
      if (isMulti()) artboardOptions(add);
      else add(el('span', 'opt-hint', 'Make a new file with “Artboards” ticked to use this.'));
    } else if (tool === 'warp') {
      add(seg([
        { value: 'skew', label: 'Skew', title: 'Slide an edge sideways or up and down' },
        { value: 'perspective', label: 'Perspective', title: 'Move a corner; the next corner moves the other way' },
        { value: 'distort', label: 'Distort', title: 'Move each corner on its own' },
      ], warpMode, (v) => { warpMode = v; renderToolOptions(); render(); }));
      const bent = selectedLayers().some((l) => l.warp);
      add(actionButton('Reset bend', 'Put the photo back to its normal shape', !bent, resetWarp));
      add(el('span', 'opt-hint', selected() ? 'Drag the handles on the photo.' : 'Click a photo first.'));
    } else {
      add(el('span', 'opt-hint', 'Drag to move around the artwork.'));
    }
  }

  // The two painting colors (front and back), with a swap button.
  function paintSwatches() {
    const wrap = el('span', 'swatches');
    for (const key of ['fg', 'bg']) {
      const c = el('input');
      c.type = 'color';
      c.value = paint[key];
      c.title = key === 'fg' ? 'Color to paint with' : 'Second color (gradient end)';
      c.addEventListener('input', () => { paint[key] = c.value; });
      swatchInputs[key] = c;
      wrap.append(c);
    }
    const swap = el('button', 'btn btn-small', '⇄');
    swap.type = 'button';
    swap.title = 'Swap the two colors';
    swap.addEventListener('click', () => {
      [paint.fg, paint.bg] = [paint.bg, paint.fg];
      swatchInputs.fg.value = paint.fg;
      swatchInputs.bg.value = paint.bg;
    });
    wrap.append(swap);
    return wrap;
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
    const flips = el('div', 'seg');
    for (const [label, axis, on] of [['Flip ↔', 'x', l.flipX], ['Flip ↕', 'y', l.flipY]]) {
      const b = el('button', on ? 'on' : '', label);
      b.type = 'button';
      b.addEventListener('click', () => flipSelected(axis));
      flips.append(b);
    }
    designBody.append(propRow('Flip', flips));
    if (l.warp) designBody.append(propRow('Bend', actionButton('Reset bend', 'Put the photo back to its normal shape', false, resetWarp)));

    if (l.type === 'image') {
      designBody.append(el('p', 'tips', 'Open the Camera Raw tab to fix light and color on this photo.'));
    } else {
      for (const [label, control] of styleFields(l.type, true)) designBody.append(propRow(label, control));
    }
  }

  const maskRow = $('mask-row');

  function renderMaskRow() {
    maskRow.textContent = '';
    const l = selected();
    maskRow.hidden = !l;
    if (!l) return;
    maskRow.append(el('span', 'mask-label', 'Mask'));
    const btn = (label, title, fn, on, disabled) => {
      const b = el('button', 'btn btn-small' + (on ? ' on' : ''), label);
      b.type = 'button';
      b.title = title;
      b.disabled = !!disabled;
      b.addEventListener('click', fn);
      maskRow.append(b);
    };
    if (!l.mask) {
      btn('Add', 'Add a mask that shows everything. Then paint black to hide parts.', () => addMask('reveal'));
      btn('Hide all', 'Add a mask that hides everything. Then paint white to show parts.', () => addMask('hide'));
      btn('From selection', 'Show only the area picked with the Marquee tool', () => addMask('selection'), false, !marq);
      if (l.type === 'image') btn('Remove background', 'Cut out the background automatically', () => setTool('cutout'));
    } else {
      btn(maskEditId === l.id ? 'Painting ✓' : 'Paint', 'Brush, Eraser and Gradient paint on the mask: black hides, white shows', () => {
        maskEditId = maskEditId === l.id ? null : l.id;
        renderSidePanels();
        render();
      }, maskEditId === l.id);
      btn(l.mask.on === false ? 'Turn on' : 'Turn off', 'Show the whole layer for a moment', toggleMask);
      btn('Invert', 'Swap what is shown and hidden', invertMask);
      btn('Remove', 'Delete the mask', removeMask);
    }
  }

  function renderSidePanels() {
    if (sel.length) abSelected = false;
    const sl = selected();
    if (maskEditId && (!sl || sl.id !== maskEditId || !sl.mask)) maskEditId = null;
    if (sl) {
      const a = abOf(sl);
      if (a) activeAbId = a.id;
    }
    renderPanel();
    renderMaskRow();
    renderOpacity();
    renderAdjust();
    renderDesign();
    renderToolOptions();
    renderFloatBar();
  }

  // ---------- Floating shortcut bar (like Photoshop's pop-up bar over the selected thing) ----------

  const floatBar = $('float-bar');
  let floatOffset = { id: null, dx: 0, dy: 0 };
  let floatMore = false;

  const ALIGN_ICON = {
    left: '<path d="M3 5h14M3 9h9M3 13h12M3 17h8"/>',
    center: '<path d="M3 5h14M6 9h8M4 13h12M7 17h6"/>',
    right: '<path d="M3 5h14M8 9h9M5 13h12M9 17h8"/>',
  };
  function iconSvg(inner) {
    return '<svg viewBox="0 0 20 22" width="16" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' + inner + '</svg>';
  }

  function duplicateLayers(ids) {
    const src = ids.map(getLayer).filter(Boolean);
    if (!src.length) return;
    finishTextEdit();
    change(() => {
      const made = [];
      for (const l of src) {
        const c = cloneLayer(l);
        c.name = l.name + ' copy';
        c.x += 24;
        c.y += 24;
        const at = state.layers.findIndex((x) => x.id === l.id);
        state.layers.splice(at + 1 + made.length, 0, c);
        made.push(c.id);
      }
      sel = made;
    });
  }

  function floatButton(label, title, onClick, on) {
    const b = el('button', 'fb-btn' + (on ? ' on' : ''));
    if (label.startsWith('<')) b.innerHTML = label; // our own fixed icon strings only
    else b.textContent = label;
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderFloatBar() {
    floatBar.textContent = '';
    const l = editing ? getLayer(editing.id) : selected();
    if (!l || !l.visible || (tool !== 'select' && tool !== 'text')) {
      floatBar.hidden = true;
      return;
    }
    if (floatOffset.id !== l.id) floatOffset = { id: l.id, dx: 0, dy: 0 };

    const grip = el('span', 'fb-grip', '⋮⋮');
    grip.title = 'Drag to move this bar';
    floatBar.append(grip);

    const row = el('div', 'fb-row');
    floatBar.append(row);
    const add = (n) => row.append(n);
    const sep = () => add(el('span', 'fb-sep'));

    if (l.type === 'text') {
      const f = Object.fromEntries(styleFields('text', true));
      const fontSel = f.Font.querySelector('select');
      fontSel.classList.add('fb-font');
      add(fontSel);
      const size = f.Size;
      size.classList.add('fb-size');
      size.title = 'Size';
      add(size);
      add(f.Color);
      sep();
      for (const a of ['left', 'center', 'right']) {
        add(floatButton(iconSvg(ALIGN_ICON[a]), 'Align ' + a, () => setStyle('text', { align: a }, false, true), l.align === a));
      }
      sep();
      add(floatButton('•••', 'More text options', () => {
        floatMore = !floatMore;
        renderFloatBar();
      }, floatMore));
      if (floatMore) {
        const more = el('div', 'fb-row fb-more');
        const mf = (label, node) => {
          const w = el('span', 'opt-field');
          w.append(el('span', 'opt-label', label), node);
          more.append(w);
        };
        more.append(f.Style);
        mf('Letter space', f['Letter space']);
        mf('Line height %', f['Line height %']);
        floatBar.append(more);
      }
    } else if (l.type === 'image') {
      add(floatButton('✨ Auto fix', 'Smart fix for light and color', () => autoBtn.click()));
      add(floatButton('Crop', 'Crop this picture', () => setTool('crop')));
      add(floatButton('Flip ↔', 'Flip left to right', () => flipSelected('x')));
      add(floatButton('Flip ↕', 'Flip top to bottom', () => flipSelected('y')));
      add(floatButton('Bend', 'Skew, perspective, distort', () => setTool('warp')));
      add(floatButton('Cut out', 'Remove the background', () => setTool('cutout')));
      add(floatButton('Camera Raw', 'Open Camera Raw controls', () => setTab('raw')));
    } else {
      const f = Object.fromEntries(styleFields(l.type, true));
      const keys = l.type === 'shape' ? ['Shape', 'Fill', 'Outline', 'Outline size'] : ['Line', 'Line size', 'Fill'];
      for (const k of keys) {
        if (!f[k]) continue;
        const w = el('span', 'opt-field');
        w.append(el('span', 'opt-label', k), f[k]);
        add(w);
      }
      add(floatButton('Flip ↔', 'Flip left to right', () => flipSelected('x')));
    }
    sep();
    add(floatButton(l.mask ? 'Mask ✓' : 'Mask', l.mask ? 'This layer has a mask. Click to paint on it.' : 'Add a mask to this layer', () => {
      if (!l.mask) addMask('reveal');
      else { maskEditId = maskEditId === l.id ? null : l.id; renderSidePanels(); render(); }
    }, maskEditId === l.id));
    add(floatButton('Duplicate', 'Make a copy (Ctrl/Cmd + D)', () => duplicateLayers([l.id])));
    add(floatButton('Delete', 'Delete', () => deleteLayers([l.id])));

    // keep text editing alive when pressing buttons
    floatBar.querySelectorAll('button').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));
    floatBar.hidden = false;
    positionFloatBar();
  }

  function positionFloatBar() {
    if (floatBar.hidden && !floatBar.firstChild) return;
    const l = editing ? getLayer(editing.id) : selected();
    if (!l || !l.visible || drag || (tool !== 'select' && tool !== 'text')) {
      floatBar.hidden = true;
      return;
    }
    if (!floatBar.firstChild) return;
    floatBar.hidden = false;
    const wrap = floatBar.parentElement.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const b = layerBounds(l);
    const left = cr.left - wrap.left + b.x * viewScale;
    const top = cr.top - wrap.top + b.y * viewScale;
    const bw = floatBar.offsetWidth;
    const bh = floatBar.offsetHeight;
    const lh = b.height * viewScale;
    const toolsH = toolOptions.firstChild ? toolOptions.offsetHeight + 24 : 8;
    const gap = editing ? 14 : 46;
    let x = left + (b.width * viewScale - bw) / 2;
    let y = top - bh - gap;
    if (y < toolsH) y = top + lh + gap; // not enough room above: go below
    x += floatOffset.dx;
    y += floatOffset.dy;
    x = clamp(x, 8, Math.max(8, wrap.width - bw - 8));
    y = clamp(y, 8, Math.max(8, wrap.height - bh - 8));
    floatBar.style.left = x + 'px';
    floatBar.style.top = y + 'px';
  }

  floatBar.addEventListener('pointerdown', (e) => {
    if (!e.target.classList.contains('fb-grip')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = floatOffset.dx, oy = floatOffset.dy;
    floatBar.setPointerCapture(e.pointerId);
    const move = (ev) => {
      floatOffset.dx = ox + ev.clientX - sx;
      floatOffset.dy = oy + ev.clientY - sy;
      positionFloatBar();
    };
    const up = () => {
      floatBar.removeEventListener('pointermove', move);
      floatBar.removeEventListener('pointerup', up);
    };
    floatBar.addEventListener('pointermove', move);
    floatBar.addEventListener('pointerup', up);
  });
  workspace.addEventListener('scroll', positionFloatBar, { passive: true });
  window.addEventListener('resize', positionFloatBar);

  function renderAll() {
    const d = state.doc;
    const resized = canvas.width !== d.width || canvas.height !== d.height;
    if (resized) {
      canvas.width = d.width;
      canvas.height = d.height;
    }
    canvas.classList.toggle('transparent', d.transparent);
    if (resized && !(d.multi && !fitMode)) fitToScreen();
    else applyScale();

    const multi = isMulti();
    $('rail-artboard').hidden = !multi;
    exportScope.hidden = !(multi && abList().length > 1);
    if (!multi && tool === 'artboard') setTool('select');
    const wa = activeAb();
    docSize.textContent = wa ? wa.width + ' × ' + wa.height : d.width + ' × ' + d.height;
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
    for (const n of ['layers', 'design', 'raw']) $('tab-' + n).hidden = !floating.has(n) && n !== name;
  }

  // ----- Detachable tabs: drag a tab out to make it a floating window; "Dock" puts it back -----

  const floating = new Map(); // tab name -> window element
  const TAB_TITLES = { layers: 'Layers', design: 'Design', raw: 'Camera Raw' };
  let floatZ = 20;

  function detachTab(name, x, y) {
    if (floating.has(name)) return;
    const body = $('tab-' + name);
    const win = el('div', 'tab-window');
    const head = el('div', 'tw-head');
    head.append(el('span', 'tw-title', TAB_TITLES[name]));
    const dock = el('button', 'btn btn-small', 'Dock');
    dock.type = 'button';
    dock.title = 'Put this tab back in the side panel';
    dock.addEventListener('click', () => dockTab(name));
    head.append(dock);
    win.append(head, body);
    win.style.left = clamp(x, 8, window.innerWidth - 300) + 'px';
    win.style.top = clamp(y, 8, window.innerHeight - 200) + 'px';
    win.style.zIndex = String(++floatZ);
    document.body.append(win);
    floating.set(name, win);
    document.querySelector('.tab[data-tab="' + name + '"]').hidden = true;
    win.addEventListener('pointerdown', () => { win.style.zIndex = String(++floatZ); });
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const ox = e.clientX - win.offsetLeft, oy = e.clientY - win.offsetTop;
      head.setPointerCapture(e.pointerId);
      const move = (ev) => {
        win.style.left = clamp(ev.clientX - ox, 0, window.innerWidth - 80) + 'px';
        win.style.top = clamp(ev.clientY - oy, 0, window.innerHeight - 40) + 'px';
      };
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
    if (activeTab === name) {
      const next = ['layers', 'design', 'raw'].find((n) => !floating.has(n));
      if (next) activeTab = next;
    }
    setTab(activeTab);
  }

  function dockTab(name) {
    const win = floating.get(name);
    if (!win) return;
    const body = $('tab-' + name);
    document.querySelector('.panel').append(body);
    win.remove();
    floating.delete(name);
    document.querySelector('.tab[data-tab="' + name + '"]').hidden = false;
    setTab(name);
  }

  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const sx = e.clientX, sy = e.clientY;
      const move = (ev) => {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 40) return;
        cleanup();
        detachTab(t.dataset.tab, ev.clientX - 140, ev.clientY - 14);
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', cleanup);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', cleanup);
    });
    t.addEventListener('dblclick', () => detachTab(t.dataset.tab, window.innerWidth - 380, 90));
    t.title = 'Drag out (or double-click) to make this tab a floating window';
  });

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
      case 'mask':
        sel = [id];
        maskEditId = maskEditId === id ? null : id;
        renderSidePanels();
        render();
        break;
    }
  });

  for (const b of BLENDS) {
    const o = el('option', '', b.label);
    o.value = b.value;
    blendSelect.append(o);
  }
  blendSelect.addEventListener('change', () => {
    const ls = selectedLayers();
    if (!ls.length) return;
    change(() => { for (const l of ls) l.blend = blendSelect.value; });
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

  textEditor.addEventListener('blur', (e) => {
    if (e.relatedTarget && floatBar.contains(e.relatedTarget)) return;
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
    const p = l.rotation ? toLocal(l, p0) : { ...p0 };
    if (l.warp && l.type === 'image') {
      // inside the bent four-corner shape?
      const q = quadCorners(l);
      let inside = false;
      for (let i = 0, j = 3; i < 4; j = i++) {
        if ((q[i].y > p.y) !== (q[j].y > p.y) && p.x < ((q[j].x - q[i].x) * (p.y - q[i].y)) / (q[j].y - q[i].y) + q[i].x) inside = !inside;
      }
      return inside;
    }
    if (l.type === 'shape' || l.type === 'path') {
      if (l.flipX) p.x = 2 * l.x + l.width - p.x;
      if (l.flipY) p.y = 2 * l.y + l.height - p.y;
      const path = l.type === 'shape' ? shapePath(l) : pathPath(l);
      ctx.save();
      ctx.lineWidth = Math.max(l.stroke ? l.strokeWidth : 0, 10 / viewScale);
      const hit = ((l.fill || l.gkind) && ctx.isPointInPath(path, p.x, p.y)) || ctx.isPointInStroke(path, p.x, p.y);
      ctx.restore();
      return hit;
    }
    return p.x >= l.x && p.x <= l.x + l.width && p.y >= l.y && p.y <= l.y + l.height;
  }

  function hitTest(p, onlyType) {
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      if (!l.visible || (onlyType && l.type !== onlyType)) continue;
      if (isMulti()) {
        const a = abOf(l);
        if (a && !inRect(p, a)) continue; // the part cut off by its artboard cannot be clicked
      }
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
    if (isMulti() && (abPlusAt(p) || abLabelAt(p))) {
      canvas.style.cursor = abPlusAt(p) ? 'pointer' : 'move';
      return;
    }
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

  // ---------- Magic wand ----------
  // Click a colour and everything like it (and touching it) is selected.
  const wandOpts = { tolerance: 30, touching: true };

  function wandSelect(l, p, add) {
    const r = rasterize(l);
    const W = r.canvas.width, H = r.canvas.height;
    const px = Math.floor((p.x - l.x) * r.sx), py = Math.floor((p.y - l.y) * r.sy);
    if (px < 0 || py < 0 || px >= W || py >= H) { toast('Click on the selected layer.'); return; }
    const d = r.canvas.getContext('2d').getImageData(0, 0, W, H).data;
    const N = W * H;
    const si = (py * W + px) * 4;
    const sr = d[si], sg = d[si + 1], sb = d[si + 2], sa = d[si + 3];
    const lim = wandOpts.tolerance * 2.55;
    const like = (i) => {
      const k = i * 4;
      return Math.max(Math.abs(d[k] - sr), Math.abs(d[k + 1] - sg), Math.abs(d[k + 2] - sb), Math.abs(d[k + 3] - sa)) <= lim;
    };
    let mask = new Uint8Array(N);
    if (wandOpts.touching) {
      const stack = [py * W + px];
      mask[stack[0]] = 1;
      while (stack.length) {
        const i = stack.pop();
        const x = i % W;
        let j;
        if (x > 0 && !mask[j = i - 1] && like(j)) { mask[j] = 1; stack.push(j); }
        if (x < W - 1 && !mask[j = i + 1] && like(j)) { mask[j] = 1; stack.push(j); }
        if (i >= W && !mask[j = i - W] && like(j)) { mask[j] = 1; stack.push(j); }
        if (i < N - W && !mask[j = i + W] && like(j)) { mask[j] = 1; stack.push(j); }
      }
    } else {
      for (let i = 0; i < N; i++) if (like(i)) mask[i] = 1;
    }
    const old = marq && marq.pix;
    if (add && old && old.id === l.id && old.w === W && old.h === H && old.x === l.x && old.y === l.y) {
      for (let i = 0; i < N; i++) if (old.data[i]) mask[i] = 1;
    }
    setWandSelection(l, r, mask, W, H);
  }

  function setWandSelection(l, r, mask, W, H) {
    let x1 = W, y1 = H, x2 = -1, y2 = -1;
    const fill = new Path2D(), edge = new Path2D();
    const X = (x) => l.x + x / r.sx, Y = (y) => l.y + y / r.sy;
    for (let y = 0; y < H; y++) {
      let x = 0;
      while (x < W) {
        if (!mask[y * W + x]) { x++; continue; }
        const a = x;
        while (x < W && mask[y * W + x]) x++;
        fill.rect(X(a), Y(y), (x - a) / r.sx, 1 / r.sy);
        if (a < x1) x1 = a; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y + 1 > y2) y2 = y + 1;
      }
    }
    // outline: only the edges between picked and not picked pixels, joined into long lines
    const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] ? 1 : 0);
    for (let y = 0; y <= H; y++) {
      let a = -1, b = -1;
      for (let x = 0; x <= W; x++) {
        const e = at(x, y) !== at(x, y - 1);
        if (e && a < 0) a = x;
        if ((!e || x === W) && a >= 0) { edge.moveTo(X(a), Y(y)); edge.lineTo(X(e ? x + 1 : x), Y(y)); a = -1; }
      }
    }
    for (let x = 0; x <= W; x++) {
      let a = -1;
      for (let y = 0; y <= H; y++) {
        const e = at(x, y) !== at(x - 1, y);
        if (e && a < 0) a = y;
        if ((!e || y === H) && a >= 0) { edge.moveTo(X(x), Y(a)); edge.lineTo(X(x), Y(e ? y + 1 : y)); a = -1; }
      }
    }
    marq = {
      kind: 'path', x: X(x1), y: Y(y1), w: (x2 - x1) / r.sx, h: (y2 - y1) / r.sy,
      path: fill, outline: edge, pix: { id: l.id, w: W, h: H, x: l.x, y: l.y, sx: r.sx, sy: r.sy, data: mask },
    };
    renderToolOptions();
    renderMaskRow();
    render();
  }

  function downWand(e, p) {
    const l = selected();
    if (!l || !l.visible) { toast('Click a layer first, then click a colour on it.'); return; }
    if (l.rotation || l.warp) { toast('Set the rotation back to 0 and reset any bend first.'); return; }
    wandSelect(l, p, e.shiftKey);
  }

  function wandOptions(add) {
    const w = el('span', 'opt-field');
    const input = el('input');
    input.type = 'range'; input.min = '0'; input.max = '100';
    input.value = String(wandOpts.tolerance);
    const out = el('span', 'opt-hint', String(wandOpts.tolerance));
    input.addEventListener('input', () => { wandOpts.tolerance = Number(input.value); out.textContent = input.value; });
    w.append(el('span', 'opt-label', 'Strength'), input, out);
    add(w);
    add(seg([{ value: 'near', label: 'Touching' }, { value: 'all', label: 'Everywhere' }], wandOpts.touching ? 'near' : 'all', (v) => {
      wandOpts.touching = v === 'near';
      renderToolOptions();
    }));
    add(el('span', 'opt-sep'));
    const has = !!marq;
    add(actionButton('Copy to new layer', 'Copy the area to a new layer', !has, () => marqueeOp('copy')));
    add(actionButton('Cut to new layer', 'Move the area to a new layer', !has, () => marqueeOp('cut')));
    add(actionButton('Erase', 'Delete the pixels in the area (Delete key)', !has, () => marqueeOp('erase')));
    add(actionButton('Deselect', 'Remove the area (Esc)', !has, () => { marq = null; renderToolOptions(); renderMaskRow(); render(); }));
    if (!has) add(el('span', 'opt-hint', 'Click a colour on the layer. Hold Shift to add more.'));
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
      dash: d.dash,
      gkind: d.gkind, gc1: d.gc1, gc2: d.gc2, gangle: d.gangle, gfade: d.gfade,
      x: Math.round(p.x),
      y: Math.round(p.y),
      width: 1,
      height: 1,
      opacity: 1,
      visible: true,
    };
    if (l.shape === 'line') {
      l.stroke = d.stroke || d.fill || '#111111';
      l.strokeWidth = Math.max(2, d.strokeWidth);
      l.fill = '';
    }
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
    if (l.shape === 'line') {
      l.flipX = w < 0; // a line remembers which way it was dragged
      l.flipY = h < 0;
    }
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
      dash: dflt.dash,
      gkind: dflt.gkind, gc1: dflt.gc1, gc2: dflt.gc2, gangle: dflt.gangle, gfade: dflt.gfade,
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
    if (tool === 'select' && isMulti() && (abPlusAt(p) || abLabelAt(p))) {
      const plus = abPlusAt(p);
      if (plus) addArtboard(activeAb(), e.shiftKey, plus);
      else pickArtboard(e, p, abLabelAt(p));
    } else if (tool === 'select') {
      if (isMulti() && !hitTest(p)) {
        const a = abAt(p);
        if (a && a.id !== activeAbId) { activeAbId = a.id; renderToolOptions(); }
      }
      downSelect(e, p);
    }
    else if (tool === 'marquee') downMarquee(e, p);
    else if (tool === 'wand') downWand(e, p);
    else if (tool === 'text') downText(e, p);
    else if (tool === 'shape') downShape(e, p);
    else if (tool === 'pen') downPen(e, p);
    else if (tool === 'crop') downCrop(e, p);
    else if (tool === 'brush' || tool === 'eraser') downPaint(e, p, tool);
    else if (tool === 'bucket') downBucket(e, p);
    else if (tool === 'gradient') downGradient(e, p);
    else if (tool === 'eyedropper') downEyedropper(e, p);
    else if (tool === 'warp') downWarp(e, p);
    else if (tool === 'cutout') pickCutoutColor(p);
    else if (tool === 'artboard') downArtboard(e, p);
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = toDoc(e);
    if (!drag) {
      updateCursor(p);
      if (tool === 'artboard') {
        const cur = activeAb();
        const h = cur ? abHandleAt(cur, p) : null;
        const map = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
        canvas.style.cursor = map[h] || (abAt(p) ? 'move' : 'crosshair');
      }
      if (penDraft) {
        penDraft.cur = p;
        scheduleRender();
      }
      if (tool === 'brush' || tool === 'eraser') {
        hoverPt = p;
        scheduleRender();
      } else if (tool === 'crop' && cropBox) {
        cropCursor(p);
      } else if (tool === 'warp') {
        const l = selected();
        canvas.style.cursor = l && l.type === 'image' && warpHandleAt(l, p) ? 'pointer' : 'crosshair';
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
    } else if (drag.mode === 'crop') {
      updateCrop(p);
    } else if (drag.mode === 'warp') {
      const l = getLayer(drag.id);
      if (l) updateWarp(l, p);
    } else if (drag.mode === 'paint') {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (events.length > 1) for (const ev of events) paintTo(toDoc(ev));
      else paintTo(p);
      hoverPt = p;
    } else if (drag.mode === 'gradient') {
      gradDraft.x2 = p.x;
      gradDraft.y2 = p.y;
    } else if (drag.mode === 'eyedrop') {
      sampleColor(p, drag.bg);
    } else if (drag.mode.startsWith('ab')) {
      dragArtboard(p, e);
    }
    render();
  });

  canvas.addEventListener('pointerleave', () => {
    if (hoverPt) {
      hoverPt = null;
      render();
    }
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
      renderMaskRow();
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
    } else if (d.mode === 'crop') {
      renderToolOptions();
      render();
    } else if (d.mode === 'warp') {
      const l = getLayer(d.id);
      if (l && l.warp && l.warp.every((a) => Math.abs(a[0]) < 1e-4 && Math.abs(a[1]) < 1e-4)) l.warp = null;
      commit(d.before);
      renderAll();
    } else if (d.mode === 'paint') {
      commit(d.before);
      renderAll();
    } else if (d.mode === 'gradient') {
      finishGradient();
    } else if (d.mode === 'eyedrop') {
      sampleCanvas = null;
    } else if (d.mode.startsWith('ab')) {
      endArtboardDrag(d);
    }
  }

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // Double-click on text to edit it.
  canvas.addEventListener('dblclick', (e) => {
    if (tool !== 'select') return;
    if (isMulti()) {
      const lab = abLabelAt(toDoc(e));
      if (lab) {
        activeAbId = lab.id;
        abSelected = true;
        sel = [];
        renderSidePanels();
        zoomToRect(lab);
        return;
      }
    }
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
    drawLayerRaw(g, l, 'export', true); // without its mask: the mask stays on the layer
    return { canvas: c, sx, sy };
  }

  function putPixels(l, c) {
    const key = 'img-' + nextImg++;
    images.set(key, c);
    l.type = 'image';
    l.img = key;
    l.adjust = defaultAdjust();
    if (l.mask && (l.flipX || l.flipY)) {
      // the mask was flipped with the picture, so flip its pixels too
      const old = images.get(l.mask.img);
      const mc = document.createElement('canvas');
      mc.width = srcW(old);
      mc.height = srcH(old);
      const mg = mc.getContext('2d');
      mg.translate(l.flipX ? mc.width : 0, l.flipY ? mc.height : 0);
      mg.scale(l.flipX ? -1 : 1, l.flipY ? -1 : 1);
      mg.drawImage(old, 0, 0);
      const mk = 'img-' + nextImg++;
      images.set(mk, mc);
      l.mask.img = mk;
    }
    l.flipX = false; // the flip and any bending are now part of the pixels
    l.flipY = false;
    l.warp = null;
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
    if (l.warp) {
      toast('Reset the bend first, then pick an area.');
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

  // ---------- Flip ----------

  function flipSelected(axis) {
    const ls = selectedLayers();
    if (!ls.length) return;
    change(() => {
      for (const l of ls) {
        if (axis === 'x') l.flipX = !l.flipX;
        else l.flipY = !l.flipY;
      }
    });
  }

  // ---------- Crop ----------

  function cropRatioValue() {
    if (cropRatio === 'free') return null;
    const [a, b] = cropRatio.split('/').map(Number);
    return b ? a / b : a;
  }

  // The area the crop box must stay inside.
  function cropBounds() {
    if (cropTarget === 'layer') {
      const l = getLayer(cropLayerId);
      if (l) return { x: l.x, y: l.y, w: l.width, h: l.height };
    }
    const wr = workRect();
    return { x: wr.x, y: wr.y, w: wr.width, h: wr.height };
  }

  // Starts (or restarts) a crop box around the whole canvas, or around the selected photo.
  function initCrop(keepTarget) {
    const l = selected();
    const photoOk = l && l.type === 'image' && l.visible;
    if (!keepTarget) cropTarget = photoOk ? 'layer' : 'canvas';
    if (cropTarget === 'layer' && !photoOk) cropTarget = 'canvas';
    if (cropTarget === 'layer' && (l.rotation || l.warp)) {
      toast('Set the rotation to 0 and reset any bend first. Cropping the canvas instead.');
      cropTarget = 'canvas';
    }
    cropLayerId = cropTarget === 'layer' ? l.id : null;
    const b = cropBounds();
    cropBox = { x: b.x, y: b.y, w: b.w, h: b.h };
    const r = cropRatioValue();
    if (r) fitCropRatio(cropBox, r, b);
  }

  // Makes the box match the shape, as large as fits inside `b`, around its own middle.
  function fitCropRatio(box, r, b) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    let w = box.w, h = box.w / r;
    if (h > box.h) { h = box.h; w = h * r; }
    box.x = clamp(cx - w / 2, b.x, b.x + b.w - w);
    box.y = clamp(cy - h / 2, b.y, b.y + b.h - h);
    box.w = w;
    box.h = h;
  }

  const CROP_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  function cropHandlePos(b, name) {
    const x = name.includes('w') ? b.x : name.includes('e') ? b.x + b.w : b.x + b.w / 2;
    const y = name.includes('n') ? b.y : name.includes('s') ? b.y + b.h : b.y + b.h / 2;
    return { x, y };
  }

  function cropHandleAt(p) {
    if (!cropBox) return null;
    const reach = (HANDLE_PX * 0.9) / viewScale;
    for (const n of CROP_HANDLES) {
      const h = cropHandlePos(cropBox, n);
      if (Math.abs(p.x - h.x) <= reach && Math.abs(p.y - h.y) <= reach) return n;
    }
    if (p.x >= cropBox.x && p.x <= cropBox.x + cropBox.w && p.y >= cropBox.y && p.y <= cropBox.y + cropBox.h) return 'move';
    return 'new';
  }

  function downCrop(e, p) {
    if (!cropBox) initCrop(false);
    const handle = cropHandleAt(p);
    startDrag(e, { mode: 'crop', handle, start: p, orig: { ...cropBox } });
  }

  function updateCrop(p) {
    const B = cropBounds();
    const d = drag;
    const o = d.orig;
    const r = cropRatioValue();
    const MIN = 8;
    const cx = (v) => clamp(v, B.x, B.x + B.w);
    const cy = (v) => clamp(v, B.y, B.y + B.h);
    let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;

    if (d.handle === 'move') {
      const w = o.w, h = o.h;
      x1 = clamp(o.x + (p.x - d.start.x), B.x, B.x + B.w - w);
      y1 = clamp(o.y + (p.y - d.start.y), B.y, B.y + B.h - h);
      cropBox = { x: x1, y: y1, w, h };
      return;
    }

    if (d.handle === 'new') {
      x1 = cx(d.start.x); y1 = cy(d.start.y);
      x2 = cx(p.x); y2 = cy(p.y);
      let w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
      if (r) {
        if (w / Math.max(h, 1e-6) > r) w = h * r; else h = w / r;
      }
      const sx = x2 >= x1 ? 1 : -1, sy = y2 >= y1 ? 1 : -1;
      const ax = x1, ay = y1;
      const nx = ax + sx * w, ny = ay + sy * h;
      cropBox = { x: Math.min(ax, nx), y: Math.min(ay, ny), w: Math.max(w, 1), h: Math.max(h, 1) };
      return;
    }

    const hd = d.handle;
    if (hd.includes('w')) x1 = Math.min(cx(p.x), x2 - MIN);
    if (hd.includes('e')) x2 = Math.max(cx(p.x), x1 + MIN);
    if (hd.includes('n')) y1 = Math.min(cy(p.y), y2 - MIN);
    if (hd.includes('s')) y2 = Math.max(cy(p.y), y1 + MIN);

    if (r) {
      let w = x2 - x1, h = y2 - y1;
      if (hd.length === 2) {
        if (w / h > r) w = h * r; else h = w / r;
        if (hd.includes('w')) x1 = x2 - w; else x2 = x1 + w;
        if (hd.includes('n')) y1 = y2 - h; else y2 = y1 + h;
      } else if (hd === 'e' || hd === 'w') {
        h = w / r;
        const mid = o.y + o.h / 2;
        if (h > B.h) { h = B.h; w = h * r; if (hd === 'w') x1 = x2 - w; else x2 = x1 + w; }
        y1 = clamp(mid - h / 2, B.y, B.y + B.h - h);
        y2 = y1 + h;
      } else {
        w = h * r;
        const mid = o.x + o.w / 2;
        if (w > B.w) { w = B.w; h = w / r; if (hd === 'n') y1 = y2 - h; else y2 = y1 + h; }
        x1 = clamp(mid - w / 2, B.x, B.x + B.w - w);
        x2 = x1 + w;
      }
    }
    cropBox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function cropCursor(p) {
    const h = cropHandleAt(p);
    const map = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move', new: 'crosshair' };
    canvas.style.cursor = map[h] || 'crosshair';
  }

  function drawCropOverlay() {
    const b = cropBox;
    const s = 1 / viewScale;
    const d = state.doc;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, d.width, d.height);
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.fill('evenodd');
    ctx.lineWidth = 1.5 * s;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.lineWidth = s;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath();
    for (let k = 1; k <= 2; k++) {
      ctx.moveTo(b.x + (b.w * k) / 3, b.y); ctx.lineTo(b.x + (b.w * k) / 3, b.y + b.h);
      ctx.moveTo(b.x, b.y + (b.h * k) / 3); ctx.lineTo(b.x + b.w, b.y + (b.h * k) / 3);
    }
    ctx.stroke();
    const size = HANDLE_PX * s;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    for (const n of CROP_HANDLES) {
      const h = cropHandlePos(b, n);
      ctx.fillRect(h.x - size / 2, h.y - size / 2, size, size);
      ctx.strokeRect(h.x - size / 2, h.y - size / 2, size, size);
    }
    ctx.restore();
  }

  function applyCrop() {
    if (!cropBox) return;
    const b = { x: Math.round(cropBox.x), y: Math.round(cropBox.y), w: Math.round(cropBox.w), h: Math.round(cropBox.h) };
    if (b.w < 2 || b.h < 2) return;

    if (cropTarget === 'layer') {
      const l = getLayer(cropLayerId);
      if (!l || l.type !== 'image') return;
      const img = images.get(l.img);
      // Which part of the real picture is inside the box (the picture may be flipped).
      let u1 = (cropBox.x - l.x) / l.width, u2 = (cropBox.x + cropBox.w - l.x) / l.width;
      let v1 = (cropBox.y - l.y) / l.height, v2 = (cropBox.y + cropBox.h - l.y) / l.height;
      if (l.flipX) [u1, u2] = [1 - u2, 1 - u1];
      if (l.flipY) [v1, v2] = [1 - v2, 1 - v1];
      const sx = Math.round(u1 * srcW(img)), sy = Math.round(v1 * srcH(img));
      const sw = Math.max(1, Math.round((u2 - u1) * srcW(img))), sh = Math.max(1, Math.round((v2 - v1) * srcH(img)));
      const out = document.createElement('canvas');
      out.width = sw;
      out.height = sh;
      out.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      // the mask is cropped to the same part
      let croppedMask = null;
      if (l.mask && images.get(l.mask.img)) {
        const mm = images.get(l.mask.img);
        const mx1 = (cropBox.x - l.x) / l.width, mx2 = (cropBox.x + cropBox.w - l.x) / l.width;
        const my1 = (cropBox.y - l.y) / l.height, my2 = (cropBox.y + cropBox.h - l.y) / l.height;
        const msx = Math.round(mx1 * srcW(mm)), msy = Math.round(my1 * srcH(mm));
        const msw = Math.max(1, Math.round((mx2 - mx1) * srcW(mm))), msh = Math.max(1, Math.round((my2 - my1) * srcH(mm)));
        croppedMask = document.createElement('canvas');
        croppedMask.width = msw;
        croppedMask.height = msh;
        croppedMask.getContext('2d').drawImage(mm, msx, msy, msw, msh, 0, 0, msw, msh);
      }
      change(() => {
        const key = 'img-' + nextImg++;
        images.set(key, out);
        l.img = key; // Camera Raw settings and flips stay as they were
        l.x = b.x; l.y = b.y; l.width = b.w; l.height = b.h;
        if (croppedMask) {
          const mk = 'img-' + nextImg++;
          images.set(mk, croppedMask);
          l.mask.img = mk;
        }
      });
    } else {
      if (isMulti()) {
        // Cropping an artboard: only the page changes, layers stay where they are.
        const a = activeAb();
        change(() => {
          a.x = b.x; a.y = b.y;
          a.width = b.w; a.height = b.h;
          fitPasteboard();
        });
        cropBox = null;
        setTool('select');
        return;
      }
      change(() => {
        const d = state.doc;
        d.width = clamp(b.w, 1, MAX_DOC);
        d.height = clamp(b.h, 1, MAX_DOC);
        d.autoSize = false;
        for (const l of state.layers) { l.x -= b.x; l.y -= b.y; }
      });
    }
    cropBox = null;
    setTool('select');
  }

  // ---------- Skew, perspective, distort ----------

  // Photos can be bent. Anything else is first turned into a picture.
  function prepareWarp() {
    const l = selected();
    if (!l || l.type === 'image') return;
    if (l.rotation) { toast('Set the rotation to 0 first (Design tab), then bend it.'); return; }
    change(() => {
      const r = rasterize(l);
      putPixels(l, r.canvas);
    });
    toast('Turned into a picture so it can be bent.');
  }

  function warpHandles(l) {
    const q = quadCorners(l);
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const list = warpMode === 'skew'
      ? [['n', mid(q[0], q[1])], ['e', mid(q[1], q[2])], ['s', mid(q[2], q[3])], ['w', mid(q[3], q[0])]]
      : q.map((c, i) => ['c' + i, c]);
    return list.map(([name, pt]) => ({ name, ...fromLocal(l, pt) }));
  }

  function warpHandleAt(l, p) {
    const reach = (HANDLE_PX * 1.0) / viewScale;
    for (const h of warpHandles(l)) {
      if (Math.abs(p.x - h.x) <= reach && Math.abs(p.y - h.y) <= reach) return h.name;
    }
    return null;
  }

  function downWarp(e, p) {
    let l = selected();
    if (l && l.type === 'image' && l.visible) {
      const handle = warpHandleAt(l, p);
      if (handle) {
        const before = snapshot();
        if (!l.warp) l.warp = NO_WARP();
        startDrag(e, {
          mode: 'warp', id: l.id, handle, before,
          start: l.rotation ? toLocal(l, p) : p,
          orig: l.warp.map((a) => a.slice()),
        });
        return;
      }
    }
    const hit = hitTest(p);
    if (hit) {
      sel = [hit.id];
      prepareWarp();
      renderSidePanels();
      render();
    }
  }

  function updateWarp(l, p) {
    const d = drag;
    const q = l.rotation ? toLocal(l, p) : p;
    const dx = (q.x - d.start.x) / l.width;
    const dy = (q.y - d.start.y) / l.height;
    const w = d.orig.map((a) => a.slice());
    const hd = d.handle;
    const LIM = 3;
    if (hd[0] === 'c') {
      const i = Number(hd[1]);
      w[i][0] += dx;
      w[i][1] += dy;
      if (warpMode === 'perspective') {
        w[[1, 0, 3, 2][i]][0] -= dx; // the corner next to it, along the same top or bottom edge
        w[[3, 2, 1, 0][i]][1] -= dy; // the corner next to it, along the same left or right edge
      }
    } else if (hd === 'n') { w[0][0] += dx; w[1][0] += dx; }
    else if (hd === 's') { w[2][0] += dx; w[3][0] += dx; }
    else if (hd === 'w') { w[0][1] += dy; w[3][1] += dy; }
    else if (hd === 'e') { w[1][1] += dy; w[2][1] += dy; }
    l.warp = w.map((a) => [clamp(a[0], -LIM, LIM), clamp(a[1], -LIM, LIM)]);
  }

  function drawWarpOverlay() {
    const l = selected();
    if (!l || l.type !== 'image' || !l.visible) return;
    const s = 1 / viewScale;
    const q = quadCorners(l);
    ctx.save();
    ctx.translate(l.x + l.width / 2, l.y + l.height / 2);
    ctx.rotate(radOf(l));
    ctx.translate(-(l.x + l.width / 2), -(l.y + l.height / 2));
    ctx.lineWidth = 1.5 * s;
    ctx.strokeStyle = colors.accent;
    ctx.beginPath();
    q.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
    const size = HANDLE_PX * s;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2 * s;
    for (const h of warpHandles(l)) {
      ctx.beginPath();
      if (warpMode === 'skew') ctx.rect(h.x - size / 2, h.y - size / 2, size, size);
      else ctx.arc(h.x, h.y, size * 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function resetWarp() {
    const ls = selectedLayers().filter((l) => l.warp);
    if (!ls.length) return;
    change(() => { for (const l of ls) l.warp = null; });
  }

  // ---------- Painting: brush, eraser, paint bucket, gradient, eyedropper ----------

  function newPaintLayer() {
    const wr = workRect();
    const c = document.createElement('canvas');
    c.width = wr.width;
    c.height = wr.height;
    const key = 'img-' + nextImg++;
    images.set(key, c);
    const l = {
      id: 'layer-' + nextId++, type: 'image', img: key, name: 'Paint',
      x: wr.x, y: wr.y, width: c.width, height: c.height, opacity: 1, visible: true, adjust: defaultAdjust(),
    };
    const at = selected() ? state.layers.indexOf(selected()) + 1 : state.layers.length;
    state.layers.splice(at, 0, l);
    sel = [l.id];
    return l;
  }

  // Finds the layer a painting tool should work on, and makes one when it has to.
  // Call it before the undo snapshot is saved, so one Undo puts everything back.
  function paintTarget(mode) {
    const l = selected();
    const clean = l && l.visible && l.type === 'image' && isDefaultAdjust(l.adjust) && !l.rotation && !l.warp;
    if (mode === 'brush') {
      const img = clean ? images.get(l.img) : null;
      const huge = img && srcW(img) * srcH(img) > 12e6; // keep strokes quick on very big photos
      if (clean && !huge) return l;
      return newPaintLayer();
    }
    if (!l || !l.visible) {
      toast('Click a layer first.');
      return null;
    }
    if (l.rotation) {
      toast('Set the rotation back to 0 first (Design tab).');
      return null;
    }
    if (l.warp) {
      toast('Reset the bend first (Design tab).');
      return null;
    }
    if (!clean) {
      const r = rasterize(l); // text, shapes and Camera Raw edits become plain pixels
      putPixels(l, r.canvas);
      toast('This layer was turned into plain pixels so it can be painted on.');
    }
    return l;
  }

  function makeDab(diameter, hardness, color) {
    const D = Math.max(2, Math.ceil(diameter) + 2);
    const c = document.createElement('canvas');
    c.width = D;
    c.height = D;
    const g = c.getContext('2d');
    const r = diameter / 2;
    const m = D / 2;
    if (hardness >= 99) {
      g.fillStyle = color;
      g.beginPath();
      g.arc(m, m, Math.max(r, 0.5), 0, Math.PI * 2);
      g.fill();
    } else {
      const grad = g.createRadialGradient(m, m, 0, m, m, Math.max(r, 0.5));
      grad.addColorStop(0, withAlpha(color, 1));
      grad.addColorStop(Math.max(0, hardness / 100), withAlpha(color, 1));
      grad.addColorStop(1, withAlpha(color, 0));
      g.fillStyle = grad;
      g.fillRect(0, 0, D, D);
    }
    return c;
  }

  // Painting on a layer's mask: black hides, white shows. (The Eraser always hides.)
  function downMaskPaint(e, p, mode) {
    const l = selected();
    const before = snapshot();
    const c = freshMask(l);
    const base = copyCanvas(c);
    const stroke = document.createElement('canvas');
    stroke.width = c.width;
    stroke.height = c.height;
    const o = brushOpts[mode];
    const sc = c.width / l.width;
    const diameter = Math.max(1, o.size * sc);
    const hide = mode === 'eraser' || lumaOf(paint.fg) < 0.5;
    startDrag(e, {
      mode: 'paint', mask: true, erase: hide, id: l.id, canvas: c, base, stroke,
      sprite: makeDab(diameter, o.hardness, hide ? '#000000' : '#ffffff'),
      sx: sc, sy: c.height / l.height, opacity: o.opacity / 100, spacing: Math.max(0.5, diameter * 0.12),
      last: null, carry: 0, before,
    });
    paintTo(p);
  }

  function downPaint(e, p, mode) {
    if (maskEditing()) { downMaskPaint(e, p, mode); return; }
    const before = snapshot();
    const l = paintTarget(mode === 'eraser' ? 'edit' : 'brush');
    if (!l) return;
    const r = rasterize(l); // a fresh copy, so Undo can go back to the old pixels
    putPixels(l, r.canvas);
    const o = brushOpts[mode];
    const base = document.createElement('canvas');
    base.width = r.canvas.width;
    base.height = r.canvas.height;
    base.getContext('2d').drawImage(r.canvas, 0, 0);
    const stroke = document.createElement('canvas');
    stroke.width = r.canvas.width;
    stroke.height = r.canvas.height;
    const diameter = Math.max(1, o.size * r.sx);
    startDrag(e, {
      mode: 'paint', erase: mode === 'eraser', id: l.id, canvas: r.canvas, base, stroke,
      sprite: makeDab(diameter, o.hardness, mode === 'eraser' ? '#000000' : paint.fg),
      sx: r.sx, sy: r.sy, opacity: o.opacity / 100, spacing: Math.max(0.5, diameter * 0.12),
      last: null, carry: 0, before,
    });
    sel = [l.id];
    renderPanel();
    renderOpacity();
    paintTo(p);
  }

  function paintTo(p) {
    const d = drag;
    const l = getLayer(d.id);
    if (!l) return;
    let x = (p.x - l.x) * d.sx;
    let y = (p.y - l.y) * d.sy;
    if (d.mask) {
      const q = docToMask(l, d.canvas, p);
      x = q.x;
      y = q.y;
    }
    const g = d.stroke.getContext('2d');
    const r = d.sprite.width / 2;
    let x1 = x - r, y1 = y - r, x2 = x + r, y2 = y + r;
    if (!d.last) {
      g.drawImage(d.sprite, x - r, y - r);
    } else {
      const dx = x - d.last.x, dy = y - d.last.y;
      const len = Math.hypot(dx, dy);
      let t = d.spacing - d.carry;
      let n = 0;
      while (t <= len) {
        const px = d.last.x + (dx * t) / len, py = d.last.y + (dy * t) / len;
        g.drawImage(d.sprite, px - r, py - r);
        x1 = Math.min(x1, px - r); y1 = Math.min(y1, py - r);
        x2 = Math.max(x2, px + r); y2 = Math.max(y2, py + r);
        t += d.spacing;
        n++;
      }
      d.carry = d.carry + len - n * d.spacing;
      x1 = Math.min(x1, d.last.x - r); y1 = Math.min(y1, d.last.y - r);
      x2 = Math.max(x2, d.last.x + r); y2 = Math.max(y2, d.last.y + r);
    }
    d.last = { x, y };

    // Redraw only the part that changed: the old pixels, then the stroke on top.
    const W = d.canvas.width, H = d.canvas.height;
    const rx = clamp(Math.floor(x1) - 1, 0, W), ry = clamp(Math.floor(y1) - 1, 0, H);
    const rw = clamp(Math.ceil(x2) + 1, 0, W) - rx, rh = clamp(Math.ceil(y2) + 1, 0, H) - ry;
    if (rw <= 0 || rh <= 0) return;
    const c = d.canvas.getContext('2d');
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.clearRect(rx, ry, rw, rh);
    c.drawImage(d.base, rx, ry, rw, rh, rx, ry, rw, rh);
    c.globalCompositeOperation = d.erase ? 'destination-out' : 'source-over';
    c.globalAlpha = d.opacity;
    c.drawImage(d.stroke, rx, ry, rw, rh, rx, ry, rw, rh);
    c.restore();
  }

  // Colors: pick one pixel from the finished artwork.
  function sampleColor(p, toBackground) {
    const d = state.doc;
    if (!sampleCanvas) {
      sampleCanvas = document.createElement('canvas');
      sampleCanvas.width = d.width;
      sampleCanvas.height = d.height;
      paintDocument(sampleCanvas.getContext('2d', { willReadFrequently: true }), true, 'preview');
    }
    const x = clamp(Math.floor(p.x), 0, d.width - 1);
    const y = clamp(Math.floor(p.y), 0, d.height - 1);
    const px = sampleCanvas.getContext('2d').getImageData(x, y, 1, 1).data;
    const hex = '#' + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (toBackground) paint.bg = hex;
    else paint.fg = hex;
    if (swatchInputs.fg) swatchInputs.fg.value = paint.fg;
    if (swatchInputs.bg) swatchInputs.bg.value = paint.bg;
  }

  function downEyedropper(e, p) {
    sampleCanvas = null;
    sampleColor(p, e.altKey);
    startDrag(e, { mode: 'eyedrop', bg: e.altKey });
  }

  // Paint bucket: fill the area of similar color that was clicked.
  function floodMask(img, x0, y0, tol, contiguous) {
    const { data, width: w, height: h } = img;
    const i0 = (y0 * w + x0) * 4;
    const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2], a0 = data[i0 + 3];
    const match = (i) => {
      const a = data[i + 3];
      if (a0 === 0 && a === 0) return true;
      return Math.max(Math.abs(data[i] - r0), Math.abs(data[i + 1] - g0), Math.abs(data[i + 2] - b0), Math.abs(a - a0)) <= tol;
    };
    const mask = new Uint8Array(w * h);
    if (!contiguous) {
      for (let p = 0; p < w * h; p++) if (match(p * 4)) mask[p] = 1;
      return mask;
    }
    const stack = [x0, y0];
    while (stack.length) {
      const y = stack.pop();
      let x = stack.pop();
      while (x >= 0 && !mask[y * w + x] && match((y * w + x) * 4)) x--;
      x++;
      let up = false, down = false;
      while (x < w && !mask[y * w + x] && match((y * w + x) * 4)) {
        mask[y * w + x] = 1;
        if (y > 0) {
          const m = !mask[(y - 1) * w + x] && match(((y - 1) * w + x) * 4);
          if (m && !up) stack.push(x, y - 1);
          up = m;
        }
        if (y < h - 1) {
          const m = !mask[(y + 1) * w + x] && match(((y + 1) * w + x) * 4);
          if (m && !down) stack.push(x, y + 1);
          down = m;
        }
        x++;
      }
    }
    return mask;
  }

  function downBucket(e, p) {
    if (maskEditing()) {
      toast('You are painting on the mask. Click the mask picture in the Layers list to go back to the layer.');
      return;
    }
    change(() => {
      const l = paintTarget('edit');
      if (!l) return;
      const r = rasterize(l);
      const g = r.canvas.getContext('2d', { willReadFrequently: true });
      const x = Math.floor((p.x - l.x) * r.sx);
      const y = Math.floor((p.y - l.y) * r.sy);
      const W = r.canvas.width, H = r.canvas.height;
      if (x < 0 || y < 0 || x >= W || y >= H) {
        toast('Click on the selected layer to fill it.');
        return;
      }
      const img = g.getImageData(0, 0, W, H);
      const mask = floodMask(img, x, y, bucketOpts.tolerance, bucketOpts.contiguous);
      // Grow the area by one pixel so soft edges are covered too.
      const grown = new Uint8Array(mask);
      for (let yy = 0; yy < H; yy++) {
        for (let xx = 0; xx < W; xx++) {
          const i = yy * W + xx;
          if (mask[i]) continue;
          if ((xx > 0 && mask[i - 1]) || (xx < W - 1 && mask[i + 1]) || (yy > 0 && mask[i - W]) || (yy < H - 1 && mask[i + W])) grown[i] = 1;
        }
      }
      const [fr, fg, fb] = hexToRgb(paint.fg);
      const a = bucketOpts.opacity / 100;
      const d = img.data;
      for (let i = 0; i < grown.length; i++) {
        if (!grown[i]) continue;
        const k = i * 4;
        const sa = d[k + 3] / 255;
        const oa = a + sa * (1 - a);
        d[k] = (fr * a + d[k] * sa * (1 - a)) / oa;
        d[k + 1] = (fg * a + d[k + 1] * sa * (1 - a)) / oa;
        d[k + 2] = (fb * a + d[k + 2] * sa * (1 - a)) / oa;
        d[k + 3] = oa * 255;
      }
      g.putImageData(img, 0, 0);
      putPixels(l, r.canvas);
    });
  }

  // Gradient: drag across the artwork. It becomes its own layer, so it can be changed later.
  function downGradient(e, p) {
    gradDraft = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    startDrag(e, { mode: 'gradient' });
  }

  function finishGradient() {
    const g = gradDraft;
    gradDraft = null;
    if (!g || Math.hypot(g.x2 - g.x1, g.y2 - g.y1) < 3) {
      render();
      return;
    }
    if (maskEditing()) {
      const ml = selected();
      change(() => {
        const c = freshMask(ml);
        const a = docToMask(ml, c, { x: g.x1, y: g.y1 });
        const z = docToMask(ml, c, { x: g.x2, y: g.y2 });
        const cg = c.getContext('2d');
        cg.setTransform(1, 0, 0, 1, 0, 0);
        cg.clearRect(0, 0, c.width, c.height);
        const grad = gradientOpts.kind === 'radial'
          ? cg.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.hypot(z.x - a.x, z.y - a.y))
          : cg.createLinearGradient(a.x, a.y, z.x, z.y);
        grad.addColorStop(0, 'rgba(255,255,255,' + lumaOf(paint.fg) + ')');
        grad.addColorStop(1, 'rgba(255,255,255,' + lumaOf(paint.bg) + ')');
        cg.fillStyle = grad;
        cg.fillRect(0, 0, c.width, c.height);
      });
      return;
    }
    const d = workRect();
    change(() => {
      const l = {
        id: 'layer-' + nextId++, type: 'shape', name: 'Gradient', shape: 'rect',
        fill: '', stroke: '', strokeWidth: 0, radius: 0, dash: 'solid',
        gkind: gradientOpts.kind, gc1: paint.fg, gc2: paint.bg, gfade: gradientOpts.fade, gangle: 90,
        gx1: (g.x1 - d.x) / d.width, gy1: (g.y1 - d.y) / d.height, gx2: (g.x2 - d.x) / d.width, gy2: (g.y2 - d.y) / d.height,
        x: d.x, y: d.y, width: d.width, height: d.height, opacity: 1, visible: true,
      };
      const at = selected() ? state.layers.indexOf(selected()) + 1 : state.layers.length;
      state.layers.splice(at, 0, l);
      sel = [l.id];
    });
  }

  function drawPaintOverlays() {
    const s = 1 / viewScale;
    if (hoverPt && (tool === 'brush' || tool === 'eraser') && !drag) {
      const r = brushOpts[tool].size / 2;
      ctx.save();
      ctx.lineWidth = s;
      ctx.beginPath();
      ctx.arc(hoverPt.x, hoverPt.y, Math.max(r, s), 0, Math.PI * 2);
      ctx.strokeStyle = '#000000';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(hoverPt.x, hoverPt.y, Math.max(r, s) + s, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.restore();
    }
    if (gradDraft) {
      ctx.save();
      ctx.lineWidth = 2 * s;
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(gradDraft.x1, gradDraft.y1);
      ctx.lineTo(gradDraft.x2, gradDraft.y2);
      ctx.stroke();
      ctx.lineWidth = s;
      ctx.strokeStyle = '#000000';
      ctx.stroke();
      ctx.fillStyle = paint.fg;
      ctx.beginPath();
      ctx.arc(gradDraft.x1, gradDraft.y1, 5 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = paint.bg;
      ctx.beginPath();
      ctx.arc(gradDraft.x2, gradDraft.y2, 5 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---------- Remove background ----------
  // Works on the colours around the edge of the picture (or a colour you click), finds the parts that
  // look like that background and joins them to the edge, then hides them with a layer mask.
  // It is not AI: it works best on plain or smooth backgrounds.

  let cutout = null; // { id, before, key, prevMask, work, opts }
  const cutoutOpts = { tolerance: 25, softness: 6, edgesOnly: true, pick: null };

  const srgb2lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };

  function rgbToLab(r, g, b) {
    const R = srgb2lin(r), G = srgb2lin(g), B = srgb2lin(b);
    let x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
    let y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    let z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    x = f(x); y = f(y); z = f(z);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }

  // Returns an alpha picture (white, with the cut-out in its alpha) the size of `img`.
  function computeCutout(img, o) {
    const W = img.width, H = img.height;
    const data = img.data;
    const N = W * H;
    const lab = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const c = rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      lab[i * 3] = c[0]; lab[i * 3 + 1] = c[1]; lab[i * 3 + 2] = c[2];
    }
    // background colours: what you picked, or the main colours found around the edge
    let centres = [];
    if (o.pick) {
      centres = [rgbToLab(o.pick[0], o.pick[1], o.pick[2])];
    } else {
      const ring = [];
      const t = 2;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (x < t || y < t || x >= W - t || y >= H - t) ring.push(y * W + x);
      }
      const K = 3;
      const step = Math.max(1, Math.floor(ring.length / K));
      centres = [];
      for (let k = 0; k < K; k++) {
        const i = ring[Math.min(ring.length - 1, k * step)];
        centres.push([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]);
      }
      for (let it = 0; it < 6; it++) {
        const sum = centres.map(() => [0, 0, 0, 0]);
        for (const i of ring) {
          let best = 0, bd = Infinity;
          for (let k = 0; k < K; k++) {
            const d = Math.hypot(lab[i * 3] - centres[k][0], lab[i * 3 + 1] - centres[k][1], lab[i * 3 + 2] - centres[k][2]);
            if (d < bd) { bd = d; best = k; }
          }
          sum[best][0] += lab[i * 3]; sum[best][1] += lab[i * 3 + 1]; sum[best][2] += lab[i * 3 + 2]; sum[best][3]++;
        }
        centres = centres.map((c, k) => (sum[k][3] ? [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]] : c));
        if (it === 5) {
          // keep only colours that cover a real share of the edge
          centres = centres.filter((c, k) => sum[k][3] >= ring.length * 0.08);
          if (!centres.length) centres = [sum.map((q, k) => [q[3], k]).sort((a, b) => b[0] - a[0])[0]].map(([, k]) => centres[k] || [lab[0], lab[1], lab[2]]);
        }
      }
    }
    // how far each pixel is from the nearest background colour
    const dist = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let m = Infinity;
      for (const c of centres) {
        const d = Math.hypot(lab[i * 3] - c[0], lab[i * 3 + 1] - c[1], lab[i * 3 + 2] - c[2]);
        if (d < m) m = d;
      }
      dist[i] = m;
    }
    const tol = o.tolerance;
    const bg = new Uint8Array(N);
    if (o.edgesOnly) {
      const stack = [];
      const push = (i) => { if (!bg[i] && dist[i] < tol) { bg[i] = 1; stack.push(i); } };
      for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
      for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
      while (stack.length) {
        const i = stack.pop();
        const x = i % W;
        if (x > 0) push(i - 1);
        if (x < W - 1) push(i + 1);
        if (i >= W) push(i - W);
        if (i < N - W) push(i + W);
      }
    } else {
      for (let i = 0; i < N; i++) if (dist[i] < tol) bg[i] = 1;
    }
    // soft edge: pixels just outside the background fade in over a few steps of colour
    let band = bg;
    const reach = 3;
    for (let r = 0; r < reach; r++) {
      const next = new Uint8Array(band);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (band[i]) continue;
        if ((x > 0 && band[i - 1]) || (x < W - 1 && band[i + 1]) || (y > 0 && band[i - W]) || (y < H - 1 && band[i + W])) next[i] = 1;
      }
      band = next;
    }
    const fade = Math.max(1, o.softness * 1.5);
    let alpha = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (bg[i]) alpha[i] = 0;
      else if (band[i]) alpha[i] = Math.min(1, Math.max(0, (dist[i] - tol) / fade));
      else alpha[i] = 1;
    }
    // a little blur so edges are smooth
    const rad = Math.round(o.softness / 4);
    for (let pass = 0; pass < (rad ? 2 : 0); pass++) {
      const tmp = new Float32Array(N);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          let sum = 0, n = 0;
          for (let dy = -rad; dy <= rad; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= H) continue;
            for (let dx = -rad; dx <= rad; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= W) continue;
              sum += alpha[yy * W + xx]; n++;
            }
          }
          tmp[y * W + x] = sum / n;
        }
      }
      alpha = tmp;
    }
    const out = new ImageData(W, H);
    for (let i = 0; i < N; i++) {
      out.data[i * 4] = 255; out.data[i * 4 + 1] = 255; out.data[i * 4 + 2] = 255;
      out.data[i * 4 + 3] = Math.round(alpha[i] * 255);
    }
    return out;
  }

  function runCutout() {
    if (!cutout) return;
    const l = getLayer(cutout.id);
    if (!l) return;
    const o = cutoutOpts;
    const result = computeCutout(cutout.work, o);
    const small = document.createElement('canvas');
    small.width = result.width;
    small.height = result.height;
    small.getContext('2d').putImageData(result, 0, 0);
    const c = newMaskCanvas(l, false);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(small, 0, 0, c.width, c.height);
    if (cutout.prevMask) {
      // keep what an earlier mask already hid
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(cutout.prevMask, 0, 0, c.width, c.height);
    }
    if (cutout.key) images.delete(cutout.key);
    cutout.key = 'img-' + nextImg++;
    images.set(cutout.key, c);
    l.mask = { img: cutout.key, on: true };
    scheduleRender();
  }

  function startCutout() {
    cutout = null;
    const l = selected();
    if (!l || l.type !== 'image' || !l.visible) {
      toast('Click a photo first, then use Remove background.');
      return false;
    }
    if (l.warp) {
      toast('Reset the bend first (Design tab).');
      return false;
    }
    const r = rasterize(l);
    const sc = Math.min(1, 1000 / Math.max(r.canvas.width, r.canvas.height));
    const wc = document.createElement('canvas');
    wc.width = Math.max(1, Math.round(r.canvas.width * sc));
    wc.height = Math.max(1, Math.round(r.canvas.height * sc));
    wc.getContext('2d', { willReadFrequently: true }).drawImage(r.canvas, 0, 0, wc.width, wc.height);
    cutout = {
      id: l.id, before: snapshot(), key: null, work: wc.getContext('2d').getImageData(0, 0, wc.width, wc.height),
      prevMask: l.mask && images.get(l.mask.img) ? copyCanvas(images.get(l.mask.img)) : null,
    };
    cutoutOpts.pick = null;
    maskEditId = null;
    runCutout();
    return true;
  }

  function endCutout(keep) {
    if (!cutout) return;
    const c = cutout;
    cutout = null;
    if (keep) {
      commit(c.before);
    } else {
      if (c.key) images.delete(c.key);
      state = JSON.parse(c.before);
      sel = sel.filter((id) => getLayer(id));
    }
    renderAll();
  }

  function pickCutoutColor(p) {
    if (!cutout) return;
    const l = getLayer(cutout.id);
    if (!l) return;
    const w = cutout.work;
    const x = clamp(Math.floor(((p.x - l.x) / l.width) * w.width), 0, w.width - 1);
    const y = clamp(Math.floor(((p.y - l.y) / l.height) * w.height), 0, w.height - 1);
    const i = (y * w.width + x) * 4;
    cutoutOpts.pick = [w.data[i], w.data[i + 1], w.data[i + 2]];
    runCutout();
    renderToolOptions();
  }

  function cutoutOptions(add) {
    if (!cutout) {
      add(el('span', 'opt-hint', 'Click a photo first.'));
      return;
    }
    const rangeField = (label, key, min, max) => {
      const w = el('span', 'opt-field');
      const input = el('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.value = String(cutoutOpts[key]);
      const out = el('span', 'opt-hint', String(cutoutOpts[key]));
      let timer = 0;
      input.addEventListener('input', () => {
        cutoutOpts[key] = Number(input.value);
        out.textContent = input.value;
        clearTimeout(timer);
        timer = setTimeout(runCutout, 60);
      });
      w.append(el('span', 'opt-label', label), input, out);
      add(w);
    };
    rangeField('Strength', 'tolerance', 3, 80);
    rangeField('Soft edge', 'softness', 0, 20);
    add(seg([{ value: 'edge', label: 'From the edges' }, { value: 'all', label: 'Everywhere' }], cutoutOpts.edgesOnly ? 'edge' : 'all', (v) => {
      cutoutOpts.edgesOnly = v === 'edge';
      runCutout();
      renderToolOptions();
    }));
    const sw = el('span', 'opt-field');
    const dot = el('span', 'cut-dot');
    if (cutoutOpts.pick) dot.style.background = 'rgb(' + cutoutOpts.pick.join(',') + ')';
    dot.title = cutoutOpts.pick ? 'Background colour you picked' : 'Background colour is found from the edges';
    sw.append(dot, el('span', 'opt-hint', cutoutOpts.pick ? 'Picked colour' : 'Click the picture to pick the background colour'));
    add(sw);
    if (cutoutOpts.pick) add(actionButton('Auto', 'Go back to finding the colour from the edges', false, () => { cutoutOpts.pick = null; runCutout(); renderToolOptions(); }));
    add(el('span', 'opt-sep'));
    add(actionButton('Apply', 'Keep the cut-out (it stays as a mask you can paint on)', false, () => { endCutout(true); setTool('select'); }));
    add(actionButton('Cancel', 'Go back', false, () => { endCutout(false); setTool('select'); }));
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
      const wr = workRect();
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
        const s = Math.min(1, wr.width / w, wr.height / h);
        w = Math.max(1, Math.round(w * s));
        h = Math.max(1, Math.round(h * s));
      }

      state.layers.push({
        id,
        type: 'image',
        img: key,
        name: file.name,
        x: Math.round(wr.x + (wr.width - w) / 2),
        y: Math.round(wr.y + (wr.height - h) / 2),
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

  // Sizes in pixels. Print sizes are at 300 dpi. (The biggest side we allow is 8000 px.)
  const PRESET_GROUPS = [
    { name: 'Popular', items: [
      { name: 'Instagram post', w: 1080, h: 1080 },
      { name: 'Instagram story', w: 1080, h: 1920 },
      { name: 'Poster A4 (300 dpi)', w: 2480, h: 3508 },
      { name: 'Poster A3 (300 dpi)', w: 3508, h: 4961 },
      { name: 'YouTube thumbnail', w: 1280, h: 720 },
      { name: 'Wallpaper (Full HD)', w: 1920, h: 1080 },
      { name: 'LinkedIn banner', w: 1584, h: 396 },
    ] },
    { name: 'Print', items: [
      { name: 'A6', w: 1240, h: 1748 },
      { name: 'A5', w: 1748, h: 2480 },
      { name: 'A4', w: 2480, h: 3508 },
      { name: 'A3', w: 3508, h: 4961 },
      { name: 'A2', w: 4961, h: 7016 },
      { name: 'US Letter', w: 2550, h: 3300 },
      { name: 'US Legal', w: 2550, h: 4200 },
      { name: 'Tabloid 11 × 17 in', w: 3300, h: 5100 },
      { name: 'Poster 18 × 24 in', w: 5400, h: 7200 },
      { name: 'Postcard 4 × 6 in', w: 1200, h: 1800 },
      { name: 'Flyer DL', w: 1181, h: 2362 },
      { name: 'Business card', w: 1050, h: 600 },
    ] },
    { name: 'Photo', items: [
      { name: '4 × 6 in', w: 1800, h: 1200 },
      { name: '5 × 7 in', w: 2100, h: 1500 },
      { name: '8 × 10 in', w: 3000, h: 2400 },
      { name: 'Square', w: 3000, h: 3000 },
      { name: '3:2 camera', w: 6000, h: 4000 },
      { name: '4:3 camera', w: 4000, h: 3000 },
      { name: '16:9', w: 3840, h: 2160 },
    ] },
    { name: 'Social', items: [
      { name: 'Instagram post', w: 1080, h: 1080 },
      { name: 'Instagram portrait', w: 1080, h: 1350 },
      { name: 'Instagram / TikTok story', w: 1080, h: 1920 },
      { name: 'Facebook post', w: 1200, h: 630 },
      { name: 'Facebook cover', w: 820, h: 312 },
      { name: 'X (Twitter) post', w: 1600, h: 900 },
      { name: 'X (Twitter) header', w: 1500, h: 500 },
      { name: 'LinkedIn banner', w: 1584, h: 396 },
      { name: 'YouTube thumbnail', w: 1280, h: 720 },
      { name: 'YouTube channel art', w: 2560, h: 1440 },
      { name: 'Pinterest pin', w: 1000, h: 1500 },
    ] },
    { name: 'Web', items: [
      { name: 'Web large', w: 1920, h: 1080 },
      { name: 'Web medium', w: 1366, h: 768 },
      { name: 'Web small', w: 1024, h: 768 },
      { name: 'Laptop', w: 1440, h: 900 },
      { name: 'Desktop 2K', w: 2560, h: 1440 },
      { name: 'Email header', w: 600, h: 200 },
      { name: 'App icon', w: 1024, h: 1024 },
      { name: 'Favicon', w: 512, h: 512 },
    ] },
    { name: 'Mobile', items: [
      { name: 'iPhone 16 Pro', w: 1206, h: 2622 },
      { name: 'iPhone 16 Pro Max', w: 1320, h: 2868 },
      { name: 'iPhone 15', w: 1179, h: 2556 },
      { name: 'iPhone SE', w: 750, h: 1334 },
      { name: 'Android (FHD+)', w: 1080, h: 2400 },
      { name: 'Galaxy S', w: 1440, h: 3120 },
      { name: 'iPad Pro 11 in', w: 1668, h: 2420 },
      { name: 'iPad Pro 13 in', w: 2064, h: 2752 },
      { name: 'iPad', w: 1536, h: 2048 },
    ] },
    { name: 'Video', items: [
      { name: 'HD 720p', w: 1280, h: 720 },
      { name: 'Full HD 1080p', w: 1920, h: 1080 },
      { name: 'Vertical HD', w: 1080, h: 1920 },
      { name: '2K', w: 2048, h: 1080 },
      { name: '4K UHD', w: 3840, h: 2160 },
      { name: 'Cinema 4K', w: 4096, h: 2160 },
      { name: 'Ultrawide', w: 2560, h: 1080 },
    ] },
  ];
  let presetGroup = 0;

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

  const presetTabs = $('preset-tabs');

  function renderPresets() {
    presetTabs.textContent = '';
    PRESET_GROUPS.forEach((g, i) => {
      const t = document.createElement('button');
      t.type = 'button';
      t.textContent = g.name;
      t.className = i === presetGroup ? 'on' : '';
      t.addEventListener('click', () => { presetGroup = i; renderPresets(); });
      presetTabs.append(t);
    });
    presetGrid.textContent = '';
    for (const p of PRESET_GROUPS[presetGroup].items) {
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
    markPreset();
  }
  renderPresets();

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

    const multi = $('new-artboards').checked;
    change(() => {
      state.doc = { name, width, height, background, transparent, autoSize: false };
      delete state.artboards;
      if (multi) {
        const cap = MAX_DOC - 2 * AB_MARGIN;
        state.artboards = [{
          id: 'ab-1', name: 'Artboard 1', x: AB_MARGIN, y: AB_MARGIN,
          width: Math.min(width, cap), height: Math.min(height, cap), background, transparent,
        }];
        state.doc.multi = true;
        state.doc.transparent = false;
        fitPasteboard();
        activeAbId = 'ab-1';
      }
      state.layers = [];
      sel = [];
    });
    fitToScreen();
    render();
    drawRulers();
  });

  // ---------- Artboard tool ----------

  const nextAbId = () => 'ab-' + (Math.max(0, ...abList().map((a) => Number(a.id.slice(3)) || 0)) + 1);
  const AB_MIN = 16;
  const AB_TOP = 40; // room above an artboard for its name tab
  const AB_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  function abHandlePos(a, name) {
    const x = name.includes('w') ? a.x : name.includes('e') ? a.x + a.width : a.x + a.width / 2;
    const y = name.includes('n') ? a.y : name.includes('s') ? a.y + a.height : a.y + a.height / 2;
    return { x, y };
  }

  function abHandleAt(a, p) {
    const reach = (HANDLE_PX * 0.9) / viewScale;
    for (const h of AB_HANDLES) {
      const q = abHandlePos(a, h);
      if (Math.abs(p.x - q.x) <= reach && Math.abs(p.y - q.y) <= reach) return h;
    }
    return null;
  }

  // Makes the canvas the right size while an artboard is being dragged.
  function growCanvasLive() {
    fitPasteboard();
    const d = state.doc;
    if (canvas.width !== d.width || canvas.height !== d.height) {
      canvas.width = d.width;
      canvas.height = d.height;
      applyScale();
    }
  }

  function ownedLayers(a) {
    return state.layers.filter((l) => abOf(l) === a);
  }

  function cloneLayer(l) {
    const c = JSON.parse(JSON.stringify(l));
    c.id = 'layer-' + nextId++;
    if (c.type === 'image') {
      const im = images.get(l.img);
      if (im) {
        const cv = document.createElement('canvas');
        cv.width = srcW(im);
        cv.height = srcH(im);
        cv.getContext('2d').drawImage(im, 0, 0);
        const key = 'img-' + nextImg++;
        images.set(key, cv);
        c.img = key;
      }
    }
    if (c.mask) {
      const mm = images.get(l.mask.img);
      if (mm) {
        const key = 'img-' + nextImg++;
        images.set(key, copyCanvas(mm));
        c.mask.img = key;
      } else {
        c.mask = null;
      }
    }
    return c;
  }

  const overlaps = (r, list) => list.some((o) => r.x < o.x + o.width + AB_GAP / 2 && r.x + r.width > o.x - AB_GAP / 2 && r.y < o.y + o.height + AB_GAP / 2 && r.y + r.height > o.y - AB_GAP / 2);

  // A free place next to `base`: to its right, or below it.
  function freeSpot(base, dir) {
    const list = abList();
    const r = { x: base.x, y: base.y, width: base.width, height: base.height };
    for (let i = 0; i < 100; i++) {
      if (dir === 'below') r.y += base.height + AB_GAP;
      else r.x += base.width + AB_GAP;
      if (!overlaps(r, list)) break;
    }
    return r;
  }

  // Scrolls the view so a rectangle of the canvas is on screen (only if it is not already).
  function revealRect(r) {
    const wr = workspace.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const x1 = cr.left + r.x * viewScale, y1 = cr.top + r.y * viewScale;
    const x2 = x1 + r.width * viewScale, y2 = y1 + r.height * viewScale;
    if (x1 >= wr.left && x2 <= wr.right && y1 >= wr.top && y2 <= wr.bottom) return;
    workspace.scrollLeft += (x1 + x2) / 2 - (wr.left + wr.right) / 2;
    workspace.scrollTop += (y1 + y2) / 2 - (wr.top + wr.bottom) / 2;
    render();
    drawRulers();
  }

  // Zooms to show one artboard big.
  function zoomToRect(r) {
    const wr = workspace.getBoundingClientRect();
    fitMode = false;
    viewScale = clamp(Math.min((wr.width - 100) / r.width, (wr.height - 200) / r.height), ZOOM_MIN, ZOOM_MAX);
    applyScale();
    const cr = canvas.getBoundingClientRect();
    workspace.scrollLeft += cr.left + (r.x + r.width / 2) * viewScale - (wr.left + wr.width / 2);
    workspace.scrollTop += cr.top + (r.y + r.height / 2) * viewScale - (wr.top + wr.height / 2 + 30);
    render();
    drawRulers();
  }

  // Makes a copy of an artboard (and what is on it). dir: 'right' / 'below' / 'here' (same place).
  // Call inside change(), or between a snapshot and a commit. Returns { ab, ids }.
  function copyArtboard(base, withLayers, dir) {
    const spot = dir === 'here' ? { x: base.x, y: base.y } : freeSpot(base, dir);
    const owned = withLayers ? ownedLayers(base) : [];
    const a = {
      id: nextAbId(),
      name: withLayers ? base.name + ' copy' : 'Artboard ' + (abList().length + 1),
      x: spot.x, y: spot.y, width: base.width, height: base.height,
      background: base.background, transparent: !!base.transparent,
    };
    state.artboards.push(a);
    const ids = [];
    for (const l of owned) {
      const c = cloneLayer(l);
      c.x += a.x - base.x;
      c.y += a.y - base.y;
      state.layers.push(c);
      ids.push(c.id);
    }
    return { ab: a, ids };
  }

  function addArtboard(src, withLayers, dir) {
    const base = src || activeAb();
    if (!base) return;
    const spot = freeSpot(base, dir || 'right');
    if (spot.x + base.width + AB_MARGIN > MAX_DOC || spot.y + base.height + AB_MARGIN > MAX_DOC) {
      toast('No more room on this canvas. Make the artboards smaller, or delete one.');
      return;
    }
    let made;
    change(() => {
      made = copyArtboard(base, withLayers, dir || 'right');
      activeAbId = made.ab.id;
      abSelected = true;
      sel = [];
      fitPasteboard();
    });
    revealRect(made.ab);
    toast('Added "' + made.ab.name + '".');
  }

  function deleteArtboard(a) {
    if (!a) return;
    if (abList().length < 2) {
      toast('Keep at least one artboard.');
      return;
    }
    finishTextEdit();
    change(() => {
      const gone = new Set(ownedLayers(a).map((l) => l.id));
      state.layers = state.layers.filter((l) => !gone.has(l.id));
      sel = sel.filter((id) => !gone.has(id));
      state.artboards = state.artboards.filter((x) => x !== a);
      activeAbId = state.artboards[0].id;
      fitPasteboard();
    });
  }

  function abLabelText(a) { return a.name + '  ' + a.width + ' × ' + a.height; }

  // The name strip above an artboard (click it to pick the artboard, drag it to move it).
  function abLabelAt(p) {
    if (!isMulti()) return null;
    const s = 1 / viewScale;
    ctx.save();
    ctx.font = '600 ' + 13 * s + 'px Inter, system-ui, sans-serif';
    const list = abList();
    let found = null;
    for (let i = list.length - 1; i >= 0 && !found; i--) {
      const a = list[i];
      const w = ctx.measureText(abLabelText(a)).width + 8 * s;
      if (p.x >= a.x && p.x <= a.x + w && p.y >= a.y - 28 * s && p.y <= a.y) found = a;
    }
    ctx.restore();
    return found;
  }

  // The little "+" buttons beside the active artboard.
  function abPlusPos(a) {
    const s = 1 / viewScale;
    const off = Math.max(10 * s, Math.min(26 * s, AB_MARGIN - 14 * s)); // stay on the canvas when zoomed out
    return {
      right: { x: a.x + a.width + off, y: a.y + a.height / 2 },
      below: { x: a.x + a.width / 2, y: a.y + a.height + off },
    };
  }

  function abPlusAt(p) {
    const a = activeAb();
    if (!a || (tool !== 'select' && tool !== 'artboard')) return null;
    const pos = abPlusPos(a);
    const reach = 15 / viewScale;
    for (const dir of ['right', 'below']) if (dist(p, pos[dir]) <= reach) return dir;
    return null;
  }

  // Pick an artboard by its name and drag it. With Alt held, drag a copy instead.
  function pickArtboard(e, p, a) {
    const before = snapshot();
    let target = a;
    let owned = ownedLayers(a);
    if (e.altKey) {
      const made = copyArtboard(a, true, 'here');
      target = made.ab;
      owned = made.ids.map(getLayer).filter(Boolean);
    }
    activeAbId = target.id;
    abSelected = true;
    sel = [];
    renderSidePanels();
    startDrag(e, {
      mode: 'abmove', id: target.id, start: p, before, orig: { x: target.x, y: target.y },
      owned: owned.map((l) => ({ id: l.id, x: l.x, y: l.y })),
    });
    render();
  }

  function downArtboard(e, p) {
    const cur = activeAb();
    const handle = cur ? abHandleAt(cur, p) : null;
    if (handle) {
      startDrag(e, { mode: 'abresize', id: cur.id, handle, before: snapshot(), orig: { x: cur.x, y: cur.y, w: cur.width, h: cur.height } });
      return;
    }
    const plus = abPlusAt(p);
    if (plus) {
      addArtboard(cur, e.shiftKey, plus);
      return;
    }
    const a = abLabelAt(p) || abAt(p);
    if (a) {
      pickArtboard(e, p, a);
      return;
    }
    startDrag(e, { mode: 'abnew', start: p, before: snapshot(), made: null });
  }

  function dragArtboard(p, e) {
    const d = drag;
    if (d.mode === 'abnew') {
      if (!d.made) {
        if (dist(p, d.start) < 8 / viewScale) return;
        d.made = { id: nextAbId(), name: 'Artboard ' + (abList().length + 1), x: 0, y: 0, width: 0, height: 0, background: '#ffffff', transparent: false };
        state.artboards.push(d.made);
        activeAbId = d.made.id;
        abSelected = true;
        sel = [];
      }
      const a = d.made;
      a.x = Math.round(Math.max(0, Math.min(d.start.x, p.x)));
      a.y = Math.round(Math.max(AB_TOP, Math.min(d.start.y, p.y)));
      a.width = Math.max(AB_MIN, Math.round(Math.abs(p.x - d.start.x)));
      a.height = Math.max(AB_MIN, Math.round(Math.abs(p.y - d.start.y)));
      growCanvasLive();
    } else if (d.mode === 'abmove') {
      const a = getAb(d.id);
      if (!a) return;
      const nx = Math.max(0, Math.round(d.orig.x + p.x - d.start.x));
      const ny = Math.max(AB_TOP, Math.round(d.orig.y + p.y - d.start.y));
      const dx = nx - d.orig.x, dy = ny - d.orig.y;
      a.x = nx;
      a.y = ny;
      for (const o of d.owned) {
        const l = getLayer(o.id);
        if (l) { l.x = o.x + dx; l.y = o.y + dy; }
      }
      growCanvasLive();
    } else if (d.mode === 'abresize') {
      const a = getAb(d.id);
      if (!a) return;
      let x1 = d.orig.x, y1 = d.orig.y, x2 = d.orig.x + d.orig.w, y2 = d.orig.y + d.orig.h;
      if (d.handle.includes('w')) x1 = Math.min(Math.max(0, Math.round(p.x)), x2 - AB_MIN);
      if (d.handle.includes('e')) x2 = Math.max(Math.round(p.x), x1 + AB_MIN);
      if (d.handle.includes('n')) y1 = Math.min(Math.max(AB_TOP, Math.round(p.y)), y2 - AB_MIN);
      if (d.handle.includes('s')) y2 = Math.max(Math.round(p.y), y1 + AB_MIN);
      a.x = x1; a.y = y1; a.width = x2 - x1; a.height = y2 - y1;
      growCanvasLive();
    }
  }

  function endArtboardDrag(d) {
    if (d.mode === 'abnew' && !d.made) {
      render();
      return;
    }
    commit(d.before);
    renderAll();
  }

  function drawArtboardOverlay() {
    if (!isMulti()) return;
    const s = 1 / viewScale;
    const act = activeAb();
    ctx.save();
    ctx.font = '600 ' + 13 * s + 'px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    for (const a of abList()) {
      ctx.fillStyle = a === act ? colors.accent : 'rgba(255,255,255,0.75)';
      const label = abLabelText(a);
      ctx.fillText(label, a.x, a.y - 6 * s);
    }
    if (act) {
      ctx.lineWidth = (abSelected ? 4 : 2) * s;
      ctx.strokeStyle = colors.accent;
      ctx.strokeRect(act.x, act.y, act.width, act.height);
      if (!drag && (tool === 'select' || tool === 'artboard')) {
        const pos = abPlusPos(act);
        for (const dir of ['right', 'below']) {
          const c = pos[dir];
          ctx.beginPath();
          ctx.arc(c.x, c.y, 13 * s, 0, Math.PI * 2);
          ctx.fillStyle = colors.accent;
          ctx.fill();
          ctx.lineWidth = 2.5 * s;
          ctx.strokeStyle = '#ffffff';
          ctx.beginPath();
          ctx.moveTo(c.x - 6 * s, c.y); ctx.lineTo(c.x + 6 * s, c.y);
          ctx.moveTo(c.x, c.y - 6 * s); ctx.lineTo(c.x, c.y + 6 * s);
          ctx.stroke();
        }
        ctx.lineWidth = (abSelected ? 4 : 2) * s;
        ctx.strokeStyle = colors.accent;
      }
      if (tool === 'artboard') {
        const hs = HANDLE_PX * s;
        ctx.fillStyle = '#ffffff';
        for (const h of AB_HANDLES) {
          const q = abHandlePos(act, h);
          ctx.fillRect(q.x - hs / 2, q.y - hs / 2, hs, hs);
          ctx.strokeRect(q.x - hs / 2, q.y - hs / 2, hs, hs);
        }
      }
    }
    ctx.restore();
  }

  function artboardOptions(add) {
    const a = activeAb();
    if (!a) return;
    const name = el('input');
    name.type = 'text';
    name.value = a.name;
    name.maxLength = 40;
    name.style.width = '130px';
    name.addEventListener('change', () => change(() => { a.name = name.value.trim().slice(0, 40) || a.name; }));
    const f = (label, node) => {
      const w = el('span', 'opt-field');
      w.append(el('span', 'opt-label', label), node);
      add(w);
    };
    f('Name', name);
    const wIn = numberInput(a.width, AB_MIN, MAX_DOC - 2 * AB_MARGIN, (v) => change(() => { a.width = v; fitPasteboard(); }));
    const hIn = numberInput(a.height, AB_MIN, MAX_DOC - 2 * AB_MARGIN, (v) => change(() => { a.height = v; fitPasteboard(); }));
    wIn.style.width = hIn.style.width = '84px'; // 4-digit sizes need room
    f('Width', wIn);
    f('Height', hIn);
    const bg = el('input');
    bg.type = 'color';
    bg.value = a.background || '#ffffff';
    bg.addEventListener('input', () => { beginEdit(); a.background = bg.value; a.transparent = false; scheduleRender(); });
    bg.addEventListener('change', () => { endEdit(); renderAll(); });
    f('Color', bg);
    const preset = el('select');
    preset.append(new Option('Size…', ''));
    PRESET_GROUPS.forEach((g, gi) => {
      if (g.name === 'Popular') return;
      const og = document.createElement('optgroup');
      og.label = g.name;
      g.items.forEach((pr, i) => og.append(new Option(pr.name + '  ' + pr.w + '×' + pr.h, gi + ':' + i)));
      preset.append(og);
    });
    preset.addEventListener('change', () => {
      const [gi, i] = preset.value.split(':').map(Number);
      const pr = PRESET_GROUPS[gi] && PRESET_GROUPS[gi].items[i];
      if (pr) change(() => { a.width = Math.min(pr.w, MAX_DOC - 2 * AB_MARGIN); a.height = Math.min(pr.h, MAX_DOC - 2 * AB_MARGIN); fitPasteboard(); });
    });
    preset.style.width = '130px';
    add(preset);
    add(el('span', 'opt-sep'));
    add(actionButton('+ Add', 'Add an empty artboard next to this one', false, () => addArtboard(a, false)));
    add(actionButton('Duplicate', 'Copy this artboard with everything on it', false, () => addArtboard(a, true)));
    add(actionButton('Delete', 'Delete this artboard and everything on it', abList().length < 2, () => deleteArtboard(a)));
  }

  // ---------- Export ----------

  const slug = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  async function saveBlob(blob, filename) {
    // In the desktop app, ask where to save (the app window cannot do normal browser downloads).
    const tauri = window.__TAURI__;
    if (tauri && tauri.dialog && tauri.fs) {
      try {
        const path = await tauri.dialog.save({ defaultPath: filename });
        if (path) {
          await tauri.fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
          toast('Saved.');
        }
      } catch (err) {
        toast('Could not save the file: ' + (err && err.message ? err.message : err));
      }
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // A plain .zip with the files stored as they are (pictures are already compressed).
  function makeZip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true);
      head.setUint16(4, 20, true);
      head.setUint16(6, 0x0800, true);
      head.setUint16(8, 0, true);
      head.setUint16(10, time, true);
      head.setUint16(12, date, true);
      head.setUint32(14, crc, true);
      head.setUint32(18, f.data.length, true);
      head.setUint32(22, f.data.length, true);
      head.setUint16(26, name.length, true);
      head.setUint16(28, 0, true);
      parts.push(head.buffer, name, f.data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, time, true);
      cen.setUint16(14, date, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, f.data.length, true);
      cen.setUint32(24, f.data.length, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(cen.buffer, name);
      offset += 30 + name.length + f.data.length;
    }
    const cdSize = central.reduce((n, p) => n + (p.byteLength !== undefined ? p.byteLength : p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  const canvasBlob = (cv, type) => new Promise((resolve) => cv.toBlob(resolve, type, 0.92));

  async function exportImage() {
    const jpeg = $('export-format').value === 'jpeg';
    const type = jpeg ? 'image/jpeg' : 'image/png';
    const ext = jpeg ? 'jpg' : 'png';
    const base = slug(state.doc.name) || 'magicshop-export';

    if (isMulti()) {
      const all = exportScope.value === 'all' && abList().length > 1;
      const list = all ? abList().slice() : [activeAb()];
      const files = [];
      const used = new Set();
      for (const a of list) {
        const out = document.createElement('canvas');
        out.width = a.width;
        out.height = a.height;
        paintArtboard(out.getContext('2d'), a, jpeg, 'export'); // JPG cannot be transparent
        const blob = await canvasBlob(out, type);
        if (!blob) {
          toast('Export failed. An artboard may be too large for this browser.');
          return;
        }
        let nm = slug(a.name) || 'artboard';
        while (used.has(nm)) nm += '-2';
        used.add(nm);
        files.push({ name: nm + '.' + ext, blob });
      }
      if (files.length === 1) {
        saveBlob(files[0].blob, base + '-' + files[0].name);
      } else {
        const data = [];
        for (const f of files) data.push({ name: f.name, data: new Uint8Array(await f.blob.arrayBuffer()) });
        saveBlob(makeZip(data), base + '-artboards.zip');
      }
      return;
    }

    const out = document.createElement('canvas');
    out.width = state.doc.width;
    out.height = state.doc.height;
    paintDocument(out.getContext('2d'), jpeg, 'export'); // JPG cannot be transparent

    const blob = await canvasBlob(out, type);
    if (!blob) {
      toast('Export failed. The image may be too large for this browser.');
      return;
    }
    saveBlob(blob, base + '.' + ext);
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
      if (tool === 'cutout' && cutout) endCutout(true);
      finishTextEdit();
      if (penDraft) finishPen(false, false);
      if (name !== 'marquee' && name !== 'wand') marq = null;
      cropBox = null;
      hoverPt = null;
      gradDraft = null;
    }
    tool = name;
    if (name === 'crop' && !cropBox) initCrop(false);
    if (name === 'warp') prepareWarp();
    if (name === 'cutout') {
      if (!startCutout()) {
        tool = 'select';
        name = 'select';
      }
    }
    workspace.dataset.tool = name;
    canvas.style.cursor = '';
    document.querySelectorAll('.rail-btn[data-tool]').forEach((b) => {
      b.classList.toggle('tool-active', b.dataset.tool === name);
    });
    if (typeof showInGroup === 'function') showInGroup(name);
    if (typeof closeFlyout === 'function') closeFlyout();
    updatePanClasses();
    renderToolOptions();
    renderFloatBar();
    render();
  }

  document.querySelectorAll('.rail-btn[data-tool]').forEach((b) => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });

  // ---------- Tool groups ----------
  // Like Photoshop: tools that belong together share one rail button.
  // The button shows the last tool you used; hold it, right-click it, or click
  // the small corner mark to see the others.
  const TOOL_GROUPS = [
    ['select', 'artboard', 'warp'],
    ['eraser', 'cutout'],
    ['gradient', 'bucket'],
  ];
  const groupOf = {};
  const flyout = el('div', 'tool-flyout');
  flyout.hidden = true;
  document.body.append(flyout);
  let flyGroup = null;

  function closeFlyout() {
    if (!flyGroup) return;
    flyout.hidden = true;
    flyGroup = null;
  }

  function openFlyout(g) {
    flyout.replaceChildren();
    for (const name of g.tools) {
      const src = document.querySelector('.rail-btn[data-tool="' + name + '"]');
      if (src.hidden) continue;
      const m = src.title.match(/^(.*?)\s*\((\w)\b/);
      const item = el('button', 'tool-fly-item' + (name === tool ? ' on' : ''));
      item.type = 'button';
      item.innerHTML = src.innerHTML;
      item.append(el('span', 'tool-fly-name', m ? m[1] : src.title), el('span', 'tool-fly-key', m ? m[2] : ''));
      item.addEventListener('click', () => { closeFlyout(); setTool(name); });
      flyout.append(item);
    }
    const r = g.box.getBoundingClientRect();
    flyout.hidden = false;
    const fw = flyout.offsetWidth, fh = flyout.offsetHeight;
    let left = r.right + 8, top = r.top;
    if (left + fw > innerWidth - 8) { left = Math.max(8, r.left); top = r.bottom + 8; }
    if (top + fh > innerHeight - 8) top = Math.max(8, innerHeight - 8 - fh);
    flyout.style.left = left + 'px';
    flyout.style.top = top + 'px';
    flyGroup = g;
  }

  function showInGroup(name) {
    const g = groupOf[name];
    if (!g) return;
    for (const b of g.btns) b.classList.toggle('g-off', b.dataset.tool !== name);
  }

  for (const tools of TOOL_GROUPS) {
    const btns = tools.map((t) => document.querySelector('.rail-btn[data-tool="' + t + '"]')).filter(Boolean);
    if (btns.length < 2) continue;
    const box = el('div', 'tool-group');
    btns[0].before(box);
    box.append(...btns);
    const caret = el('span', 'tool-caret');
    caret.title = 'More tools';
    box.append(caret);
    const g = { tools, btns, box };
    for (const t of tools) groupOf[t] = g;
    showInGroup(tools[0]);
    const toggle = () => (flyGroup === g ? closeFlyout() : openFlyout(g));
    caret.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
    box.addEventListener('contextmenu', (e) => { e.preventDefault(); openFlyout(g); });
    let hold = 0, held = false;
    box.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      held = false;
      hold = setTimeout(() => { hold = 0; held = true; openFlyout(g); }, 350);
    });
    // after a long press, letting go keeps the list open instead of picking the tool
    box.addEventListener('click', (e) => { if (held) { held = false; e.stopPropagation(); } }, true);
    const stop = () => { if (hold) { clearTimeout(hold); hold = 0; } };
    box.addEventListener('pointerup', stop);
    box.addEventListener('pointerleave', stop);
  }

  document.addEventListener('pointerdown', (e) => {
    if (flyGroup && !flyout.contains(e.target) && !flyGroup.box.contains(e.target)) closeFlyout();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFlyout(); });

  // ---------- Selection commands (Select menu) ----------
  let lastMarq = null;

  function useSelectTool() {
    if (tool !== 'marquee' && tool !== 'wand') {
      const keep = marq;
      setTool('marquee');
      marq = keep;
    }
  }

  function afterSelectChange() {
    renderToolOptions();
    renderMaskRow();
    render();
  }

  function selectAll() {
    useSelectTool();
    const wr = workRect();
    marq = { kind: 'rect', x: wr.x, y: wr.y, w: wr.width, h: wr.height };
    afterSelectChange();
  }

  function deselect() {
    if (marq) lastMarq = marq;
    marq = null;
    afterSelectChange();
  }

  function reselect() {
    if (!lastMarq) return;
    useSelectTool();
    marq = lastMarq;
    afterSelectChange();
  }

  function invertSelection() {
    if (!marq) return;
    useSelectTool();
    if (marq.inv) { marq = marq.inv; afterSelectChange(); return; }
    if (marq.pix) {
      const p = marq.pix;
      const l = getLayer(p.id);
      if (l && l.x === p.x && l.y === p.y) {
        const data = new Uint8Array(p.data.length);
        for (let i = 0; i < data.length; i++) data[i] = p.data[i] ? 0 : 1;
        setWandSelection(l, { sx: p.sx, sy: p.sy }, data, p.w, p.h);
        return;
      }
    }
    // everything on the artwork except the area: the outside goes one way round, the hole the other
    const wr = workRect();
    const path = new Path2D();
    path.rect(wr.x, wr.y, wr.width, wr.height);
    const m = marq;
    if (m.kind === 'ellipse') {
      path.ellipse(m.x + m.w / 2, m.y + m.h / 2, m.w / 2, m.h / 2, 0, 0, Math.PI * 2, true);
    } else {
      path.moveTo(m.x, m.y);
      path.lineTo(m.x, m.y + m.h);
      path.lineTo(m.x + m.w, m.y + m.h);
      path.lineTo(m.x + m.w, m.y);
      path.closePath();
    }
    marq = { kind: 'path', x: wr.x, y: wr.y, w: wr.width, h: wr.height, path, outline: path, inv: m };
    afterSelectChange();
  }

  // Fill the selected area (or the whole layer) with a colour. With no layer picked,
  // it colours the background, like filling the Background layer in Photoshop.
  function fillWith(color) {
    const l = selected();
    if (!l) {
      if (sel.length > 1) { toast('Pick just one layer to fill.'); return; }
      change(() => {
        const a = activeAb() || state.doc;
        a.background = color;
        a.transparent = false;
      });
      return;
    }
    if (!l.visible) { toast('Show the layer first.'); return; }
    if (l.rotation || l.warp) { toast('Set the rotation back to 0 and reset any bend first.'); return; }
    const raster = rasterize(l);
    const g = raster.canvas.getContext('2d');
    g.setTransform(raster.sx, 0, 0, raster.sy, -l.x * raster.sx, -l.y * raster.sy);
    g.fillStyle = color;
    if (marq) g.fill(regionPath(marq));
    else g.fillRect(l.x, l.y, l.width, l.height);
    change(() => putPixels(l, raster.canvas));
  }

  function newEmptyLayer() {
    finishTextEdit();
    change(() => {
      const l = newPaintLayer();
      l.name = 'Layer ' + state.layers.length;
    });
  }

  function layerToEnd(top) {
    const l = selected();
    if (!l) return;
    change(() => {
      const i = state.layers.indexOf(l);
      state.layers.splice(i, 1);
      if (top) state.layers.push(l);
      else state.layers.unshift(l);
    });
  }

  function exportAs(format) {
    $('export-format').value = format;
    $('export-format').dispatchEvent(new Event('change'));
    exportImage();
  }

  // ---------- Menu bar ----------
  // Photoshop's menus, with the same shortcuts. Every item runs something the
  // app already does, so the menus and the buttons always agree.
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const hasLayer = () => !!selected();
  const hasLayers = () => sel.length > 0;
  const hasMask = () => !!(selected() && selected().mask);

  const MENUS = [
    ['File', [
      ['New…', 'Ctrl+N', () => $('btn-new').click()],
      ['Open / Upload image…', 'Ctrl+O', () => fileInput.click()],
      ['Place image…', 'Ctrl+Shift+P', () => fileInput.click()],
      '-',
      ['Export as PNG', 'Ctrl+Alt+Shift+W', () => exportAs('png')],
      ['Export as JPG', '', () => exportAs('jpeg')],
    ]],
    ['Edit', [
      ['Undo', 'Ctrl+Z', () => undo(), () => undoStack.length > 0],
      ['Redo', 'Ctrl+Shift+Z', () => redo(), () => redoStack.length > 0],
      '-',
      ['Fill with foreground', 'Alt+Backspace', () => fillWith(paint.fg)],
      ['Fill with background', 'Ctrl+Backspace', () => fillWith(paint.bg)],
      ['Clear', 'Delete', () => (marq && selected() ? marqueeOp('erase') : deleteLayers(sel.slice())), hasLayers],
      '-',
      ['Free Transform', 'Ctrl+T', () => { setTool('select'); if (!sel.length) toast('Click a layer to transform it.'); }],
      ['Skew / Perspective / Distort', '', () => setTool('warp')],
      ['Flip Horizontal', '', () => flipSelected('x'), hasLayers],
      ['Flip Vertical', '', () => flipSelected('y'), hasLayers],
    ]],
    ['Image', [
      ['Adjustments (Camera Raw)…', '', () => setTab('raw')],
      '-',
      ['Crop', '', () => setTool('crop')],
      ['Remove Background', '', () => setTool('cutout'), hasLayer],
    ]],
    ['Layer', [
      ['New Layer', 'Ctrl+Shift+N', newEmptyLayer],
      ['Duplicate Layer', 'Ctrl+J', () => {
        if (marq && selected()) marqueeOp('copy');
        else if (sel.length) duplicateLayers(sel.slice());
        else if (isMulti() && abSelected) addArtboard(activeAb(), true, 'right');
      }, () => hasLayers() || (isMulti() && abSelected)],
      ['Layer via Cut', 'Ctrl+Shift+J', () => marqueeOp('cut'), () => !!(marq && selected())],
      ['Delete Layer', '', () => deleteLayers(sel.slice()), hasLayers],
      '-',
      ['Mask: Reveal All', '', () => addMask('show'), () => hasLayer() && !hasMask()],
      ['Mask: Hide All', '', () => addMask('hide'), () => hasLayer() && !hasMask()],
      ['Mask: Reveal Selection', '', () => addMask('selection'), () => hasLayer() && !hasMask() && !!marq],
      ['Mask: Invert', '', invertMask, hasMask],
      ['Mask: Turn On / Off', '', toggleMask, hasMask],
      ['Mask: Delete', '', removeMask, hasMask],
      '-',
      ['Bring to Front', 'Ctrl+Shift+]', () => layerToEnd(true), hasLayer],
      ['Bring Forward', 'Ctrl+]', () => moveLayer(sel[0], 1), hasLayer],
      ['Send Backward', 'Ctrl+[', () => moveLayer(sel[0], -1), hasLayer],
      ['Send to Back', 'Ctrl+Shift+[', () => layerToEnd(false), hasLayer],
    ]],
    ['Select', [
      ['All', 'Ctrl+A', selectAll],
      ['Deselect', 'Ctrl+D', deselect, () => !!marq],
      ['Reselect', 'Ctrl+Shift+D', reselect, () => !!lastMarq],
      ['Inverse', 'Ctrl+Shift+I', invertSelection, () => !!marq],
    ]],
    ['Filter', [
      ['Camera Raw Filter…', 'Ctrl+Shift+A', () => setTab('raw')],
    ]],
    ['View', [
      ['Zoom In', 'Ctrl+=', () => zoomBy(1.25)],
      ['Zoom Out', 'Ctrl+-', () => zoomBy(0.8)],
      ['Fit on Screen', 'Ctrl+0', () => { fitToScreen(); render(); drawRulers(); }],
      ['100%', 'Ctrl+1', () => { const r = workspace.getBoundingClientRect(); setZoom(1, r.left + r.width / 2, r.top + r.height / 2); }],
    ]],
    ['Window', [
      ['Layers', 'F7', () => setTab('layers')],
      ['Properties (Design)', '', () => setTab('design')],
      ['Camera Raw', '', () => setTab('raw')],
    ]],
  ];

  // "Ctrl+Shift+]" -> what to show on screen (⌘⇧] on a Mac)
  function keyLabel(k) {
    if (!k) return '';
    if (!IS_MAC) return k;
    return k.replace('Ctrl+', '⌘').replace('Alt+', '⌥').replace('Shift+', '⇧').replace('Backspace', '⌫');
  }

  // The key that was pressed, written the same way as in MENUS.
  function pressedKey(e) {
    const c = e.code;
    let k = c.startsWith('Key') ? c.slice(3) : c.startsWith('Digit') ? c.slice(5)
      : ({ BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-', NumpadAdd: '=', NumpadSubtract: '-' })[c] || e.key;
    if (k.length === 1) k = k.toUpperCase();
    return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + k;
  }

  const shortcutMap = new Map();
  for (const [, items] of MENUS) {
    for (const it of items) {
      if (it === '-' || !it[1] || it[1] === 'Delete') continue; // Delete is already handled by the main key handler
      // store with modifiers in one fixed order: Ctrl, Alt, Shift
      const parts = it[1].split('+');
      const key = parts.pop() || '+';
      const norm = (parts.includes('Ctrl') ? 'Ctrl+' : '') + (parts.includes('Alt') ? 'Alt+' : '') + (parts.includes('Shift') ? 'Shift+' : '') + (key.length === 1 ? key.toUpperCase() : key);
      shortcutMap.set(norm, it);
    }
  }

  const menubar = el('nav', 'menubar');
  menubar.setAttribute('aria-label', 'Menus');
  const menuPop = el('div', 'menu-pop');
  menuPop.hidden = true;
  document.body.append(menuPop);
  let openMenu = null;

  function closeMenu() {
    if (!openMenu) return;
    openMenu.btn.classList.remove('open');
    menuPop.hidden = true;
    openMenu = null;
  }

  function showMenu(btn, items) {
    closeMenu();
    menuPop.replaceChildren();
    for (const it of items) {
      if (it === '-') { menuPop.append(el('div', 'menu-sep')); continue; }
      const [label, keys, run, ok] = it;
      const b = el('button', 'menu-item');
      b.type = 'button';
      b.disabled = ok ? !ok() : false;
      b.append(el('span', 'menu-label', label), el('span', 'menu-key', keyLabel(keys)));
      b.addEventListener('click', () => { closeMenu(); run(); });
      menuPop.append(b);
    }
    const r = btn.getBoundingClientRect();
    menuPop.hidden = false;
    menuPop.style.left = Math.min(r.left, innerWidth - menuPop.offsetWidth - 8) + 'px';
    menuPop.style.top = r.bottom + 4 + 'px';
    btn.classList.add('open');
    openMenu = { btn, items };
  }

  for (const [name, items] of MENUS) {
    const b = el('button', 'menu-btn', name);
    b.type = 'button';
    b.addEventListener('click', () => (openMenu && openMenu.btn === b ? closeMenu() : showMenu(b, items)));
    b.addEventListener('mouseenter', () => { if (openMenu && openMenu.btn !== b) showMenu(b, items); });
    menubar.append(b);
  }
  document.querySelector('.topbar .brand').after(menubar);

  document.addEventListener('pointerdown', (e) => {
    if (openMenu && !menuPop.contains(e.target) && !menubar.contains(e.target)) closeMenu();
  });

  // Runs before the other key handlers, so Photoshop's shortcuts win.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenu) { closeMenu(); e.stopPropagation(); return; }
    if (newDialog.open || fontsDialog.open) return;
    const t = e.target;
    if ((t instanceof HTMLInputElement && t.type !== 'range') || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || (t && t.isContentEditable)) return;
    const it = shortcutMap.get(pressedKey(e));
    if (!it) return;
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    if (it[3] && !it[3]()) return;
    it[2]();
  }, true);

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

  const TOOL_KEYS = { v: 'select', m: 'marquee', c: 'crop', t: 'text', u: 'shape', p: 'pen', b: 'brush', e: 'eraser', k: 'bucket', g: 'gradient', i: 'eyedropper', d: 'warp', h: 'hand', a: 'artboard', x: 'cutout', w: 'wand' };

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
    } else if (tool === 'crop' && cropBox && e.key === 'Enter') {
      applyCrop();
    } else if (tool === 'crop' && e.key === 'Escape') {
      initCrop(true);
      renderToolOptions();
      render();
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
      if (isMulti() && !sel.length && (tool === 'artboard' || (tool === 'select' && abSelected))) deleteArtboard(activeAb());
      else if (marq && selected()) marqueeOp('erase');
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
      if (TOOL_KEYS[key] === 'artboard' && !isMulti()) {
        toast('Make a new file with “Artboards” ticked to use artboards.');
        return;
      }
      let next = TOOL_KEYS[key];
      // Shift + the letter steps through the tools that share a button (like Photoshop)
      const g = e.shiftKey && groupOf[next];
      if (g && g.tools.includes(tool)) {
        const list = g.tools.filter((t) => !document.querySelector('.rail-btn[data-tool="' + t + '"]').hidden);
        next = list[(list.indexOf(tool) + 1) % list.length];
      }
      setTool(next);
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
