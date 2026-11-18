/* Vectorious UI: loading images, settings, worker orchestration, preview. */
(function () {
  'use strict';

  var MAX_WORK_PIXELS = 8e6; // cap on the traced bitmap size, keeps memory sane

  var BASE = { pureColors: false, autoThreshold: false, refine: false, resample: 'smooth', layering: 'stacked', order: 'lightness' };
  var PRESETS = {
    max:          { mode: 'color', colors: 64, scale: 2, blur: 0, speckle: 2, alphamax: 1, opticurve: true, opttolerance: 0.1, pixelExact: false },
    photo:        { mode: 'color', colors: 48, scale: 1, blur: 1, speckle: 12, alphamax: 1, opticurve: true, opttolerance: 0.2, pixelExact: false },
    illustration: { mode: 'color', colors: 16, scale: 1, blur: 0, speckle: 4, alphamax: 1, opticurve: true, opttolerance: 0.2, pixelExact: false },
    // Small, anti-aliased text and icons: a smooth 8x upscale gives the tracer
    // sub-pixel edges, and pure colors drop the blended edge pixels.
    smalltext:    { mode: 'color', colors: 8, pureColors: true, refine: true, scale: 8, resample: 'smooth', blur: 0, speckle: 2, alphamax: 1, opticurve: true, opttolerance: 0.2, pixelExact: false },
    lineart:      { mode: 'bw', threshold: 128, autoThreshold: true, invert: false, bwBackground: true, scale: 2, blur: 0, speckle: 8, alphamax: 1, opticurve: true, opttolerance: 0.2, pixelExact: false },
    pixel:        { mode: 'color', colors: 64, scale: 1, blur: 0, speckle: 0, alphamax: 0, opticurve: false, opttolerance: 0.2, pixelExact: true },
    pixelsmooth:  { mode: 'color', colors: 64, scale: 8, resample: 'scale2x', blur: 0, speckle: 0, alphamax: 0.6, opticurve: true, opttolerance: 0.2, pixelExact: false }
  };
  Object.keys(PRESETS).forEach(function (k) {
    Object.keys(BASE).forEach(function (b) { if (!(b in PRESETS[k])) PRESETS[k][b] = BASE[b]; });
  });
  var SMALL_IMAGE = 400; // longest side in px below which small-text tracing is suggested
  var CONTROL_IDS = ['mode', 'colors', 'pureColors', 'threshold', 'autoThreshold', 'invert', 'bwBackground', 'scale', 'resample', 'blur', 'speckle', 'pixelExact', 'refine', 'alphamax', 'opticurve', 'opttolerance', 'layering', 'order', 'groupBy', 'maxLayers'];

  var GROUP_HINTS = {
    color: 'One layer per color, with similar colors merged.',
    shape: 'Round, rectangular, pointed, thin and complex shapes each get a layer.',
    size: 'Large shapes, medium shapes, small shapes and fine details each get a layer.',
    similar: 'Shapes that look alike in size, outline and color are clustered together.'
  };

  var $ = function (id) { return document.getElementById(id); };
  var els = {};
  ['file', 'sample', 'download', 'copy', 'trace', 'auto', 'preset', 'stage', 'drop', 'canvas', 'imgOriginal', 'imgVector',
   'divider', 'busy', 'busyBar', 'busyText', 'stats', 'palette', 'zoomIn', 'zoomOut', 'zoomFit', 'zoom1', 'zoomLabel',
   'groupBy', 'groupHint', 'layerList', 'layerSummary', 'layersAll', 'layersNone', 'downloadVisible']
    .forEach(function (id) { els[id] = $(id); });

  var state = {
    image: null, name: 'image', w: 0, h: 0,
    origUrl: null, svg: null, svgUrl: null, outlineUrl: null,
    view: 'split', split: 0.5,
    zoom: 1, tx: 0, ty: 0,
    jobId: 0, worker: null, workerOk: typeof Worker !== 'undefined',
    pending: null,
    open: null, layers: [], hidden: {},
    vw: 0, vh: 0,      // size of what the viewer shows (image, or text when there is no image)
    work: 'trace',     // 'trace' | 'text'
    traceResult: null, // last trace, restored when switching back from text
    text: { fit: null, free: true }
  };

  function setCanvasSize(w, h) {
    state.vw = w; state.vh = h;
    els.canvas.style.width = w + 'px';
    els.canvas.style.height = h + 'px';
  }

  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------
  function readOptions() {
    return {
      mode: $('mode').value,
      colors: +$('colors').value,
      pureColors: $('pureColors').checked,
      threshold: +$('threshold').value,
      autoThreshold: $('autoThreshold').checked,
      invert: $('invert').checked,
      bwBackground: $('bwBackground').checked,
      scale: +$('scale').value,
      resample: $('resample').value,
      blur: +$('blur').value,
      speckle: +$('speckle').value,
      pixelExact: $('pixelExact').checked,
      refine: $('refine').checked,
      alphamax: +$('alphamax').value,
      opticurve: $('opticurve').checked,
      opttolerance: +$('opttolerance').value,
      layering: $('layering').value,
      order: $('order').value,
      groupBy: $('groupBy').value,
      maxLayers: +$('maxLayers').value
    };
  }

  function applyPreset(name) {
    var p = PRESETS[name];
    if (!p) return;
    Object.keys(p).forEach(function (k) {
      var el = $(k);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!p[k]; else el.value = p[k];
    });
    refreshControls();
  }

  function refreshControls() {
    var mode = $('mode').value, exact = $('pixelExact').checked, opt = $('opticurve').checked;
    document.querySelectorAll('[data-show]').forEach(function (el) {
      el.hidden = el.getAttribute('data-show').split(' ').indexOf(mode) < 0;
    });
    document.querySelectorAll('[data-curves]').forEach(function (el) {
      el.classList.toggle('disabled-field', exact);
    });
    var groupBy = $('groupBy').value, objectLayers = groupBy !== 'color';
    document.querySelectorAll('[data-stacked]').forEach(function (el) {
      el.classList.toggle('disabled-field', objectLayers || $('layering').value !== 'stacked');
    });
    $('layering').closest('.field').classList.toggle('disabled-field', objectLayers);
    document.querySelectorAll('[data-group]').forEach(function (el) {
      el.hidden = el.getAttribute('data-group').split(' ').indexOf(groupBy) < 0;
    });
    els.groupHint.textContent = GROUP_HINTS[groupBy] +
      (objectLayers ? ' Each shape is traced on its own (cutout), so layers never cover each other.'
        : $('layering').value === 'stacked' ? ' With Stacked layering a layer also fills in under the layers above it. Pick Cutout for layers that stand alone.' : '');
    $('opttolerance').closest('.field').classList.toggle('disabled-field', exact || !opt);
    $('threshold').closest('.field').classList.toggle('disabled-field', $('autoThreshold').checked);
    $('resample').closest('.field').classList.toggle('disabled-field', exact || +$('scale').value <= 1);
    document.querySelectorAll('[data-work="trace"] output[for]').forEach(function (out) {
      var input = $(out.getAttribute('for')), v = +input.value;
      if (input.id === 'scale') out.textContent = Math.round(v * 100) + '%';
      else if (input.id === 'blur') out.textContent = v ? v + ' px' : 'off';
      else if (input.id === 'speckle') out.textContent = v > 1 ? v + ' px' : 'off';
      else if (input.id === 'alphamax') out.textContent = v.toFixed(2);
      else if (input.id === 'opttolerance') out.textContent = v.toFixed(2);
      else out.textContent = String(v);
    });
  }

  var debounceTimer = 0;
  function onControlChange(e) {
    if (e && e.target && e.target.id === 'groupBy') state.hidden = {};
    $('preset').value = 'custom';
    refreshControls();
    saveSettings();
    if ($('auto').checked && state.image) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(trace, e && e.type === 'input' ? 350 : 0);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem('vectorious.settings', JSON.stringify({ preset: $('preset').value, opts: readOptions(), auto: $('auto').checked }));
    } catch (_) { /* storage unavailable */ }
  }
  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem('vectorious.settings') || 'null');
      if (!s) return false;
      Object.keys(s.opts || {}).forEach(function (k) {
        var el = $(k);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!s.opts[k]; else el.value = s.opts[k];
      });
      if (s.preset) $('preset').value = s.preset;
      if (typeof s.auto === 'boolean') $('auto').checked = s.auto;
      return true;
    } catch (_) { return false; }
  }

  // ------------------------------------------------------------------
  // Loading images
  // ------------------------------------------------------------------
  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) { toastStats('That file is not an image.'); return; }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      setImage(img, url, (file.name || 'image').replace(/\.[^.]+$/, ''));
    };
    img.onerror = function () { URL.revokeObjectURL(url); toastStats('Could not decode that image.'); };
    img.src = url;
  }

  function setImage(img, url, name) {
    if (state.origUrl) URL.revokeObjectURL(state.origUrl);
    state.image = img;
    state.origUrl = url;
    state.name = name;
    state.hidden = {};
    state.traceResult = null;
    state.text.anchor = null;
    state.w = img.naturalWidth;
    state.h = img.naturalHeight;
    els.imgOriginal.src = url;
    els.imgVector.removeAttribute('src');
    setCanvasSize(state.w, state.h);
    els.drop.hidden = true;
    els.canvas.hidden = false;
    els.trace.disabled = false;
    fit();
    updateView();
    refreshMatchButtons();
    if (state.work === 'text') renderText(); else trace();
  }

  function makeSample() {
    var c = document.createElement('canvas'), w = 640, h = 420;
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    var bg = g.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#ffe8a3'); bg.addColorStop(1, '#ff8a65');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff6d5';
    g.beginPath(); g.arc(470, 120, 70, 0, Math.PI * 2); g.fill();
    var hills = [['#5e548e', 270, 0.9], ['#3d348b', 320, 1.4], ['#231942', 360, 2.1]];
    hills.forEach(function (hl) {
      g.fillStyle = hl[0];
      g.beginPath(); g.moveTo(0, h);
      for (var x = 0; x <= w; x += 8) g.lineTo(x, hl[1] + Math.sin(x / 70 * hl[2]) * 30 + Math.cos(x / 33) * 8);
      g.lineTo(w, h); g.fill();
    });
    g.fillStyle = '#231942';
    for (var i = 0; i < 6; i++) {
      var tx = 60 + i * 95, ty = 330 + (i % 2) * 18;
      g.beginPath(); g.moveTo(tx, ty - 70); g.lineTo(tx - 22, ty); g.lineTo(tx + 22, ty); g.fill();
    }
    g.fillStyle = '#ffffff';
    g.font = 'bold 56px system-ui, sans-serif';
    g.fillText('Vectorious', 40, 90);
    g.strokeStyle = '#231942'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(40, 110); g.bezierCurveTo(140, 140, 240, 80, 340, 110); g.stroke();
    c.toBlob(function (blob) {
      var file = new File([blob], 'sample.png', { type: 'image/png' });
      loadFile(file);
    }, 'image/png');
  }

  // ------------------------------------------------------------------
  // Tracing (in a Web Worker when possible)
  // ------------------------------------------------------------------
  // Downscaling happens here on a canvas; upscaling is left to the engine,
  // which has deterministic smooth, Scale2x and nearest-neighbour resamplers.
  function getPixels(opts) {
    var scale = Math.min(opts.scale, Math.sqrt(MAX_WORK_PIXELS / (state.w * state.h)));
    var down = Math.min(1, scale);
    var pw = Math.max(1, Math.round(state.w * down)), ph = Math.max(1, Math.round(state.h * down));
    var c = document.createElement('canvas');
    c.width = pw; c.height = ph;
    var g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(state.image, 0, 0, pw, ph);
    var data = g.getImageData(0, 0, pw, ph);
    return { data: data, upscale: scale > 1 ? scale : 1 };
  }

  function trace() {
    if (!state.image || state.work !== 'trace') return;
    var opts = readOptions();
    var id = ++state.jobId;
    var imgData, upscale;
    try { var got = getPixels(opts); imgData = got.data; upscale = got.upscale; } catch (err) { showError(err); return; }
    var traceScale = imgData.width * upscale / state.w; // traced pixels per original pixel
    var options = {
      mode: opts.mode, colors: opts.colors, pureColors: opts.pureColors,
      threshold: opts.threshold, autoThreshold: opts.autoThreshold, invert: opts.invert, bwBackground: opts.bwBackground,
      upscale: upscale, resample: opts.pixelExact ? 'nearest' : opts.resample,
      blur: Math.round(opts.blur * traceScale), // blur radius is in original pixels
      speckle: Math.round(opts.speckle * traceScale * traceScale),
      alphamax: opts.pixelExact ? 0 : opts.alphamax,
      opticurve: opts.opticurve, opttolerance: opts.opttolerance,
      pixelExact: opts.pixelExact, refine: opts.refine, layering: opts.layering, order: opts.order,
      groupBy: opts.groupBy, maxLayers: opts.maxLayers,
      outWidth: state.w, outHeight: state.h
    };
    if (opts.blur > 0 && options.blur < 1) options.blur = 1;
    if (opts.speckle > 1 && options.speckle < 2) options.speckle = 2;
    showBusy('Preparing', 0);
    var started = performance.now();

    if (state.workerOk) {
      if (state.worker && state.pending) { state.worker.terminate(); state.worker = null; }
      if (!state.worker) {
        try { state.worker = new Worker('js/worker.js'); }
        catch (_) { state.workerOk = false; }
      }
    }
    if (state.worker) {
      state.pending = id;
      state.worker.onmessage = function (e) {
        var m = e.data;
        if (m.id !== state.jobId) return;
        if (m.type === 'progress') showBusy(m.stage, m.fraction);
        else if (m.type === 'done') { state.pending = null; onResult(m, imgData, performance.now() - started); }
        else if (m.type === 'error') { state.pending = null; showError(m.message); }
      };
      state.worker.onerror = function (e) {
        // e.g. opened from file:// where workers are blocked: fall back to the main thread.
        e.preventDefault();
        state.worker = null; state.pending = null; state.workerOk = false;
        trace();
      };
      state.worker.postMessage({ id: id, buffer: imgData.data.buffer, width: imgData.width, height: imgData.height, options: options },
        [imgData.data.buffer]);
    } else {
      setTimeout(function () {
        if (id !== state.jobId) return;
        try {
          var r = window.Vectorious.vectorize(imgData, options);
          onResult({ svg: r.svg, open: r.open, layers: r.layers, palette: r.palette, stats: r.stats }, imgData, performance.now() - started);
        } catch (err) { showError(err); }
      }, 30);
    }
  }

  function onResult(m, imgData, elapsed) {
    hideBusy();
    state.traceResult = { m: m, elapsed: elapsed };
    if (state.work !== 'trace') return;
    showTraceResult(m, elapsed);
  }

  function showTraceResult(m, elapsed) {
    state.open = m.open;
    state.layers = m.layers;
    renderLayers();
    rebuildVisible();

    var s = m.stats;
    els.stats.innerHTML =
      '<b>' + state.w + '×' + state.h + '</b> traced at ' + s.width + '×' + s.height +
      ' · <b>' + s.colors + '</b> colors · <b>' + s.layers + '</b> layers · <b>' + s.paths.toLocaleString() + '</b> shapes' +
      (s.segments ? ' · ' + s.segments.toLocaleString() + ' segments' : '') +
      ' · <b>' + formatBytes(s.bytes) + '</b> in all · ' + (elapsed / 1000).toFixed(2) + ' s' +
      (s.threshold != null && $('autoThreshold').checked ? ' · auto threshold ' + s.threshold : '') +
      (s.refined === true ? ' · edges refined' : s.refined ? ' · not refined (' + s.refined + ')' : '') +
      (s.bytes > 25e6 ? ' · <b>Very large file.</b> For photos try the Photo preset, Denoise, or a higher Speckle filter.' : '') +
      (Math.max(state.w, state.h) <= SMALL_IMAGE && +$('scale').value < 4 && !$('pixelExact').checked
        ? ' · Small image: <button type="button" class="linkbtn" id="useSmallText">try the Small text / icon preset</button>' : '');
    var tip = $('useSmallText');
    if (tip) tip.onclick = function () { $('preset').value = 'smalltext'; applyPreset('smalltext'); saveSettings(); trace(); };
    els.palette.innerHTML = '';
    m.palette.slice(0, 128).forEach(function (hex) {
      var i = document.createElement('i');
      i.style.background = hex;
      i.title = hex;
      els.palette.appendChild(i);
    });
  }

  // ------------------------------------------------------------------
  // Layers: visibility and per-layer download
  // ------------------------------------------------------------------
  function visibleLayers() {
    return state.layers.filter(function (l) { return !state.hidden[l.name]; });
  }

  function rebuildVisible() {
    var vis = visibleLayers();
    state.svg = window.Vectorious.buildSvg(state.open, vis);
    if (state.svgUrl) URL.revokeObjectURL(state.svgUrl);
    if (state.outlineUrl) URL.revokeObjectURL(state.outlineUrl);
    state.svgUrl = URL.createObjectURL(new Blob([state.svg], { type: 'image/svg+xml' }));
    state.outlineUrl = null;
    setVectorSrc();
    var none = !vis.length, all = vis.length === state.layers.length;
    els.download.disabled = none;
    els.copy.disabled = none;
    els.downloadVisible.disabled = none;
    els.download.textContent = all ? 'Download SVG' : 'Download visible';
    els.layersAll.disabled = all;
    els.layersNone.disabled = none;
    els.layerSummary.textContent = vis.length + ' of ' + state.layers.length + ' layers shown · ' + formatBytes(state.svg.length);
    els.layerList.querySelectorAll('li').forEach(function (li) {
      var on = !state.hidden[state.layers[+li.getAttribute('data-index')].name];
      li.classList.toggle('off', !on);
      li.querySelector('input').checked = on;
    });
  }

  function renderLayers() {
    els.layerList.innerHTML = '';
    // top of the stack first, like a layers panel in an editor
    for (var i = state.layers.length - 1; i >= 0; i--) {
      var row = layerRow(state.layers[i]);
      row.setAttribute('data-index', i);
      els.layerList.appendChild(row);
    }
  }

  function layerRow(layer) {
    var li = document.createElement('li');
    li.className = 'layer';
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.title = 'Show or hide. Alt-click to show only this layer.';
    box.setAttribute('aria-label', 'Show ' + layer.name);
    box.addEventListener('click', function (e) {
      if (e.altKey) {
        state.layers.forEach(function (l) { state.hidden[l.name] = l !== layer; });
      } else if (box.checked) {
        delete state.hidden[layer.name];
      } else {
        state.hidden[layer.name] = true;
      }
      rebuildVisible();
    });
    var sw = document.createElement('span');
    sw.className = 'swatches';
    layer.colors.slice(0, 5).forEach(function (c) {
      var i = document.createElement('i');
      i.style.background = c;
      sw.appendChild(i);
    });
    if (layer.colors.length > 5) sw.title = layer.colors.length + ' colors';
    var label = document.createElement('span');
    label.className = 'layer-name';
    label.textContent = layer.name;
    var meta = document.createElement('small');
    meta.textContent = layer.count.toLocaleString() + (layer.count === 1 ? ' shape' : ' shapes') +
      (layer.colors.length > 1 ? ' · ' + layer.colors.length + ' colors' : '') + ' · ' + formatBytes(layer.body.length);
    label.appendChild(meta);
    label.addEventListener('click', function () { box.click(); });
    var dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'icon';
    dl.title = 'Download this layer as SVG';
    dl.setAttribute('aria-label', 'Download ' + layer.name);
    dl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    dl.addEventListener('click', function () {
      saveSvg(window.Vectorious.buildSvg(state.open, [layer]), outName() + '-' + layer.id + '.svg');
    });
    li.appendChild(box);
    li.appendChild(sw);
    li.appendChild(label);
    li.appendChild(dl);
    return li;
  }

  function saveSvg(text, filename) {
    var url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function downloadVisible() {
    if (!state.svg) return;
    var all = visibleLayers().length === state.layers.length;
    saveSvg(state.svg, outName() + (all ? '' : '-layers') + '.svg');
  }

  function outName() {
    if (state.work !== 'text') return state.name;
    var words = $('textInput').value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return words || 'text';
  }

  function outlineSvg(svg) {
    return svg
      .replace(/<rect ([^>]*?)fill="(#[0-9a-f]{6})"/g, '<rect $1fill="none" stroke="$2" stroke-width="0.5" vector-effect="non-scaling-stroke"')
      .replace(/fill="(#[0-9a-f]{6})" fill-rule="evenodd"/g, 'fill="none" stroke="$1" stroke-width="0.5" vector-effect="non-scaling-stroke"')
      .replace('>', '><rect width="100%" height="100%" fill="#ffffff"/>');
  }

  function setVectorSrc() {
    if (!state.svg) { els.imgVector.removeAttribute('src'); return; }
    if (state.view === 'outline') {
      if (!state.outlineUrl) state.outlineUrl = URL.createObjectURL(new Blob([outlineSvg(state.svg)], { type: 'image/svg+xml' }));
      els.imgVector.src = state.outlineUrl;
    } else {
      els.imgVector.src = state.svgUrl;
    }
  }

  function showBusy(stage, f) {
    els.busy.hidden = false;
    els.busyText.textContent = stage + '…';
    els.busyBar.style.width = Math.round((f || 0) * 100) + '%';
  }
  function hideBusy() { els.busy.hidden = true; }
  function showError(err) {
    hideBusy();
    els.stats.textContent = 'Tracing failed: ' + (err && err.message || err);
  }
  function toastStats(text) { els.stats.textContent = text; }
  function formatBytes(b) {
    return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(2) + ' MB';
  }

  // ------------------------------------------------------------------
  // Viewer: zoom, pan, compare slider
  // ------------------------------------------------------------------
  function fit() {
    var r = els.stage.getBoundingClientRect();
    if (!state.vw || !r.width) return;
    var z = Math.min((r.width - 32) / state.vw, (r.height - 32) / state.vh);
    setZoom(Math.max(0.02, z), r.width / 2, r.height / 2, true);
  }
  function setZoom(z, cx, cy, center) {
    z = Math.min(64, Math.max(0.02, z));
    var r = els.stage.getBoundingClientRect();
    if (center) {
      state.tx = (r.width - state.vw * z) / 2;
      state.ty = (r.height - state.vh * z) / 2;
    } else {
      // keep the point under (cx, cy) fixed
      state.tx = cx - (cx - state.tx) * (z / state.zoom);
      state.ty = cy - (cy - state.ty) * (z / state.zoom);
    }
    state.zoom = z;
    updateView();
  }

  function updateView() {
    els.canvas.style.transform = 'translate(' + state.tx + 'px,' + state.ty + 'px) scale(' + state.zoom + ')';
    els.canvas.classList.toggle('pixelated', state.zoom > 2);
    els.zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
    var v = state.view, r = els.stage.getBoundingClientRect();
    var orig = !!state.image && !(state.work === 'text' && state.text.free);
    if (!orig && (v === 'split' || v === 'original')) v = 'svg';
    els.imgOriginal.hidden = !orig || !(v === 'split' || v === 'original');
    els.imgVector.hidden = v === 'original';
    els.divider.hidden = v !== 'split';
    if (v === 'split') {
      var sxScreen = r.width * state.split;
      var local = (sxScreen - state.tx) / state.zoom; // divider position in image pixels
      els.imgVector.style.clipPath = 'inset(0 0 0 ' + Math.max(0, local) + 'px)';
      els.divider.style.left = sxScreen + 'px';
    } else {
      els.imgVector.style.clipPath = '';
    }
  }

  function setView(v) {
    state.view = v;
    document.querySelectorAll('[data-view]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-view') === v); });
    setVectorSrc();
    updateView();
  }

  // Pointer handling: drag divider, or pan.
  var drag = null;
  els.stage.addEventListener('pointerdown', function (e) {
    if (els.canvas.hidden || e.button > 0) return;
    var r = els.stage.getBoundingClientRect();
    var onDivider = state.view === 'split' && Math.abs(e.clientX - r.left - r.width * state.split) < 14;
    drag = { mode: onDivider ? 'split' : 'pan', x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
    els.stage.setPointerCapture(e.pointerId);
    if (!onDivider) els.stage.classList.add('panning');
  });
  els.stage.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var r = els.stage.getBoundingClientRect();
    if (drag.mode === 'split') {
      state.split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    } else {
      state.tx = drag.tx + e.clientX - drag.x;
      state.ty = drag.ty + e.clientY - drag.y;
    }
    updateView();
  });
  function endDrag() { drag = null; els.stage.classList.remove('panning'); }
  els.stage.addEventListener('pointerup', endDrag);
  els.stage.addEventListener('pointercancel', endDrag);
  els.stage.addEventListener('wheel', function (e) {
    if (els.canvas.hidden) return;
    e.preventDefault();
    var r = els.stage.getBoundingClientRect();
    var factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
    setZoom(state.zoom * factor, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  els.stage.addEventListener('dblclick', function () { if (!els.canvas.hidden) fit(); });

  function zoomBy(f) {
    var r = els.stage.getBoundingClientRect();
    setZoom(state.zoom * f, r.width / 2, r.height / 2);
  }
  els.zoomIn.onclick = function () { zoomBy(1.5); };
  els.zoomOut.onclick = function () { zoomBy(1 / 1.5); };
  els.zoomFit.onclick = fit;
  els.zoom1.onclick = function () { var r = els.stage.getBoundingClientRect(); setZoom(1, r.width / 2, r.height / 2); };
  window.addEventListener('resize', function () { updateView(); });

  // ------------------------------------------------------------------
  // Text to vector: typed text + a font -> SVG outlines
  // ------------------------------------------------------------------
  // Bundled fonts (fonts/, OFL or Apache licensed, subset to Latin-1).
  var FONT_GROUPS = [
    ['Sans serif', [['Lato', 'Lato-Regular'], ['Lato Bold', 'Lato-Bold'], ['Bebas Neue', 'BebasNeue-Regular'], ['Anton', 'Anton-Regular']]],
    ['Serif', [['DM Serif Display', 'DMSerifDisplay-Regular'], ['Abril Fatface', 'AbrilFatface-Regular'], ['Arvo', 'Arvo-Regular']]],
    ['Script', [['Pacifico', 'Pacifico-Regular'], ['Lobster', 'Lobster-Regular'], ['Great Vibes', 'GreatVibes-Regular']]],
    ['Handwriting', [['Patrick Hand', 'PatrickHand-Regular'], ['Indie Flower', 'IndieFlower-Regular'], ['Gochi Hand', 'GochiHand-Regular'],
      ['Schoolbell', 'Schoolbell-Regular'], ['Short Stack', 'ShortStack-Regular']]],
    ['Playful', [['Mouse Memoirs', 'MouseMemoirs-Regular'], ['Sniglet', 'Sniglet-Regular'], ['Luckiest Guy', 'LuckiestGuy-Regular'],
      ['Bangers', 'Bangers-Regular'], ['Henny Penny', 'HennyPenny-Regular'], ['Mystery Quest', 'MysteryQuest-Regular']]],
    ['Pixel and mono', [['Press Start 2P', 'PressStart2P-Regular'], ['Silkscreen', 'Silkscreen-Regular'], ['VT323', 'VT323-Regular'], ['Space Mono', 'SpaceMono-Regular']]],
    ['Blackletter', [['UnifrakturMaguntia', 'UnifrakturMaguntia-Book']]]
  ];
  var FONTS = [];          // [{ id, name, file?, font? }]
  var TEXT_IDS = ['textInput', 'font', 'textSize', 'letterSpacing', 'scaleX', 'lineHeight', 'textAlign', 'smallCaps', 'textFill', 'textBgOn', 'textBg', 'textCrop'];
  var opentypeReady = null;

  FONT_GROUPS.forEach(function (g) {
    g[1].forEach(function (f) { FONTS.push({ id: f[1], name: f[0], file: 'fonts/' + f[1] + '.woff', group: g[0] }); });
  });

  function fontById(id) { return FONTS.filter(function (f) { return f.id === id; })[0]; }

  function buildFontSelect() {
    var sel = $('font'), keep = sel.value;
    sel.innerHTML = '';
    var groups = FONT_GROUPS.map(function (g) { return g[0]; });
    if (FONTS.some(function (f) { return f.group === 'Your fonts'; })) groups.unshift('Your fonts');
    groups.forEach(function (name) {
      var og = document.createElement('optgroup');
      og.label = name;
      FONTS.forEach(function (f) {
        if (f.group !== name) return;
        var op = document.createElement('option');
        op.value = f.id; op.textContent = f.name;
        og.appendChild(op);
      });
      sel.appendChild(og);
    });
    sel.value = keep && fontById(keep) ? keep : 'ShortStack-Regular';
  }

  function loadOpentype() {
    if (window.opentype) return Promise.resolve();
    if (!opentypeReady) {
      opentypeReady = new Promise(function (resolve, reject) {
        var sc = document.createElement('script');
        sc.src = 'js/vendor/opentype.min.js';
        sc.onload = function () { resolve(); };
        sc.onerror = function () { opentypeReady = null; reject(new Error('Could not load the font reader.')); };
        document.head.appendChild(sc);
      });
    }
    return opentypeReady;
  }

  function loadFont(entry) {
    if (entry.font) return Promise.resolve(entry.font);
    if (entry.loading) return entry.loading;
    entry.loading = loadOpentype().then(function () {
      if (entry.local) return entry.local.blob().then(function (b) { return b.arrayBuffer(); });
      return fetch(entry.file).then(function (r) {
        if (!r.ok) throw new Error('Could not load ' + entry.name + ' (' + r.status + ').');
        return r.arrayBuffer();
      });
    }).then(function (buf) {
      entry.font = window.opentype.parse(buf);
      return entry.font;
    }).catch(function (err) {
      entry.loading = null;
      throw err;
    });
    return entry.loading;
  }

  function addUserFont(buf, fallbackName) {
    return loadOpentype().then(function () {
      var font = window.opentype.parse(buf);
      var names = font.names || {}, fam = (names.fullName || names.fontFamily || {}).en || fallbackName || 'Custom font';
      var id = 'user-' + fam.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      var entry = fontById(id);
      if (!entry) { entry = { id: id, name: fam, group: 'Your fonts' }; FONTS.unshift(entry); }
      entry.font = font;
      buildFontSelect();
      $('font').value = id;
      return entry;
    });
  }

  function readTextOptions() {
    return {
      text: $('textInput').value,
      font: $('font').value,
      size: +$('textSize').value,
      letterSpacing: +$('letterSpacing').value,
      scaleX: +$('scaleX').value,
      lineHeight: +$('lineHeight').value,
      align: $('textAlign').value,
      smallCaps: $('smallCaps').checked,
      fill: $('textFill').value,
      background: $('textBgOn').checked ? $('textBg').value : null,
      crop: $('textCrop').checked
    };
  }

  function saveTextSettings() {
    try {
      var t = readTextOptions();
      delete t.font;
      var fe = fontById($('font').value);
      t.font = fe && fe.file ? $('font').value : null;
      t.userFont = fe && fe.traced ? fe.id : null;
      localStorage.setItem('vectorious.text', JSON.stringify(t));
    } catch (_) { /* storage unavailable */ }
  }
  function loadTextSettings() {
    try {
      var t = JSON.parse(localStorage.getItem('vectorious.text') || 'null');
      if (!t) return;
      var map = { text: 'textInput', font: 'font', size: 'textSize', letterSpacing: 'letterSpacing', scaleX: 'scaleX',
        lineHeight: 'lineHeight', align: 'textAlign', smallCaps: 'smallCaps', fill: 'textFill', crop: 'textCrop' };
      Object.keys(map).forEach(function (k) {
        var el = $(map[k]);
        if (t[k] == null || !el) return;
        if (el.type === 'checkbox') el.checked = !!t[k]; else el.value = t[k];
      });
      $('textBgOn').checked = !!t.background;
      if (t.background) $('textBg').value = t.background;
    } catch (_) { /* ignore */ }
  }

  function refreshTextControls() {
    document.querySelectorAll('#panel output[for]').forEach(function (out) {
      var id = out.getAttribute('for'), v = +$(id).value;
      if (id === 'textSize') out.textContent = v + ' px';
      else if (id === 'letterSpacing') out.textContent = (v >= 0 ? '+' : '') + v.toFixed(3) + ' em';
      else if (id === 'scaleX') out.textContent = Math.round(v * 100) + '%';
      else if (id === 'lineHeight') out.textContent = v.toFixed(2);
    });
  }

  function refreshMatchButtons() {
    var has = !!state.image;
    $('fitText').disabled = !has;
    $('findFont').disabled = !has;
    $('makeFont').disabled = !has;
    $('textCrop').closest('.check').hidden = !has;
    $('matchNote').textContent = has
      ? 'Type the words in the image above, then fit them. Matching compares letter shapes with the image; it is not AI.'
      : 'Open an image of text, type its words above, then let Vectorious fit them. Matching compares letter shapes; it is not AI.';
  }

  var textTimer = 0, textJob = 0;
  function scheduleText(delay) {
    clearTimeout(textTimer);
    textTimer = setTimeout(renderText, delay || 0);
  }

  function renderText() {
    if (state.work !== 'text') return;
    var t = readTextOptions(), entry = fontById(t.font), job = ++textJob;
    if (!entry) return;
    showBusy('Loading ' + entry.name, 0.3);
    var fbEntry = entry.group === 'Your fonts' ? fontById($('fallbackFont').value) : null;
    Promise.all([loadFont(entry), fbEntry ? loadFont(fbEntry).catch(function () { return null; }) : null]).then(function (fonts) {
      var font = fonts[0], fb = fonts[1];
      if (job !== textJob) return;
      hideBusy();
      refreshFontTools();
      var onImage = !!state.image && !t.crop;
      state.text.free = !onImage;
      var o = {
        size: t.size, letterSpacing: t.letterSpacing, scaleX: t.scaleX, lineHeight: t.lineHeight,
        align: t.align, smallCaps: t.smallCaps, fill: t.fill, background: t.background,
        fallback: fb, fallbackScale: fb ? window.VectoriousText.capRatio(font) / window.VectoriousText.capRatio(fb) : 1,
        // traced lettering in small caps: borrowed lowercase become small capitals too
        fallbackSmallCaps: fb && entry.traced && entry.smallCaps ? entry.smallCaps : 0
      };
      if (onImage) {
        // Keep the text centred on its anchor: the fitted position, else the image centre.
        o.width = state.w; o.height = state.h;
        var a = state.text.anchor || { x: state.w / 2, y: state.h / 2 };
        var b = window.VectoriousText.layout(font, t.text, o).bbox;
        o.x = b ? a.x - (b.x1 + b.x2) / 2 : 0;
        o.y = b ? a.y - (b.y1 + b.y2) / 2 : 0;
      }
      var r = window.VectoriousText.textLayers(font, t.text, o);
      state.open = r.open;
      state.layers = r.layers;
      if (state.vw !== r.width || state.vh !== r.height || els.canvas.hidden) {
        setCanvasSize(r.width, r.height);
        els.drop.hidden = true;
        els.canvas.hidden = false;
        fit();
      }
      renderLayers();
      rebuildVisible();
      updateView();
      els.stats.innerHTML = '<b>' + escapeHtml(entry.name) + '</b> · <b>' + r.glyphs + '</b> letters · ' + r.width + '×' + r.height +
        ' · <b>' + formatBytes(state.svg.length) + '</b>' + (onImage ? ' · drawn on the image canvas' : '') +
        (state.text.note ? '<br>' + state.text.note : '');
      els.palette.innerHTML = '';
    }).catch(function (err) {
      if (job !== textJob) return;
      showError(err);
      if (location.protocol === 'file:') els.stats.textContent += ' Fonts need the page served over http (see README).';
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  // Image pixels for matching, at most ~320 px wide (matching is O(pixels)).
  function matchPixels() {
    var k = Math.min(1, 320 / state.w, 160 / state.h);
    var w = Math.max(1, Math.round(state.w * k)), h = Math.max(1, Math.round(state.h * k));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(state.image, 0, 0, w, h);
    return { img: g.getImageData(0, 0, w, h), k: k };
  }

  function applyFit(fontId, fitted, ink, k) {
    var o = window.VectoriousText.scaleOptions(fitted, 1 / k);
    $('font').value = fontId;
    $('textSize').value = Math.round(o.size * 2) / 2;
    $('letterSpacing').value = Math.round(o.letterSpacing * 1000) / 1000;
    $('scaleX').value = Math.round(o.scaleX * 100) / 100;
    $('smallCaps').checked = !!o.smallCaps;
    $('textCrop').checked = false;
    var b = window.VectoriousText.layout(fontById(fontId).font, $('textInput').value, o).bbox;
    if (b) state.text.anchor = { x: (b.x1 + b.x2) / 2 + o.x, y: (b.y1 + b.y2) / 2 + o.y };
    if (ink) {
      $('textFill').value = window.VectoriousText.hex(ink.ink);
      $('textBgOn').checked = !!ink.background;
      if (ink.background) $('textBg').value = window.VectoriousText.hex(ink.background);
    }
    refreshTextControls();
    saveTextSettings();
    renderText();
  }

  function needWords() {
    if (/\S/.test($('textInput').value)) return false;
    els.stats.textContent = 'Type the words that are in the image first.';
    $('textInput').focus();
    return true;
  }

  function fitCurrentFont() {
    if (!state.image || needWords()) return;
    var entry = fontById($('font').value), text = $('textInput').value;
    showBusy('Fitting ' + entry.name, 0.2);
    loadFont(entry).then(function (font) {
      setTimeout(function () {
        var mp = matchPixels(), ink = window.VectoriousText.inkOf(mp.img);
        var r = window.VectoriousText.matchFont(font, text, ink, textBase());
        hideBusy();
        if (!r) { els.stats.textContent = 'No text found in the image to fit to.'; return; }
        applyFit(entry.id, r.options, ink, mp.k);
        els.stats.innerHTML += ' · overlap with the image <b>' + Math.round(r.score * 100) + '%</b>';
      }, 20);
    }).catch(showError);
  }

  function textBase() {
    return { lineHeight: +$('lineHeight').value, align: $('textAlign').value };
  }

  function findClosestFont() {
    if (!state.image || needWords()) return;
    // bundled fonts plus uploaded ones (installed fonts can number in the hundreds)
    var text = $('textInput').value, results = [], i = 0;
    var list = FONTS.filter(function (f) { return f.file || (f.font && !f.local); });
    var mp = matchPixels(), ink = window.VectoriousText.inkOf(mp.img);
    if (!ink.box) { els.stats.textContent = 'No text found in the image to match.'; return; }
    var job = ++textJob;
    $('fontResults').innerHTML = '';
    (function step() {
      if (job !== textJob) return;
      if (i >= list.length) return done();
      var entry = list[i++];
      showBusy('Comparing ' + entry.name, i / list.length);
      loadFont(entry).then(function (font) {
        setTimeout(function () {
          var r = window.VectoriousText.matchFont(font, text, ink, textBase());
          if (r) results.push({ entry: entry, score: r.score, options: r.options });
          step();
        }, 0);
      }).catch(function () { step(); });
    })();
    function done() {
      hideBusy();
      results.sort(function (a, b) { return b.score - a.score; });
      var top = results.slice(0, 6), ol = $('fontResults');
      top.forEach(function (r, ri) {
        var li = document.createElement('li'), b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = '<span>' + escapeHtml(r.entry.name) + (r.options.smallCaps ? ' <small>small caps</small>' : '') + '</span><small>' +
          Math.round(r.score * 100) + '% match</small>';
        b.onclick = function () {
          ol.querySelectorAll('li').forEach(function (x) { x.classList.remove('on'); });
          li.classList.add('on');
          applyFit(r.entry.id, r.options, ink, mp.k);
        };
        li.appendChild(b);
        ol.appendChild(li);
        if (ri === 0) { li.classList.add('on'); applyFit(r.entry.id, r.options, ink, mp.k); }
      });
      if (!top.length) els.stats.textContent = 'No font could be fitted to the image.';
    }
  }

  // ------------------------------------------------------------------
  // Making a font from the image's own lettering
  // ------------------------------------------------------------------
  function refreshFontTools() {
    var e = fontById($('font').value);
    var user = !!e && e.group === 'Your fonts';
    $('fallbackField').hidden = !user;
    $('downloadFont').hidden = !(e && e.traced);
  }

  function makeFontFromImage() {
    if (!state.image || needWords()) return;
    var words = $('textInput').value;
    showBusy('Tracing the letters', 0.1);
    loadOpentype().then(function () {
      setTimeout(function () {
        try {
          var w = state.w, h = state.h;
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          var g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(state.image, 0, 0);
          var img = g.getImageData(0, 0, w, h);
          var ink = window.VectoriousText.inkOf(img);
          if (!ink.box) throw new Error('No lettering found in the image.');
          // small text needs room to trace; keep the work under ~2 megapixels
          var up = Math.max(1, Math.min(8, Math.sqrt(2e6 / (w * h))));
          var r = window.Vectorious.vectorize(img, {
            mode: 'color', colors: 8, pureColors: true, upscale: up, resample: 'smooth',
            speckle: Math.round(2 * up * up), alphamax: 1, opttolerance: 0.2,
            groupBy: 'size', returnObjects: true, refine: true
          });
          var inkHex = window.VectoriousText.hex(ink.ink), bgHex = ink.background ? window.VectoriousText.hex(ink.background) : null;
          // the shapes in the ink's color (the palette color nearest to it)
          var dist = function (hx) {
            var v = parseInt(hx.slice(1), 16);
            return Math.hypot(((v >> 16) & 255) - ink.ink[0], ((v >> 8) & 255) - ink.ink[1], (v & 255) - ink.ink[2]);
          };
          var inkColor = r.palette.filter(function (hx) { return hx !== bgHex; }).sort(function (a, b) { return dist(a) - dist(b); })[0];
          var shapes = r.objects.filter(function (ob) { return ob.color === inkColor; });
          var name = 'Traced ' + (words.trim().replace(/\s+/g, ' ').replace(/[^\w !?.,'-]/g, '').slice(0, 28) || 'lettering');
          var made = window.VectoriousText.fontFromShapes(window.opentype, shapes, words, { familyName: name });
          var entry = registerTracedFont(name, made.font);
          entry.smallCaps = tracedSmallCaps(made.font);
          storeTracedFont(name, made.font);
          hideBusy();
          $('font').value = entry.id;
          $('textSize').value = Math.round(made.sizePx * 2) / 2;
          $('letterSpacing').value = 0;
          $('scaleX').value = 1;
          $('smallCaps').checked = false;
          $('textCrop').checked = false;
          $('textFill').value = inkHex;
          $('textBgOn').checked = !!bgHex;
          if (bgHex) $('textBg').value = bgHex;
          state.text.anchor = { x: (ink.box.x1 + ink.box.x2) / 2, y: (ink.box.y1 + ink.box.y2) / 2 };
          refreshTextControls();
          saveTextSettings();
          state.text.note = 'Made <b>' + escapeHtml(name) + '</b> with ' + made.chars.length + ' characters: ' +
            escapeHtml(made.chars.join(' ')) + (made.synthesized.length ? ' (' + made.synthesized.length + ' scaled from the other case)' : '') +
            (r.stats.refined === true ? ' · edges refined against the image' : '');
          renderText();
        } catch (err) {
          hideBusy();
          showError(err);
        }
      }, 20);
    }).catch(showError);
  }

  function registerTracedFont(name, font) {
    var id = 'traced-' + name.toLowerCase().replace(/^traced\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    var entry = fontById(id);
    if (!entry) { entry = { id: id, name: name, group: 'Your fonts', traced: true }; FONTS.unshift(entry); }
    entry.font = font;
    entry.smallCaps = tracedSmallCaps(font);
    buildFontSelect();
    return entry;
  }

  // Lowercase drawn as capitals (small caps lettering)? Then the case ratio, else 0.
  function tracedSmallCaps(font) {
    var lo = font.charToGlyph('a'), up = font.charToGlyph('A'), r = window.VectoriousText.caseRatio(font);
    if (!lo || !up || lo.index === 0 || up.index === 0 || !r) return 0;
    // the scaled-up capital has the same outline as the lowercase letter: compare their widths at equal height
    var a = lo.getBoundingBox(), b = up.getBoundingBox();
    var same = Math.abs((a.x2 - a.x1) / (a.y2 - a.y1) - (b.x2 - b.x1) / (b.y2 - b.y1)) < 0.05;
    return same ? r : 0;
  }

  function storeTracedFont(name, font) {
    try {
      var bytes = new Uint8Array(font.toArrayBuffer()), bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      var list = JSON.parse(localStorage.getItem('vectorious.tracedFonts') || '[]').filter(function (f) { return f.name !== name; });
      list.unshift({ name: name, b64: btoa(bin) });
      localStorage.setItem('vectorious.tracedFonts', JSON.stringify(list.slice(0, 8)));
    } catch (_) { /* storage full or unavailable: the font lasts for this visit */ }
  }

  function restoreTracedFonts() {
    var list;
    try { list = JSON.parse(localStorage.getItem('vectorious.tracedFonts') || '[]'); } catch (_) { return Promise.resolve(); }
    if (!list.length) return Promise.resolve();
    return loadOpentype().then(function () {
      list.slice().reverse().forEach(function (f) {
        try {
          var bin = atob(f.b64), bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          registerTracedFont(f.name, window.opentype.parse(bytes.buffer));
        } catch (_) { /* skip a damaged entry */ }
      });
    }).catch(function () {});
  }

  function downloadTracedFont() {
    var e = fontById($('font').value);
    if (!e || !e.font) return;
    var url = URL.createObjectURL(new Blob([e.font.toArrayBuffer()], { type: 'font/otf' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = e.name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') + '.otf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function setWork(work) {
    state.work = work;
    document.querySelectorAll('[data-work-tab]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-work-tab') === work); });
    document.querySelectorAll('[data-work]').forEach(function (el) { el.hidden = el.getAttribute('data-work') !== work; });
    try { localStorage.setItem('vectorious.work', work); } catch (_) { /* ignore */ }
    state.hidden = {};
    if (work === 'text') {
      textJob++;
      renderText();
    } else {
      textJob++;
      hideBusy();
      if (!state.image) {
        els.canvas.hidden = true; els.drop.hidden = false;
        state.layers = []; renderLayers(); state.svg = null; setVectorSrc();
        els.stats.textContent = 'Open an image to begin.';
        els.download.disabled = els.copy.disabled = els.downloadVisible.disabled = true;
        return;
      }
      setCanvasSize(state.w, state.h);
      fit();
      if (state.traceResult) showTraceResult(state.traceResult.m, state.traceResult.elapsed);
      else trace();
    }
  }

  function initText() {
    buildFontSelect();
    loadTextSettings();
    if (!fontById($('font').value)) $('font').value = 'ShortStack-Regular';
    refreshTextControls();
    refreshMatchButtons();
    if (window.queryLocalFonts) $('localFonts').hidden = false;
    TEXT_IDS.forEach(function (id) {
      var el = $(id);
      var ev = el.type === 'range' || el.tagName === 'TEXTAREA' || el.type === 'color' ? 'input' : 'change';
      el.addEventListener(ev, function () {
        state.text.note = null;
        refreshTextControls();
        saveTextSettings();
        scheduleText(ev === 'input' ? 120 : 0);
      });
    });
    $('font').addEventListener('change', function () { $('fontResults').querySelectorAll('li').forEach(function (x) { x.classList.remove('on'); }); });
    $('fontFile').addEventListener('change', function () {
      var f = $('fontFile').files[0];
      $('fontFile').value = '';
      if (!f) return;
      f.arrayBuffer().then(function (buf) { return addUserFont(buf, f.name.replace(/\.[^.]+$/, '')); })
        .then(function () { renderText(); })
        .catch(function (err) { showError('That font could not be read: ' + (err && err.message || err)); });
    });
    $('localFonts').addEventListener('click', function () {
      window.queryLocalFonts().then(function (fonts) {
        if (!fonts.length) { els.stats.textContent = 'No installed fonts were shared.'; return; }
        var added = 0;
        fonts.slice(0, 400).forEach(function (fd) {
          if (fontById('local-' + fd.postscriptName)) return;
          FONTS.unshift({ id: 'local-' + fd.postscriptName, name: fd.fullName, group: 'Your fonts', local: fd });
          added++;
        });
        buildFontSelect();
        els.stats.textContent = added + ' installed fonts added to the font list under "Your fonts".';
      }).catch(function (err) { showError(err); });
    });
    var fb = $('fallbackFont');
    FONTS.forEach(function (f) {
      if (!f.file) return;
      var op = document.createElement('option');
      op.value = f.id; op.textContent = f.name;
      fb.appendChild(op);
    });
    try { fb.value = localStorage.getItem('vectorious.fallback') || 'ShortStack-Regular'; } catch (_) { fb.value = 'ShortStack-Regular'; }
    if (!fb.value) fb.value = '';
    fb.addEventListener('change', function () {
      try { localStorage.setItem('vectorious.fallback', fb.value); } catch (_) { /* ignore */ }
      renderText();
    });
    $('font').addEventListener('change', refreshFontTools);
    $('makeFont').onclick = makeFontFromImage;
    $('downloadFont').onclick = downloadTracedFont;
    $('fitText').onclick = fitCurrentFont;
    $('findFont').onclick = findClosestFont;
    document.querySelectorAll('[data-work-tab]').forEach(function (b) {
      b.onclick = function () { setWork(b.getAttribute('data-work-tab')); };
    });
    var saved = null, savedFont = null;
    try {
      saved = localStorage.getItem('vectorious.work');
      savedFont = (JSON.parse(localStorage.getItem('vectorious.text') || 'null') || {}).userFont;
    } catch (_) { /* ignore */ }
    var start = function () { if (saved === 'text') setWork('text'); };
    restoreTracedFonts().then(function () {
      if (savedFont && fontById(savedFont)) $('font').value = savedFont;
      refreshFontTools();
      start();
    });
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  els.file.addEventListener('change', function () { if (els.file.files[0]) loadFile(els.file.files[0]); els.file.value = ''; });
  els.sample.onclick = makeSample;
  els.trace.onclick = trace;
  els.download.onclick = downloadVisible;
  els.downloadVisible.onclick = downloadVisible;
  els.layersAll.onclick = function () { state.hidden = {}; rebuildVisible(); };
  els.layersNone.onclick = function () {
    state.layers.forEach(function (l) { state.hidden[l.name] = true; });
    rebuildVisible();
  };
  els.copy.onclick = function () {
    if (!state.svg || !navigator.clipboard) return;
    navigator.clipboard.writeText(state.svg).then(function () {
      els.copy.textContent = 'Copied';
      setTimeout(function () { els.copy.textContent = 'Copy SVG'; }, 1400);
    });
  };
  document.querySelectorAll('[data-view]').forEach(function (b) {
    b.onclick = function () { setView(b.getAttribute('data-view')); };
  });
  els.preset.addEventListener('change', function () {
    applyPreset(els.preset.value);
    saveSettings();
    if ($('auto').checked && state.image) trace();
  });
  els.auto.addEventListener('change', saveSettings);
  CONTROL_IDS.forEach(function (id) {
    var el = $(id);
    el.addEventListener(el.type === 'range' ? 'input' : 'change', onControlChange);
  });

  // drag & drop and paste
  ['dragenter', 'dragover'].forEach(function (t) {
    els.stage.addEventListener(t, function (e) { e.preventDefault(); els.stage.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    els.stage.addEventListener(t, function (e) { e.preventDefault(); els.stage.classList.remove('dragover'); });
  });
  els.stage.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
  window.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) { loadFile(items[i].getAsFile()); break; }
    }
  });

  if (!loadSettings()) applyPreset('illustration');
  refreshControls();
  initText();
})();
