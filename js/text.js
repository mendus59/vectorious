/*
 * Vectorious text engine: typed text + a font -> SVG paths.
 *
 * Glyph outlines come from the font file itself (parsed with opentype.js), so
 * the result is exact vector text, not a trace. To help recreate text from an
 * image, `match` lays the text out in each candidate font, fits it to the
 * image's ink box and scores the overlap (intersection over union of the
 * coverage masks). It is plain template matching, no machine learning.
 *
 * Works in a browser window or in Node (for tests). Fonts are opentype.js
 * Font objects; this file never loads anything itself.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    size: 64,            // font size in px (em height)
    letterSpacing: 0,    // extra space after each character, in em
    lineHeight: 1.2,     // line distance, in em
    align: 'left',       // 'left' | 'center' | 'right'
    smallCaps: false,    // draw lowercase letters as smaller capitals
    smallCapsScale: 0,   // 0 = from the font's x-height / cap-height
    scaleX: 1            // horizontal stretch
  };

  function opts(o) {
    var r = {}, k;
    for (k in DEFAULTS) r[k] = DEFAULTS[k];
    for (k in o || {}) if (o[k] !== undefined && o[k] !== null) r[k] = o[k];
    return r;
  }

  function smallCapsRatio(font) {
    var os2 = font.tables && font.tables.os2;
    if (os2 && os2.sxHeight > 0 && os2.sCapHeight > 0) {
      return Math.max(0.6, Math.min(0.85, os2.sxHeight / os2.sCapHeight + 0.05));
    }
    return 0.75;
  }

  /**
   * Lay out text as outline commands.
   * @returns {{commands: Array, bbox: {x1,y1,x2,y2}|null, glyphs: number, lines: number}}
   *   Commands use opentype.js's shape: {type: 'M'|'L'|'Q'|'C'|'Z', x, y, x1, y1, x2, y2}.
   *   The first line's baseline is y = 0 and lines start at x = 0 (before alignment).
   */
  function layout(font, text, options) {
    var o = opts(options);
    var size = o.size, upm = font.unitsPerEm || 1000, ls = o.letterSpacing * size;
    var sc = o.smallCaps ? (o.smallCapsScale || smallCapsRatio(font)) : 1;
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var runs = [], glyphCount = 0;

    lines.forEach(function (line, li) {
      var x = 0, y = li * o.lineHeight * size, prev = null, prevSize = 0, items = [];
      var chars = Array.from ? Array.from(line) : line.split('');
      chars.forEach(function (ch, ci) {
        var s = size, c = ch;
        if (o.smallCaps) {
          var up = ch.toUpperCase();
          if (up !== ch && up.length === 1) { c = up; s = size * sc; }
        }
        var g = font.charToGlyph(c), gu = upm;
        if (o.fallback && (!g || g.index === 0) && /\S/.test(ch)) {
          // missing from this font: borrow the letter from the fallback font, scaled to match
          var fc = c, fs = o.fallbackScale || 1;
          // a font whose lowercase are small capitals borrows capitals for lowercase too
          if (o.fallbackSmallCaps && c.toUpperCase() !== c && c.toUpperCase().length === 1) { fc = c.toUpperCase(); fs *= o.fallbackSmallCaps; }
          var fg = o.fallback.charToGlyph(fc);
          if (fg && fg.index !== 0) { g = fg; gu = o.fallback.unitsPerEm || 1000; s *= fs; }
        }
        if (prev && prevSize === s && gu === upm && font.getKerningValue) x += font.getKerningValue(prev, g) * s / upm;
        var adv = (g.advanceWidth || 0) * s / gu;
        if (/\S/.test(ch)) {
          var p = g.getPath(x, y, s);
          if (p.commands.length) { items.push(p.commands); glyphCount++; }
        }
        x += adv + (ci < chars.length - 1 ? ls : 0);
        prev = g; prevSize = s;
      });
      runs.push({ items: items, width: x });
    });

    var maxW = 0;
    runs.forEach(function (r) { if (r.width > maxW) maxW = r.width; });
    var commands = [];
    runs.forEach(function (r) {
      var dx = o.align === 'center' ? (maxW - r.width) / 2 : o.align === 'right' ? maxW - r.width : 0;
      r.items.forEach(function (cmds) {
        cmds.forEach(function (c) {
          var n = { type: c.type };
          if (c.x !== undefined) { n.x = (c.x + dx) * o.scaleX; n.y = c.y; }
          if (c.x1 !== undefined) { n.x1 = (c.x1 + dx) * o.scaleX; n.y1 = c.y1; }
          if (c.x2 !== undefined) { n.x2 = (c.x2 + dx) * o.scaleX; n.y2 = c.y2; }
          commands.push(n);
        });
      });
    });
    return { commands: commands, bbox: bounds(commands), glyphs: glyphCount, lines: lines.length, advance: maxW * o.scaleX };
  }

  // Tight bounds, including curve extremes (sampled).
  function bounds(cmds) {
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    function add(x, y) {
      if (x < x1) x1 = x; if (x > x2) x2 = x;
      if (y < y1) y1 = y; if (y > y2) y2 = y;
    }
    flatten(cmds, function (poly) { for (var i = 0; i < poly.length; i += 2) add(poly[i], poly[i + 1]); }, 6);
    return x1 === Infinity ? null : { x1: x1, y1: y1, x2: x2, y2: y2 };
  }

  // Turn commands into closed polylines ([x0, y0, x1, y1, ...]).
  function flatten(cmds, emit, steps) {
    var poly = null, cx = 0, cy = 0, sx = 0, sy = 0, i, t, k;
    steps = steps || 8;
    function close() { if (poly && poly.length >= 6) emit(poly); poly = null; }
    for (i = 0; i < cmds.length; i++) {
      var c = cmds[i];
      if (c.type === 'M') { close(); poly = [c.x, c.y]; cx = sx = c.x; cy = sy = c.y; }
      else if (c.type === 'L') { if (!poly) poly = [cx, cy]; poly.push(c.x, c.y); cx = c.x; cy = c.y; }
      else if (c.type === 'Q') {
        if (!poly) poly = [cx, cy];
        for (k = 1; k <= steps; k++) {
          t = k / steps;
          var a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t;
          poly.push(a * cx + b * c.x1 + d * c.x, a * cy + b * c.y1 + d * c.y);
        }
        cx = c.x; cy = c.y;
      } else if (c.type === 'C') {
        if (!poly) poly = [cx, cy];
        for (k = 1; k <= steps; k++) {
          t = k / steps;
          var u = 1 - t, a3 = u * u * u, b3 = 3 * u * u * t, c3 = 3 * u * t * t, d3 = t * t * t;
          poly.push(a3 * cx + b3 * c.x1 + c3 * c.x2 + d3 * c.x, a3 * cy + b3 * c.y1 + c3 * c.y2 + d3 * c.y);
        }
        cx = c.x; cy = c.y;
      } else if (c.type === 'Z') { close(); cx = sx; cy = sy; }
    }
    close();
  }

  // Affine map: x' = a*x + e, y' = d*y + f.
  function transform(cmds, a, d, e, f) {
    return cmds.map(function (c) {
      var n = { type: c.type };
      if (c.x !== undefined) { n.x = a * c.x + e; n.y = d * c.y + f; }
      if (c.x1 !== undefined) { n.x1 = a * c.x1 + e; n.y1 = d * c.y1 + f; }
      if (c.x2 !== undefined) { n.x2 = a * c.x2 + e; n.y2 = d * c.y2 + f; }
      return n;
    });
  }

  function toPathData(cmds, decimals) {
    var f = Math.pow(10, decimals == null ? 2 : decimals);
    function n(v) { var r = Math.round(v * f) / f; return r === 0 ? '0' : String(r); }
    var out = '';
    cmds.forEach(function (c) {
      if (c.type === 'M' || c.type === 'L') out += c.type + n(c.x) + ' ' + n(c.y);
      else if (c.type === 'Q') out += 'Q' + n(c.x1) + ' ' + n(c.y1) + ' ' + n(c.x) + ' ' + n(c.y);
      else if (c.type === 'C') out += 'C' + n(c.x1) + ' ' + n(c.y1) + ' ' + n(c.x2) + ' ' + n(c.y2) + ' ' + n(c.x) + ' ' + n(c.y);
      else if (c.type === 'Z') out += 'Z';
    });
    return out;
  }

  /**
   * Coverage (0..1 per pixel) of filled outlines, nonzero winding like fonts use.
   * Scanline fill on an ss x ss supersampled grid.
   */
  function rasterize(cmds, w, h, ss) {
    ss = ss || 4;
    var W = w * ss, H = h * ss, edges = [];
    flatten(cmds, function (poly) {
      var n = poly.length / 2;
      for (var i = 0; i < n; i++) {
        var j = (i + 1) % n;
        var x0 = poly[i * 2] * ss, y0 = poly[i * 2 + 1] * ss, x1 = poly[j * 2] * ss, y1 = poly[j * 2 + 1] * ss;
        if (y0 === y1) continue;
        var dir = y1 > y0 ? 1 : -1;
        if (dir < 0) { var tx = x0, ty = y0; x0 = x1; y0 = y1; x1 = tx; y1 = ty; }
        edges.push({ y0: y0, y1: y1, x0: x0, k: (x1 - x0) / (y1 - y0), dir: dir });
      }
    }, 10);
    var cov = new Float32Array(w * h), inc = 1 / (ss * ss), xs = [];
    edges.sort(function (a, b) { return a.y0 - b.y0; });
    var active = [], next = 0;
    for (var Y = 0; Y < H; Y++) {
      var sy = Y + 0.5;
      while (next < edges.length && edges[next].y0 <= sy) active.push(edges[next++]);
      xs.length = 0;
      for (var a = active.length - 1; a >= 0; a--) {
        var e = active[a];
        if (e.y1 <= sy) { active.splice(a, 1); continue; }
        if (e.y0 <= sy) xs.push({ x: e.x0 + (sy - e.y0) * e.k, dir: e.dir });
      }
      if (!xs.length) continue;
      xs.sort(function (p, q) { return p.x - q.x; });
      var wind = 0, row = ((Y / ss) | 0) * w;
      for (var q = 0; q < xs.length - 1; q++) {
        wind += xs[q].dir;
        if (!wind) continue;
        var from = Math.max(0, Math.ceil(xs[q].x - 0.5)), to = Math.min(W - 1, Math.ceil(xs[q + 1].x - 0.5) - 1);
        for (var X = from; X <= to; X++) cov[row + ((X / ss) | 0)] += inc;
      }
    }
    return cov;
  }

  // ------------------------------------------------------------------
  // Reading the ink out of an image
  // ------------------------------------------------------------------
  /**
   * Separate text from its background. The background is the most common
   * border color (or transparency); the ink is the most common color among
   * the pixels farthest from it. Each pixel's coverage is how far it sits
   * from the background towards the ink, which undoes anti-aliasing.
   */
  function inkOf(img) {
    var w = img.width, h = img.height, px = img.data, n = w * h, i;
    var border = new Map(), transparentBorder = 0, borderN = 0;
    function key(p) { return (px[p * 4] << 16) | (px[p * 4 + 1] << 8) | px[p * 4 + 2]; }
    function tally(p) {
      borderN++;
      if (px[p * 4 + 3] < 128) { transparentBorder++; return; }
      var k = key(p);
      border.set(k, (border.get(k) || 0) + 1);
    }
    for (i = 0; i < w; i++) { tally(i); tally((h - 1) * w + i); }
    for (i = 1; i < h - 1; i++) { tally(i * w); tally(i * w + w - 1); }
    var cov = new Float32Array(n), bg = null, ink = [0, 0, 0];
    if (transparentBorder * 2 >= borderN) {
      // Transparent background: alpha is the coverage, ink is the most common opaque color.
      var cnt = new Map(), bestK = 0, bestN = -1;
      for (i = 0; i < n; i++) {
        cov[i] = px[i * 4 + 3] / 255;
        if (px[i * 4 + 3] > 200) { var kk = key(i); cnt.set(kk, (cnt.get(kk) || 0) + 1); }
      }
      cnt.forEach(function (v, k) { if (v > bestN) { bestN = v; bestK = k; } });
      ink = [(bestK >> 16) & 255, (bestK >> 8) & 255, bestK & 255];
    } else {
      var bk = 0, bn = -1;
      border.forEach(function (v, k) { if (v > bn) { bn = v; bk = k; } });
      bg = [(bk >> 16) & 255, (bk >> 8) & 255, bk & 255];
      var dist = new Float32Array(n), maxD = 0;
      for (i = 0; i < n; i++) {
        var dr = px[i * 4] - bg[0], dg = px[i * 4 + 1] - bg[1], db = px[i * 4 + 2] - bg[2];
        dist[i] = px[i * 4 + 3] < 128 ? 0 : Math.sqrt(dr * dr + dg * dg + db * db);
        if (dist[i] > maxD) maxD = dist[i];
      }
      if (maxD > 0) {
        var far = new Map(), fk = 0, fn = -1;
        for (i = 0; i < n; i++) if (dist[i] >= maxD * 0.8) { var k2 = key(i); far.set(k2, (far.get(k2) || 0) + 1); }
        far.forEach(function (v, k) { if (v > fn) { fn = v; fk = k; } });
        ink = [(fk >> 16) & 255, (fk >> 8) & 255, fk & 255];
        var ir = ink[0] - bg[0], ig = ink[1] - bg[1], ib = ink[2] - bg[2], L = ir * ir + ig * ig + ib * ib;
        for (i = 0; i < n; i++) {
          if (px[i * 4 + 3] < 128) continue;
          var t = ((px[i * 4] - bg[0]) * ir + (px[i * 4 + 1] - bg[1]) * ig + (px[i * 4 + 2] - bg[2]) * ib) / L;
          cov[i] = t < 0 ? 0 : t > 1 ? 1 : t;
        }
      }
    }
    var x1 = w, y1 = h, x2 = -1, y2 = -1;
    // Sub-pixel ink box: half-covered pixels count as half a pixel.
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (cov[y * w + x] < 0.25) continue;
        if (x < x1) x1 = x; if (x > x2) x2 = x;
        if (y < y1) y1 = y; if (y > y2) y2 = y;
      }
    }
    var box = x2 < 0 ? null : { x1: x1 + 0.5 - edgeCov(cov, w, h, x1, 'x') / 2, y1: y1 + 0.5 - edgeCov(cov, w, h, y1, 'y') / 2,
      x2: x2 + 0.5 + edgeCov(cov, w, h, x2, 'x') / 2, y2: y2 + 0.5 + edgeCov(cov, w, h, y2, 'y') / 2 };
    return { coverage: cov, width: w, height: h, box: box, ink: ink, background: bg };
  }
  // Highest coverage along one column / row, a proxy for how far the edge reaches into that pixel.
  function edgeCov(cov, w, h, at, axis) {
    var m = 0, i;
    if (axis === 'x') for (i = 0; i < h; i++) m = Math.max(m, cov[i * w + at]);
    else for (i = 0; i < w; i++) m = Math.max(m, cov[at * w + i]);
    return m;
  }

  function iou(a, b) {
    var inter = 0, uni = 0;
    for (var i = 0; i < a.length; i++) {
      var x = a[i] > 1 ? 1 : a[i], y = b[i];
      inter += x < y ? x : y;
      uni += x > y ? x : y;
    }
    return uni > 0 ? inter / uni : 0;
  }

  /**
   * Place laid-out text so its bounds fill a box: uniform scale from the
   * height, then letter spacing (and, past a limit, a horizontal stretch)
   * to match the width.
   * @returns layout options plus {x, y} offsets, in the box's units
   */
  function fitToBox(font, text, box, base) {
    var o = opts(base);
    var probe = layout(font, text, Object.assign({}, o, { size: 100, letterSpacing: 0, scaleX: 1 }));
    if (!probe.bbox) return null;
    var bw = probe.bbox.x2 - probe.bbox.x1, bh = probe.bbox.y2 - probe.bbox.y1;
    var tw = box.x2 - box.x1, th = box.y2 - box.y1;
    if (bh <= 0 || bw <= 0 || th <= 0 || tw <= 0) return null;
    var size = 100 * th / bh;
    var longest = 0;
    String(text).split('\n').forEach(function (l) { longest = Math.max(longest, (Array.from ? Array.from(l) : l.split('')).length); });
    var gaps = Math.max(1, longest - 1);
    var ls = (tw - bw * size / 100) / gaps / size;
    ls = Math.max(-0.08, Math.min(0.5, ls));
    var fitted = Object.assign({}, o, { size: size, letterSpacing: ls, scaleX: 1 });
    var lay = layout(font, text, fitted);
    var lw = lay.bbox.x2 - lay.bbox.x1;
    fitted.scaleX = Math.max(0.6, Math.min(1.6, tw / lw));
    lay = layout(font, text, fitted);
    fitted.x = box.x1 - lay.bbox.x1;
    fitted.y = box.y1 - lay.bbox.y1;
    return fitted;
  }

  /**
   * Rank fonts by how closely the typed text overlaps the image's ink. For
   * each font (regular and small-caps lettering) it tries a range of sizes;
   * at each size, letter spacing and a slight stretch match the ink's width,
   * the text is centred on the ink's centre of mass, and the overlap is
   * scored as intersection over union of the two coverage masks.
   * @param {Array<{name, font}>} fonts
   * @returns {{ink, results: Array<{name, index, score, options}>}}
   */
  function match(fonts, text, img, base, onProgress) {
    var ink = inkOf(img), results = [];
    fonts.forEach(function (f, index) {
      if (onProgress) onProgress(index / fonts.length, f.name);
      var r = matchFont(f.font, text, ink, base);
      if (r) { r.name = f.name; r.index = index; results.push(r); }
    });
    results.sort(function (x, y) { return y.score - x.score; });
    return { ink: ink, results: results };
  }

  /** Best fit of one font to the ink from `inkOf`: {score, options} or null. */
  function matchFont(font, text, ink, base) {
    if (!ink.box || !/\S/.test(text)) return null;
    var w = ink.width, h = ink.height;
    if (!ink.centroid) ink.centroid = centroid(ink.coverage, w, h);
    var inkC = ink.centroid, hasLower = /\p{Ll}/u.test(text), best = null;
    [false, true].forEach(function (smallCaps) {
      if (smallCaps && !hasLower) return;
      var b = Object.assign({}, base, { smallCaps: smallCaps });
      var fit = fitToBox(font, text, ink.box, b);
      if (!fit) return;
      var bestHere = null;
      function tryK(k) {
        var cand = fitWidth(font, text, ink.box, b, fit.size * k);
        if (!cand) return;
        var cmds = placed(font, text, cand);
        var c = centroid(rasterize(cmds, w, h, 3), w, h);
        if (c) { cand.y += inkC.y - c.y; cmds = transform(cmds, 1, 1, 0, inkC.y - c.y); }
        var score = iou(rasterize(cmds, w, h, 3), ink.coverage);
        if (!bestHere || score > bestHere.score) bestHere = { k: k, score: score, options: cand };
      }
      for (var k = 0.5; k <= 1.051; k += 0.05) tryK(k);
      if (bestHere) { var k0 = bestHere.k; tryK(k0 - 0.025); tryK(k0 + 0.025); }
      if (bestHere && (!best || bestHere.score > best.score)) best = { score: bestHere.score, options: bestHere.options };
    });
    return best;
  }

  /** Convert fitted options to another pixel scale (e.g. from a downscaled match). */
  function scaleOptions(o, k) {
    var r = Object.assign({}, o);
    r.size = o.size * k; r.x = (o.x || 0) * k; r.y = (o.y || 0) * k;
    return r;
  }

  // At a given size, letter spacing then stretch so the text spans the box's width.
  function fitWidth(font, text, box, base, size) {
    var o = Object.assign(opts(base), { size: size, letterSpacing: 0, scaleX: 1 });
    var lay = layout(font, text, o);
    if (!lay.bbox) return null;
    var tw = box.x2 - box.x1, longest = 0;
    String(text).split('\n').forEach(function (l) { longest = Math.max(longest, (Array.from ? Array.from(l) : l.split('')).length); });
    o.letterSpacing = Math.max(-0.1, Math.min(0.6, (tw - (lay.bbox.x2 - lay.bbox.x1)) / Math.max(1, longest - 1) / size));
    lay = layout(font, text, o);
    o.scaleX = Math.max(0.75, Math.min(1.33, tw / (lay.bbox.x2 - lay.bbox.x1)));
    lay = layout(font, text, o);
    o.x = box.x1 - lay.bbox.x1;
    o.y = box.y1 - lay.bbox.y1;
    return o;
  }

  function centroid(cov, w, h) {
    var sx = 0, sy = 0, s = 0;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var v = cov[y * w + x];
      if (v > 1) v = 1;
      sx += v * (x + 0.5); sy += v * (y + 0.5); s += v;
    }
    return s > 0 ? { x: sx / s, y: sy / s } : null;
  }

  // Layout followed by the fitted offset.
  function placed(font, text, o) {
    var lay = layout(font, text, o);
    return transform(lay.commands, 1, 1, o.x || 0, o.y || 0);
  }

  /**
   * Build Vectorious layers for text.
   * @param {object} o  layout options plus {x, y, fill, background, width, height, padding, decimals}
   * @returns {{open: string, layers: Array, width, height, glyphs}}
   */
  function textLayers(font, text, o) {
    var lay = layout(font, text, o);
    var cmds = lay.commands, w = o.width, h = o.height;
    if (!w || !h) {
      // no canvas given: size the SVG to the text plus padding
      var pad = o.padding == null ? Math.round((o.size || 64) * 0.25) : o.padding;
      var b = lay.bbox || { x1: 0, y1: 0, x2: 0, y2: 0 };
      cmds = transform(cmds, 1, 1, pad - b.x1, pad - b.y1);
      w = Math.max(1, Math.ceil(b.x2 - b.x1 + pad * 2));
      h = Math.max(1, Math.ceil(b.y2 - b.y1 + pad * 2));
    } else {
      cmds = transform(cmds, 1, 1, o.x || 0, o.y || 0);
    }
    var fill = o.fill || '#000000', layers = [];
    if (o.background) {
      layers.push({ id: 'background', name: 'Background', colors: [o.background], count: 1,
        body: '<rect width="' + w + '" height="' + h + '" fill="' + o.background + '"/>' });
    }
    var d = toPathData(cmds, o.decimals == null ? 2 : o.decimals);
    if (d) layers.push({ id: 'text', name: 'Text', colors: [fill], count: lay.glyphs, body: '<path fill="' + fill + '" d="' + d + '"/>' });
    var open = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="' +
      w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">';
    return { open: open, layers: layers, width: w, height: h, glyphs: lay.glyphs };
  }

  // ------------------------------------------------------------------
  // Making a font from traced lettering
  // ------------------------------------------------------------------
  /** Cap height as a fraction of the em (from the font, else measured from "H"). */
  function capRatio(font) {
    var os2 = font.tables && font.tables.os2, upm = font.unitsPerEm || 1000;
    if (os2 && os2.sCapHeight > 0) return os2.sCapHeight / upm;
    var g = font.charToGlyph('H');
    if (g && g.index !== 0) { var b = g.getBoundingBox(); if (b.y2 > 0) return b.y2 / upm; }
    return 0.7;
  }

  /** Height of a lowercase letter over its capital, from the glyphs (e.g. a traced font's small caps). */
  function caseRatio(font) {
    var pairs = ['eE', 'aA', 'vV', 'xX', 'oO', 'cC', 'mM'];
    for (var i = 0; i < pairs.length; i++) {
      var lo = font.charToGlyph(pairs[i][0]), up = font.charToGlyph(pairs[i][1]);
      if (!lo || !up || lo.index === 0 || up.index === 0) continue;
      var a = lo.getBoundingBox(), b = up.getBoundingBox();
      if (b.y2 > 0 && a.y2 > 0) return a.y2 / b.y2;
    }
    return 0;
  }

  /**
   * Group traced shapes into letters, left to right. Shapes that overlap
   * horizontally (the dot of an i, the parts of a broken letter) join one letter.
   * @param {Array<{d, bbox}>} shapes  in image pixels
   */
  function groupLetters(shapes) {
    var list = shapes.filter(function (s) { return s.bbox.x2 > s.bbox.x1 && s.bbox.y2 > s.bbox.y1; })
      .sort(function (a, b) { return a.bbox.x1 - b.bbox.x1; });
    var groups = [];
    list.forEach(function (s) {
      var b = s.bbox, best = null, bestOv = 0;
      groups.forEach(function (g) {
        g.shapes.forEach(function (t) {
          var c = t.bbox, ov = Math.min(b.x2, c.x2) - Math.max(b.x1, c.x1), narrow = Math.min(b.x2 - b.x1, c.x2 - c.x1);
          if (ov > 0 && ov / narrow > bestOv) { bestOv = ov / narrow; best = g; }
        });
      });
      if (best && bestOv >= 0.7) {
        best.shapes.push(s);
        best.x1 = Math.min(best.x1, b.x1); best.x2 = Math.max(best.x2, b.x2);
        best.y1 = Math.min(best.y1, b.y1); best.y2 = Math.max(best.y2, b.y2);
      } else {
        groups.push({ shapes: [s], x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 });
      }
    });
    return groups.sort(function (a, b) { return a.x1 - b.x1; });
  }

  // Cut a letter group in two at the vertical line with the least ink in its
  // middle 30-70%. Outlines are flattened and clipped to each side.
  function splitGroup(g, aim) {
    aim = aim || 0.5;
    var cmds = [];
    g.shapes.forEach(function (s) { cmds = cmds.concat(s.cmds || parsePathData(s.d)); });
    var W = Math.ceil(g.x2 - g.x1) + 1, H = Math.ceil(g.y2 - g.y1) + 1, F = 8;
    var cov = rasterize(transform(cmds, F, 1, -g.x1 * F, -g.y1), W * F, H, 2);
    var col = new Float64Array(W * F);
    for (var y = 0; y < H; y++) for (var x = 0; x < W * F; x++) col[x] += Math.min(1, cov[y * W * F + x]);
    var lo = Math.max(0.15, aim - 0.15), hi = Math.min(0.85, aim + 0.15);
    var from = Math.floor((g.x2 - g.x1) * F * lo), to = Math.ceil((g.x2 - g.x1) * F * hi), cut = -1, low = Infinity;
    for (x = from; x <= to; x++) if (col[x] < low) { low = col[x]; cut = x; }
    if (cut < 0) return null;
    var cx = g.x1 + (cut + 0.5) / F, polys = [];
    flatten(cmds, function (p) { polys.push(p); }, 12);
    function side(keepLeft) {
      var out = [];
      polys.forEach(function (p) {
        var c = clipX(p, cx, keepLeft);
        if (c.length >= 6) {
          out.push({ type: 'M', x: c[0], y: c[1] });
          for (var i = 2; i < c.length; i += 2) out.push({ type: 'L', x: c[i], y: c[i + 1] });
          out.push({ type: 'Z' });
        }
      });
      if (!out.length) return null;
      var b = bounds(out);
      return { shapes: [{ cmds: out, bbox: b }], x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, split: true };
    }
    var l = side(true), r = side(false);
    return l && r ? [l, r] : null;
  }

  // Sutherland-Hodgman against the half-plane x <= c (or x >= c).
  function clipX(p, c, keepLeft) {
    var out = [], n = p.length / 2;
    function inside(x) { return keepLeft ? x <= c : x >= c; }
    for (var i = 0; i < n; i++) {
      var ax = p[i * 2], ay = p[i * 2 + 1], j = (i + 1) % n, bx = p[j * 2], by = p[j * 2 + 1];
      var ai = inside(ax), bi = inside(bx);
      if (ai) out.push(ax, ay);
      if (ai !== bi) { var t = (c - ax) / (bx - ax); out.push(c, ay + t * (by - ay)); }
    }
    return out;
  }

  function median(a) {
    if (!a.length) return 0;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /**
   * Build an OpenType font from lettering traced out of an image.
   * @param {object} opentype  the opentype.js module
   * @param {Array<{d, bbox}>} shapes  traced ink shapes, image pixels (y down)
   * @param {string} text  the characters in the image, in order (spaces mark word gaps)
   * @param {object} [o]  { familyName, fillCase (default true) }
   * @returns {{font, chars: string[], synthesized: string[], pxPerUnit: number, problems?: string}}
   */
  function fontFromShapes(opentype, shapes, text, o) {
    o = o || {};
    var chars = Array.from(String(text).replace(/\s+/g, ' ').trim());
    var labels = chars.filter(function (c) { return c !== ' '; });
    var groups = groupLetters(shapes);
    if (!labels.length) throw new Error('Type the characters that are in the image first.');
    if (groups.length > labels.length) {
      // drop the smallest specks first
      groups.sort(function (a, b) { return (b.x2 - b.x1) * (b.y2 - b.y1) - (a.x2 - a.x1) * (a.y2 - a.y1); });
      groups = groups.slice(0, labels.length).sort(function (a, b) { return a.x1 - b.x1; });
    }
    while (groups.length < labels.length) {
      // letters that touch: cut the widest group at its thinnest column
      var widths = groups.map(function (g) { return g.x2 - g.x1; }), mw = median(widths), wi = 0;
      for (var q = 1; q < groups.length; q++) if (widths[q] > widths[wi]) wi = q;
      if (widths[wi] < mw * 1.3) break;
      // Groups before it are taken to be one letter each, so it holds labels wi and wi+1.
      // Aim the cut using the width of another copy of either letter, when there is one.
      var aim = 0.5, gw = widths[wi];
      var other = function (ch) {
        var ws = [];
        groups.forEach(function (g, gi2) {
          var lab = gi2 < wi ? labels[gi2] : gi2 > wi ? labels[gi2 + 1] : null;
          if (lab === ch) ws.push(g.x2 - g.x1);
        });
        return ws.length ? median(ws) : 0;
      };
      var rightW = other(labels[wi + 1]), leftW = other(labels[wi]);
      if (rightW && rightW < gw) aim = (gw - rightW) / gw;
      else if (leftW && leftW < gw) aim = leftW / gw;
      var halves = splitGroup(groups[wi], aim);
      if (!halves) break;
      groups.splice(wi, 1, halves[0], halves[1]);
    }
    if (groups.length < labels.length) {
      throw new Error('Found ' + groups.length + ' letters in the image but ' + labels.length +
        ' characters in the text. Letters that touch count as one; check the spelling, or trace at a higher resolution.');
    }
    groups.forEach(function (g, i) { g.ch = labels[i]; });

    // baseline: where most letters stop (descenders and punctuation stick out)
    var DESC = /[gjpqy,;]/;
    var bottoms = groups.filter(function (g) { return !DESC.test(g.ch); }).map(function (g) { return g.y2; });
    var baseline = median(bottoms.length ? bottoms : groups.map(function (g) { return g.y2; }));
    var upperH = groups.filter(function (g) { return /\p{Lu}/u.test(g.ch); }).map(function (g) { return baseline - g.y1; });
    var lowerH = groups.filter(function (g) { return /\p{Ll}/u.test(g.ch) && !/[bdfhklt]/.test(g.ch); }).map(function (g) { return baseline - g.y1; });
    var capPx = upperH.length ? median(upperH) : lowerH.length ? median(lowerH) / 0.72 : median(groups.map(function (g) { return g.y2 - g.y1; }));
    var xPx = lowerH.length ? median(lowerH) : capPx * 0.72;
    // A letter's width comes from its body (the parts that reach down to the
    // baseline area); dots and accents above it may overhang, as in the image.
    groups.forEach(function (g) {
      var bx1 = Infinity, bx2 = -Infinity;
      g.shapes.forEach(function (s) {
        if (s.bbox.y2 < baseline - capPx * 0.35) return;
        bx1 = Math.min(bx1, s.bbox.x1); bx2 = Math.max(bx2, s.bbox.x2);
      });
      g.bx1 = bx1 === Infinity ? g.x1 : bx1;
      g.bx2 = bx2 === -Infinity ? g.x2 : bx2;
    });
    // gaps between neighbours, split into letter gaps and word gaps
    var letterGaps = [], wordGaps = [], gi = 0;
    for (var ci = 0; ci < chars.length; ci++) {
      if (chars[ci] === ' ') continue;
      if (gi > 0) {
        var gap = groups[gi].bx1 - groups[gi - 1].bx2;
        (chars[ci - 1] === ' ' ? wordGaps : letterGaps).push(gap);
      }
      gi++;
    }
    var letterGap = Math.max(0, median(letterGaps));
    if (!letterGaps.length) letterGap = median(groups.map(function (g) { return g.y2 - g.y1; })) * 0.12;
    var spacePx = wordGaps.length ? Math.max(letterGap, median(wordGaps) - letterGap) : median(groups.map(function (g) { return g.x2 - g.x1; })) * 0.6;

    var upm = 1000, k = 700 / capPx; // font units per pixel; cap height = 700
    var side = Math.round(letterGap * k / 2);

    // one sample per character: the median-sized instance
    var byChar = {};
    groups.forEach(function (g) { (byChar[g.ch] = byChar[g.ch] || []).push(g); });
    function toPath(g, scale, shiftY) {
      var path = new opentype.Path();
      g.shapes.forEach(function (s) {
        (s.cmds || parsePathData(s.d)).forEach(function (c) {
          function X(v) { return Math.round(((v - g.bx1) * k) * scale + side); }
          function Y(v) { return Math.round(((baseline - v) * k) * scale + (shiftY || 0)); }
          if (c.type === 'M') path.moveTo(X(c.x), Y(c.y));
          else if (c.type === 'L') path.lineTo(X(c.x), Y(c.y));
          else if (c.type === 'C') path.curveTo(X(c.x1), Y(c.y1), X(c.x2), Y(c.y2), X(c.x), Y(c.y));
          else if (c.type === 'Q') path.quadraticCurveTo(X(c.x1), Y(c.y1), X(c.x), Y(c.y));
          else if (c.type === 'Z') path.close();
        });
      });
      return path;
    }
    var glyphs = [
      new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: Math.round(capPx * k * 0.6), path: new opentype.Path() }),
      new opentype.Glyph({ name: 'space', unicode: 32, advanceWidth: Math.max(1, Math.round(spacePx * k)), path: new opentype.Path() })
    ];
    var made = {}, synthesized = [];
    function add(ch, g, scale) {
      if (made[ch] || ch === ' ') return;
      made[ch] = 1;
      glyphs.push(new opentype.Glyph({
        name: 'uni' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'),
        unicode: ch.codePointAt(0),
        advanceWidth: Math.round((g.bx2 - g.bx1) * k * scale + side * 2),
        path: toPath(g, scale)
      }));
    }
    Object.keys(byChar).forEach(function (ch) {
      var whole = byChar[ch].filter(function (g) { return !g.split; });
      var list = (whole.length ? whole : byChar[ch]).slice().sort(function (a, b) { return (a.x2 - a.x1) * (a.y2 - a.y1) - (b.x2 - b.x1) * (b.y2 - b.y1); });
      byChar[ch].rep = list[(list.length - 1) >> 1];
      add(ch, byChar[ch].rep, 1);
    });
    if (o.fillCase !== false) {
      // the other case of each letter, scaled between cap height and x-height
      Object.keys(byChar).forEach(function (ch) {
        var up = ch.toUpperCase(), lo = ch.toLowerCase(), g = byChar[ch].rep;
        if (up !== ch && up.length === 1 && !byChar[up]) { add(up, g, capPx / xPx); synthesized.push(up); }
        if (lo !== ch && lo.length === 1 && !byChar[lo]) { add(lo, g, xPx / capPx); synthesized.push(lo); }
      });
    }
    var family = o.familyName || 'Traced lettering';
    var font = new opentype.Font({
      familyName: family,
      styleName: 'Regular',
      unitsPerEm: upm,
      ascender: Math.round(Math.max(800, (baseline - Math.min.apply(null, groups.map(function (g) { return g.y1; }))) * k + 50)),
      descender: -Math.round(Math.max(200, (Math.max.apply(null, groups.map(function (g) { return g.y2; })) - baseline) * k + 50)),
      designer: 'Traced with Vectorious',
      description: 'Letters traced from an image with Vectorious.',
      glyphs: glyphs
    });
    // Write it out and read it back: the parsed font has real cmap, OS/2 and
    // metrics tables and behaves exactly like the downloaded .otf.
    var buf = font.toArrayBuffer(), parsed = opentype.parse(buf);
    if (parsed.tables.os2) { parsed.tables.os2.sCapHeight = 700; parsed.tables.os2.sxHeight = Math.round(xPx * k); }
    return {
      font: parsed,
      buffer: buf,
      chars: Object.keys(made).sort(),
      synthesized: synthesized.sort(),
      pxPerUnit: 1 / k,
      sizePx: upm / k,   // font size in px that reproduces the image's lettering
      baseline: baseline
    };
  }

  /** Parse absolute SVG path data (M L H V C Q Z, as Vectorious writes it) into commands. */
  function parsePathData(d) {
    var toks = String(d).match(/[MLHVCQZmlhvcqz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) || [];
    var out = [], i = 0, cmd = null, x = 0, y = 0, sx = 0, sy = 0;
    function num() { return +toks[i++]; }
    while (i < toks.length) {
      if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
      var C = cmd.toUpperCase();
      if (C !== cmd) throw new Error('relative path commands are not supported');
      if (C === 'M') { x = num(); y = num(); sx = x; sy = y; out.push({ type: 'M', x: x, y: y }); cmd = 'L'; }
      else if (C === 'L') { x = num(); y = num(); out.push({ type: 'L', x: x, y: y }); }
      else if (C === 'H') { x = num(); out.push({ type: 'L', x: x, y: y }); }
      else if (C === 'V') { y = num(); out.push({ type: 'L', x: x, y: y }); }
      else if (C === 'C') { var c1x = num(), c1y = num(), c2x = num(), c2y = num(); x = num(); y = num(); out.push({ type: 'C', x1: c1x, y1: c1y, x2: c2x, y2: c2y, x: x, y: y }); }
      else if (C === 'Q') { var qx = num(), qy = num(); x = num(); y = num(); out.push({ type: 'Q', x1: qx, y1: qy, x: x, y: y }); }
      else if (C === 'Z') { out.push({ type: 'Z' }); x = sx; y = sy; }
    }
    return out;
  }

  function hex(c) {
    return '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1);
  }

  var api = {
    DEFAULTS: DEFAULTS,
    layout: layout,
    bounds: bounds,
    transform: transform,
    toPathData: toPathData,
    rasterize: rasterize,
    inkOf: inkOf,
    iou: iou,
    fitToBox: fitToBox,
    match: match,
    matchFont: matchFont,
    scaleOptions: scaleOptions,
    placed: placed,
    textLayers: textLayers,
    parsePathData: parsePathData,
    capRatio: capRatio,
    caseRatio: caseRatio,
    groupLetters: groupLetters,
    fontFromShapes: fontFromShapes,
    hex: hex
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VectoriousText = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
