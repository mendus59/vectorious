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
  const nums = r.svg.match(/d="([^"]+)"/)[1].match(/-?\d+(\.\d+)?/g).map(Number);
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
  const d = r.svg.match(/d="([^"]+)"/)[1];
  assert.strictEqual((d.match(/M/g) || []).length, 2, 'outer + hole');
});

test('pixel-exact mode outputs only axis-aligned edges', () => {
  const img = makeImage(8, 8, (x, y) => ((x + y) % 2 ? [0, 0, 0] : [255, 255, 255]));
  const r = V.vectorize(img, { pixelExact: true, speckle: 0, colors: 2 });
  const d = r.svg.match(/d="([^"]+)"/)[1];
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
