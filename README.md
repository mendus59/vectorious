# Vectorious

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
