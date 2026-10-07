#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bake the Ink Peaks · 卧游 gallery DEM crops.

For every place in tools/gallery_sources.json this script

1. lays a north-up square grid (side = 2 x radius) on the local east/north
   tangent plane at (lat, lon): metres -> WGS84 lat/lon -> Web-Mercator pixel,
2. samples Terrarium elevation tiles (Mapterhorn; AWS Terrain Tiles as a
   fallback) from an on-disk tile cache, bilinearly,
3. writes data/dem/{id}.png (Terrarium RGB PNG) and data/gallery-dem.json,
4. writes QA hillshades + a contact sheet to tools/.cache/qa/.

Grid rules
  * Outside mainland China: N = 640 samples per side, m/px = 2r/640.
    Zoom = the one whose native m/px is at or just below that target.
  * Mainland China ("china": true): grid spacing must be >= 100 m.
    N = floor(2r / 100), and every output pixel is the MEAN of the elevation
    surface over its whole footprint (k x k supersampling + box average),
    never a point sample.  This implements the Chinese public-map rule that
    DEM grids may not be finer than 100 m, so finer DEMs of China are never
    redistributed.  Do not change this rule.

Per-place options in gallery_sources.json
  * "destripe": true removes N-S column stripes that Mapterhorn tiles carry
    where Copernicus GLO-30 has 1.5" longitude spacing (seen at 49-51 deg S:
    torres, fitzroy).  Every bake logs a stripe score (natural terrain ~1) and
    warns above 2.5.  Leave it off elsewhere: it would erase real N-S grain.

