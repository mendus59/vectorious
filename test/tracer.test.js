// Run with: node test/tracer.test.js
'use strict';
const assert = require('assert');
const V = require('../js/tracer.js');

function makeImage(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fn(x, y);
      const i = (y * w + x) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c[3] == null ? 255 : c[3];
    }
  }
  return { data, width: w, height: h };
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n' + e.stack); process.exitCode = 1; }
}

const circle = makeImage(100, 100, (x, y) =>
  (x - 50) ** 2 + (y - 50) ** 2 < 30 ** 2 ? [200, 30, 30] : [255, 255, 255]);

test('two-color circle becomes a rect background + one curved path', () => {
  const r = V.vectorize(circle, { colors: 4 });
  assert.strictEqual(r.palette.length, 2);
  assert.ok(r.svg.startsWith('<svg'));
  assert.ok(r.svg.includes('<rect'));
  assert.ok(r.svg.includes('fill="#c81e1e"'));
  assert.ok(/C/.test(r.svg), 'expected Bezier curves');
});

test('circle path stays near the true circle', () => {
  const r = V.vectorize(circle, { colors: 2, opticurve: false, order: 'area' });
  const nums = r.svg.match(/ d="([^"]+)"/)[1].match(/-?\d+(\.\d+)?/g).map(Number);
  // check every end point (every 2 numbers) lies within 1.5px of radius 30
  for (let i = 0; i < nums.length; i += 2) {
    const d = Math.hypot(nums[i] - 50, nums[i + 1] - 50);
    assert.ok(Math.abs(d - 30) < 1.6, 'point off circle by ' + (d - 30));
  }
});

test('square with hole keeps the hole', () => {
  const img = makeImage(60, 60, (x, y) => {
    const inOuter = x >= 10 && x < 50 && y >= 10 && y < 50;
    const inHole = x >= 25 && x < 35 && y >= 25 && y < 35;
    return inOuter && !inHole ? [0, 0, 0] : [255, 255, 255];
  });
  const r = V.vectorize(img, { mode: 'bw' });
  const d = r.svg.match(/ d="([^"]+)"/)[1];
  assert.strictEqual((d.match(/M/g) || []).length, 2, 'outer + hole');
});

test('pixel-exact mode outputs only axis-aligned edges', () => {
  const img = makeImage(8, 8, (x, y) => ((x + y) % 2 ? [0, 0, 0] : [255, 255, 255]));
  const r = V.vectorize(img, { pixelExact: true, speckle: 0, colors: 2 });
  const d = r.svg.match(/ d="([^"]+)"/)[1];
  assert.ok(!/[CL]/.test(d), 'no curves or diagonals');
});

test('transparent pixels are not traced', () => {
  const img = makeImage(40, 40, (x, y) => (x > 10 && x < 30 && y > 10 && y < 30 ? [0, 128, 0] : [0, 0, 0, 0]));
  const r = V.vectorize(img, { colors: 4 });
  assert.ok(!r.svg.includes('<rect'));
  assert.strictEqual(r.palette.length, 1);
});

test('photo-like gradient quantizes to requested count', () => {
  const img = makeImage(120, 80, (x, y) => [x * 2, y * 3, (x + y) % 256]);
  const r = V.vectorize(img, { colors: 12, speckle: 4 });
  assert.ok(r.palette.length <= 12 && r.palette.length >= 8, 'got ' + r.palette.length);
  assert.ok(!/NaN|Infinity/.test(r.svg));
});

test('speckle filter removes isolated pixels', () => {
  const img = makeImage(50, 50, (x, y) => (x === 20 && y === 20 ? [0, 0, 0] : [255, 255, 255]));
  const r = V.vectorize(img, { colors: 2, speckle: 4 });
  assert.ok(!r.svg.includes('<path'));
});

test('cutout layering traces each color separately', () => {
  const r = V.vectorize(circle, { colors: 2, layering: 'cutout' });
  assert.strictEqual((r.svg.match(/<path/g) || []).length, 2);
});

// One color, four kinds of shape on white.
const shapes = makeImage(240, 160, (x, y) => {
  const ink = [40, 40, 160];
  if ((x - 50) ** 2 + (y - 50) ** 2 < 28 ** 2) return ink;                 // circle
  if (x >= 110 && x < 160 && y >= 25 && y < 75) return ink;                // square
  if (y >= 20 && y < 80 && Math.abs(x - 205) * 2 < (y - 20)) return ink;   // triangle
  if (y >= 120 && y < 123 && x >= 20 && x < 220) return ink;               // thin line
  return [255, 255, 255];
});
const layerOf = (r, re) => r.layers.find((l) => re.test(l.name));

