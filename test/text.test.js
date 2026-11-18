// Run with: node test/text.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const opentype = require('../js/vendor/opentype.min.js');
const T = require('../js/text.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n' + e.stack); process.exitCode = 1; }
}

function font(file) {
  const b = fs.readFileSync(path.join(__dirname, '..', 'fonts', file + '.woff'));
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}
const lato = font('Lato-Regular');
const pacifico = font('Pacifico-Regular');
const mono = font('SpaceMono-Regular');
const w = (b) => b.x2 - b.x1;
const h = (b) => b.y2 - b.y1;

test('every bundled font parses and draws Latin text', () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'fonts')).filter((f) => f.endsWith('.woff'));
  assert.ok(files.length >= 20, files.length + ' fonts');
  for (const f of files) {
    const lay = T.layout(font(f.replace('.woff', '')), 'Hamburgefonstiv 123 ÄÉ!', { size: 50 });
    assert.ok(lay.bbox && w(lay.bbox) > 100, f);
  }
});

test('layout: size, letter spacing, stretch and lines', () => {
  const a = T.layout(lato, 'Hello', { size: 100 });
  const b = T.layout(lato, 'Hello', { size: 200 });
  assert.ok(Math.abs(w(b.bbox) / w(a.bbox) - 2) < 0.01);
  const spaced = T.layout(lato, 'Hello', { size: 100, letterSpacing: 0.2 });
  assert.ok(Math.abs(w(spaced.bbox) - w(a.bbox) - 4 * 20) < 0.5, 'four gaps of 0.2 em');
  const wide = T.layout(lato, 'Hello', { size: 100, scaleX: 1.5 });
  assert.ok(Math.abs(w(wide.bbox) / w(a.bbox) - 1.5) < 0.01);
  const two = T.layout(lato, 'Hello\nHello', { size: 100, lineHeight: 1.5 });
  assert.strictEqual(two.lines, 2);
  assert.ok(Math.abs(h(two.bbox) - h(a.bbox) - 150) < 0.5);
  assert.strictEqual(two.glyphs, 10);
});

test('small caps draw lowercase as shorter capitals', () => {
  const caps = T.layout(lato, 'X', { size: 100 }).bbox;
  const sc = T.layout(lato, 'x', { size: 100, smallCaps: true }).bbox;
  const lower = T.layout(lato, 'x', { size: 100 }).bbox;
  assert.ok(h(sc) < h(caps) * 0.9 && h(sc) > h(caps) * 0.6, 'small cap height ' + h(sc));
  assert.ok(Math.abs(h(sc) - h(lower)) > 0.5, 'not the lowercase glyph');
});

test('rasterize fills shapes with nonzero winding', () => {
  const sq = [{ type: 'M', x: 2, y: 2 }, { type: 'L', x: 8, y: 2 }, { type: 'L', x: 8, y: 8 }, { type: 'L', x: 2, y: 8 }, { type: 'Z' }];
  const cov = T.rasterize(sq, 10, 10, 4);
  assert.ok(Math.abs(cov[5 * 10 + 5] - 1) < 1e-6);
  assert.strictEqual(cov[0], 0);
  const sum = cov.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 36) < 0.01, 'area ' + sum);
});

test('textLayers writes a text layer, optional background, and sizes to the text', () => {
  const r = T.textLayers(lato, 'Hi', { size: 40, fill: '#123456', background: '#ffffff' });
  assert.deepStrictEqual(r.layers.map((l) => l.name), ['Background', 'Text']);
  assert.ok(r.layers[1].body.startsWith('<path fill="#123456" d="M'));
  assert.ok(r.width > 40 && r.height > 20);
  assert.ok(!/NaN|undefined/.test(r.layers[1].body));
});

// Draw text in a known font as an anti-aliased image, then match it.
function textImage(f, text, opts, W, H) {
  const cmds = T.placed(f, text, opts);
  const cov = T.rasterize(cmds, W, H, 4);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const t = Math.min(1, cov[i]);
    data[i * 4] = Math.round(200 * t + 255 * (1 - t));
    data[i * 4 + 1] = Math.round(30 * t + 255 * (1 - t));
    data[i * 4 + 2] = Math.round(60 * t + 255 * (1 - t));
    data[i * 4 + 3] = 255;
  }
  return { data, width: W, height: H };
}

test('inkOf finds the ink color, background and box', () => {
  const img = textImage(lato, 'Magic', { size: 40, x: 10, y: 40 }, 160, 60);
  const ink = T.inkOf(img);
  assert.deepStrictEqual(ink.ink, [200, 30, 60]);
  assert.deepStrictEqual(ink.background, [255, 255, 255]);
  const lay = T.layout(lato, 'Magic', { size: 40 }).bbox;
  assert.ok(Math.abs(ink.box.x1 - (10 + lay.x1)) < 1 && Math.abs(ink.box.y2 - (40 + lay.y2)) < 1, JSON.stringify(ink.box));
});