Terrarium encoding of data/dem/*.png (8-bit RGB, no alpha, and no
gAMA / sRGB / iCCP / cHRM chunks, so canvas colour management cannot touch it):
    v = elev_m + 32768
    R = floor(v / 256);  G = floor(v) % 256;  B = floor((v - floor(v)) * 256)
    decode:  elev_m = R * 256 + G + B / 256 - 32768

Usage
    python tools/bake_gallery.py                  # bake every place
    python tools/bake_gallery.py --only fuji,zion # bake a subset (JSON is merged)
    python tools/bake_gallery.py --context        # framing previews only (4r window)
    python tools/bake_gallery.py --source aws     # force the fallback source

Data
    © Mapterhorn (https://mapterhorn.com/attribution).  Copernicus DEM GLO-30:
    © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018
    provided under COPERNICUS by the European Union and ESA; all rights reserved.
    Fallback: AWS Terrain Tiles (Mapzen/Tilezen; SRTM, USGS 3DEP and others).

Politeness: every response (including 404s) is cached under tools/.cache/ and
never requested again; at most 4 requests run in parallel.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import struct
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage, sparse
from scipy.fft import dctn, idctn
from scipy.sparse.linalg import spsolve

ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = ROOT / "tools"
CACHE_DIR = TOOLS_DIR / ".cache"
QA_DIR = CACHE_DIR / "qa"
CONTEXT_DIR = QA_DIR / "context"
DEM_DIR = ROOT / "data" / "dem"
OUT_JSON = ROOT / "data" / "gallery-dem.json"
SOURCES_JSON = TOOLS_DIR / "gallery_sources.json"

USER_AGENT = "InkPeaks-bake_gallery/1.0 (open-source DEM gallery baker; disk tile cache; <=4 parallel)"
MAX_WORKERS = 4

GRID_N = 640                    # samples per side outside mainland China
CHINA_MIN_SPACING_M = 100.0     # mainland China: grid spacing >= 100 m (do not change)
SEA_LEVEL_M = 0.5               # a crop "has sea" if any pixel <= this
QA_SIZE = 320
STRIPE_WARN = 2.5               # stripe_score above this -> warn (natural terrain ~1)

SOURCES = {
    # Mapterhorn: 512 px lossless WebP, Terrarium.  404 "Archive not found"
    # where a zoom level does not exist (e.g. mainland China above z12).
    # Fully-ocean tiles are tiny (~52 byte) but valid all-zero WebPs.
    "mapterhorn": {"url": "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp",
                   "tile": 512, "ext": "webp", "maxzoom": 17},
    # AWS Terrain Tiles: 256 px PNG, Terrarium, z0-15.
    "aws": {"url": "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
            "tile": 256, "ext": "png", "maxzoom": 15},
}

WM_R = 6378137.0                         # Web-Mercator sphere radius
WGS84_A = 6378137.0
WGS84_F = 1.0 / 298.257223563
WGS84_E2 = WGS84_F * (2.0 - WGS84_F)


def log(*args):
    print(*args, flush=True)


# --------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------
def native_mpp(z: int, lat: float, tile: int) -> float:
    """Ground metres per pixel of a Web-Mercator tile pyramid at latitude `lat`."""
    return 2.0 * math.pi * WM_R * math.cos(math.radians(lat)) / (tile * 2 ** z)


def pick_zoom(target_mpp: float, lat: float, tile: int, maxzoom: int) -> int:
    """Lowest zoom whose native m/px is at or just below `target_mpp`."""
    z = 0
    while z < maxzoom and native_mpp(z, lat, tile) > target_mpp * (1 + 1e-9):
        z += 1
    return z


def enu_to_latlon(e, n, lat0: float, lon0: float):
    """Points (e, n) in metres on the tangent plane (u = 0) at (lat0, lon0)
    -> WGS84 geodetic lat/lon in degrees (point dropped onto the ellipsoid
    along its normal).  Exact ENU -> ECEF -> geodetic, no flat-earth shortcut."""
    e = np.asarray(e, dtype=np.float64)
    n = np.asarray(n, dtype=np.float64)
    phi0, lam0 = math.radians(lat0), math.radians(lon0)
    sp, cp, sl, cl = math.sin(phi0), math.cos(phi0), math.sin(lam0), math.cos(lam0)
    n0 = WGS84_A / math.sqrt(1.0 - WGS84_E2 * sp * sp)
    x0, y0, z0 = n0 * cp * cl, n0 * cp * sl, n0 * (1.0 - WGS84_E2) * sp
    x = x0 - sl * e - sp * cl * n
    y = y0 + cl * e - sp * sl * n
    z = z0 + cp * n
    lon = np.arctan2(y, x)
    p = np.hypot(x, y)
    lat = np.arctan2(z, p * (1.0 - WGS84_E2))
    for _ in range(6):                      # converges to < 1e-12 rad in 3-4 steps
        s = np.sin(lat)
        nn = WGS84_A / np.sqrt(1.0 - WGS84_E2 * s * s)
        h = p / np.cos(lat) - nn
        lat = np.arctan2(z, p * (1.0 - WGS84_E2 * nn / (nn + h)))
    return np.degrees(lat), np.degrees(lon)


def latlon_to_px(lat, lon, z: int, tile: int):
    """WGS84 lat/lon (deg) -> global Web-Mercator pixel coords at zoom z.
    Pixel (i, j) of the world image covers [i, i+1) x [j, j+1); its value
    belongs to the pixel centre (i + 0.5, j + 0.5)."""
    world = tile * 2.0 ** z
    x = (np.asarray(lon, dtype=np.float64) + 180.0) / 360.0 * world
    phi = np.radians(np.asarray(lat, dtype=np.float64))
    y = (0.5 - np.log(np.tan(np.pi / 4.0 + phi / 2.0)) / (2.0 * np.pi)) * world
    return x, y


def grid_axes(radius_m: float, n: int, k: int = 1):
    """East and north coordinates (m) of the N*k sub-sample centres, west->east
    and north->south (row 0 = north)."""
    step = 2.0 * radius_m / (n * k)
    c = -radius_m + (np.arange(n * k) + 0.5) * step
    return c, -c


# --------------------------------------------------------------------------
# Tiles
# --------------------------------------------------------------------------
def decode_terrarium(img: Image.Image) -> np.ndarray:
    """Terrarium image -> float64 elevation (m); void pixels -> NaN."""
    void = None
    if img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info:
        alpha = np.asarray(img.convert("RGBA"))[..., 3]
        void = alpha == 0
    a = np.asarray(img.convert("RGB"), dtype=np.float64)
    elev = a[..., 0] * 256.0 + a[..., 1] + a[..., 2] / 256.0 - 32768.0
    bad = (elev < -11000.0) | (elev > 9000.0)     # incl. RGB(0,0,0) = -32768 sentinel
    if void is not None:
        bad |= void
    if bad.any():
        elev[bad] = np.nan
    return elev


class TileStore:
    """Disk-cached Terrarium tile source. Every response, including 404s, is
    cached; a cached tile is never requested again."""

    def __init__(self, name: str, offline: bool = False):
        self.name = name
        self.cfg = SOURCES[name]
        self.tile = self.cfg["tile"]
        self.maxzoom = self.cfg["maxzoom"]
        self.offline = offline
        self.lock = threading.Lock()
        self.stats = {"downloaded": 0, "cached": 0, "missing": 0, "bytes": 0}

    def _count(self, key, inc=1):
        with self.lock:
            self.stats[key] += inc

    def path(self, z, x, y) -> Path:
        return CACHE_DIR / self.name / str(z) / str(x) / f"{y}.{self.cfg['ext']}"

    def _http_get(self, url: str):
        last = None
        for attempt in range(5):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=60) as r:
                    return r.status, r.read()
            except urllib.error.HTTPError as err:
                if err.code in (400, 403, 404, 410):
                    return err.code, err.read()
                last = err                      # 429 / 5xx: retry
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as err:
                last = err
            time.sleep(2.0 * 2 ** attempt)
        raise RuntimeError(f"giving up on {url}: {last}")

    def fetch(self, z: int, x: int, y: int):
        """Elevation array (tile x tile) or None if the tile does not exist."""
        x %= 2 ** z
        path = self.path(z, x, y)
        missing = path.with_suffix(".missing")
        if path.exists():
            self._count("cached")
            return decode_terrarium(Image.open(path))
        if missing.exists():
            self._count("missing")
            return None
        if self.offline:
            raise RuntimeError(f"offline and not cached: {self.name} {z}/{x}/{y}")
        status, body = self._http_get(self.cfg["url"].format(z=z, x=x, y=y))
        arr = None
        if status == 200 and body:
            try:
                img = Image.open(io.BytesIO(body))
                img.load()
                if img.size == (self.tile, self.tile):
                    arr = decode_terrarium(img)
            except Exception:
                arr = None
        path.parent.mkdir(parents=True, exist_ok=True)
        if arr is None:
            # empty body, 404 "Archive not found", HTML error page, wrong size...
            missing.write_text(f"HTTP {status}, {len(body)} bytes: {body[:80]!r}\n", encoding="utf-8")
            self._count("missing")
            return None
        tmp = path.with_suffix(".part")
        tmp.write_bytes(body)
        tmp.replace(path)
        self._count("downloaded")
        self._count("bytes", len(body))
        return arr

    def mosaic(self, z: int, px_min, px_max, py_min, py_max):
        """Mosaic of all tiles covering the global pixel box at zoom z.
        Returns (array, (origin_px_x, origin_px_y), n_tiles) or None if any
        tile is missing."""
        t = self.tile
        n = 2 ** z
        tx0, tx1 = int(math.floor(px_min / t)), int(math.floor(px_max / t))
        ty0, ty1 = int(math.floor(py_min / t)), int(math.floor(py_max / t))
        ty0, ty1 = max(ty0, 0), min(ty1, n - 1)
        jobs = [(z, tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
        with ThreadPoolExecutor(MAX_WORKERS) as ex:
            tiles = list(ex.map(lambda j: self.fetch(*j), jobs))
        if any(tile is None for tile in tiles):
            return None
        out = np.empty(((ty1 - ty0 + 1) * t, (tx1 - tx0 + 1) * t), dtype=np.float64)
        for (_, tx, ty), tile in zip(jobs, tiles):
            out[(ty - ty0) * t:(ty - ty0 + 1) * t, (tx - tx0) * t:(tx - tx0 + 1) * t] = tile
        return out, (tx0 * t, ty0 * t), len(jobs)


# --------------------------------------------------------------------------
# Raster helpers
# --------------------------------------------------------------------------
def fill_voids(arr: np.ndarray) -> np.ndarray:
    """Fill NaN holes by interpolation: solve Laplace's equation inside the
    holes with the surrounding valid pixels as boundary values (harmonic fill:
    smooth, no overshoot, reproduces planes exactly)."""
    void = np.isnan(arr)
    if not void.any():
        return arr
    if void.all():
        raise RuntimeError("tile mosaic is entirely void")
    h, w = arr.shape
    vi = np.flatnonzero(void)
    m = vi.size
    index = np.full(arr.size, -1, dtype=np.int64)
    index[vi] = np.arange(m)
    rows, cols = np.unravel_index(vi, arr.shape)
    known = np.where(void, 0.0, arr)
    diag = np.zeros(m)
    rhs = np.zeros(m)
    ii, jj = [np.arange(m)], [np.arange(m)]
    vv = []
    for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        rr, cc = rows + dr, cols + dc
        inside = (rr >= 0) & (rr < h) & (cc >= 0) & (cc < w)   # array border: Neumann
        diag[inside] += 1.0
        src = np.flatnonzero(inside)
        r2, c2 = rr[inside], cc[inside]
        nb_void = void[r2, c2]
        ii.append(src[nb_void])
        jj.append(index[r2[nb_void] * w + c2[nb_void]])
        vv.append(-np.ones(int(nb_void.sum())))
        np.add.at(rhs, src[~nb_void], known[r2[~nb_void], c2[~nb_void]])
    a = sparse.csr_matrix((np.concatenate([diag] + vv), (np.concatenate(ii), np.concatenate(jj))), shape=(m, m))
    out = arr.copy()
    out.flat[vi] = spsolve(a, rhs)
    return out


def box_mean(a: np.ndarray, k: int) -> np.ndarray:
    if k == 1:
        return a
    n = a.shape[0] // k
    return a.reshape(n, k, n, k).mean(axis=(1, 3))


def encode_terrarium(elev: np.ndarray) -> np.ndarray:
    v = np.clip(elev.astype(np.float64) + 32768.0, 0.0, 65535.0 + 255.0 / 256.0)
    fl = np.floor(v)
    r = np.floor(v / 256.0)
    g = np.mod(fl, 256.0)
    b = np.floor((v - fl) * 256.0)
    return np.stack([r, g, b], axis=-1).astype(np.uint8)


def decode_rgb(rgb: np.ndarray) -> np.ndarray:
    rgb = rgb.astype(np.float64)
    return rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0


def png_chunks(path: Path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, out = 8, []
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8].decode("ascii")
        if ctype == "IHDR":
            w, h, depth, color = struct.unpack(">IIBB", data[pos + 8:pos + 18])
            out.append((ctype, (w, h, depth, color)))
        else:
            out.append((ctype, length))
        pos += 12 + length
    return out


def write_terrarium_png(path: Path, elev: np.ndarray) -> np.ndarray:
    rgb = encode_terrarium(elev)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp.png")
    Image.fromarray(rgb).save(tmp, format="PNG", optimize=True)
    tmp.replace(path)
    chunks = png_chunks(path)
    kinds = {c for c, _ in chunks}
    forbidden = kinds & {"gAMA", "sRGB", "iCCP", "cHRM", "tRNS", "PLTE"}
    assert not forbidden, f"{path.name}: forbidden PNG chunks {forbidden}"
    ihdr = chunks[0][1]
    assert chunks[0][0] == "IHDR" and ihdr[2] == 8 and ihdr[3] == 2, f"{path.name}: not 8-bit RGB {ihdr}"
    with Image.open(path) as im:
        assert im.mode == "RGB" and im.size == elev.shape[::-1]
        back = decode_rgb(np.asarray(im))
    return back


def _ew_ns_power_ratio(elev: np.ndarray, period_bins):
    """E-W / N-S spectral power of the 2nd differences, per band of periods (px)."""
    def spec(axis):
        hp = np.diff(elev, 2, axis=axis)
        hp = hp if axis == 1 else hp.T
        hp = hp - hp.mean(axis=1, keepdims=True)
        s = np.abs(np.fft.rfft(hp * np.hanning(hp.shape[1]), axis=1)) ** 2
        return np.fft.rfftfreq(hp.shape[1]), s.mean(axis=0)
    f, sx = spec(1)
    _, sy = spec(0)
    out = []
    for lo, hi in period_bins:
        m = (f > 1.0 / hi) & (f <= 1.0 / lo)
        out.append(float(sx[m].sum() / max(sy[m].sum(), 1e-12)))
    return out


def stripe_score(elev: np.ndarray) -> float:
    """Detects N-S column striping (a tile-source artefact).  E-W/N-S power at
    2-6 px periods relative to the same ratio at 8-15 px.  Natural terrain,
    even strongly oriented terrain such as Zion's joint canyons, scores ~1;
    the striped Mapterhorn tiles at 49-51 deg S (Copernicus 1.5" longitude
    spacing) score ~15."""
    small = _ew_ns_power_ratio(elev, [(2, 3), (3, 4), (4, 5), (5, 6)])
    large = _ew_ns_power_ratio(elev, [(8, 15)])[0]
    return max(small) / max(large, 1e-12)


def destripe_ns(elev: np.ndarray, max_period_px: float = 8.0, smooth_bins: float = 2.0) -> np.ndarray:
    """Remove N-S stripes: in the DCT domain (symmetric extension, so no edge
    leakage) attenuate each coefficient whose E-W frequency dominates
    (|v| > |u|) and whose wavelength is < max_period_px, down to the power of
    its 90-degree-rotated twin (isotropy assumption).  Only ever attenuates.
    Flat surfaces (lakes/sea, flattened in GLO-30 and stripe-free) are left
    bit-exact so the filter cannot ripple them; the correction is feathered
    in over ~2 px at their shores.
    Opt-in per place ("destripe": true): it would erase real N-S grain."""
    n = elev.shape[0]
    assert elev.shape == (n, n)
    yy, xx = np.mgrid[0:n, 0:n]
    a = np.c_[np.ones(n * n), xx.ravel(), yy.ravel()]
    coef, *_ = np.linalg.lstsq(a, elev.ravel(), rcond=None)
    plane = (a @ coef).reshape(n, n)
    c = dctn(elev - plane, type=2, norm="ortho")
    logp = ndimage.gaussian_filter(np.log(c * c + 1e-9), smooth_bins, mode="mirror")
    gain = np.sqrt(np.minimum(1.0, np.exp(logp.T - logp)))
    u = np.arange(n)[:, None]                 # N-S frequency index
    v = np.arange(n)[None, :]                 # E-W frequency index
    gain = np.where((v > 2.0 * n / max_period_px) & (u < v), gain, 1.0)
    fixed = idctn(c * gain, type=2, norm="ortho") + plane
    # no new local extremes: removing stripes only pulls values toward the local mean
    fixed = np.clip(fixed, ndimage.minimum_filter(elev, 3), ndimage.maximum_filter(elev, 3))
    flat =(ndimage.maximum_filter(elev, 5) - ndimage.minimum_filter(elev, 5)) < 0.6
    weight = 1.0 - ndimage.gaussian_filter(ndimage.binary_dilation(flat).astype(np.float64), 1.0)
    weight[flat] = 0.0
    return elev + np.clip(weight, 0.0, 1.0) * (fixed - elev)


def hillshade(elev: np.ndarray, mpp: float, azimuth=315.0, altitude=45.0) -> np.ndarray:
    """Lambertian hillshade, light from `azimuth` (deg clockwise from north)."""
    dz_drow, dz_dx = np.gradient(elev, mpp)
    dz_dy = -dz_drow                                  # rows run north -> south
    az, alt = math.radians(azimuth), math.radians(altitude)
    lx, ly, lz = math.cos(alt) * math.sin(az), math.cos(alt) * math.cos(az), math.sin(alt)
    shade = (-dz_dx * lx - dz_dy * ly + lz) / np.sqrt(dz_dx ** 2 + dz_dy ** 2 + 1.0)
    return np.clip(shade, 0.0, 1.0)


def qa_image(elev: np.ndarray, mpp: float, size: int, void_mask=None) -> Image.Image:
    hs = hillshade(elev, mpp)
    g = (hs * 255.0).astype(np.float64)
    rgb = np.stack([g, g, g], axis=-1)
    sea = elev <= SEA_LEVEL_M
    rgb[sea] = rgb[sea] * 0.35 + np.array([70.0, 130.0, 200.0]) * 0.65
    if void_mask is not None and void_mask.any():
        rgb[void_mask] = rgb[void_mask] * 0.4 + np.array([255.0, 0.0, 0.0]) * 0.6
    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    if img.size[0] != size:
        img = img.resize((size, size), Image.LANCZOS if img.size[0] > size else Image.BICUBIC)
    return img


def load_font(size: int):
    for name in ("arial.ttf", "segoeui.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


# --------------------------------------------------------------------------
# Sampling
# --------------------------------------------------------------------------
def sample_crop(place: dict, radius_m: float, n: int, k: int, stores: list[TileStore], target_mpp: float):
    """Sample an n x n grid (k x k sub-samples per cell, box-averaged).
    Tries each store in order; within a store starts at the zoom whose native
    m/px is at or just below target_mpp and steps down while tiles are missing."""
    lat0, lon0 = place["lat"], place["lon"]
    e, nn = grid_axes(radius_m, n, k)
    ee, nnn = np.meshgrid(e, nn)
    lat, lon = enu_to_latlon(ee, nnn, lat0, lon0)
    notes = []
    for store in stores:
        z0 = pick_zoom(target_mpp, lat0, store.tile, store.maxzoom)
        for z in range(z0, max(z0 - 4, 0) - 1, -1):
            px, py = latlon_to_px(lat, lon, z, store.tile)
            try:
                res = store.mosaic(z, px.min() - 2, px.max() + 2, py.min() - 2, py.max() + 2)
            except RuntimeError as err:
                notes.append(f"{store.name} z{z}: {err}")
                break
            if res is None:
                notes.append(f"{store.name} z{z} missing tiles -> lower zoom")
                continue
            mos, (ox, oy), ntiles = res
            void = np.isnan(mos)
            n_void_src = int(void.sum())
            if n_void_src:
                mos = fill_voids(mos)
            coords = [(py - oy - 0.5).ravel(), (px - ox - 0.5).ravel()]
            vals = ndimage.map_coordinates(mos, coords, order=1, mode="nearest").reshape(px.shape)
            void_cells = None
            if n_void_src:
                vm = ndimage.map_coordinates(void.astype(np.float64), coords, order=1, mode="nearest")
                void_cells = box_mean(vm.reshape(px.shape), k) > 0
            info = {
                "source": store.name, "zoom": z, "tiles": ntiles,
                "native_mpp": native_mpp(z, lat0, store.tile),
                "void_px_in_mosaic": n_void_src,
                "void_cells": int(void_cells.sum()) if void_cells is not None else 0,
                "notes": notes,
            }
            return box_mean(vals, k), void_cells, info
    raise RuntimeError(f"{place['id']}: no source could cover the crop ({'; '.join(notes)})")


def plan_grid(place: dict):
    r = place["radiusKm"] * 1000.0
    if place.get("china"):
        n = int(math.floor(2.0 * r / CHINA_MIN_SPACING_M))
        mpp = 2.0 * r / n
        assert mpp >= CHINA_MIN_SPACING_M - 1e-9
    else:
        n = GRID_N
        mpp = 2.0 * r / n
    return r, n, mpp


def supersample_factor(place: dict, mpp: float, nat: float) -> int:
    """China: average over the whole footprint with >= 5x5 sub-samples (and at
    least 2 per native source pixel).  Elsewhere: plain bilinear point sample."""
    if place.get("china"):
        return max(5, math.ceil(2.0 * mpp / nat))
    return 1


# --------------------------------------------------------------------------
# Baking
# --------------------------------------------------------------------------
def bake_place(place: dict, stores: list[TileStore]):
    r, n, mpp = plan_grid(place)
    # k depends on the native resolution of the zoom finally used; the zoom
    # pick does not depend on k, so derive k from the first-choice zoom of the
    # primary store and re-check after sampling.
    s0 = stores[0]
    nat0 = native_mpp(pick_zoom(mpp, place["lat"], s0.tile, s0.maxzoom), place["lat"], s0.tile)
    k = supersample_factor(place, mpp, nat0)
    elev, void_cells, info = sample_crop(place, r, n, k, stores, mpp)
    k_needed = supersample_factor(place, mpp, info["native_mpp"])
    if k_needed > k:                       # safety net, e.g. a fallback source with finer pixels
        k = k_needed
        elev, void_cells, info = sample_crop(place, r, n, k, stores, mpp)
    info["k"] = k
    if place.get("china"):
        assert mpp >= CHINA_MIN_SPACING_M and k > 1

    info["stripe_raw"] = stripe_score(elev)
    info["destriped"] = bool(place.get("destripe"))
    if info["destriped"]:
        elev = destripe_ns(elev)
    info["stripe"] = stripe_score(elev)

    out_png = DEM_DIR / f"{place['id']}.png"
    back = write_terrarium_png(out_png, elev)
    err = elev - back
    max_err = float(np.abs(err).max())
    assert max_err < 0.01, f"{place['id']}: round-trip error {max_err}"

    sea = bool((back <= SEA_LEVEL_M).any())
    entry = {
        "id": place["id"], "nameEn": place["nameEn"], "nameZh": place["nameZh"],
        "lat": place["lat"], "lon": place["lon"], "radiusKm": place["radiusKm"],
        "size": n, "mpp": round(mpp, 4),
        "elevMin": round(float(back.min()), 1), "elevMax": round(float(back.max()), 1),
        "elevP01": round(float(np.percentile(back, 1)), 1),
        "elevP99": round(float(np.percentile(back, 99)), 1),
        "sea": sea, "china": bool(place.get("china", False)),
        "zoom": info["zoom"], "source": info["source"],
    }
    qa = qa_image(back, mpp, QA_SIZE, void_cells)
    QA_DIR.mkdir(parents=True, exist_ok=True)
    qa.save(QA_DIR / f"{place['id']}.png")
    info.update({
        "max_err": max_err, "bytes": out_png.stat().st_size,
        "sea_frac": float((back <= SEA_LEVEL_M).mean()),
        "neg_frac": float((back < 0).mean()),
    })
    return entry, info


def contact_sheet(entries: list[dict], tags: dict | None = None, cols: int = 6):
    tags = tags or {}
    font = load_font(15)
    small = load_font(12)
    label_h = 38
    cell_w, cell_h = QA_SIZE, QA_SIZE + label_h
    rows = math.ceil(len(entries) / cols)
    pad = 6
    sheet = Image.new("RGB", (cols * (cell_w + pad) + pad, rows * (cell_h + pad) + pad), (250, 248, 242))
    draw = ImageDraw.Draw(sheet)
    for i, e in enumerate(entries):
        x = pad + (i % cols) * (cell_w + pad)
        y = pad + (i // cols) * (cell_h + pad)
        qa_path = QA_DIR / f"{e['id']}.png"
        if qa_path.exists():
            with Image.open(qa_path) as im:
                sheet.paste(im.convert("RGB"), (x, y))
        label = e["id"] + ("  [CN]" if e["china"] else "") + (f"  ({tags[e['id']]})" if e["id"] in tags else "")
        draw.text((x + 2, y + QA_SIZE + 2), label, fill=(20, 20, 20), font=font)
        sub = (f"z{e['zoom']} {e['source']} {e['mpp']:.1f} m/px {e['size']}px  "
               f"{e['elevMin']:.0f}-{e['elevMax']:.0f} m{'  sea' if e['sea'] else ''}")
        draw.text((x + 2, y + QA_SIZE + 20), sub, fill=(90, 90, 90), font=small)
    sheet.save(QA_DIR / "contact.png")


def write_gallery_json(entries: list[dict]):
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    body = ",\n".join(json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in entries)
    OUT_JSON.write_text("[\n" + body + "\n]\n", encoding="utf-8", newline="\n")


# --------------------------------------------------------------------------
# Framing previews (--context)
# --------------------------------------------------------------------------
def find_peaks(elev: np.ndarray, mpp: float, sep_m: float = 1500.0, count: int = 8):
    w = max(3, int(round(sep_m / mpp)) | 1)
    mx = ndimage.maximum_filter(elev, size=w, mode="nearest")
    cand = np.argwhere((elev == mx) & (elev > np.percentile(elev, 50)))
    cand = sorted(cand.tolist(), key=lambda rc: -elev[rc[0], rc[1]])
    peaks = []
    for rr, cc in cand:
        if all((rr - pr) ** 2 + (cc - pc) ** 2 >= (sep_m / mpp) ** 2 for pr, pc in peaks):
            peaks.append((rr, cc))
        if len(peaks) >= count:
            break
    return peaks


def context_preview(place: dict, stores: list[TileStore], view_px: int = 600):
    """4r x 4r window around the centre with the crop square, a 1 km/2 km/5 km
    grid, the originally proposed centre (+) and numbered local peaks."""
    r = place["radiusKm"] * 1000.0
    half = 2.0 * r
    if place.get("china"):
        n = min(480, int(math.floor(2 * half / CHINA_MIN_SPACING_M)))
    else:
        n = 480
    mpp = 2 * half / n
    k = 2 if place.get("china") else 1
    elev, _, info = sample_crop(place, half, n, k, stores, mpp)
    img = qa_image(elev, mpp, view_px)
    draw = ImageDraw.Draw(img)
    s = view_px / (2 * half)                       # view px per metre

    def to_view(e_m, n_m):
        return (e_m + half) * s, (half - n_m) * s

    step = 1000.0 if r <= 5000 else 2000.0 if r <= 10000 else 5000.0
    for i in range(-int(half // step), int(half // step) + 1):
        x, _ = to_view(i * step, 0)
        _, y = to_view(0, i * step)
        draw.line([(x, 0), (x, view_px)], fill=(255, 255, 255) if i else (255, 220, 0), width=1)
        draw.line([(0, y), (view_px, y)], fill=(255, 255, 255) if i else (255, 220, 0), width=1)
    x0, y0 = to_view(-r, r)
    x1, y1 = to_view(r, -r)
    draw.rectangle([x0, y0, x1, y1], outline=(230, 30, 30), width=3)
    font = load_font(13)
    # originally proposed centre
    if place.get("approx"):
        plat, plon = place["approx"]
        de = (plon - place["lon"]) * math.cos(math.radians(place["lat"])) * 111320.0
        dn = (plat - place["lat"]) * 110574.0
        cx, cy = to_view(de, dn)
        draw.line([(cx - 8, cy), (cx + 8, cy)], fill=(0, 200, 255), width=2)
        draw.line([(cx, cy - 8), (cx, cy + 8)], fill=(0, 200, 255), width=2)
    peaks = find_peaks(elev, mpp)
    e_ax, n_ax = grid_axes(half, n)
    lines = []
    for idx, (rr, cc) in enumerate(peaks, 1):
        pe, pn = e_ax[cc], n_ax[rr]
        plat, plon = enu_to_latlon(pe, pn, place["lat"], place["lon"])
        vx, vy = to_view(pe, pn)
        draw.polygon([(vx, vy - 6), (vx - 5, vy + 4), (vx + 5, vy + 4)], fill=(255, 140, 0))
        draw.text((vx + 6, vy - 8), str(idx), fill=(255, 255, 0), font=font)
        lines.append(f"    peak{idx}: {float(plat):.4f},{float(plon):.4f}  {elev[rr, cc]:.0f} m"
                     f"  ({pe / 1000:+.1f} km E, {pn / 1000:+.1f} km N)")
    draw.text((4, 4), f"{place['id']}  window {2 * half / 1000:.0f} km  grid {step / 1000:.0f} km  "
                      f"z{info['zoom']} {info['source']}", fill=(255, 255, 0), font=font)
    CONTEXT_DIR.mkdir(parents=True, exist_ok=True)
    img.save(CONTEXT_DIR / f"{place['id']}.png")
    inner = elev[n // 4: 3 * n // 4, n // 4: 3 * n // 4]
    log(f"  {place['id']:13s} z{info['zoom']} {info['source']}  crop {inner.min():.0f}-{inner.max():.0f} m,"
        f" window {elev.min():.0f}-{elev.max():.0f} m")
    for line in lines:
        log(line)


# --------------------------------------------------------------------------
def main():
    try:
        sys.stdout.reconfigure(errors="backslashreplace")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="comma-separated ids to (re)bake; other JSON entries are kept")
    ap.add_argument("--context", action="store_true", help="write framing previews to tools/.cache/qa/context/ and exit")
    ap.add_argument("--source", choices=sorted(SOURCES), help="force one source (default: mapterhorn, then aws)")
    ap.add_argument("--offline", action="store_true", help="use cached tiles only")
    args = ap.parse_args()

    doc = json.loads(SOURCES_JSON.read_text(encoding="utf-8"))
    places = doc["places"]
    ids = [p["id"] for p in places]
    assert len(set(ids)) == len(ids), "duplicate ids"
    only = set(args.only.split(",")) if args.only else None
    if only:
        unknown = only - set(ids)
        assert not unknown, f"unknown ids: {unknown}"

    order = [args.source] if args.source else ["mapterhorn", "aws"]
    stores = [TileStore(name, offline=args.offline) for name in order]

    if args.context:
        for p in places:
            if only and p["id"] not in only:
                continue
            context_preview(p, stores)
        for st in stores:
            log(f"{st.name}: {st.stats}")
        return

    previous = {}
    if OUT_JSON.exists():
        try:
            previous = {e["id"]: e for e in json.loads(OUT_JSON.read_text(encoding="utf-8"))}
        except (ValueError, KeyError):
            previous = {}
    entries = []
    for p in places:
        if only and p["id"] not in only:
            if p["id"] in previous:
                entries.append(previous[p["id"]])
            continue
        t0 = time.time()
        entry, info = bake_place(p, stores)
        entries.append(entry)
        log(f"{p['id']:13s} {entry['size']:4d}px {entry['mpp']:7.3f} m/px  z{info['zoom']:<2d} {info['source']:10s}"
            f" native {info['native_mpp']:6.2f} m/px k={info['k']} tiles={info['tiles']:2d}"
            f"  {entry['elevMin']:7.1f}..{entry['elevMax']:7.1f} m (p01 {entry['elevP01']:.0f}, p99 {entry['elevP99']:.0f})"
            f"  sea={'Y' if entry['sea'] else 'n'} ({info['sea_frac'] * 100:4.1f}%, <0: {info['neg_frac'] * 100:.2f}%)"
            f"  void_src={info['void_px_in_mosaic']} void_cells={info['void_cells']}"
            f"  stripe={info['stripe']:.1f}" + (f" (raw {info['stripe_raw']:.1f}, destriped)" if info["destriped"] else "") +
            f"  err={info['max_err']:.4f}  {info['bytes'] / 1024:6.0f} KB  {time.time() - t0:4.1f}s")
        for note in info["notes"]:
            log(f"    note: {note}")
        if info["stripe"] > STRIPE_WARN:
            log(f"    WARNING: N-S striping suspected (stripe score {info['stripe']:.1f} > {STRIPE_WARN});"
                f" inspect tools/.cache/qa/{p['id']}.png and consider \"destripe\": true")

    write_gallery_json(entries)
    contact_sheet(entries, {p["id"]: "destriped" for p in places if p.get("destripe")})
    total = sum((DEM_DIR / f"{e['id']}.png").stat().st_size for e in entries if (DEM_DIR / f"{e['id']}.png").exists())
    log(f"wrote {OUT_JSON.relative_to(ROOT)} ({len(entries)} places), data/dem total {total / 1024 / 1024:.2f} MB")
    for st in stores:
        log(f"{st.name}: {st.stats}")


if __name__ == "__main__":
    main()
