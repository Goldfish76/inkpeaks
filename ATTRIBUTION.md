# Attribution

The code in this repository is MIT-licensed (see [LICENSE](LICENSE)). Data and fonts keep their own licenses.

## Terrain

Ink Peaks reads elevation from [Mapterhorn](https://mapterhorn.com), which merges open elevation datasets into one set of terrain tiles. If Mapterhorn can't be reached, it falls back to [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/).

### Gallery terrain (bundled)

`tools/bake_gallery.py` resampled the 28 gallery crops in `data/dem/*.png` from Mapterhorn tiles. The grid is 100 m for mainland China and 18.75–62.5 m elsewhere, re-encoded as Terrarium PNG. `tools/gallery_credits.py` looks up which sources sit under each crop in Mapterhorn's coverage index and saves the result in `tools/gallery_credits.json`:

| Source | Producer | License | Gallery places |
|---|---|---|---|
| [Copernicus DEM GLO-30](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM) | © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA; all rights reserved | Copernicus DEM licence (full, free and open) | All except Reine, Lofoten |
| [swissALTI3D](https://www.swisstopo.admin.ch/en/height-model-swissalti3d) | Federal Office of Topography swisstopo | Open Government Data | Matterhorn; Eiger and Jungfrau; Mont Blanc |
| [Modello Digitale del Terreno (DTM)](https://geoportale.regione.vda.it/download/dtm/) | Regione Autonoma Valle d'Aosta | CC BY 4.0 | Matterhorn; Mont Blanc |
| [TINITALY 1.1](https://tinitaly.pi.ingv.it/) | Istituto Nazionale di Geofisica e Vulcanologia (INGV) | CC BY 4.0 | Matterhorn; Tre Cime di Lavaredo; Mont Blanc |
| [Digitales Geländemodell (DGM 2,5 m)](https://natur-raum.provinz.bz.it/de/digitale-hohenmodelle) | Autonome Provinz Bozen – Südtirol | CC0 | Tre Cime di Lavaredo |
| [RGE ALTI® 1 m / 5 m](https://geoservices.ign.fr/rgealti), [MNT LiDAR HD](https://www.data.gouv.fr/datasets/mnt-lidar-hd) | Institut national de l'information géographique et forestière (IGN) | Licence Ouverte / Open Licence 2.0 | Mont Blanc |
| [基盤地図情報 数値標高モデル](https://service.gsi.go.jp/kiban/app/) (Fundamental Geospatial Data, DEM) | 国土交通省国土地理院 (Geospatial Information Authority of Japan, GSI) | 国土地理院コンテンツ利用規約 (GSI Content Terms of Use) | Mount Fuji |
| [Terrengmodell (DTM)](https://www.kartverket.no/api-og-data/terrengdata) | Kartverket | CC BY 4.0 | Reine, Lofoten |
| [New Zealand LiDAR 1 m DEM](https://www.linz.govt.nz/products-services/data/types-linz-data/elevation-data/access-elevation-data) | Toitū Te Whenua Land Information New Zealand (LINZ) | CC BY 4.0 | Milford Sound; Aoraki / Mount Cook |
| [USGS 3DEP](https://www.usgs.gov/3d-elevation-program) 1 m and 1/3 arc-second DEMs | U.S. Geological Survey | Public domain | Yosemite Valley; Mount Rainier; Denali |

Mount Fuji: 「基盤地図情報 数値標高モデル」（国土地理院）を加工して作成 (processed from GSI's Fundamental Geospatial Data DEM).

Dataset versions are the ones Mapterhorn accessed in 2025–2026. Its [attribution.json](https://download.mapterhorn.com/attribution.json) lists each version.

### Places you search (fetched in your browser, not bundled)

When you search a place, the app fetches its terrain from Mapterhorn while it paints. Mapterhorn's coverage index tells the app which producers made the tiles it used, and the painting's margin names them, for example "Terrain © swisstopo, Copernicus via Mapterhorn". If the index can't be read (some browsers block the request), the margin credits Mapterhorn and its attribution page instead. [mapterhorn.com/attribution](https://mapterhorn.com/attribution) lists every source Mapterhorn may draw on.

The fallback, AWS Terrain Tiles, comes from Mapzen/Tilezen. It merges SRTM, USGS 3DEP, GMTED2010, ETOPO1 and others; see [tilezen/joerd](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).

## Other data and fonts

| What | Files | Source | License |
|---|---|---|---|
| Mountain names and positions (search) | `data/peaks.json` | [Wikidata](https://www.wikidata.org) | CC0 |
| Traditional → simplified Chinese names (build time only, not distributed) | `tools/build_peaks.py` | [OpenCC](https://github.com/BYVoid/OpenCC) `TSCharacters.txt` | Apache-2.0 |
| Fonts (self-hosted subsets, built by `tools/build_fonts.py`) | `fonts/` | Jost, Cormorant Garamond, Noto Sans SC, Noto Serif SC, Ma Shan Zheng (马善政), Zhi Mang Xing (志莽行书) and Long Cang (龙藏), from [google/fonts](https://github.com/google/fonts) | SIL Open Font License 1.1 ([`fonts/licenses/`](fonts/licenses)) |
| Poem lines in the default inscriptions | `data/gallery.json` | Classical poems by 李白, 杜甫, 苏轼, 王维, 韩愈, 寇准, 柳宗元 and the 《瀑布联句》 | Public domain |

The scripts in `tools/` rebuild every derived file:
- `bake_gallery.py`, `gallery_credits.py` and `build_gallery.py` make the gallery.
- `build_peaks.py` makes the search index.
- `build_fonts.py` makes the fonts.
- `make_docs.py` makes the README images and gallery thumbnails.

## Credit on paintings

Every exported painting has a small credit line for its terrain data in the margin. You can switch it off. If you publish a painting, please keep crediting the elevation data. Several sources, the CC BY ones among them, require it.

## No borders

Paintings show no political borders, place labels or coordinates. For the gallery mountains in mainland China, the bundled terrain uses a 100 m grid.
