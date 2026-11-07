/*
 * Vectorious tracing engine.
 *
 * Pure, dependency-free JavaScript. No machine learning: the pipeline is
 *   1. optional denoise (separable box blur)
 *   2. color quantization (k-means++ in the OKLab perceptual color space,
 *      or an exact palette when the image has few colors)
 *   3. speckle removal (merge tiny connected regions into their neighbours)
 *   4. per-color bitmap tracing with an implementation of the Potrace
 *      algorithm (Selinger, 2003): path decomposition, optimal polygon,
 *      vertex adjustment, corner detection / Bezier smoothing and curve
 *      optimization
 *   5. SVG assembly (stacked layers so adjacent shapes never leave gaps)
 *
 * Works in a browser window, a Web Worker, or Node (for tests).
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  function mod(a, n) {
    return a >= n ? a % n : a >= 0 ? a : n - 1 - ((-1 - a) % n);
  }
  function sign(x) { return x > 0 ? 1 : x < 0 ? -1 : 0; }
  function Pt(x, y) { this.x = x; this.y = y; }
  Pt.prototype.copy = function () { return new Pt(this.x, this.y); };

  function xprod(p1, p2) { return p1.x * p2.y - p1.y * p2.x; }
  function cyclic(a, b, c) {
    if (a <= c) return a <= b && b < c;
    return a <= b || b < c;
  }
  function interval(l, a, b) { return new Pt(a.x + l * (b.x - a.x), a.y + l * (b.y - a.y)); }
  function dorthInfty(p0, p2) { return new Pt(-sign(p2.y - p0.y), sign(p2.x - p0.x)); }
  function dpara(p0, p1, p2) {
    return (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
  }
  function ddenom(p0, p2) {
    var r = dorthInfty(p0, p2);
    return r.y * (p2.x - p0.x) - r.x * (p2.y - p0.y);
  }
  function cprod(p0, p1, p2, p3) {
    return (p1.x - p0.x) * (p3.y - p2.y) - (p3.x - p2.x) * (p1.y - p0.y);
  }
  function iprod(p0, p1, p2) {
    return (p1.x - p0.x) * (p2.x - p0.x) + (p1.y - p0.y) * (p2.y - p0.y);
  }
  function iprod1(p0, p1, p2, p3) {
    return (p1.x - p0.x) * (p3.x - p2.x) + (p1.y - p0.y) * (p3.y - p2.y);
  }
  function ddist(p, q) {
    var dx = p.x - q.x, dy = p.y - q.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function bezier(t, p0, p1, p2, p3) {
    var s = 1 - t, a = s * s * s, b = 3 * s * s * t, c = 3 * t * t * s, d = t * t * t;
    return new Pt(a * p0.x + b * p1.x + c * p2.x + d * p3.x,
                  a * p0.y + b * p1.y + c * p2.y + d * p3.y);
  }
  function tangent(p0, p1, p2, p3, q0, q1) {
    var A = cprod(p0, p1, q0, q1), B = cprod(p1, p2, q0, q1), C = cprod(p2, p3, q0, q1);
    var a = A - 2 * B + C, b = -2 * A + 2 * B, c = A;
    var d = b * b - 4 * a * c;
    if (a === 0 || d < 0) return -1;
    var s = Math.sqrt(d);
    var r1 = (-b + s) / (2 * a), r2 = (-b - s) / (2 * a);
    if (r1 >= 0 && r1 <= 1) return r1;
    if (r2 >= 0 && r2 <= 1) return r2;
    return -1;
  }

  // Deterministic PRNG (mulberry32) so the same settings give the same SVG.
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------------
  // Potrace: bitmap -> list of closed Bezier curves
  // ------------------------------------------------------------------
  function Curve(n) {
    this.n = n;
    this.tag = new Array(n);
    this.c = new Array(n * 3);
    this.alphaCurve = 0;
    this.vertex = new Array(n);
    this.alpha = new Array(n);
    this.alpha0 = new Array(n);
    this.beta = new Array(n);
  }

  /**
   * Trace a binary bitmap.
   * @param {Uint8Array} data  w*h, 1 = foreground
   * @param {object} o  { turdsize, turnpolicy, alphamax, opticurve, opttolerance, polygonOnly }
   * @returns {Array} paths with .curve (or .pt when polygonOnly)
   */
  function potrace(data, w, h, o) {
    var turdsize = o.turdsize == null ? 2 : o.turdsize;
    var turnpolicy = o.turnpolicy || 'minority';
    var alphamax = o.alphamax == null ? 1 : o.alphamax;
    var opticurve = o.opticurve !== false;
    var opttolerance = o.opttolerance == null ? 0.2 : o.opttolerance;

    var bm1 = new Uint8Array(data); // working copy, gets XOR-ed as paths are removed
    function at(x, y) { return x >= 0 && x < w && y >= 0 && y < h && bm1[w * y + x] === 1; }
    function atOrig(x, y) { return x >= 0 && x < w && y >= 0 && y < h && data[w * y + x] === 1; }

    function majority(x, y) {
      for (var i = 2; i < 5; i++) {
        var ct = 0;
        for (var a = -i + 1; a <= i - 1; a++) {
          ct += at(x + a, y + i - 1) ? 1 : -1;
          ct += at(x + i - 1, y + a - 1) ? 1 : -1;
          ct += at(x + a - 1, y - i) ? 1 : -1;
          ct += at(x - i, y + a) ? 1 : -1;
        }
        if (ct > 0) return 1;
        if (ct < 0) return 0;
      }
      return 0;
    }

    function findPath(px, py) {
      var path = { pt: [], len: 0, area: 0, sign: atOrig(px, py) ? '+' : '-', minX: 1e9, minY: 1e9, maxX: -1, maxY: -1 };
      var x = px, y = py, dirx = 0, diry = 1, tmp;
      for (;;) {
        path.pt.push(new Pt(x, y));
        if (x > path.maxX) path.maxX = x;
        if (x < path.minX) path.minX = x;
        if (y > path.maxY) path.maxY = y;
        if (y < path.minY) path.minY = y;
        path.len++;
        x += dirx; y += diry;
        path.area -= x * diry;
        if (x === px && y === py) break;
        var l = at(x + (dirx + diry - 1) / 2, y + (diry - dirx - 1) / 2);
        var r = at(x + (dirx - diry - 1) / 2, y + (diry + dirx - 1) / 2);
        if (r && !l) {
          if (turnpolicy === 'right' ||
              (turnpolicy === 'black' && path.sign === '+') ||
              (turnpolicy === 'white' && path.sign === '-') ||
              (turnpolicy === 'majority' && majority(x, y)) ||
              (turnpolicy === 'minority' && !majority(x, y))) {
            tmp = dirx; dirx = -diry; diry = tmp;
          } else {
            tmp = dirx; dirx = diry; diry = -tmp;
          }
        } else if (r) {
          tmp = dirx; dirx = -diry; diry = tmp;
        } else if (!l) {
          tmp = dirx; dirx = diry; diry = -tmp;
        }
      }
      path.area = Math.abs(path.area);
      return path;
    }

    function xorPath(path) {
      var y1 = path.pt[0].y, len = path.len;
      for (var i = 1; i < len; i++) {
        var x = path.pt[i].x, y = path.pt[i].y;
        if (y !== y1) {
          var minY = y1 < y ? y1 : y, maxX = path.maxX, row = minY * w;
          for (var j = x; j < maxX; j++) bm1[row + j] ^= 1;
          y1 = y;
        }
      }
    }

    // --- stage 1: path decomposition
    var pathlist = [];
    var idx = 0, total = w * h;
    for (;;) {
      while (idx < total && bm1[idx] !== 1) idx++;
      if (idx >= total) break;
      var sx = idx % w, sy = (idx / w) | 0;
      var path = findPath(sx, sy);
      xorPath(path);
      if (path.area > turdsize) pathlist.push(path);
    }

    if (o.polygonOnly) return pathlist;

    // --- stage 2..5 per path
    for (var pi = 0; pi < pathlist.length; pi++) processPath(pathlist[pi]);
    return pathlist;

    function processPath(path) {
      calcSums(path);
      calcLon(path);
      bestPolygon(path);
      adjustVertices(path);
      if (path.sign === '-') reverse(path);
      smooth(path);
      if (opticurve) optiCurve(path);
    }

    function calcSums(path) {
      path.x0 = path.pt[0].x;
      path.y0 = path.pt[0].y;
      var n = path.len;
      var sx = new Float64Array(n + 1), sy = new Float64Array(n + 1),
          sxy = new Float64Array(n + 1), sx2 = new Float64Array(n + 1), sy2 = new Float64Array(n + 1);
      for (var i = 0; i < n; i++) {
        var x = path.pt[i].x - path.x0, y = path.pt[i].y - path.y0;
        sx[i + 1] = sx[i] + x;
        sy[i + 1] = sy[i] + y;
        sxy[i + 1] = sxy[i] + x * y;
        sx2[i + 1] = sx2[i] + x * x;
        sy2[i + 1] = sy2[i] + y * y;
      }
      path.sums = { x: sx, y: sy, xy: sxy, x2: sx2, y2: sy2 };
    }

    function calcLon(path) {
      var n = path.len, pt = path.pt, dir,
          pivk = new Int32Array(n), nc = new Int32Array(n), ct = [0, 0, 0, 0];
      path.lon = new Int32Array(n);
      var constraint = [new Pt(0, 0), new Pt(0, 0)], cur = new Pt(0, 0), off = new Pt(0, 0), dk = new Pt(0, 0);
      var foundk, i, j, k1, a, b, c, d, k = 0;

      for (i = n - 1; i >= 0; i--) {
        if (pt[i].x !== pt[k].x && pt[i].y !== pt[k].y) k = i + 1;
        nc[i] = k;
      }

      for (i = n - 1; i >= 0; i--) {
        ct[0] = ct[1] = ct[2] = ct[3] = 0;
        dir = (3 + 3 * (pt[mod(i + 1, n)].x - pt[i].x) + (pt[mod(i + 1, n)].y - pt[i].y)) / 2;
        ct[dir]++;
        constraint[0].x = 0; constraint[0].y = 0;
        constraint[1].x = 0; constraint[1].y = 0;
        k = nc[i];
        k1 = i;
        foundk = 0;
        for (;;) {
          dir = (3 + 3 * sign(pt[k].x - pt[k1].x) + sign(pt[k].y - pt[k1].y)) / 2;
          ct[dir]++;
          if (ct[0] && ct[1] && ct[2] && ct[3]) {
            pivk[i] = k1;
            foundk = 1;
            break;
          }
          cur.x = pt[k].x - pt[i].x;
          cur.y = pt[k].y - pt[i].y;
          if (xprod(constraint[0], cur) < 0 || xprod(constraint[1], cur) > 0) break;
          if (!(Math.abs(cur.x) <= 1 && Math.abs(cur.y) <= 1)) {
            off.x = cur.x + ((cur.y >= 0 && (cur.y > 0 || cur.x < 0)) ? 1 : -1);
            off.y = cur.y + ((cur.x <= 0 && (cur.x < 0 || cur.y < 0)) ? 1 : -1);
            if (xprod(constraint[0], off) >= 0) { constraint[0].x = off.x; constraint[0].y = off.y; }
            off.x = cur.x + ((cur.y <= 0 && (cur.y < 0 || cur.x < 0)) ? 1 : -1);
            off.y = cur.y + ((cur.x >= 0 && (cur.x > 0 || cur.y < 0)) ? 1 : -1);
            if (xprod(constraint[1], off) <= 0) { constraint[1].x = off.x; constraint[1].y = off.y; }
          }
          k1 = k;
          k = nc[k1];
          if (!cyclic(k, i, k1)) break;
        }
        if (foundk === 0) {
          dk.x = sign(pt[k].x - pt[k1].x);
          dk.y = sign(pt[k].y - pt[k1].y);
          cur.x = pt[k1].x - pt[i].x;
          cur.y = pt[k1].y - pt[i].y;
          a = xprod(constraint[0], cur);
          b = xprod(constraint[0], dk);
          c = xprod(constraint[1], cur);
          d = xprod(constraint[1], dk);
          j = 10000000;
          if (b < 0) j = Math.floor(a / -b);
          if (d > 0) j = Math.min(j, Math.floor(-c / d));
          pivk[i] = mod(k1 + j, n);
        }
      }

      j = pivk[n - 1];
      path.lon[n - 1] = j;
      for (i = n - 2; i >= 0; i--) {
        if (cyclic(i + 1, pivk[i], j)) j = pivk[i];
        path.lon[i] = j;
      }
      for (i = n - 1; cyclic(mod(i + 1, n), j, path.lon[i]); i--) path.lon[i] = j;
    }

    function penalty3(path, i, j) {
      var n = path.len, pt = path.pt, s = path.sums, r = 0, x, y, xy, x2, y2, k;
      if (j >= n) { j -= n; r = 1; }
      if (r === 0) {
        x = s.x[j + 1] - s.x[i];
        y = s.y[j + 1] - s.y[i];
        x2 = s.x2[j + 1] - s.x2[i];
        xy = s.xy[j + 1] - s.xy[i];
        y2 = s.y2[j + 1] - s.y2[i];
        k = j + 1 - i;
      } else {
        x = s.x[j + 1] - s.x[i] + s.x[n];
        y = s.y[j + 1] - s.y[i] + s.y[n];
        x2 = s.x2[j + 1] - s.x2[i] + s.x2[n];
        xy = s.xy[j + 1] - s.xy[i] + s.xy[n];
        y2 = s.y2[j + 1] - s.y2[i] + s.y2[n];
        k = j + 1 - i + n;
      }
      var px = (pt[i].x + pt[j].x) / 2 - pt[0].x;
      var py = (pt[i].y + pt[j].y) / 2 - pt[0].y;
      var ey = pt[j].x - pt[i].x;
      var ex = -(pt[j].y - pt[i].y);
      var a = (x2 - 2 * x * px) / k + px * px;
      var b = (xy - x * py - y * px) / k + px * py;
      var c = (y2 - 2 * y * py) / k + py * py;
      var sq = ex * ex * a + 2 * ex * ey * b + ey * ey * c;
      return Math.sqrt(sq > 0 ? sq : 0);
    }

    function bestPolygon(path) {
      var i, j, m, k, n = path.len;
      var pen = new Float64Array(n + 1), prev = new Int32Array(n + 1), clip0 = new Int32Array(n),
          clip1 = new Int32Array(n + 1), seg0 = new Int32Array(n + 1), seg1 = new Int32Array(n + 1);
      var thispen, best, c;

      for (i = 0; i < n; i++) {
        c = mod(path.lon[mod(i - 1, n)] - 1, n);
        if (c === i) c = mod(i + 1, n);
        clip0[i] = c < i ? n : c;
      }
      j = 1;
      for (i = 0; i < n; i++) {
        while (j <= clip0[i]) { clip1[j] = i; j++; }
      }
      i = 0;
      for (j = 0; i < n; j++) { seg0[j] = i; i = clip0[i]; }
      seg0[j] = n;
      m = j;
      i = n;
      for (j = m; j > 0; j--) { seg1[j] = i; i = clip1[i]; }
      seg1[0] = 0;

      pen[0] = 0;
      for (j = 1; j <= m; j++) {
        for (i = seg1[j]; i <= seg0[j]; i++) {
          best = -1;
          for (k = seg0[j - 1]; k >= clip1[i]; k--) {
            thispen = penalty3(path, k, i) + pen[k];
            if (best < 0 || thispen < best) { prev[i] = k; best = thispen; }
          }
          pen[i] = best;
        }
      }
      path.m = m;
      path.po = new Int32Array(m);
      for (i = n, j = m - 1; i > 0; j--) { i = prev[i]; path.po[j] = i; }
    }

    function pointslope(path, i, j, ctr, dir) {
      var n = path.len, s = path.sums, r = 0, l = 0;
      while (j >= n) { j -= n; r += 1; }
      while (i >= n) { i -= n; r -= 1; }
      while (j < 0) { j += n; r -= 1; }
      while (i < 0) { i += n; r += 1; }
      var x = s.x[j + 1] - s.x[i] + r * s.x[n];
      var y = s.y[j + 1] - s.y[i] + r * s.y[n];
      var x2 = s.x2[j + 1] - s.x2[i] + r * s.x2[n];
      var xy = s.xy[j + 1] - s.xy[i] + r * s.xy[n];
      var y2 = s.y2[j + 1] - s.y2[i] + r * s.y2[n];
      var k = j + 1 - i + r * n;
      ctr.x = x / k;
      ctr.y = y / k;
      var a = (x2 - x * x / k) / k, b = (xy - x * y / k) / k, c = (y2 - y * y / k) / k;
      var lambda2 = (a + c + Math.sqrt((a - c) * (a - c) + 4 * b * b)) / 2;
      a -= lambda2;
      c -= lambda2;
      if (Math.abs(a) >= Math.abs(c)) {
        l = Math.sqrt(a * a + b * b);
        if (l !== 0) { dir.x = -b / l; dir.y = a / l; }
      } else {
        l = Math.sqrt(c * c + b * b);
        if (l !== 0) { dir.x = -c / l; dir.y = b / l; }
      }
      if (l === 0) { dir.x = 0; dir.y = 0; }
    }

    function quadform(Q, wx, wy) {
      var v0 = wx, v1 = wy, v2 = 1;
      return v0 * (Q[0] * v0 + Q[1] * v1 + Q[2] * v2) +
             v1 * (Q[3] * v0 + Q[4] * v1 + Q[5] * v2) +
             v2 * (Q[6] * v0 + Q[7] * v1 + Q[8] * v2);
    }

    function adjustVertices(path) {
      var m = path.m, po = path.po, n = path.len, pt = path.pt, x0 = path.x0, y0 = path.y0;
      var ctr = new Array(m), dir = new Array(m), q = new Array(m), v = [0, 0, 0], d, i, j, k, l;
      var s = new Pt(0, 0);
      path.curve = new Curve(m);

      for (i = 0; i < m; i++) {
        j = po[mod(i + 1, m)];
        j = mod(j - po[i], n) + po[i];
        ctr[i] = new Pt(0, 0);
        dir[i] = new Pt(0, 0);
        pointslope(path, po[i], j, ctr[i], dir[i]);
      }

      for (i = 0; i < m; i++) {
        q[i] = new Float64Array(9);
        d = dir[i].x * dir[i].x + dir[i].y * dir[i].y;
        if (d !== 0) {
          v[0] = dir[i].y;
          v[1] = -dir[i].x;
          v[2] = -v[1] * ctr[i].y - v[0] * ctr[i].x;
          for (l = 0; l < 3; l++) for (k = 0; k < 3; k++) q[i][l * 3 + k] = v[l] * v[k] / d;
        }
      }

      var Q = new Float64Array(9), wx, wy, dx, dy, det, min, cand, xmin, ymin, z;
      for (i = 0; i < m; i++) {
        s.x = pt[po[i]].x - x0;
        s.y = pt[po[i]].y - y0;
        j = mod(i - 1, m);
        for (l = 0; l < 9; l++) Q[l] = q[j][l] + q[i][l];

        for (;;) {
          det = Q[0] * Q[4] - Q[1] * Q[3];
          if (det !== 0) {
            wx = (-Q[2] * Q[4] + Q[5] * Q[1]) / det;
            wy = (Q[2] * Q[3] - Q[5] * Q[0]) / det;
            break;
          }
          if (Q[0] > Q[4]) { v[0] = -Q[1]; v[1] = Q[0]; }
          else if (Q[4]) { v[0] = -Q[4]; v[1] = Q[3]; }
          else { v[0] = 1; v[1] = 0; }
          d = v[0] * v[0] + v[1] * v[1];
          v[2] = -v[1] * s.y - v[0] * s.x;
          for (l = 0; l < 3; l++) for (k = 0; k < 3; k++) Q[l * 3 + k] += v[l] * v[k] / d;
        }

        dx = Math.abs(wx - s.x);
        dy = Math.abs(wy - s.y);
        if (dx <= 0.5 && dy <= 0.5) {
          path.curve.vertex[i] = new Pt(wx + x0, wy + y0);
          continue;
        }

        min = quadform(Q, s.x, s.y);
        xmin = s.x;
        ymin = s.y;

        if (Q[0] !== 0) {
          for (z = 0; z < 2; z++) {
            wy = s.y - 0.5 + z;
            wx = -(Q[1] * wy + Q[2]) / Q[0];
            dx = Math.abs(wx - s.x);
            cand = quadform(Q, wx, wy);
            if (dx <= 0.5 && cand < min) { min = cand; xmin = wx; ymin = wy; }
          }
        }
        if (Q[4] !== 0) {
          for (z = 0; z < 2; z++) {
            wx = s.x - 0.5 + z;
            wy = -(Q[3] * wx + Q[5]) / Q[4];
            dy = Math.abs(wy - s.y);
            cand = quadform(Q, wx, wy);
            if (dy <= 0.5 && cand < min) { min = cand; xmin = wx; ymin = wy; }
          }
        }
        for (l = 0; l < 2; l++) {
          for (k = 0; k < 2; k++) {
            wx = s.x - 0.5 + l;
            wy = s.y - 0.5 + k;
            cand = quadform(Q, wx, wy);
            if (cand < min) { min = cand; xmin = wx; ymin = wy; }
          }
        }
        path.curve.vertex[i] = new Pt(xmin + x0, ymin + y0);
      }
    }

    function reverse(path) {
      var v = path.curve.vertex, m = path.curve.n, i, j, tmp;
      for (i = 0, j = m - 1; i < j; i++, j--) { tmp = v[i]; v[i] = v[j]; v[j] = tmp; }
    }

    function smooth(path) {
      var curve = path.curve, m = curve.n, i, j, k, dd, denom, alpha, p2, p3, p4;
      for (i = 0; i < m; i++) {
        j = mod(i + 1, m);
        k = mod(i + 2, m);
        p4 = interval(0.5, curve.vertex[k], curve.vertex[j]);
        denom = ddenom(curve.vertex[i], curve.vertex[k]);
        if (denom !== 0) {
          dd = Math.abs(dpara(curve.vertex[i], curve.vertex[j], curve.vertex[k]) / denom);
          alpha = dd > 1 ? (1 - 1 / dd) : 0;
          alpha = alpha / 0.75;
        } else {
          alpha = 4 / 3;
        }
        curve.alpha0[j] = alpha;
        if (alpha >= alphamax) {
          curve.tag[j] = 'CORNER';
          curve.c[3 * j + 1] = curve.vertex[j];
          curve.c[3 * j + 2] = p4;
        } else {
          if (alpha < 0.55) alpha = 0.55;
          else if (alpha > 1) alpha = 1;
          p2 = interval(0.5 + 0.5 * alpha, curve.vertex[i], curve.vertex[j]);
          p3 = interval(0.5 + 0.5 * alpha, curve.vertex[k], curve.vertex[j]);
          curve.tag[j] = 'CURVE';
          curve.c[3 * j] = p2;
          curve.c[3 * j + 1] = p3;
          curve.c[3 * j + 2] = p4;
        }
        curve.alpha[j] = alpha;
        curve.beta[j] = 0.5;
      }
      curve.alphaCurve = 1;
    }

    function Opti() { this.pen = 0; this.c = [new Pt(0, 0), new Pt(0, 0)]; this.t = 0; this.s = 0; this.alpha = 0; }

    function optiPenalty(path, i, j, res, convc, areac) {
      var curve = path.curve, m = curve.n, vertex = curve.vertex;
      var k, k1, k2, conv, i1, area, alpha, d, d1, d2, p0, p1, p2, p3, pt, A, R, A1, A2, A3, A4, s, t;
      if (i === j) return 1;
      k = i;
      i1 = mod(i + 1, m);
      k1 = mod(k + 1, m);
      conv = convc[k1];
      if (conv === 0) return 1;
      d = ddist(vertex[i], vertex[i1]);
      for (k = k1; k !== j; k = k1) {
        k1 = mod(k + 1, m);
        k2 = mod(k + 2, m);
        if (convc[k1] !== conv) return 1;
        if (sign(cprod(vertex[i], vertex[i1], vertex[k1], vertex[k2])) !== conv) return 1;
        if (iprod1(vertex[i], vertex[i1], vertex[k1], vertex[k2]) <
            d * ddist(vertex[k1], vertex[k2]) * -0.999847695156) return 1;
      }

      p0 = curve.c[mod(i, m) * 3 + 2];
      p1 = vertex[mod(i + 1, m)];
      p2 = vertex[mod(j, m)];
      p3 = curve.c[mod(j, m) * 3 + 2];

      area = areac[j] - areac[i];
      area -= dpara(vertex[0], curve.c[i * 3 + 2], curve.c[j * 3 + 2]) / 2;
      if (i >= j) area += areac[m];

      A1 = dpara(p0, p1, p2);
      A2 = dpara(p0, p1, p3);
      A3 = dpara(p0, p2, p3);
      A4 = A1 + A3 - A2;
      if (A2 === A1) return 1;

      t = A3 / (A3 - A4);
      s = A2 / (A2 - A1);
      A = A2 * t / 2;
      if (A === 0) return 1;

      R = area / A;
      alpha = 2 - Math.sqrt(4 - R / 0.3);
      if (!(alpha === alpha)) return 1; // NaN guard

      res.c[0] = interval(t * alpha, p0, p1);
      res.c[1] = interval(s * alpha, p3, p2);
      res.alpha = alpha;
      res.t = t;
      res.s = s;
      p1 = res.c[0];
      p2 = res.c[1];
      res.pen = 0;

      for (k = mod(i + 1, m); k !== j; k = k1) {
        k1 = mod(k + 1, m);
        t = tangent(p0, p1, p2, p3, vertex[k], vertex[k1]);
        if (t < -0.5) return 1;
        pt = bezier(t, p0, p1, p2, p3);
        d = ddist(vertex[k], vertex[k1]);
        if (d === 0) return 1;
        d1 = dpara(vertex[k], vertex[k1], pt) / d;
        if (Math.abs(d1) > opttolerance) return 1;
        if (iprod(vertex[k], vertex[k1], pt) < 0 || iprod(vertex[k1], vertex[k], pt) < 0) return 1;
        res.pen += d1 * d1;
      }

      for (k = i; k !== j; k = k1) {
        k1 = mod(k + 1, m);
        t = tangent(p0, p1, p2, p3, curve.c[k * 3 + 2], curve.c[k1 * 3 + 2]);
        if (t < -0.5) return 1;
        pt = bezier(t, p0, p1, p2, p3);
        d = ddist(curve.c[k * 3 + 2], curve.c[k1 * 3 + 2]);
        if (d === 0) return 1;
        d1 = dpara(curve.c[k * 3 + 2], curve.c[k1 * 3 + 2], pt) / d;
        d2 = dpara(curve.c[k * 3 + 2], curve.c[k1 * 3 + 2], vertex[k1]) / d;
        d2 *= 0.75 * curve.alpha[k1];
        if (d2 < 0) { d1 = -d1; d2 = -d2; }
        if (d1 < d2 - opttolerance) return 1;
        if (d1 < d2) res.pen += (d1 - d2) * (d1 - d2);
      }
      return 0;
    }

    function optiCurve(path) {
      var curve = path.curve, m = curve.n, vert = curve.vertex;
      var pt = new Int32Array(m + 1), pen = new Float64Array(m + 1), len = new Int32Array(m + 1), opt = new Array(m + 1);
      var om, i, j, r, o = new Opti(), p0, i1, area, alpha, ocurve, s, t;
      var convc = new Int8Array(m), areac = new Float64Array(m + 1);

      for (i = 0; i < m; i++) {
        convc[i] = curve.tag[i] === 'CURVE' ? sign(dpara(vert[mod(i - 1, m)], vert[i], vert[mod(i + 1, m)])) : 0;
      }

      area = 0;
      areac[0] = 0;
      p0 = curve.vertex[0];
      for (i = 0; i < m; i++) {
        i1 = mod(i + 1, m);
        if (curve.tag[i1] === 'CURVE') {
          alpha = curve.alpha[i1];
          area += 0.3 * alpha * (4 - alpha) * dpara(curve.c[i * 3 + 2], vert[i1], curve.c[i1 * 3 + 2]) / 2;
          area += dpara(p0, curve.c[i * 3 + 2], curve.c[i1 * 3 + 2]) / 2;
        }
        areac[i + 1] = area;
      }

      pt[0] = -1;
      pen[0] = 0;
      len[0] = 0;
      for (j = 1; j <= m; j++) {
        pt[j] = j - 1;
        pen[j] = pen[j - 1];
        len[j] = len[j - 1] + 1;
        for (i = j - 2; i >= 0; i--) {
          r = optiPenalty(path, i, mod(j, m), o, convc, areac);
          if (r) break;
          if (len[j] > len[i] + 1 || (len[j] === len[i] + 1 && pen[j] > pen[i] + o.pen)) {
            pt[j] = i;
            pen[j] = pen[i] + o.pen;
            len[j] = len[i] + 1;
            opt[j] = o;
            o = new Opti();
          }
        }
      }
      om = len[m];
      ocurve = new Curve(om);
      s = new Float64Array(om);
      t = new Float64Array(om);

      j = m;
      for (i = om - 1; i >= 0; i--) {
        var jm = mod(j, m);
        if (pt[j] === j - 1) {
          ocurve.tag[i] = curve.tag[jm];
          ocurve.c[i * 3] = curve.c[jm * 3];
          ocurve.c[i * 3 + 1] = curve.c[jm * 3 + 1];
          ocurve.c[i * 3 + 2] = curve.c[jm * 3 + 2];
          ocurve.vertex[i] = curve.vertex[jm];
          ocurve.alpha[i] = curve.alpha[jm];
          ocurve.alpha0[i] = curve.alpha0[jm];
          ocurve.beta[i] = curve.beta[jm];
          s[i] = t[i] = 1;
        } else {
          ocurve.tag[i] = 'CURVE';
          ocurve.c[i * 3] = opt[j].c[0];
          ocurve.c[i * 3 + 1] = opt[j].c[1];
          ocurve.c[i * 3 + 2] = curve.c[jm * 3 + 2];
          ocurve.vertex[i] = interval(opt[j].s, curve.c[jm * 3 + 2], vert[jm]);
          ocurve.alpha[i] = opt[j].alpha;
          ocurve.alpha0[i] = opt[j].alpha;
          s[i] = opt[j].s;
          t[i] = opt[j].t;
        }
        j = pt[j];
      }
      for (i = 0; i < om; i++) {
        i1 = mod(i + 1, om);
        ocurve.beta[i] = s[i] / (s[i] + t[i1]);
      }
      ocurve.alphaCurve = 1;
      path.curve = ocurve;
    }
  }

  // ------------------------------------------------------------------
  // SVG path serialisation
  // ------------------------------------------------------------------
  function makeFmt(decimals) {
    var f = Math.pow(10, decimals);
    return function (v) {
      var r = Math.round(v * f) / f;
      if (r === 0) return '0'; // avoids "-0"
      return String(r);
    };
  }

  function curveToD(curve, sx, sy, fmt) {
    var n = curve.n, c = curve.c;
    function p(pt) { return fmt(pt.x * sx) + ' ' + fmt(pt.y * sy); }
    var out = 'M' + p(c[(n - 1) * 3 + 2]);
    for (var i = 0; i < n; i++) {
      if (curve.tag[i] === 'CURVE') {
        out += 'C' + p(c[i * 3]) + ' ' + p(c[i * 3 + 1]) + ' ' + p(c[i * 3 + 2]);
      } else {
        out += 'L' + p(c[i * 3 + 1]) + 'L' + p(c[i * 3 + 2]);
      }
    }
    return out + 'Z';
  }

  // Exact pixel-boundary polygon with collinear points removed.
  function polygonToD(path, sx, sy, fmt) {
    var pts = path.pt, n = pts.length, keep = [];
    for (var i = 0; i < n; i++) {
      var a = pts[mod(i - 1, n)], b = pts[i], c = pts[(i + 1) % n];
      var dx1 = b.x - a.x, dy1 = b.y - a.y, dx2 = c.x - b.x, dy2 = c.y - b.y;
      if (dx1 !== dx2 || dy1 !== dy2) keep.push(b);
    }
    if (keep.length < 3) return '';
    var out = 'M' + fmt(keep[0].x * sx) + ' ' + fmt(keep[0].y * sy);
    for (var k = 1; k < keep.length; k++) {
      var q = keep[k], pq = keep[k - 1];
      if (q.y === pq.y) out += 'H' + fmt(q.x * sx);
      else if (q.x === pq.x) out += 'V' + fmt(q.y * sy);
      else out += 'L' + fmt(q.x * sx) + ' ' + fmt(q.y * sy);
    }
    return out + 'Z';
  }

  // ------------------------------------------------------------------
  // Color science (sRGB <-> OKLab)
  // ------------------------------------------------------------------
  var SRGB_TO_LIN = new Float64Array(256);
  for (var si = 0; si < 256; si++) {
    var cs = si / 255;
    SRGB_TO_LIN[si] = cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  }
  function toOklab(r, g, b, out, o) {
    var lr = SRGB_TO_LIN[r], lg = SRGB_TO_LIN[g], lb = SRGB_TO_LIN[b];
    var l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    var m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    var s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    out[o] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    out[o + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  }

  // ------------------------------------------------------------------
  // Pre-processing
  // ------------------------------------------------------------------
  function boxBlur(src, w, h, radius) {
    if (radius <= 0) return src;
    var a = new Uint8ClampedArray(src), b = new Uint8ClampedArray(src.length);
    // Three box passes approximate a Gaussian.
    var passes = 3, r = Math.max(1, Math.round(radius));
    for (var p = 0; p < passes; p++) {
      blurH(a, b, w, h, r);
      blurV(b, a, w, h, r);
    }
    return a;
  }
  function blurH(src, dst, w, h, r) {
    var win = 2 * r + 1;
    for (var y = 0; y < h; y++) {
      var row = y * w * 4;
      for (var ch = 0; ch < 4; ch++) {
        var acc = 0;
        for (var k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k)) * 4 + ch];
        for (var x = 0; x < w; x++) {
          dst[row + x * 4 + ch] = acc / win;
          var xin = Math.min(w - 1, x + r + 1), xout = Math.max(0, x - r);
          acc += src[row + xin * 4 + ch] - src[row + xout * 4 + ch];
        }
      }
    }
  }
  function blurV(src, dst, w, h, r) {
    var win = 2 * r + 1, stride = w * 4;
    for (var x = 0; x < w; x++) {
      for (var ch = 0; ch < 4; ch++) {
        var col = x * 4 + ch, acc = 0;
        for (var k = -r; k <= r; k++) acc += src[Math.min(h - 1, Math.max(0, k)) * stride + col];
        for (var y = 0; y < h; y++) {
          dst[y * stride + col] = acc / win;
          var yin = Math.min(h - 1, y + r + 1), yout = Math.max(0, y - r);
          acc += src[yin * stride + col] - src[yout * stride + col];
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Color quantization
  // ------------------------------------------------------------------
  var TRANSPARENT = 0xFFFF;

  /**
   * @returns {{indices: Uint16Array, palette: number[][], counts: number[]}}
   */
  function quantize(px, w, h, k, opts, progress) {
    var n = w * h, alphaCut = opts.alphaThreshold == null ? 128 : opts.alphaThreshold;
    var gray = opts.mode === 'gray';
    var indices = new Uint16Array(n);
    var i, j, r, g, b;

    function rgbAt(p) {
      r = px[p * 4]; g = px[p * 4 + 1]; b = px[p * 4 + 2];
      if (gray) { r = g = b = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b); }
    }

    // Fast path: the image already has <= k distinct colors (logos, pixel art).
    var exact = new Map(), opaqueCount = 0;
    for (i = 0; i < n; i++) {
      if (px[i * 4 + 3] < alphaCut) continue;
      opaqueCount++;
      if (exact) {
        rgbAt(i);
        var key = (r << 16) | (g << 8) | b;
        if (!exact.has(key)) {
          if (exact.size >= k) exact = null;
          else exact.set(key, exact.size);
        }
      }
    }
    if (opaqueCount === 0) {
      indices.fill(TRANSPARENT);
      return { indices: indices, palette: [], counts: [] };
    }
    if (exact) {
      var palette = [], counts = [];
      exact.forEach(function (idx, key) { palette[idx] = [(key >> 16) & 255, (key >> 8) & 255, key & 255]; counts[idx] = 0; });
      for (i = 0; i < n; i++) {
        if (px[i * 4 + 3] < alphaCut) { indices[i] = TRANSPARENT; continue; }
        rgbAt(i);
        var id = exact.get((r << 16) | (g << 8) | b);
        indices[i] = id;
        counts[id]++;
      }
      return { indices: indices, palette: palette, counts: counts };
    }

    // --- k-means++ on a deterministic sample, in OKLab space.
    var rand = rng(1234567);
    var maxSamples = 80000;
    var step = Math.max(1, opaqueCount / maxSamples);
    var sample = new Float64Array(Math.min(opaqueCount, maxSamples) * 3 + 3);
    var ns = 0, acc = 0, ci = 0;
    for (i = 0; i < n; i++) {
      if (px[i * 4 + 3] < alphaCut) continue;
      if (ci++ >= acc) {
        acc += step;
        rgbAt(i);
        toOklab(r, g, b, sample, ns * 3);
        ns++;
        if (ns * 3 >= sample.length - 3) break;
      }
    }
    k = Math.min(k, ns);

    var cent = new Float64Array(k * 3);
    var dist = new Float64Array(ns);
    var first = Math.floor(rand() * ns);
    cent[0] = sample[first * 3]; cent[1] = sample[first * 3 + 1]; cent[2] = sample[first * 3 + 2];
    for (i = 0; i < ns; i++) dist[i] = sq3(sample, i * 3, cent, 0);
    var kc;
    for (kc = 1; kc < k; kc++) {
      var sum = 0;
      for (i = 0; i < ns; i++) sum += dist[i];
      if (sum <= 1e-12) break; // fewer distinct colors than k
      var target = rand() * sum, pick = ns - 1;
      for (i = 0; i < ns; i++) { target -= dist[i]; if (target <= 0) { pick = i; break; } }
      cent[kc * 3] = sample[pick * 3]; cent[kc * 3 + 1] = sample[pick * 3 + 1]; cent[kc * 3 + 2] = sample[pick * 3 + 2];
      for (i = 0; i < ns; i++) {
        var dd = sq3(sample, i * 3, cent, kc * 3);
        if (dd < dist[i]) dist[i] = dd;
      }
    }
    k = kc;

    var assign = new Int32Array(ns), sums = new Float64Array(k * 3), cnt = new Int32Array(k);
    var iters = opts.kmeansIterations || 16;
    for (var it = 0; it < iters; it++) {
      sums.fill(0); cnt.fill(0);
      for (i = 0; i < ns; i++) {
        var best = 0, bd = Infinity;
        for (j = 0; j < k; j++) {
          var d0 = sq3(sample, i * 3, cent, j * 3);
          if (d0 < bd) { bd = d0; best = j; }
        }
        assign[i] = best;
        cnt[best]++;
        sums[best * 3] += sample[i * 3]; sums[best * 3 + 1] += sample[i * 3 + 1]; sums[best * 3 + 2] += sample[i * 3 + 2];
      }
      var moved = 0;
      for (j = 0; j < k; j++) {
        if (cnt[j] === 0) continue;
        var nx = sums[j * 3] / cnt[j], ny = sums[j * 3 + 1] / cnt[j], nz = sums[j * 3 + 2] / cnt[j];
        moved += Math.abs(nx - cent[j * 3]) + Math.abs(ny - cent[j * 3 + 1]) + Math.abs(nz - cent[j * 3 + 2]);
        cent[j * 3] = nx; cent[j * 3 + 1] = ny; cent[j * 3 + 2] = nz;
      }
      if (progress) progress((it + 1) / iters);
      if (moved < 1e-5) break;
    }

    // --- assign every pixel (with a hashed cache of recent colors).
    var CACHE = 1 << 18;
    var cacheKey = new Int32Array(CACHE).fill(-1), cacheVal = new Uint16Array(CACHE);
    var lab = new Float64Array(3);
    var rs = new Float64Array(k), gs = new Float64Array(k), bs = new Float64Array(k), cn = new Float64Array(k);
    for (i = 0; i < n; i++) {
      if (px[i * 4 + 3] < alphaCut) { indices[i] = TRANSPARENT; continue; }
      rgbAt(i);
      var ck = (r << 16) | (g << 8) | b, slot = (Math.imul(ck, 0x9E3779B1) >>> 14) & (CACHE - 1), bi;
      if (cacheKey[slot] === ck) bi = cacheVal[slot];
      else {
        toOklab(r, g, b, lab, 0);
        bi = 0;
        var bdist = Infinity;
        for (j = 0; j < k; j++) {
          var d1 = sq3(lab, 0, cent, j * 3);
          if (d1 < bdist) { bdist = d1; bi = j; }
        }
        cacheKey[slot] = ck; cacheVal[slot] = bi;
      }
      indices[i] = bi;
      rs[bi] += r; gs[bi] += g; bs[bi] += b; cn[bi]++;
    }

    // --- compact: drop empty clusters, palette = mean sRGB of members.
    var remap = new Uint16Array(k), pal = [], cts = [];
    for (j = 0; j < k; j++) {
      if (cn[j] > 0) {
        remap[j] = pal.length;
        pal.push([Math.round(rs[j] / cn[j]), Math.round(gs[j] / cn[j]), Math.round(bs[j] / cn[j])]);
        cts.push(cn[j]);
      }
    }
    for (i = 0; i < n; i++) if (indices[i] !== TRANSPARENT) indices[i] = remap[indices[i]];
    return { indices: indices, palette: pal, counts: cts };
  }
  function sq3(a, ai, b, bi) {
    var x = a[ai] - b[bi], y = a[ai + 1] - b[bi + 1], z = a[ai + 2] - b[bi + 2];
    return x * x + y * y + z * z;
  }

  // Merge 4-connected regions smaller than minArea into the neighbouring
  // color they share the longest border with.
  function mergeSpeckles(indices, w, h, k, minArea) {
    if (minArea <= 1) return 0;
    var n = w * h, seen = new Uint8Array(n), queue = new Int32Array(n);
    var nb = new Float64Array(k), touched = [], merged = 0;
    for (var start = 0; start < n; start++) {
      if (seen[start]) continue;
      var col = indices[start];
      seen[start] = 1;
      if (col === TRANSPARENT) continue;
      var qh = 0, qt = 0;
      queue[qt++] = start;
      while (qh < qt) {
        var p = queue[qh++], x = p % w, y = (p / w) | 0;
        if (x > 0) visit(p - 1);
        if (x < w - 1) visit(p + 1);
        if (y > 0) visit(p - w);
        if (y < h - 1) visit(p + w);
      }
      if (qt >= minArea) continue;
      // count neighbour colors along the border
      touched.length = 0;
      for (var q = 0; q < qt; q++) {
        var pp = queue[q], xx = pp % w, yy = (pp / w) | 0;
        if (xx > 0) tally(pp - 1);
        if (xx < w - 1) tally(pp + 1);
        if (yy > 0) tally(pp - w);
        if (yy < h - 1) tally(pp + w);
      }
      var best = -1, bv = 0;
      for (var t = 0; t < touched.length; t++) {
        var c = touched[t];
        if (nb[c] > bv) { bv = nb[c]; best = c; }
        nb[c] = 0;
      }
      if (best >= 0) {
        for (var z = 0; z < qt; z++) indices[queue[z]] = best;
        merged++;
      }
    }
    return merged;

    function visit(np) {
      if (!seen[np] && indices[np] === col) { seen[np] = 1; queue[qt++] = np; }
    }
    function tally(np) {
      var c2 = indices[np];
      if (c2 === col || c2 === TRANSPARENT) return;
      if (nb[c2] === 0) touched.push(c2);
      nb[c2]++;
    }
  }

  function hex(c) {
    return '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1);
  }

  // ------------------------------------------------------------------
  // Main entry point
  // ------------------------------------------------------------------
  var DEFAULTS = {
    mode: 'color',        // 'color' | 'gray' | 'bw'
    colors: 16,           // palette size for color / gray
    threshold: 128,       // luminance cut-off for 'bw'
    invert: false,        // 'bw': trace light pixels instead of dark
    bwBackground: false,  // 'bw': fill the untraced side with a solid rect
    blur: 0,              // denoise radius in px
    speckle: 4,           // regions smaller than this (px) are merged away
    alphamax: 1.0,        // corner threshold: 0 = all corners, 1.334 = all curves
    opticurve: true,      // join adjacent Bezier segments
    opttolerance: 0.2,    // max error allowed when joining segments
    turnpolicy: 'minority',
    layering: 'stacked',  // 'stacked' (no gaps) | 'cutout' (no overlaps)
    order: 'lightness',   // stacking order: 'lightness' (dark at bottom) | 'area' (largest at bottom)
    lightFirst: false,    // with order 'lightness': put light colors at the bottom
    pixelExact: false,    // emit exact pixel-edge polygons, no curve fitting
    outWidth: 0,          // SVG width in user units (defaults to bitmap width)
    outHeight: 0,
    decimals: 2
  };

  /**
   * Convert RGBA pixels to an SVG string.
   * @param {{data: Uint8ClampedArray, width: number, height: number}} img
   * @param {object} options  see DEFAULTS
   * @param {function} [onProgress]  (stage: string, fraction: number) => void
   */
  function vectorize(img, options, onProgress) {
    var o = {};
    for (var key in DEFAULTS) o[key] = DEFAULTS[key];
    for (key in options || {}) if (options[key] !== undefined) o[key] = options[key];
    var progress = onProgress || function () {};

    var w = img.width, h = img.height, t0 = now();
    var outW = o.outWidth || w, outH = o.outHeight || h;
    var sx = outW / w, sy = outH / h;
    var decimals = o.decimals;
    if (sx < 0.75 && decimals < 3) decimals = 3;
    var fmt = makeFmt(decimals);

    progress('Denoising', 0);
    var px = boxBlur(img.data, w, h, o.blur);

    var indices, palette, counts, layers = [];
    var tracerOpts = {
      turdsize: Math.max(0, (o.speckle | 0) - 1),
      turnpolicy: o.turnpolicy,
      alphamax: o.alphamax,
      opticurve: o.opticurve,
      opttolerance: o.opttolerance,
      polygonOnly: o.pixelExact
    };

    // Serialize each layer as soon as it is traced so the heavy path
    // structures can be garbage-collected (matters for large images).
    var pathCount = 0, segCount = 0;
    function addLayer(color, paths) {
      var ds = [];
      for (var p = 0; p < paths.length; p++) {
        if (o.pixelExact) ds.push(polygonToD(paths[p], sx, sy, fmt));
        else { ds.push(curveToD(paths[p].curve, sx, sy, fmt)); segCount += paths[p].curve.n; }
      }
      pathCount += paths.length;
      layers.push({ color: color, d: ds.join('') });
    }

    var n = w * h, i;
    if (o.mode === 'bw') {
      var mask = new Uint8Array(n), alphaCut = 128;
      for (i = 0; i < n; i++) {
        if (px[i * 4 + 3] < alphaCut) continue;
        var lum = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
        mask[i] = (o.invert ? lum >= o.threshold : lum < o.threshold) ? 1 : 0;
      }
      // speckle removal on the binary image
      if (o.speckle > 1) {
        var bin = new Uint16Array(n);
        for (i = 0; i < n; i++) bin[i] = mask[i];
        mergeSpeckles(bin, w, h, 2, o.speckle);
        for (i = 0; i < n; i++) mask[i] = bin[i];
      }
      palette = [o.invert ? [255, 255, 255] : [0, 0, 0]];
      counts = [0];
      for (i = 0; i < n; i++) counts[0] += mask[i];
      progress('Tracing', 0.1);
      if (o.bwBackground) layers.push({ color: o.invert ? [0, 0, 0] : [255, 255, 255], rect: true });
      addLayer(palette[0], potrace(mask, w, h, tracerOpts));
    } else {
      progress('Quantizing colors', 0);
      var q = quantize(px, w, h, Math.max(2, Math.min(256, o.colors | 0)), o, function (f) {
        progress('Quantizing colors', f);
      });
      indices = q.indices; palette = q.palette; counts = q.counts;
      var k = palette.length;
      progress('Removing speckles', 0);
      if (o.speckle > 1 && k > 1) {
        mergeSpeckles(indices, w, h, k, o.speckle);
        counts = new Array(k).fill(0);
        for (i = 0; i < n; i++) if (indices[i] !== TRANSPARENT) counts[indices[i]]++;
      }

      // Order: largest area first (drawn at the bottom).
      var order = [];
      for (i = 0; i < k; i++) if (counts[i] > 0) order.push(i);
      if (o.order === 'lightness') {
        // Dark to light: each stacked mask becomes a brightness iso-level,
        // which keeps anti-aliased edges and gradients smooth.
        var lumOf = function (c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
        order.sort(function (a, b) { return lumOf(palette[a]) - lumOf(palette[b]); });
        if (o.lightFirst) order.reverse();
      } else {
        order.sort(function (a, b) { return counts[b] - counts[a]; });
      }
      var rank = new Int32Array(k).fill(-1);
      for (i = 0; i < order.length; i++) rank[order[i]] = i;

      var hasTransparency = false;
      for (i = 0; i < n; i++) if (indices[i] === TRANSPARENT) { hasTransparency = true; break; }

      var stacked = o.layering !== 'cutout';
      var lmask = new Uint8Array(n);
      for (var li = 0; li < order.length; li++) {
        progress('Tracing', li / order.length);
        var color = palette[order[li]];
        if (stacked && li === 0 && !hasTransparency) {
          layers.push({ color: color, rect: true });
          continue;
        }
        for (i = 0; i < n; i++) {
          var ix = indices[i];
          lmask[i] = ix === TRANSPARENT ? 0 : stacked ? (rank[ix] >= li ? 1 : 0) : (rank[ix] === li ? 1 : 0);
        }
        addLayer(color, potrace(lmask, w, h, tracerOpts));
      }
    }

    progress('Writing SVG', 1);
    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(outW) + '" height="' + fmt(outH) +
               '" viewBox="0 0 ' + fmt(outW) + ' ' + fmt(outH) + '">');
    for (var L = 0; L < layers.length; L++) {
      var layer = layers[L], fill = hex(layer.color);
      if (layer.rect) {
        parts.push('<rect width="' + fmt(outW) + '" height="' + fmt(outH) + '" fill="' + fill + '"/>');
        pathCount++;
        continue;
      }
      if (layer.d) parts.push('<path fill="' + fill + '" fill-rule="evenodd" d="' + layer.d + '"/>');
    }
    parts.push('</svg>');
    var svg = parts.join('\n');

    var usedPalette = [];
    for (L = 0; L < layers.length; L++) usedPalette.push(hex(layers[L].color));

    return {
      svg: svg,
      palette: usedPalette,
      stats: {
        width: w,
        height: h,
        colors: layers.length,
        paths: pathCount,
        segments: segCount,
        bytes: svg.length,
        ms: Math.round(now() - t0)
      }
    };
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  var api = {
    vectorize: vectorize,
    potrace: potrace,
    quantize: quantize,
    mergeSpeckles: mergeSpeckles,
    DEFAULTS: DEFAULTS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Vectorious = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
