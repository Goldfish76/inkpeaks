#!/usr/bin/env python3
"""Build data/peaks.json, the offline mountain gazetteer for Ink Peaks · 卧游.

Source: Wikidata (CC0) through the Wikidata Query Service (WDQS).

    python tools/build_peaks.py            # use cached query results where present
    python tools/build_peaks.py --refresh  # re-query everything (several minutes)
    python tools/build_peaks.py --offline  # never touch the network; cache only

Stages
  1. scan     Page through every instance of the mountain-like classes below and
              keep the candidates (>= MIN_SL sitelinks, or a Chinese label, or a
              P2044 elevation >= 3000 m). Big classes are paged with a named
              subquery (LIMIT/OFFSET) so that no single query nears the 60 s limit.
  2. details  Labels (en, mul, zh-*), best-rank coordinates (with globe and
              precision), best-rank elevations (with units) and P31 classes, in
              VALUES batches.
  3. select   Popularity filter, de-duplication, sort by sitelinks.
  4. aliases  English and Chinese aliases (skos:altLabel, other zh variants, the
              zhwiki article title) for the top ~2,000 entries only.
  5. write    Minified data/peaks.json plus a sanity report on stdout.

Raw query results (the WDQS JSON, gzipped) are cached in tools/.cache/wikidata/,
keyed by a hash of the query text, so a re-run with unchanged settings is
offline and deterministic. OpenCC's TSCharacters.txt (Apache-2.0) is downloaded
at build time into the same cache. The cache directory carries its own
.gitignore ("*"), so none of it is ever committed.

Only the Python 3.11 standard library is used.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache" / "wikidata"
OUT = ROOT / "data" / "peaks.json"

ENDPOINT = "https://query.wikidata.org/sparql"
UA = "InkPeaksGazetteer/0.1 (https://github.com/Goldfish76/inkpeaks)"
OPENCC_URL = "https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSCharacters.txt"

# --------------------------------------------------------------------------
# Classes. `wdt:P31/wdt:P279*` is not used: the subclass trees of hill and
# mountain also contain dunes, spoil tips, compost heaps, seamounts and
# planetary "montes", and the transitive walk over ~850k items times out.
# The common, genuinely terrestrial subclasses are listed explicitly instead.
# --------------------------------------------------------------------------
PEAK_CLASSES = {
    # the five requested roots
    "Q8502": "mountain", "Q8072": "volcano", "Q54050": "hill",
    "Q1061151": "massif", "Q207326": "summit",
    # mountain / hill subclasses
    "Q1139493": "inselberg", "Q1595289": "sacred mountain",
    "Q3116906": "ultra-prominent peak", "Q11571545": "isolated peak",
    "Q623319": "mesa", "Q828329": "tepui", "Q5421955": "fell",
    "Q10561633": "hometown Fuji", "Q11588709": "shintaisan",
    "Q1242936": "double summit", "Q502899": "outlier", "Q15812753": "grass mountain",
    "Q2997316": "sopka", "Q100989082": "vaara", "Q2459045": "granite dome",
    "Q1868238": "mogote", "Q107983776": "monadnock", "Q1343179": "tor",
    "Q873398": "cuesta", "Q3294251": "hillock", "Q55182635": "knoll",
    "Q62088999": "knob", "Q1671747": "conical hill", "Q4959757": "breast-shaped hill",
    "Q1792880": "Kuppe", "Q194408": "nunatak", "Q285562": "Marilyn",
    "Q442987": "Hewitt", "Q1320721": "Munro", "Q11964099": "Corbett",
    "Q11972429": "Graham",
    # volcano subclasses
    "Q169358": "stratovolcano", "Q212057": "shield volcano",
    "Q1197120": "extinct volcano", "Q1368970": "volcanic cone",
    "Q534282": "lava dome", "Q1806785": "cinder cone", "Q1330974": "active volcano",
    "Q1325302": "dormant volcano", "Q1200524": "complex volcano",
    "Q20743938": "eruptive center", "Q2143039": "fissure vent",
    "Q332614": "supervolcano", "Q367004": "tuya", "Q100365971": "lateral volcano",
    "Q1142381": "parasitic cone", "Q771409": "subglacial volcano",
    "Q1491559": "somma volcano", "Q6151660": "tuff ring", "Q6502221": "lava cone",
    "Q37499745": "plug dome volcano", "Q190869": "central volcano",
    "Q995054": "pyroclastic shield", "Q11566951": "pyroclastic cone",
    "Q123469891": "ash cone", "Q2398326": "subaerial volcano",
    "Q159954": "caldera", "Q2895674": "volcanic group",
    # summit subclasses
    "Q3618634": "subpeak", "Q131860194": "minor summit", "Q111177881": "main peak",
    "Q12059057": "one-thousander", "Q233165": "two-thousander",
    "Q1258187": "three-thousander", "Q1740763": "four-thousander",
    "Q36648794": "five-thousander", "Q65255159": "six-thousander",
    "Q65256324": "seven-thousander", "Q185552": "eight-thousander",
    "Q102166120": "fourteener", "Q7785181": "thirteener",
    "Q1570358": "pyramidal peak", "Q27963400": "virgin peak",
    "Q748184": "climbing peak", "Q3538399": "trekking peak",
    "Q11397890": "Kengamine",
    # massif subclasses (SOIUSA Alpine subdivisions)
    "Q514999": "alpine subgroup", "Q3958436": "sector of alpine subgroup",
}
# Extra beyond the brief: famous Chinese mountains such as 华山 (Q112568) and
# 黄山 (Q36034), plus 梅里雪山, 武夷山, 武当山, 秦岭 and 太行山, are typed only as
# "mountain range" on Wikidata (the Altai, Alaska Range and Black Forest use the
# other range classes). Ranges get a stricter popularity bar (below).
RANGE_CLASSES = {
    "Q46831": "mountain range", "Q1437459": "non-geologically related mountain range",
    "Q2624046": "mountain chain", "Q674541": "low mountain range",
    "Q9381142": "hill chain", "Q77854728": "group of mountains",
}

# Items that are also an instance of one of these are dropped (fictional,
# extraterrestrial, submarine and man-made "mountains", dunes, ...).
EXCLUDE_CLASSES = {
    "Q19838114": "fictional mountain", "Q15831596": "fictional location",
    "Q429088": "mons", "Q2983016": "colles", "Q723802": "lunar dome",
    "Q478788": "cryovolcano", "Q526644": "pancake dome",
    "Q682471": "scalloped margin dome", "Q100167812": "Martian boulder or hill",
    "Q190250": "central uplift", "Q503269": "seamount", "Q151957": "guyot",
    "Q47781032": "group of seamounts", "Q674775": "submarine volcano",
    "Q7630766": "subaqueous volcano", "Q4670743": "abyssal hill",
    "Q47781632": "undersea hill", "Q193457": "mud volcano", "Q842928": "sand volcano",
    "Q104698": "mid-ocean ridge", "Q11702690": "undersea ridge",
    "Q55182671": "undersea landform",
    "Q25391": "dune", "Q10460934": "artificial hill", "Q819511": "spoil tip",
    "Q843181": "Schuttberg", "Q505963": "artificial dwelling hill",
    "Q14947481": "wierde", "Q5507555": "Fujizuka", "Q2710737": "stockpile",
    "Q331211": "overburden dump", "Q109278954": "coal tip",
    "Q105988252": "tailings dump", "Q1205140": "barrier island",
    "Q43397044": "hilltop site", "Q4167410": "Wikimedia disambiguation page",
    # settlements: the app shows no political or settlement labels
    "Q486972": "human settlement", "Q532": "village", "Q3957": "town", "Q515": "city",
    "Q1549591": "big city", "Q5119": "capital", "Q15284": "municipality",
}

# Submarine features typed only as mountain / volcano / mountain range.
EXCLUDE_ITEMS = {
    "Q632794": "Hawaiian–Emperor seamount chain", "Q3321642": "Adams Seamount",
    "Q4887861": "Benham Rise", "Q1658385": "Ile des Cendres (submarine volcano)",
    "Q1783754": "Kuwae (submarine caldera)", "Q807010": "Banua Wuhu (submarine volcano)",
}

# Famous non-peak terrain people search for. Always included (no popularity
# filter). Optional: coordinate override and extra search aliases.
CURATED = [
    ("Q118841", "Grand Canyon", None, ["大峡谷"]),
    ("Q1996389", "Yosemite Valley", None, ["优胜美地"]),
    ("Q8072495", "Zion Canyon", None, ["锡安峡谷"]),
    ("Q187197", "Milford Sound / Piopiotahi", None, ["Milford Sound", "Piopiotahi"]),
    ("Q190128", "Ha Long Bay", None, ["Halong Bay"]),
    ("Q186822", "Lofoten", None, []),
    ("Q3895620", "Zhangjiajie National Forest Park", None, ["张家界", "Zhangjiajie"]),
    # Li River: P625 has two values (upper course N of Guilin, and Pingle); use the
    # Guilin–Yangshuo karst stretch at Xingping instead.
    ("Q334225", "Li River", (24.9200, 110.5200), ["Lijiang River"]),
    ("Q124305089", "Torres del Paine (the towers)", None, []),
    ("Q901646", "Torres del Paine National Park", None, ["Torres del Paine"]),
    ("Q1257207", "Tre Cime di Lavaredo", None, ["Tre Cime", "Drei Zinnen"]),
    ("Q1283", "Dolomites", None, []),
    ("Q213360", "Table Mountain", None, []),
    ("Q676203", "Machu Picchu", None, []),
    ("Q4111", "Jiuzhaigou Valley", None, ["九寨沟", "Jiuzhaigou"]),
    ("Q36034", "Huangshan (scenic area)", None, ["黄山风景区", "Yellow Mountain"]),
    # a few more of the same kind
    ("Q4187", "Wulingyuan", None, ["武陵源风景名胜区"]),
    ("Q17638329", "Zhangye Danxia", None, ["张掖丹霞", "七彩丹霞", "Rainbow Mountains"]),
    ("Q1460797", "Tiger Leaping Gorge", None, []),
    ("Q673287", "Three Gorges", None, ["三峡"]),
    ("Q853364", "South China Karst", None, []),
    ("Q192017", "Monument Valley", None, []),
    ("Q1124852", "El Capitan", None, []),
    ("Q33910", "Uluru", None, ["Ayers Rock", "艾尔斯岩"]),
    ("Q193989", "Geirangerfjord", None, []),
    ("Q746223", "Preikestolen", None, ["Pulpit Rock"]),
    ("Q1512593", "Trolltunga", None, []),
    ("Q716232", "Putuoshan (island; one of the four sacred Buddhist mountains)", None, ["普陀山"]),
    ("Q131148", "Stromboli (typed only as an island)", None, []),
    ("Q82613", "Krakatoa (typed as caldera / former island)", None, ["Krakatau"]),
    ("Q179842", "Tibetan Plateau", None, ["青藏高原"]),
    ("Q293730", "Loess Plateau", None, ["黄土高原"]),
    ("Q604329", "Yunnan–Guizhou Plateau", None, ["云贵高原"]),
]

# Extra search names for items that the popularity filter selects anyway.
EXTRA_ALIASES = {
    "Q216059": ["东岳泰山"], "Q112568": ["西岳华山"], "Q644965": ["南岳衡山"],
    "Q1323539": ["北岳恒山"], "Q1140980": ["中岳嵩山"],
    # Its zh label is 阿里山山脉, and "阿里山 (非洲)" (Mousa Ali, Q1951029) loses
    # its disambiguator, so make sure 阿里山 also finds Taiwan's Alishan.
    "Q717495": ["阿里山"],
}

# Wrong-looking P625 values on famous peaks, checked against the summits.
COORD_OVERRIDES = {
    # Mount Heng (Shanxi) 恒山: P625 is 38.583,112.900 (~140 km SW, near Ningwu).
    # The main peak Tianfengling is S of Hunyuan (zhwiki 恒山: 39.6739,113.7356;
    # the 1-sitelink duplicate Q31684016 also sits there).
    "Q1323539": (39.6739, 113.7356),
}

# Selection thresholds (sitelinks = Wikidata sitelink count = the "rank" field).
# The brief's "~3 sitelinks unless >= 3000 m or a Chinese label" would keep
# ~60k items, because bot-generated stubs (cebwiki, svwiki, lldwiki, arzwiki,
# ...) give minor peaks 3-7 sitelinks. These bars land at ~14.5k entries.
MIN_SL = 8               # any peak-class item with at least this many sitelinks
MIN_SL_ZH = 2            # ...or this many with a Chinese label inside ZH_REGION
MIN_SL_HIGH = 3          # ...or this many with elevation >= EXCEPTION_ELEV
EXCEPTION_ELEV = 3000
MIN_SL_RANGE = 15        # mountain ranges
MIN_SL_RANGE_ZH = 6      # mountain ranges with a Chinese label inside ZH_REGION
# The Chinese-label exception only applies in East Asia (China, Taiwan, Korea,
# Japan, Mongolia, the Himalaya-Karakoram). Elsewhere zh labels on low-sitelink
# peaks are mostly bot transliterations (e.g. ~1.7k Andean peaks such as
# 維尼維尼山 "Wini Wini", ~2.5k minor Alpine peaks); those still keep their zh
# label when another rule selects them.
ZH_REGION = (15.0, 55.0, 70.0, 150.0)  # lat_min, lat_max, lon_min, lon_max
ANTARCTIC_LAT = -60.0    # south of this, ~7k bot stubs (6-9 sitelinks each, incl.
ANTARCTIC_MIN_SL = 12    # zhwiki) would crowd out real peaks; Vinson, Erebus stay
ALIAS_TOP_N = 2000
MAX_ALIASES = 6
MAX_ENTRIES = 20000
MAX_BYTES = 1_200_000
DEDUP_KM = 1.0

ZH_SIMPLIFIED = ("zh-hans", "zh-cn", "zh", "zh-sg", "zh-my")
ZH_TRADITIONAL = ("zh-hant", "zh-tw", "zh-hk", "zh-mo")
ZH_LANGS = ZH_SIMPLIFIED + ZH_TRADITIONAL
LABEL_LANGS = ("en", "mul") + ZH_LANGS
EARTH = "http://www.wikidata.org/entity/Q2"
UNIT_FACTORS = {  # P2044 units -> metres (anything else, incl. unitless, is ignored)
    "http://www.wikidata.org/entity/Q11573": 1.0,      # metre
    "http://www.wikidata.org/entity/Q3710": 0.3048,    # foot
    "http://www.wikidata.org/entity/Q828224": 1000.0,  # kilometre
}
PAGE = 50_000
PAGE_OVERLAP = 500   # tolerate small shifts between page queries (edits)
BATCH = 2000
LABEL_BUDGET = 20_000  # max sum of sitelinks per label/alias batch

ARGS = argparse.Namespace(refresh=False, offline=False)
_last_request = [0.0]
STATS = Counter()


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def ensure_cache_dir() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    ignore = CACHE / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8")


class QueryTimeout(Exception):
    """WDQS hit its 60 s limit twice for the same query."""


# ---------------------------------------------------------------- WDQS access
def sparql(query: str, name: str) -> list[dict]:
    """POST a query to WDQS (sequentially, >= 1 s apart) with an on-disk cache."""
    digest = hashlib.sha1(query.encode("utf-8")).hexdigest()[:10]
    path = CACHE / f"{name}_{digest}.json.gz"  # raw WDQS JSON, gzipped
    if path.exists() and not ARGS.refresh:
        STATS["cache_hits"] += 1
        return json.loads(gzip.decompress(path.read_bytes()))["results"]["bindings"]
    if ARGS.offline:
        raise SystemExit(f"--offline: no cached result for {name} ({path.name})")
    body = urllib.parse.urlencode({"query": query}).encode()
    timeouts = 0
    for attempt in range(8):
        pause = 1.0 - (time.time() - _last_request[0])
        if pause > 0:
            time.sleep(pause)
        req = urllib.request.Request(ENDPOINT, data=body, headers={
            "User-Agent": UA,
            "Accept": "application/sparql-results+json",
            "Content-Type": "application/x-www-form-urlencoded",
        })
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=150) as resp:
                raw = resp.read()
            _last_request[0] = time.time()
            rows = json.loads(raw)["results"]["bindings"]
            ensure_cache_dir()
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(gzip.compress(raw, compresslevel=6, mtime=0))
            tmp.replace(path)
            STATS["queries"] += 1
            log(f"  {name}: {len(rows)} rows, {time.time() - t0:.1f}s")
            return rows
        except urllib.error.HTTPError as e:
            _last_request[0] = time.time()
            text = e.read()[:2000].decode("utf-8", "replace")
            log(f"  {name}: HTTP {e.code} after {time.time() - t0:.1f}s")
            if e.code not in (429, 500, 502, 503, 504):
                raise
            if e.code == 504 or "TimeoutException" in text:
                timeouts += 1
                if timeouts >= 2:  # retrying a query that times out is pointless
                    raise QueryTimeout(name)
            retry_after = e.headers.get("Retry-After", "")
            delay = int(retry_after) if retry_after.isdigit() else 10 * 2 ** attempt
            time.sleep(min(delay, 600))
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as e:
            _last_request[0] = time.time()
            log(f"  {name}: {type(e).__name__}: {e}")
            time.sleep(min(10 * 2 ** attempt, 600))
    raise SystemExit(f"{name}: giving up after repeated errors")


def qid(binding: dict) -> str:
    return binding["value"].rsplit("/", 1)[1]


def values_clause(qids) -> str:
    return " ".join("wd:" + q for q in qids)


def qnum(q: str) -> int:
    return int(q[1:])


# ------------------------------------------------------------ stage 1: scan
def class_sizes(classes: list[str]) -> dict[str, int]:
    # NB: "VALUES ?cls {...} ?item wdt:P31 ?cls } GROUP BY ?cls" silently returns
    # zero rows on WDQS (Blazegraph); a UNION of per-class range counts is instant.
    parts = [f"{{ {{ SELECT (COUNT(*) AS ?n) WHERE {{ ?item wdt:P31 wd:{c} }} }} BIND(wd:{c} AS ?cls) }}"
             for c in classes]
    q = "SELECT ?cls ?n WHERE {\n  " + "\n  UNION ".join(parts) + "\n}"
    sizes = {qid(r["cls"]): int(r["n"]["value"]) for r in sparql(q, "class_sizes")}
    if set(sizes) != set(classes) or sizes.get("Q8502", 0) < 100_000:
        raise SystemExit(f"class_sizes looks wrong: {sizes}")
    return sizes


# The named subquery (WITH ... AS %page) is evaluated first, so each request
# touches at most PAGE (+ overlap) class members; pages follow index order.
SCAN_QUERY = """SELECT ?item ?sl
WITH {{ SELECT {distinct} ?item WHERE {{ {members} }} LIMIT {limit} OFFSET {offset} }} AS %page
WHERE {{
  INCLUDE %page .
  ?item wikibase:sitelinks ?sl .
  FILTER EXISTS {{ ?item wdt:P625 ?coord }}
  FILTER(?sl >= {min_sl}
    || EXISTS {{ ?item rdfs:label ?zl . FILTER(LANG(?zl) IN ({zh_langs})) }}
    || EXISTS {{ ?item p:P2044/psn:P2044/wikibase:quantityAmount ?m . FILTER(?m >= {elev}) }})
}}"""


def scan_groups(sizes: dict[str, int]) -> list[tuple[list[str], int]]:
    """Big classes are paged on their own; small ones share one query."""
    groups, small, small_n = [], [], 0
    for cls, n in sorted(sizes.items(), key=lambda kv: (-kv[1], qnum(kv[0]))):
        if n == 0:
            continue
        if n > PAGE // 2:
            groups.append(([cls], n))
        elif small_n + n > PAGE:
            groups.append((small, small_n))
            small, small_n = [cls], n
        else:
            small.append(cls)
            small_n += n
    if small:
        groups.append((small, small_n))
    return groups


def scan_page(tag: str, members: str, distinct: str, offset: int, size: int) -> list[dict]:
    """One page of class members; split in half (recursively) if WDQS times out."""
    zh_langs = ", ".join(f'"{l}"' for l in ZH_LANGS)
    q = SCAN_QUERY.format(members=members, distinct=distinct, limit=size + PAGE_OVERLAP,
                          offset=offset, zh_langs=zh_langs, elev=EXCEPTION_ELEV, min_sl=MIN_SL)
    try:
        return sparql(q, f"scan_{tag}_{offset:07d}")
    except QueryTimeout:
        if size <= 5000 or distinct:
            raise SystemExit(f"scan_{tag}_{offset:07d} keeps timing out")
        half = size // 2
        log(f"  splitting scan_{tag}_{offset:07d} into two pages of {half}")
        return (scan_page(tag, members, distinct, offset, half)
                + scan_page(tag, members, distinct, offset + half, size - half))


def scan() -> dict[str, dict]:
    classes = list(PEAK_CLASSES) + list(RANGE_CLASSES)
    sizes = class_sizes(classes)
    cands: dict[str, dict] = {}
    for gi, (group, n) in enumerate(scan_groups(sizes)):
        tag = group[0] if len(group) == 1 else f"group{gi:02d}"
        # Multi-class groups fit in one page (no ordering issue with DISTINCT);
        # single big classes page in index order without DISTINCT.
        if len(group) == 1:
            distinct, members = "", f"?item wdt:P31 wd:{group[0]}"
        else:
            distinct = "DISTINCT"
            members = f"VALUES ?cls {{ {values_clause(sorted(group, key=qnum))} }} ?item wdt:P31 ?cls"
        for offset in range(0, n, PAGE):
            rows = scan_page(tag, members, distinct, offset, PAGE)
            if not rows and n - offset > 5000:
                log(f"  WARNING: scan_{tag}_{offset:07d} returned nothing for a big page")
            for r in rows:
                c = cands.setdefault(qid(r["item"]), {"sl": 0})
                c["sl"] = max(c["sl"], int(r["sl"]["value"]))
    for q, *_ in CURATED:  # curated items bypass the scan
        cands.setdefault(q, {"sl": 0})
    log(f"scan: {len(cands)} candidates from {len(classes)} classes "
        f"({sum(sizes.values())} instances in total)")
    return cands


# --------------------------------------------------------- stage 2: details
LABEL_QUERY = """SELECT ?item ?l WHERE {{
  VALUES ?item {{ {values} }}
  ?item {pred} ?l .
  FILTER(LANG(?l) IN ({langs}))
}}"""

CLAIM_QUERY = """SELECT ?item ?k ?a ?b ?c ?d ?f ?sl WHERE {{
  VALUES ?item {{ {values} }}
  {{ ?item wikibase:sitelinks ?sl . BIND("s" AS ?k) }}
  UNION
  {{ ?item p:P625 ?st . ?st a wikibase:BestRank ; psv:P625 ?v .
     ?v wikibase:geoLatitude ?a ; wikibase:geoLongitude ?b .
     OPTIONAL {{ ?v wikibase:geoGlobe ?c }} OPTIONAL {{ ?v wikibase:geoPrecision ?d }}
     BIND(EXISTS {{ ?st prov:wasDerivedFrom ?ref }} AS ?f)
     BIND("c" AS ?k) }}
  UNION
  {{ ?item p:P2044 ?st . ?st a wikibase:BestRank ; psv:P2044 ?v .
     ?v wikibase:quantityAmount ?a . OPTIONAL {{ ?v wikibase:quantityUnit ?b }}
     BIND("e" AS ?k) }}
  UNION
  {{ ?item wdt:P31 ?a . BIND("t" AS ?k) }}
}}"""


def batches(qids, weight=None, budget=0):
    """VALUES batches of <= BATCH items in QID order. With `weight`, a batch is also
    closed at `budget` total weight: famous items carry hundreds of labels, and
    the label filter has to read all of them."""
    out, cur, total = [], [], 0
    for q in sorted(qids, key=qnum):
        w = weight(q) if weight else 0
        if cur and (len(cur) >= BATCH or (budget and total + w > budget)):
            out.append(cur)
            cur, total = [], 0
        cur.append(q)
        total += w
    if cur:
        out.append(cur)
    return list(enumerate(out))


def run_values(template: str, chunk: list[str], name: str, **fmt) -> list[dict]:
    """Run a VALUES query; if WDQS times out, halve the batch and retry."""
    try:
        return sparql(template.format(values=values_clause(chunk), **fmt), name)
    except QueryTimeout:
        if len(chunk) < 50:
            raise
        mid = len(chunk) // 2
        log(f"  splitting {name} ({len(chunk)} items)")
        return (run_values(template, chunk[:mid], name + "a", **fmt)
                + run_values(template, chunk[mid:], name + "b", **fmt))


def fetch_labels(qids, pred: str, tag: str, weight=None) -> dict[str, dict[str, list[str]]]:
    langs = ", ".join(f'"{l}"' for l in LABEL_LANGS)
    out: dict[str, dict[str, list[str]]] = {}
    for i, chunk in batches(qids, weight, LABEL_BUDGET):
        for r in run_values(LABEL_QUERY, chunk, f"{tag}_{i:03d}", pred=pred, langs=langs):
            lang = r["l"].get("xml:lang", "")
            out.setdefault(qid(r["item"]), {}).setdefault(lang, []).append(r["l"]["value"])
    for d in out.values():
        for lst in d.values():
            lst.sort()
    return out


ZHWIKI_QUERY = """SELECT ?item ?t WHERE {{
  VALUES ?item {{ {values} }}
  ?a schema:about ?item ; schema:isPartOf <https://zh.wikipedia.org/> ; schema:name ?t .
}}"""


def fetch_zhwiki_titles(qids) -> dict[str, str]:
    """zhwiki article titles: a Chinese alias, and the zh label of last resort."""
    out: dict[str, str] = {}
    for i, chunk in batches(qids):
        for r in run_values(ZHWIKI_QUERY, chunk, f"zhwiki_{i:03d}"):
            out[qid(r["item"])] = r["t"]["value"]
    return out


def fetch_claims(qids) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for i, chunk in batches(qids):
        for r in run_values(CLAIM_QUERY, chunk, f"claims_{i:03d}"):
            d = out.setdefault(qid(r["item"]), {"coords": [], "elevs": [], "p31": set(), "sl": 0})
            k = r["k"]["value"]
            if k == "s":
                d["sl"] = int(r["sl"]["value"])
            elif k == "c":  # (lat, lon, globe, declared precision, has a reference)
                d["coords"].append((float(r["a"]["value"]), float(r["b"]["value"]),
                                    r.get("c", {}).get("value", EARTH),
                                    float(r["d"]["value"]) if "d" in r else None,
                                    r.get("f", {}).get("value") == "true"))
            elif k == "e":
                d["elevs"].append((float(r["a"]["value"]), r.get("b", {}).get("value", "")))
            elif k == "t":
                d["p31"].add(qid(r["a"]))
    return out


# ------------------------------------------------- text and value helpers
class TS:
    """Character-level Traditional->Simplified from OpenCC TSCharacters.txt."""

    def __init__(self):
        path = CACHE / "opencc" / "TSCharacters.txt"
        if not path.exists() or ARGS.refresh:
            if ARGS.offline:
                raise SystemExit("--offline: OpenCC TSCharacters.txt is not cached")
            ensure_cache_dir()
            path.parent.mkdir(parents=True, exist_ok=True)
            req = urllib.request.Request(OPENCC_URL, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as resp:
                path.write_bytes(resp.read())
        self.map: dict[str, str] = {}
        for line in path.read_text("utf-8").splitlines():
            if not line or line.startswith("#") or "\t" not in line:
                continue
            key, vals = line.split("\t", 1)
            cands = vals.split()
            # When the character is itself one of its candidates (乾 -> 干 乾,
            # 於 -> 于 於) only OpenCC's phrase tables can decide; keep it.
            if cands and key not in cands:
                self.map[key] = cands[0]
        if len(self.map) < 2000:
            raise SystemExit("TSCharacters.txt looks truncated")

    def __call__(self, s: str) -> str:
        return "".join(self.map.get(ch, ch) for ch in s)


def is_cjk(ch: str) -> bool:
    o = ord(ch)
    return (0x3400 <= o <= 0x4DBF or 0x4E00 <= o <= 0x9FFF or 0xF900 <= o <= 0xFAFF
            or 0x20000 <= o <= 0x3134F)


def has_cjk(s: str) -> bool:
    return any(is_cjk(c) for c in s)


def is_latin_text(s: str) -> bool:
    letters = [c for c in s if c.isalpha()]
    return bool(letters) and all(unicodedata.name(c, "").startswith("LATIN") for c in letters)


_PAREN = re.compile(r"\s*[(（][^()（）]*[)）]\s*$")
_COMMA_PLACE = re.compile(r",\s+[^\d,()（）][^,()（）]*$")  # "Guallatiri, Chile"
_LATIN_RUN = re.compile(r"[A-Za-z]{3,}")
_ROMAN = re.compile(r"[IVXLC]+")


def clean(s: str) -> str:
    """Normalise whitespace and drop trailing disambiguators, which are mostly
    places: '天门山 (张家界)', '三峰山 (意大利)', 'Peak Pobeda, Sakha'."""
    s = unicodedata.normalize("NFC", " ".join(s.replace("|", " ").split()))
    if is_latin_text(s):
        s = _COMMA_PLACE.sub("", s) or s
    stripped = _PAREN.sub("", s)
    return stripped if stripped else s


def is_good_zh(s: str) -> bool:
    """CJK text, without half-transliterated names such as 'Ventoux山'."""
    return has_cjk(s) and all(_ROMAN.fullmatch(w) for w in _LATIN_RUN.findall(s))


def pick_en(labels: dict[str, list[str]]) -> str:
    for lang in ("en", "mul"):  # 'mul' (default for all languages), e.g. Denali Q130018
        for v in labels.get(lang, []):
            v = clean(v)
            if is_latin_text(v):
                return v
    return ""


def pick_zh(labels: dict[str, list[str]], ts: TS) -> str:
    for lang in ZH_LANGS:  # simplified variants first, then traditional ones
        for v in labels.get(lang, []):
            v = clean(ts(v))  # also normalises traditional text left in plain 'zh'
            if is_good_zh(v):
                return v
    return ""


def value_precision(x: float) -> float:
    """Precision implied by the digits actually stored (40.94 -> 0.01)."""
    s = repr(round(x, 9))
    return 10.0 ** -len(s.split(".")[1]) if "." in s and "e" not in s else 1.0


def pick_coord(coords):
    """Best-rank Earth coordinate. When an item has several (~1% do, some 100+ km
    apart, e.g. 长白山 Q107635), prefer a referenced statement, then the finest
    effective precision: the coarser of the declared precision and the stored digits."""
    earth = [c for c in coords if c[2] == EARTH]
    if not earth:
        return None

    def rank(c):
        eff = max(c[3] or 0.0, value_precision(c[0]), value_precision(c[1]))
        return (not c[4], eff, c[0], c[1])

    earth.sort(key=rank)
    lat, lon = earth[0][0], earth[0][1]
    if not (-90 <= lat <= 90):
        return None
    lon = (lon + 180.0) % 360.0 - 180.0
    conflict = len(earth) > 1 and max(haversine_km(lat, lon, c[0], c[1]) for c in earth) > 5
    return lat, lon, conflict


def pick_elev(elevs):
    vals = sorted(a * UNIT_FACTORS[u] for a, u in elevs if u in UNIT_FACTORS)
    if not vals:
        return None
    v = vals[(len(vals) - 1) // 2]  # lower median of the best-rank values
    if not (-450 <= v <= 8850):
        STATS["elev_out_of_range"] += 1
        return None
    return int(round(v))


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(a)))


# --------------------------------------------------------- stage 3: select
def build_entries(cands, labels, claims, ts) -> list[dict]:
    curated = {q: cc for q, _n, cc, _al in CURATED}
    entries = []
    for q, c in cands.items():
        cl = claims.get(q)
        if cl is None:
            STATS["drop_no_claims"] += 1
            continue
        if (cl["p31"] & set(EXCLUDE_CLASSES) or q in EXCLUDE_ITEMS) and q not in curated:
            STATS["drop_excluded"] += 1
            continue
        override = COORD_OVERRIDES.get(q) or curated.get(q)
        coord = (*override, False) if override else pick_coord(cl["coords"])
        if coord is None:
            STATS["drop_no_earth_coord"] += 1
            continue
        lb = labels.get(q, {})
        en, zh = pick_en(lb), pick_zh(lb, ts)
        if not en and not zh:
            STATS["drop_no_label"] += 1
            continue
        is_peak = bool(cl["p31"] & set(PEAK_CLASSES))
        is_range = bool(cl["p31"] & set(RANGE_CLASSES))
        entries.append({
            "q": q, "en": en, "zh": zh, "lat": coord[0], "lon": coord[1], "conflict": coord[2],
            "elev": pick_elev(cl["elevs"]), "sl": cl["sl"] or c["sl"],
            "peak": is_peak, "range": is_range and not is_peak,
            "curated": q in curated, "labels": lb,
        })
    return entries


def keep(e, min_sl: int) -> bool:
    if e["curated"]:
        return True
    sl = e["sl"]
    if e["lat"] < ANTARCTIC_LAT and sl < ANTARCTIC_MIN_SL:
        return False
    lat0, lat1, lon0, lon1 = ZH_REGION
    zh_bonus = bool(e["zh"]) and lat0 <= e["lat"] <= lat1 and lon0 <= e["lon"] <= lon1
    if e["peak"]:
        return (sl >= min_sl
                or (zh_bonus and sl >= MIN_SL_ZH)
                or ((e["elev"] or 0) >= EXCEPTION_ELEV and sl >= MIN_SL_HIGH))
    if e["range"]:
        return sl >= MIN_SL_RANGE or (zh_bonus and sl >= MIN_SL_RANGE_ZH)
    return False


def label_keys(e) -> list[str]:
    keys = []
    if e["en"]:
        keys.append("en:" + e["en"].casefold())
    if e["zh"]:
        keys.append("zh:" + e["zh"])
    return keys


def dedupe(entries: list[dict]) -> list[dict]:
    """Same label (en or zh) within DEDUP_KM -> keep the one with more sitelinks."""
    seen: dict[str, list[dict]] = {}
    out = []
    for e in entries:  # already sorted by popularity
        dup = next((o for k in label_keys(e) for o in seen.get(k, [])
                    if haversine_km(e["lat"], e["lon"], o["lat"], o["lon"]) <= DEDUP_KM), None)
        if dup is None:
            out.append(e)
            for k in label_keys(e):
                seen.setdefault(k, []).append(e)
            continue
        STATS["dedup_merged"] += 1
        before = set(label_keys(dup))
        for f in ("en", "zh", "elev"):  # fill gaps in the survivor
            if not dup[f] and e[f]:
                dup[f] = e[f]
        for k in set(label_keys(dup)) - before:
            seen.setdefault(k, []).append(dup)
    return out


def sort_key(e):
    return (-e["sl"], -(e["elev"] if e["elev"] is not None else -1e9), e["en"] or e["zh"], qnum(e["q"]))


# -------------------------------------------------------- stage 4: aliases
CURATED_ALIASES = {q: al for q, _n, _c, al in CURATED}
for _q, _al in EXTRA_ALIASES.items():
    CURATED_ALIASES[_q] = CURATED_ALIASES.get(_q, []) + _al


def alias_string(e, aliases, zhwiki, ts) -> str:
    """Up to MAX_ALIASES alternative names, balanced between English and Chinese.

    Sources: other labels (mul, zh variants), skos:altLabel in en/mul/zh-*, the
    zhwiki article title, and the curated extras. Aliases contained in (or
    containing) the main label add nothing to a substring search and are
    skipped; shorter names go first."""
    lb, al = e["labels"], dict(aliases.get(e["q"], {}))
    if e["q"] in zhwiki:
        al["zh"] = al.get("zh", []) + [zhwiki[e["q"]]]
    mains = [m.casefold() for m in (e["en"], e["zh"]) if m]

    def usable(a: str) -> bool:
        f = a.casefold()
        return (0 < len(a) <= 40 and (is_latin_text(a) or is_good_zh(a))
                and not any(f in m or m in f for m in mains))

    def ranked(raw):
        seen, out = set(), []
        for a in sorted({clean(x) for x in raw}, key=lambda s: (len(s), s)):
            if usable(a) and a.casefold() not in seen:
                seen.add(a.casefold())
                out.append(a)
        return out

    extra = [clean(a) for a in CURATED_ALIASES.get(e["q"], [])]
    en = ranked([x for lang in ("en", "mul") for x in lb.get(lang, []) + al.get(lang, [])])
    zh = ranked([ts(x) for lang in ZH_LANGS for x in lb.get(lang, []) + al.get(lang, [])])
    half = MAX_ALIASES // 2
    picked = extra + en[:half] + zh[:half]
    rest = en[half:] + zh[half:]
    picked += rest[:max(0, MAX_ALIASES - len(picked))]
    out, seen = [], set(mains)
    for a in picked:
        if a and a.casefold() not in seen:
            seen.add(a.casefold())
            out.append(a)
    return "|".join(out[:MAX_ALIASES])


# ------------------------------------------------------------ stage 5: write
def encode(rows) -> bytes:
    doc = {"license": "CC0 (Wikidata)",
           "fields": ["en", "zh", "lat", "lon", "elev", "rank", "alias"],
           "rows": rows}
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def to_row(e, alias: str):
    return [e["en"], e["zh"], round(e["lat"], 4), round(e["lon"], 4), e["elev"], e["sl"], alias]


SANITY = [  # (label shown, terms to look for, expected lat, lon)
    ("黄山 / Huangshan", ["黄山", "Huangshan"], 30.13, 118.17),
    ("华山", ["华山"], 34.48, 110.08),
    ("泰山", ["泰山"], 36.25, 117.10),
    ("峨眉山", ["峨眉山"], 29.52, 103.33),
    ("富士山 / Mount Fuji", ["富士山", "Mount Fuji"], 35.36, 138.73),
    ("Matterhorn", ["Matterhorn"], 45.98, 7.66),
    ("Mount Everest / 珠穆朗玛峰", ["Mount Everest", "珠穆朗玛峰"], 27.99, 86.93),
    ("K2", ["K2"], 35.88, 76.51),
    ("Kilimanjaro", ["Kilimanjaro", "Mount Kilimanjaro"], -3.07, 37.36),
    ("Denali", ["Denali"], 63.07, -151.01),
    ("Mont Blanc", ["Mont Blanc"], 45.83, 6.87),
    ("Table Mountain", ["Table Mountain"], -33.96, 18.41),
    ("玉龙雪山", ["玉龙雪山"], 27.10, 100.18),
    ("梅里雪山 / 卡瓦格博", ["梅里雪山", "卡瓦格博"], 28.44, 98.68),
    ("贡嘎山", ["贡嘎山"], 29.60, 101.88),
    ("长白山", ["长白山"], 41.99, 128.08),
    ("嵩山", ["嵩山"], 34.48, 112.96),
    ("衡山", ["衡山"], 27.30, 112.68),
    ("恒山", ["恒山"], 39.67, 113.73),
]


def sanity_report(rows) -> bool:
    ok_all = True
    print("\nSanity checks (best match by rank; distance to the known summit):")
    for name, terms, lat, lon in SANITY:
        hits = []
        for r in rows:
            names = {r[0], r[1], *r[6].split("|")} - {""}
            if any(t in names for t in terms):
                hits.append(r)
        if not hits:
            ok_all = False
            print(f"  MISSING  {name}")
            continue
        best = min(hits, key=lambda r: (haversine_km(lat, lon, r[2], r[3]) > 25, -r[5]))
        d = haversine_km(lat, lon, best[2], best[3])
        flag = "ok" if d <= 25 else "FAR"
        ok_all &= d <= 25
        print(f"  {flag:4} {name:28} -> {best[0]!r} / {best[1]!r} ({best[2]}, {best[3]}) "
              f"elev={best[4]} rank={best[5]}  d={d:.1f} km  [{len(hits)} match(es)]")
    return ok_all


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--refresh", action="store_true", help="ignore cached query results")
    ap.add_argument("--offline", action="store_true", help="use cached results only")
    ap.parse_args(namespace=ARGS)

    ts = TS()
    log("stage 1: scan")
    cands = scan()

    log("stage 2: details")
    claims = fetch_claims(cands)

    def weight(q):  # sitelinks ~ number of labels/aliases an item carries
        return claims.get(q, {}).get("sl", 0) or cands.get(q, {}).get("sl", 0)

    labels = fetch_labels(cands, "rdfs:label", "labels", weight)
    entries = build_entries(cands, labels, claims, ts)
    entries.sort(key=sort_key)

    log("stage 3: select")
    min_sl = MIN_SL
    while True:
        chosen = sorted(dedupe([dict(e) for e in entries if keep(e, min_sl)]), key=sort_key)
        alias_ids = {e["q"] for e in chosen[:ALIAS_TOP_N]}
        alias_ids |= {e["q"] for e in chosen if e["q"] in CURATED_ALIASES}
        aliases = fetch_labels(alias_ids, "skos:altLabel", "aliases", weight)
        zhwiki = fetch_zhwiki_titles(alias_ids)
        STATS["zh_from_zhwiki_title"] = 0
        for e in chosen:  # e.g. Mont Ventoux: zh label "Ventoux山" rejected, zhwiki 旺图山
            if not e["zh"] and e["q"] in zhwiki and is_good_zh(clean(ts(zhwiki[e["q"]]))):
                e["zh"] = clean(ts(zhwiki[e["q"]]))
                STATS["zh_from_zhwiki_title"] += 1
        rows = [to_row(e, alias_string(e, aliases, zhwiki, ts) if e["q"] in alias_ids else "")
                for e in chosen]
        blob = encode(rows)
        if len(rows) <= MAX_ENTRIES and len(blob) <= MAX_BYTES:
            break
        log(f"  {len(rows)} rows / {len(blob)} bytes at MIN_SL={min_sl}: too big, raising")
        min_sl += 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(blob)
    gz = len(gzip.compress(blob, compresslevel=9))
    n = len(rows)
    zh_share = sum(1 for r in rows if r[1]) / n
    print(f"wrote {OUT.relative_to(ROOT)}: {n} entries, {len(blob):,} bytes minified, "
          f"{gz:,} bytes gzipped (MIN_SL={min_sl})")
    print(f"zh label: {zh_share:.1%}   en label: {sum(1 for r in rows if r[0]) / n:.1%}   "
          f"elevation: {sum(1 for r in rows if r[4] is not None) / n:.1%}   "
          f"aliases: {sum(1 for r in rows if r[6])}")
    kinds = Counter("curated" if e["curated"] else "range" if e["range"] else "peak" for e in chosen)
    STATS["coord_conflicts_kept"] = sum(1 for e in chosen if e["conflict"])
    print("kinds:", dict(kinds), " stats:", dict(STATS))
    if not sanity_report(rows):
        print("\nWARNING: some sanity checks failed")


if __name__ == "__main__":
    try:
        main()
    except QueryTimeout as exc:
        raise SystemExit(f"WDQS timed out twice on {exc}; lower BATCH or PAGE and re-run")
