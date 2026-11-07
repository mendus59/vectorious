/* Vectorious UI: loading images, settings, worker orchestration, preview. */
(function () {
  'use strict';

  var MAX_WORK_PIXELS = 8e6; // cap on the traced bitmap size, keeps memory sane

  var PRESETS = {
    max:          { mode: 'color', colors: 64, scale: 2, blur: 0, speckle: 2, alphamax: 1, opticurve: true, opttolerance: 0.1, pixelExact: false, layering: 'stacked', order: 'lightness' },
    photo:        { mode: 'color', colors: 48, scale: 1, blur: 1, speckle: 12, alphamax: 1, opticurve: true, opttolerance: 0.2, pixelExact: false, layering: 'stacked', order: 'lightness' },
    illustration: { mode: 'color', colors: 16, scale: 1, blur: 0, speckle: 4, alphamax: 1, opticurve: true, opttolerance: 0.2, pixelExact: false, layering: 'stacked', order: 'lightness' },
    lineart:      { mode: 'bw', threshold: 128, invert: false, bwBackground: true, scale: 2, blur: 0, speckle: 8, alphamax: 1, opticurve: true, opttolerance: 0.2, pixelExact: false, layering: 'stacked', order: 'lightness' },
    pixel:        { mode: 'color', colors: 64, scale: 1, blur: 0, speckle: 0, alphamax: 0, opticurve: false, opttolerance: 0.2, pixelExact: true, layering: 'stacked', order: 'lightness' }
  };
  var CONTROL_IDS = ['mode', 'colors', 'threshold', 'invert', 'bwBackground', 'scale', 'blur', 'speckle', 'pixelExact', 'alphamax', 'opticurve', 'opttolerance', 'layering', 'order'];

  var $ = function (id) { return document.getElementById(id); };
  var els = {};
  ['file', 'sample', 'download', 'copy', 'trace', 'auto', 'preset', 'stage', 'drop', 'canvas', 'imgOriginal', 'imgVector',
   'divider', 'busy', 'busyBar', 'busyText', 'stats', 'palette', 'zoomIn', 'zoomOut', 'zoomFit', 'zoom1', 'zoomLabel']
    .forEach(function (id) { els[id] = $(id); });

  var state = {
    image: null, name: 'image', w: 0, h: 0,
    origUrl: null, svg: null, svgUrl: null, outlineUrl: null,
    view: 'split', split: 0.5,
    zoom: 1, tx: 0, ty: 0,
    jobId: 0, worker: null, workerOk: typeof Worker !== 'undefined',
    pending: null
  };

  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------
  function readOptions() {
    return {
      mode: $('mode').value,
      colors: +$('colors').value,
      threshold: +$('threshold').value,
      invert: $('invert').checked,
      bwBackground: $('bwBackground').checked,
      scale: +$('scale').value,
      blur: +$('blur').value,
      speckle: +$('speckle').value,
      pixelExact: $('pixelExact').checked,
      alphamax: +$('alphamax').value,
      opticurve: $('opticurve').checked,
      opttolerance: +$('opttolerance').value,
      layering: $('layering').value,
      order: $('order').value
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
    document.querySelectorAll('[data-stacked]').forEach(function (el) {
      el.classList.toggle('disabled-field', $('layering').value !== 'stacked');
    });
    $('opttolerance').closest('.field').classList.toggle('disabled-field', exact || !opt);
    document.querySelectorAll('output[for]').forEach(function (out) {
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
    state.w = img.naturalWidth;
    state.h = img.naturalHeight;
    els.imgOriginal.src = url;
    els.imgVector.removeAttribute('src');
    els.canvas.style.width = state.w + 'px';
    els.canvas.style.height = state.h + 'px';
    els.drop.hidden = true;
    els.canvas.hidden = false;
    els.trace.disabled = false;
    fit();
    updateView();
    trace();
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
  function getPixels(opts) {
    var scale = opts.scale;
    var pw = Math.max(1, Math.round(state.w * scale)), ph = Math.max(1, Math.round(state.h * scale));
    if (pw * ph > MAX_WORK_PIXELS) {
      var f = Math.sqrt(MAX_WORK_PIXELS / (pw * ph));
      pw = Math.max(1, Math.floor(pw * f));
      ph = Math.max(1, Math.floor(ph * f));
    }
    var c = document.createElement('canvas');
    c.width = pw; c.height = ph;
    var g = c.getContext('2d', { willReadFrequently: true });
    // Pixel-exact tracing needs hard pixel edges; everything else benefits from smooth resampling.
    g.imageSmoothingEnabled = !(opts.pixelExact && pw >= state.w);
    g.imageSmoothingQuality = 'high';
    g.drawImage(state.image, 0, 0, pw, ph);
    return g.getImageData(0, 0, pw, ph);
  }

  function trace() {
    if (!state.image) return;
    var opts = readOptions();
    var id = ++state.jobId;
    var imgData;
    try { imgData = getPixels(opts); } catch (err) { showError(err); return; }
    var options = {
      mode: opts.mode, colors: opts.colors, threshold: opts.threshold, invert: opts.invert, bwBackground: opts.bwBackground,
      blur: Math.round(opts.blur * imgData.width / state.w), // blur radius is in original pixels
      speckle: Math.round(opts.speckle * Math.pow(imgData.width / state.w, 2)),
      alphamax: opts.pixelExact ? 0 : opts.alphamax,
      opticurve: opts.opticurve, opttolerance: opts.opttolerance,
      pixelExact: opts.pixelExact, layering: opts.layering, order: opts.order,
      outWidth: state.w, outHeight: state.h
    };
    if (opts.blur > 0 && options.blur < 1) options.blur = 1;
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
          onResult({ svg: r.svg, palette: r.palette, stats: r.stats }, imgData, performance.now() - started);
        } catch (err) { showError(err); }
      }, 30);
    }
  }

  function onResult(m, imgData, elapsed) {
    hideBusy();
    state.svg = m.svg;
    if (state.svgUrl) URL.revokeObjectURL(state.svgUrl);
    if (state.outlineUrl) URL.revokeObjectURL(state.outlineUrl);
    state.svgUrl = URL.createObjectURL(new Blob([m.svg], { type: 'image/svg+xml' }));
    state.outlineUrl = null;
    setVectorSrc();
    els.download.disabled = false;
    els.copy.disabled = false;

    var s = m.stats;
    els.stats.innerHTML =
      '<b>' + state.w + '×' + state.h + '</b> traced at ' + s.width + '×' + s.height +
      ' · <b>' + s.colors + '</b> colors · <b>' + s.paths.toLocaleString() + '</b> shapes' +
      (s.segments ? ' · ' + s.segments.toLocaleString() + ' segments' : '') +
      ' · <b>' + formatBytes(s.bytes) + '</b> · ' + (elapsed / 1000).toFixed(2) + ' s' +
      (s.bytes > 25e6 ? ' · <b>Very large file.</b> For photos try the Photo preset, Denoise, or a higher Speckle filter.' : '');
    els.palette.innerHTML = '';
    m.palette.slice(0, 128).forEach(function (hex) {
      var i = document.createElement('i');
      i.style.background = hex;
      i.title = hex;
      els.palette.appendChild(i);
    });
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
    if (!state.w || !r.width) return;
    var z = Math.min((r.width - 32) / state.w, (r.height - 32) / state.h);
    setZoom(Math.max(0.02, z), r.width / 2, r.height / 2, true);
  }
  function setZoom(z, cx, cy, center) {
    z = Math.min(64, Math.max(0.02, z));
    var r = els.stage.getBoundingClientRect();
    if (center) {
      state.tx = (r.width - state.w * z) / 2;
      state.ty = (r.height - state.h * z) / 2;
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
    els.imgOriginal.hidden = !(v === 'split' || v === 'original');
    els.imgVector.hidden = v === 'original';
    els.divider.hidden = v !== 'split' || !state.image;
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
    if (!state.image || e.button > 0) return;
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
    if (!state.image) return;
    e.preventDefault();
    var r = els.stage.getBoundingClientRect();
    var factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
    setZoom(state.zoom * factor, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  els.stage.addEventListener('dblclick', function () { if (state.image) fit(); });

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
  // Wiring
  // ------------------------------------------------------------------
  els.file.addEventListener('change', function () { if (els.file.files[0]) loadFile(els.file.files[0]); els.file.value = ''; });
  els.sample.onclick = makeSample;
  els.trace.onclick = trace;
  els.download.onclick = function () {
    if (!state.svg) return;
    var a = document.createElement('a');
    a.href = state.svgUrl;
    a.download = state.name + '.svg';
    document.body.appendChild(a);
    a.click();
    a.remove();
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
})();
