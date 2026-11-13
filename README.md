# Vectorious

<!-- site-summary:start -->
<!-- This section is this project's card on https://mendus59.github.io and is copied there daily.
     Keep it true of what's on main: one plain-text summary line (max 160 characters), then 1-6 short bullets.
     See CLAUDE.md ("Site summary"). -->
Convert raster images (PNG, JPG, WebP, GIF, BMP) into detailed SVG vector graphics, entirely in the browser.

- Traces each color layer with a built-in Potrace implementation into smooth Bezier curves, with no AI and nothing uploaded.
- Presets for photos, logos, line art and pixel art, with up to 128 colors and optional pixel-exact edges.
- Splits the result into layers by color, shape, size or similar objects, and downloads any layer as an SVG.
- Compare, outline and zoom views check the vector against the original.
<!-- site-summary:end -->

Convert raster images (PNG, JPG, WebP, GIF, BMP) into detailed SVG vector graphics, entirely in the browser.

- **No AI.** Conversion uses classic, deterministic algorithms only.
- **Nothing is uploaded.** Images are processed locally in a Web Worker.
- **Static site.** Plain HTML/CSS/JS, no build step, hosted on GitHub Pages.

## How it works

1. **Denoise** (optional): a three-pass box blur that approximates a Gaussian.
2. **Color quantization**: k-means++ clustering in the OKLab perceptual color space. Images that already have few colors (logos, pixel art) keep their exact palette.
3. **Speckle filter**: connected regions smaller than N pixels merge into the neighbouring color they share the most border with.
4. **Tracing**: each color layer is traced with an implementation of the [Potrace](https://potrace.sourceforge.net/potrace.pdf) algorithm (Selinger, 2003). It decomposes the bitmap into boundary paths, finds the optimal polygon, adjusts vertices to sub-pixel accuracy, detects corners, fits Bézier curves, and optionally merges segments.
5. **Layering**: layers are stacked dark to light, so each layer is a brightness iso-level and adjacent shapes never leave hairline gaps. A "cutout" mode outputs non-overlapping shapes for cutting machines.

## Settings

| Setting | What it does |
| --- | --- |
| Preset | Starting points: Maximum detail, Photo, Illustration / logo, Line art, Pixel art |
| Mode | Color, Grayscale, or Black & white with a threshold slider |
| Colors | Palette size (2–128) |
| Resolution | Upscales before tracing for finer curves (up to 400%) |
| Denoise | Blur radius applied before quantizing |
| Speckle filter | Minimum region size in pixels |
| Pixel-exact edges | Outputs exact pixel outlines with no curve fitting (pixel art) |
| Smoothness | Potrace `alphamax`: 0 = all corners, 1.33 = all curves |
| Simplify curves / tolerance | Potrace curve optimization |
| Layering / Layer order | Stacked or cutout, and the stacking order |

## Layers

The Layers panel splits the result into layers you can show, hide, and download one at a time (or download every visible layer together). Alt-click a layer's checkbox to show only that layer. Every SVG keeps its layers as `<g>` groups that Illustrator and Inkscape open as layers.

| Group by | How layers are made |
| --- | --- |
| Color | One layer per palette color. Similar colors (closest in OKLab) merge until at most *Max layers* remain. |
| Shape | Each shape is measured with classic descriptors (fill of its minimum bounding rectangle, convexity, fit to an ellipse with the same second moments, elongation, stroke thickness) and sorted into round, rectangular, pointed, thin, or complex. |
| Size | Large (≥ 10% of the image), medium (≥ 1%), small (≥ 0.1%), and fine details. |
| Similar objects | k-means over size, shape descriptors, hole count, and color puts look-alike shapes in the same layer, up to *Max layers*. |

Shape, size, and similar-object grouping trace each color region on its own (cutout), and each shape keeps its holes, so any layer stands alone.

The preview supports compare (split slider), vector-only, outline, and original views, with zoom (wheel or buttons) and pan (drag).

## Running locally

Any static file server works. Web Workers don't load from `file://`, so the app falls back to the main thread there.

```sh
python3 -m http.server 8000   # then open http://localhost:8000
node test/tracer.test.js      # engine tests (Node 18+)
```

## Deployment

`.github/workflows/pages.yml` runs the tests and publishes the site to GitHub Pages on every push to `main`.
One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