test('match ranks the font the image was drawn in first', () => {
  for (const [name, f] of [['lato', lato], ['pacifico', pacifico], ['mono', mono]]) {
    const img = textImage(f, 'Have a nice day', { size: 30, x: 8, y: 34 }, 320, 48);
    const r = T.match([{ name: 'lato', font: lato }, { name: 'pacifico', font: pacifico }, { name: 'mono', font: mono }], 'Have a nice day', img, {});
    assert.strictEqual(r.results[0].name, name, r.results.map((x) => x.name + ' ' + x.score.toFixed(2)).join(', '));
    assert.ok(r.results[0].score > 0.6, name + ' score ' + r.results[0].score);
  }
});

test('scaleOptions converts a fit between pixel scales', () => {
  const o = T.scaleOptions({ size: 10, x: 2, y: 3, letterSpacing: 0.1, scaleX: 1.2 }, 4);
  assert.deepStrictEqual([o.size, o.x, o.y, o.letterSpacing, o.scaleX], [40, 8, 12, 0.1, 1.2]);
});


test('a font made from traced lettering reproduces it', () => {
  const V = require('../js/tracer.js');
  const words = 'Big Wave';
  const img = textImage(lato, words, { size: 36, x: 6, y: 40, letterSpacing: 0.06 }, 220, 56);
  const r = V.vectorize(img, { colors: 4, pureColors: true, upscale: 4, speckle: 16, groupBy: 'size', returnObjects: true, refine: true });
  const ink = r.objects.filter((o) => o.color === '#c81e3c');
  assert.ok(ink.length >= 7, ink.length + ' shapes');
  const made = T.fontFromShapes(opentype, ink, words, { familyName: 'Test Traced' });
  assert.deepStrictEqual(made.chars.filter((c) => /[a-z]/i.test(c)).sort().join(''), 'ABEGIVWabegivw');
  assert.ok(made.synthesized.includes('b') && made.synthesized.includes('A'));
  // the font round-trips through a file and draws the same words at the measured size
  const back = opentype.parse(made.buffer);
  assert.strictEqual(back.names.fontFamily.en, 'Test Traced');
  const lay = T.layout(back, words, { size: made.sizePx });
  const src = T.inkOf(img);
  const ratio = (lay.bbox.x2 - lay.bbox.x1) / (src.box.x2 - src.box.x1);
  assert.ok(Math.abs(ratio - 1) < 0.06, 'width ratio ' + ratio);
  const cx = (src.box.x1 + src.box.x2) / 2 - (lay.bbox.x1 + lay.bbox.x2) / 2, cy = (src.box.y1 + src.box.y2) / 2 - (lay.bbox.y1 + lay.bbox.y2) / 2;
  const overlap = T.iou(T.rasterize(T.transform(lay.commands, 1, 1, cx, cy), 220, 56, 4), src.coverage);
  assert.ok(overlap > 0.45, 'overlap ' + overlap); // thin strokes: small spacing differences cost a lot of overlap
});

test('font building splits letters that touch and keeps dots with their letter', () => {
  const sq = (x1, y1, x2, y2) => ({ d: 'M' + x1 + ' ' + y1 + 'H' + x2 + 'V' + y2 + 'H' + x1 + 'Z', bbox: { x1, y1, x2, y2 } });
  // "ii" where the stems touch through a bridge, plus their dots, and a separate "l"
  const shapes = [sq(0, 4, 6, 12), sq(1, 0, 2, 2), sq(4, 0, 5, 2), sq(10, 0, 11, 12)];
  shapes[0].d = 'M0 4H2V12H0Z M2 7H4V8H2Z M4 4H6V12H4Z';
  const groups = T.groupLetters(shapes);
  assert.strictEqual(groups.length, 2, 'both dots join the wide shape; the l stays apart');
  const made = T.fontFromShapes(opentype, shapes, 'iil', { fillCase: false });
  assert.deepStrictEqual(made.chars, ['i', 'l']);
});

test('layout borrows missing letters from a fallback font', () => {
  const minimal = new opentype.Font({ familyName: 'Mini', styleName: 'Regular', unitsPerEm: 1000, ascender: 800, descender: -200,
    glyphs: [new opentype.Glyph({ name: '.notdef', advanceWidth: 500, path: new opentype.Path() }),
      new opentype.Glyph({ name: 'A', unicode: 65, advanceWidth: 600, path: (() => { const p = new opentype.Path(); p.moveTo(0, 0); p.lineTo(600, 0); p.lineTo(300, 700); p.close(); return p; })() })] });
  const mini = opentype.parse(minimal.toArrayBuffer());
  const without = T.layout(mini, 'AB', { size: 100 });
  const withFb = T.layout(mini, 'AB', { size: 100, fallback: lato, fallbackScale: 1 });
  assert.strictEqual(without.glyphs, 1);
  assert.strictEqual(withFb.glyphs, 2);
});

console.log(passed + ' tests passed');
