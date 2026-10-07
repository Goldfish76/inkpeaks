"""Render paintings with headless Chrome through tools/dev.html and make a contact sheet.

    python -m http.server 5174 --bind 127.0.0.1     # in the repository root, in another terminal
    python tools/shoot.py jobs.json out_dir [--sheet sheet.png] [--h 700]

jobs.json: [{"name": "huangshan_ink", "w": 1200, "h": 2000, "q": {"dem": "...", "style": "ink", ...}}, ...]
Finds Chrome (or Edge, or Chromium) in the usual places; set CHROME to its path otherwise.
Developer tool only; the app itself needs none of this.
"""
import json
import os
import shutil
import subprocess
import sys
import urllib.parse
from pathlib import Path

from PIL import Image, ImageDraw

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "chromium",
]
ROOT = Path(__file__).resolve().parent.parent
BASE = os.environ.get("INKPEAKS_DEV", "http://127.0.0.1:5174/tools/dev.html")


def chrome():
    for c in [os.environ.get("CHROME", "")] + CHROME_CANDIDATES:
        if c and (os.path.exists(c) or shutil.which(c)):
            return c
    raise SystemExit("Chrome not found: set CHROME to its path")


def shoot(job, out_dir):
    q = dict(job["q"])
    q.setdefault("w", job["w"])
    q.setdefault("h", job["h"])
    q["log"] = "0"
    base = BASE.rsplit("/", 1)[0] + "/" + job["page"] if "page" in job else BASE
    url = base + "?" + urllib.parse.urlencode(q)
    out = (Path(out_dir) / f"{job['name']}.png").resolve()
    profile = ROOT / "tools" / ".cache" / "chrome-profile"
    for attempt in range(4):
        budget = 300000 * (attempt + 1)
        cmd = [chrome(), "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
               f"--window-size={job['w']},{job['h']}", f"--virtual-time-budget={budget}",
               f"--user-data-dir={profile}", f"--screenshot={out}", url]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=900)
        # A blank white shot means the page was captured before it finished drawing.
        lo, hi = Image.open(out).convert("L").getextrema()
        if not (lo > 250 and hi == 255):
            return out
    raise SystemExit(f"{job['name']}: still blank after 4 tries; is the page failing? Open {url}")


def sheet(paths, out, h=700, labels=True, per_row=6):
    ims = []
    for p in paths:
        im = Image.open(p).convert("RGB")
        ims.append((Path(p).stem, im.resize((max(1, int(im.width * h / im.height)), h), Image.LANCZOS)))
    rows = [ims[i:i + per_row] for i in range(0, len(ims), per_row)]
    W = max(sum(im.width for _, im in r) + 10 * (len(r) + 1) for r in rows)
    s = Image.new("RGB", (W, len(rows) * (h + 40)), (255, 255, 255))
    d = ImageDraw.Draw(s)
    for ri, r in enumerate(rows):
        x, y0 = 10, ri * (h + 40)
        for name, im in r:
            s.paste(im, (x, y0 + 10))
            if labels:
                d.text((x, y0 + h + 16), name, fill=(60, 60, 60))
            x += im.width + 10
    s.save(out)
    return out


def main():
    # A fresh browser profile per batch, so edited modules are never served from cache.
    shutil.rmtree(ROOT / "tools" / ".cache" / "chrome-profile", ignore_errors=True)
    jobs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = [shoot(j, out_dir) for j in jobs]
    if "--sheet" in sys.argv:
        h = int(sys.argv[sys.argv.index("--h") + 1]) if "--h" in sys.argv else 700
        sheet(paths, sys.argv[sys.argv.index("--sheet") + 1], h)
    for p in paths:
        print(p)


if __name__ == "__main__":
    main()
