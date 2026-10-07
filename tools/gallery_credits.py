"""Find who made the terrain under each gallery place: writes tools/gallery_credits.json.

    python tools/gallery_credits.py
    python tools/build_gallery.py        # copies the credits into data/gallery.json

Mapterhorn merges many open elevation datasets. Its coverage index
(https://download.mapterhorn.com/coverage-index.pmtiles, a PMTiles archive of small JSON tiles,
zoom 4-12) names the sources behind every terrain tile. For each place in data/gallery-dem.json
this reads the index tiles under the crop at the zoom it was baked from, and keeps the sources
and their short producer names, finest data first. js/terrain/credits.js does the same in the
browser for places people search. PMTiles format:
https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
"""
import gzip
import json
import math
import struct
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tools" / "gallery_credits.json"
INDEX_URL = "https://download.mapterhorn.com/coverage-index.pmtiles"
TILE = 512                                  # Mapterhorn tile size in pixels


def get_range(offset, length):
    req = urllib.request.Request(INDEX_URL, headers={"Range": f"bytes={offset}-{offset + length - 1}",
                                                     "User-Agent": "inkpeaks-gallery-credits"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
        return body[offset:offset + length] if r.status == 200 else body


def decompress(data, kind):
    if kind in (0, 1):                      # unknown / none
        return data
    if kind == 2:
        return gzip.decompress(data)
    raise ValueError(f"unsupported compression {kind}")


def varint(buf, i):
    shift = value = 0
    while True:
        b = buf[i]
        i += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, i
        shift += 7


def parse_directory(buf):
    n, i = varint(buf, 0)
    cols = []
    for _ in range(4):                      # tile ids (delta), run lengths, lengths, offsets
        col = []
        for _ in range(n):
            v, i = varint(buf, i)
            col.append(v)
        cols.append(col)
    ids, runs, lens, raw = cols
    for k in range(1, n):
        ids[k] += ids[k - 1]
    offs = []
    for k in range(n):
        offs.append(offs[k - 1] + lens[k - 1] if raw[k] == 0 and k > 0 else raw[k] - 1)
    return list(zip(ids, runs, lens, offs))


def tile_id(z, x, y):
    """Position on the Hilbert curve, counting all tiles of lower zooms first."""
    acc = ((1 << (2 * z)) - 1) // 3
    for a in range(z - 1, -1, -1):
        s = 1 << a
        rx, ry = s & x, s & y
        acc += ((3 * rx) ^ ry) << a
        if ry == 0:
            if rx:
                x, y = s - 1 - x, s - 1 - y
            x, y = y, x
    return acc


def find_entry(entries, tid):
    lo, hi = 0, len(entries) - 1
    while lo <= hi:
        m = (lo + hi) // 2
        if entries[m][0] < tid:
            lo = m + 1
        elif entries[m][0] > tid:
            hi = m - 1
        else:
            return entries[m]
    if hi >= 0 and (entries[hi][1] == 0 or tid - entries[hi][0] < entries[hi][1]):
        return entries[hi]
    return None


class CoverageIndex:
    def __init__(self):
        head = get_range(0, 16384)
        if head[:7] != b"PMTiles" or head[7] != 3:
            raise RuntimeError("not a PMTiles v3 archive")
        root_off, root_len, _, _, self.leaf_off, _, self.data_off = struct.unpack_from("<7Q", head, 8)
        self.icomp, self.tcomp = head[97], head[98]
        self.min_zoom, self.max_zoom = head[100], head[101]
        self.root = parse_directory(decompress(head[root_off:root_off + root_len], self.icomp))
        self.leaves = {}

    def tile(self, z, x, y):
        tid = tile_id(z, x, y)
        entries = self.root
        for _ in range(4):
            e = find_entry(entries, tid)
            if e is None:
                return {}
            _, run, length, offset = e
            if run > 0:
                return json.loads(decompress(get_range(self.data_off + offset, length), self.tcomp))
            if (offset, length) not in self.leaves:
                self.leaves[(offset, length)] = parse_directory(
                    decompress(get_range(self.leaf_off + offset, length), self.icomp))
            entries = self.leaves[(offset, length)]
        return {}


def crop_tiles(place, z):
    """Tiles at zoom z under the square, north-up crop (side 2 x radiusKm)."""
    lat, lon, r = place["lat"], place["lon"], place["radiusKm"] * 1000.0
    dlat = r / 111320.0
    dlon = r / (111320.0 * math.cos(math.radians(max(abs(lat - dlat), abs(lat + dlat)))))
    n = 2 ** z

    def tx(lo):
        return int((lo + 180.0) / 360.0 * n)

    def ty(la):
        s = math.sin(math.radians(la))
        return int((0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n)

    return [(z, x % n, y) for x in range(tx(lon - dlon), tx(lon + dlon) + 1)
            for y in range(ty(lat + dlat), ty(lat - dlat) + 1)]


def main():
    index = CoverageIndex()
    places = json.loads((ROOT / "data" / "gallery-dem.json").read_text(encoding="utf-8"))
    out = {}
    for p in places:
        if p.get("source") != "mapterhorn":
            continue
        z = min(p["zoom"], index.max_zoom)
        found = {}
        for t in crop_tiles(p, z):
            found.update(index.tile(*t))
        ranked = sorted(found.items(), key=lambda kv: (kv[1]["resolution"], kv[1]["producer_short"]))
        producers = []
        for _, meta in ranked:
            if meta["producer_short"] not in producers:
                producers.append(meta["producer_short"])
        out[p["id"]] = {"sources": [k for k, _ in ranked], "credit": producers}
        print(f"{p['id']:14s} z{z}  {', '.join(producers)}")
    body = ",\n".join(f" {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}" for k, v in out.items())
    OUT.write_text("{\n" + body + "\n}\n", encoding="utf-8", newline="\n")
    print(f"{len(out)} places -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