test('shape grouping sorts round, rectangular, pointed and thin shapes', () => {
  const r = V.vectorize(shapes, { colors: 2, groupBy: 'shape' });
  const names = r.layers.map((l) => l.name);
  for (const re of [/Round/, /Rectangles/, /Triangles/, /Lines/]) {
    const l = layerOf(r, re);
    assert.ok(l, 'missing ' + re + ' in ' + names.join(', '));
  }
  assert.strictEqual(layerOf(r, /Round/).count, 1);
  assert.strictEqual(layerOf(r, /Lines/).count, 1);
  assert.ok(r.svg.includes('inkscape:groupmode="layer"'));
});

test('object grouping keeps holes with their shape', () => {
  const ring = makeImage(80, 80, (x, y) => {
    const d = (x - 40) ** 2 + (y - 40) ** 2;
    return d < 30 ** 2 && d > 15 ** 2 ? [0, 0, 0] : [255, 255, 255];
  });
  const r = V.vectorize(ring, { colors: 2, groupBy: 'shape' });
  const black = r.layers.find((l) => l.colors.includes('#000000'));
  const d = black.body.match(/fill="#000000" fill-rule="evenodd" d="([^"]+)"/)[1];
  assert.strictEqual((d.match(/M/g) || []).length, 2, 'ring outline + hole in one path');
});

test('size grouping separates big and small shapes', () => {
  const img = makeImage(200, 200, (x, y) => {
    if (x >= 20 && x < 120 && y >= 20 && y < 120) return [200, 0, 0];
    if (x >= 150 && x < 156 && y >= 150 && y < 156) return [200, 0, 0];
    return [255, 255, 255];
  });
  const r = V.vectorize(img, { colors: 2, groupBy: 'size' });
  assert.ok(layerOf(r, /Large/) && layerOf(r, /Fine|Small/), r.layers.map((l) => l.name).join(', '));
});

test('similar-object grouping puts look-alikes together', () => {
  const img = makeImage(300, 200, (x, y) => {
    for (let i = 0; i < 3; i++) {
      if ((x - (50 + i * 100)) ** 2 + (y - 60) ** 2 < 30 ** 2) return [220, 120, 0];
      if (x >= 40 + i * 100 && x < 50 + i * 100 && y >= 150 && y < 160) return [0, 120, 60];
    }
    return [255, 255, 255];
  });
  const r = V.vectorize(img, { colors: 3, groupBy: 'similar', maxLayers: 3, speckle: 0 });
  const counts = r.layers.map((l) => l.count).sort();
  assert.deepStrictEqual(counts, [1, 3, 3]);
});

test('color grouping merges similar colors down to the layer limit', () => {
  const img = makeImage(80, 80, (x, y) => {
    if (x < 20) return [220, 20, 20];
    if (x < 40) return [200, 30, 40];
    if (x < 60) return [20, 20, 220];
    return [30, 50, 200];
  });
  const r = V.vectorize(img, { colors: 4, maxLayers: 2, speckle: 0 });
  assert.strictEqual(r.layers.length, 2);
  assert.ok(r.layers.every((l) => l.colors.length === 2));
});

test('buildSvg writes only the layers it is given', () => {
  const r = V.vectorize(shapes, { colors: 2, groupBy: 'shape' });
  const one = V.buildSvg(r.open, [r.layers[1]]);
  assert.strictEqual((one.match(/<g /g) || []).length, 1);
  assert.ok(one.endsWith('</svg>'));
});

test('larger noisy image completes in reasonable time', () => {
  let s = 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const img = makeImage(400, 300, (x, y) => {
    const v = Math.sin(x / 17) * Math.cos(y / 23) * 120 + 128 + rnd() * 30;
    return [v, 255 - v, (x * y) % 255];
  });
  const r = V.vectorize(img, { colors: 32, blur: 1, speckle: 6 });
  assert.ok(!/NaN|Infinity|undefined/.test(r.svg));
  console.log('     400x300, 32 colors:', r.stats.ms + 'ms,', r.stats.paths, 'paths,', (r.stats.bytes / 1024).toFixed(0) + 'KB');
});

console.log(passed + ' tests passed');
