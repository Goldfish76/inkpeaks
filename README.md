<h1 align="center">卧游 · Ink Peaks</h1>

<p align="center"><b>Real mountains, painted like the Song dynasty.</b><br>
Pick any mountain on Earth and the browser paints its real terrain as a Chinese landscape scroll, with layered ridges, ink washes, mist, an inscription and a seal.</p>

<p align="center">
  <a href="https://goldfish76.github.io/inkpeaks/"><b>Open Ink Peaks →</b></a> ·
  <a href="README.zh-CN.md">中文说明</a>
</p>

<p align="center"><a href="https://goldfish76.github.io/inkpeaks/"><img src="docs/hero.jpg" alt="Five hanging scrolls painted from real terrain: Huangshan, the Li River at Xingping, the Matterhorn, Mount Emei and Reine in Lofoten"></a></p>

**卧游** (*wò yóu*, "travelling while lying down") comes from the painter Zong Bing (宗炳, 375–443). Too old and ill to climb, he painted the mountains he had known on the walls of his room and travelled them from his bed. Ink Peaks starts from the real mountain. It reads open elevation data for the place, so every ridge, gorge and summit in the picture is really there. Only the brush is invented.

## What it does

- **Any mountain.** 28 hand-framed famous mountains, plus a search over 14,500 named peaks. You can also type coordinates or use your location.
- **The three distances (三远).** The compositions follow Guo Xi's *Linquan Gaozhi*. High distance (高远) looks up at a peak from its foot, deep distance (深远) looks past the front ridge into layered valleys, and level distance (平远) looks across to far, low ranges.
- **Four manners.** Ink (水墨), blue-green (青绿), light crimson (浅绛) and snow scene (雪景).
- **Formats.** Hanging scroll, handscroll, square album leaf, round fan and phone wallpaper, with or without a silk mounting.
- **Inscription.** Vertical columns in running, regular or cursive script, with the date in the sexagenary calendar (丙午秋日) and a carved seal. English titles are set horizontally. Gallery mountains come with a matching classical poem.
- **Export.** A large PNG (up to 5,400 px along the painting's long side) or a print-ready PDF in A4, A3 or Letter. The link carries every setting of the painting, so you can share exactly what you see.
- **Private.** Everything is painted on your device, in a Web Worker. There are no accounts, no analytics and no uploads.

<p align="center">
  <a href="https://goldfish76.github.io/inkpeaks/#p=huangshan"><img src="docs/samples/huangshan.jpg" width="30%" alt="Huangshan"></a>
  <a href="https://goldfish76.github.io/inkpeaks/#p=guilin"><img src="docs/samples/guilin.jpg" width="30%" alt="Li River at Xingping"></a>
  <a href="https://goldfish76.github.io/inkpeaks/#p=fuji"><img src="docs/samples/fuji.jpg" width="30%" alt="Mount Fuji"></a>
</p>
<p align="center">
  <a href="https://goldfish76.github.io/inkpeaks/#p=matterhorn"><img src="docs/samples/matterhorn.jpg" width="30%" alt="Matterhorn"></a>
  <a href="https://goldfish76.github.io/inkpeaks/#p=emeishan"><img src="docs/samples/emeishan.jpg" width="30%" alt="Mount Emei"></a>
  <a href="https://goldfish76.github.io/inkpeaks/#p=lofoten"><img src="docs/samples/lofoten.jpg" width="30%" alt="Reine, Lofoten"></a>
</p>
<p align="center">
  <a href="https://goldfish76.github.io/inkpeaks/#p=huashan"><img src="docs/samples/huashan.jpg" width="30%" alt="Mount Hua"></a>
  <a href="https://goldfish76.github.io/inkpeaks/#p=eiger"><img src="docs/samples/eiger.jpg" width="30%" alt="Eiger and Jungfrau"></a>
  <a href="https://goldfish76.github.io/inkpeaks/#p=taishan"><img src="docs/samples/taishan.jpg" width="30%" alt="Mount Tai"></a>
</p>

<p align="center"><img src="docs/styles.jpg" alt="Huangshan in the four manners: ink, blue-green, light crimson and snow scene"></p>

<p align="center"><img src="docs/formats.jpg" alt="A handscroll of the Li River and a round fan of Jade Dragon Snow Mountain"></p>

## How it works

<p align="center"><img src="docs/how-it-works.jpg" alt="Four stages: real elevation, layered ranges, washes hanging from ridges, and the finished painting"></p>

A Song landscape is not a photograph. The painter stacks ranges one behind another, lets ink gather under each ridge and fade downward, and leaves the low ground to mist. Ink Peaks follows those habits with the real terrain:

1. **Terrain (真实地形).** Elevation tiles in Terrarium encoding are fetched and resampled onto a north-up grid in metres. The 28 gallery crops ship with the site.
2. **Layered ranges (层峦).** The ground in front of you is projected with a *floating horizon*: each column of the picture walks from near to far and keeps only what rises above everything nearer. Far ground is lifted and shrunk, so ranges stack up the page the way they do in a scroll. The depth is cut into bands, and each band keeps its own skyline.
3. **Ink washes (墨分五色).** Ink hangs from every true silhouette and fades downward. A smooth slope passes the wash on from the ridge above it, while a real silhouette starts a new layer. Shadow and steepness deepen the tone, and the far ranges fade into the air.
4. **Brush, mist, paper (皴擦、云气、宣纸).** Texture strokes follow the fall line. Then come ridge lines broken by dry brush, moss dots, pines on near crests and ripples on water. A cloud sea fills the valleys, cloud bands drift through the middle distance, and everything sits on fibrous paper. The colour manners lay mineral pigment or ochre over the ink.
5. **Mounting (题款、装裱).** The inscription goes on the side where the sky is clearest, followed by the seal, the silk mount and a small credit line for the terrain data.

The whole painter is about 1,300 lines of plain JavaScript (`js/paint/`) with no dependencies. It runs in a module Web Worker on an `OffscreenCanvas` and falls back to the main thread.

## Run it locally

No build step and no dependencies. Any static file server will do:

```bash
git clone https://github.com/Goldfish76/inkpeaks.git
cd inkpeaks
python -m http.server 8000
```

Then open <http://localhost:8000>. The page uses ES modules, so opening `index.html` straight from the file system won't work. Tested in Chrome.

```
index.html, css/        the page
js/app.js               interface, state in the URL, export
js/paint/               the painter: view grid, raster, brush marks, styles
js/terrain/             elevation tiles and data credits
js/compose.js           inscription, seal and mounting
js/worker.js            runs the painter off the main thread
data/                   gallery, bundled terrain, peak index for search
fonts/                  self-hosted font subsets (OFL)
tools/                  build scripts, a debug page (tools/dev.html) and render helpers
```

The scripts in `tools/` rebuild everything under `data/`, `fonts/`, `docs/` and `img/thumbs/`. Each one explains its use at the top.

## Data and credits

Terrain comes from [Mapterhorn](https://mapterhorn.com/attribution), which merges Copernicus DEM GLO-30 (© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA) with national elevation models such as swisstopo, IGN, GSI, USGS, Kartverket and LINZ. [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) are the fallback. Each painting credits its terrain data in a small line in the margin. Mountain names come from [Wikidata](https://www.wikidata.org) (CC0), and the calligraphy fonts are Ma Shan Zheng, Zhi Mang Xing and Long Cang (SIL OFL). See [ATTRIBUTION.md](ATTRIBUTION.md) for the full list.

Paintings show no political borders, place labels or coordinates.

## See also

[那晚星空 · The Sky That Night](https://github.com/Goldfish76/the-sky-that-night) turns a date and a place into a print-ready poster of the real night sky at that moment.

## License

Code: [MIT](LICENSE). Data and fonts keep their own licenses; see [ATTRIBUTION.md](ATTRIBUTION.md).
