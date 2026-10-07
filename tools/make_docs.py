"""Make the README images in docs/ and the gallery thumbnails in img/thumbs/ from the app's own renders.

    python -m http.server 5174 --bind 127.0.0.1     # in the repository root, in another terminal
    python tools/make_docs.py

Needs Chrome (see tools/shoot.py) and Pillow.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
CACHE = ROOT / "tools" / ".cache" / "docs"
FONTS = ROOT / "tools" / ".cache" / "fonts"
WALL = (228, 221, 204)
INK = (42, 38, 34)
RED = (179, 51, 43)


def font(name, size):
    for cand in [FONTS / name, ROOT / "fonts" / name]:
        if cand.exists():
            return ImageFont.truetype(str(cand), size)
    return ImageFont.load_default()


def mounted_size(fmt, w, h):
    """Mirror js/compose.js mountMargins (top, right, bottom, left)."""
    if fmt == "scroll":
        t, r, b, l = 0.15 * h, 0.07 * w, 0.09 * h, 0.07 * w
    elif fmt == "handscroll":
        t, r, b, l = 0.1 * h, 0.035 * w, 0.1 * h, 0.035 * w
    else:
        m = 0.07 * min(w, h)
        t = r = b = l = m
    return round(w + l + r), round(h + t + b)


def shoot(jobs, name):
    CACHE.mkdir(parents=True, exist_ok=True)
    jf = CACHE / f"{name}.json"
    out = CACHE / name
    for j in jobs:
        if j["q"].get("mount") == "1":
            j["w"], j["h"] = mounted_size(j["q"].get("format", "scroll"), j["pw"], j["ph"])
        else:
            j["w"], j["h"] = j["pw"], j["ph"]
        j["q"]["w"], j["q"]["h"] = j["pw"], j["ph"]
    jf.write_text(json.dumps(jobs), encoding="utf-8")
    subprocess.run([sys.executable, str(ROOT / "tools" / "shoot.py"), str(jf), str(out)], check=True, stdout=subprocess.DEVNULL)
    return {j["name"]: Image.open(out / f"{j['name']}.png").convert("RGB") for j in jobs}


def job(name, pid, pw, ph, page="render.html", **q):
    q = {k: str(v) for k, v in q.items()}
    q["id"] = pid
    return {"name": name, "page": page, "pw": pw, "ph": ph, "q": q}


def shadowed(canvas, im, x, y, blur=18, offset=10, alpha=70):
    sh = Image.new("RGBA", (im.width + 4 * blur, im.height + 4 * blur), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rectangle([2 * blur, 2 * blur, 2 * blur + im.width, 2 * blur + im.height], fill=(60, 45, 20, alpha))
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    canvas.paste(sh, (x - 2 * blur, y - 2 * blur + offset), sh)
    canvas.paste(im, (x, y))


def save_jpg(im, path, width=None, q=86):
    if width and im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, "JPEG", quality=q, optimize=True, progressive=True)
    print(path.relative_to(ROOT), im.size, path.stat().st_size // 1024, "KB")


def hero():
    picks = [("huangshan", "zh"), ("guilin", "zh"), ("matterhorn", "en"), ("emeishan", "zh"), ("lofoten", "en")]
    ims = shoot([job(f"hero-{p}", p, 600, 1000, format="scroll", mount="1", insc="1", lang=l) for p, l in picks], "hero")
    pad = 70
    W = sum(im.width for im in ims.values()) + pad * (len(ims) + 1)
    H = max(im.height for im in ims.values()) + 2 * pad
    c = Image.new("RGB", (W, H), WALL)
    x = pad
    for im in ims.values():
        shadowed(c, im, x, pad)
        x += im.width + pad
    save_jpg(c, DOCS / "hero.jpg", width=2400)


def styles():
    names = [("ink", "水墨 Ink"), ("qinglu", "青绿 Blue-green"), ("qianjiang", "浅绛 Light crimson"), ("snow", "雪景 Snow")]
    ims = shoot([job(f"style-{s}", "huangshan", 540, 900, style=s, insc="0", comp="gaoyuan") for s, _ in names], "styles")
    pad, lab = 40, 70
    W = sum(im.width for im in ims.values()) + pad * (len(ims) + 1)
    H = 900 + 2 * pad + lab
    c = Image.new("RGB", (W, H), WALL)
    d = ImageDraw.Draw(c)
    f = font("noto-serif-sc-NotoSerifSC[wght]-600.ttf", 34)
    x = pad
    for (s, label), im in zip(names, ims.values()):
        shadowed(c, im, x, pad, blur=12, offset=6, alpha=55)
        tw = d.textlength(label, font=f)
        d.text((x + (im.width - tw) / 2, pad + im.height + 18), label, font=f, fill=INK)
        x += im.width + pad
    save_jpg(c, DOCS / "styles.jpg", width=2000)


def formats():
    ims = shoot([
        job("fmt-handscroll", "guilin", 1500, 560, format="handscroll", mount="1", insc="1", lang="zh"),
        job("fmt-fan", "yulong", 760, 760, format="fan", mount="1", insc="1", lang="zh"),
    ], "formats")
    hs, fan = ims["fmt-handscroll"], ims["fmt-fan"]
    pad = 60
    W = hs.width + fan.width + 3 * pad
    H = max(hs.height, fan.height) + 2 * pad
    c = Image.new("RGB", (W, H), WALL)
    shadowed(c, hs, pad, (H - hs.height) // 2)
    shadowed(c, fan, 2 * pad + hs.width, (H - fan.height) // 2)
    save_jpg(c, DOCS / "formats.jpg", width=2200)


def terrain_panel(pid, size):
    """A plain hillshade of the elevation grid (north up), as the 'input' panel."""
    meta = {e["id"]: e for e in json.loads((ROOT / "data" / "gallery-dem.json").read_text(encoding="utf-8"))}[pid]
    a = np.asarray(Image.open(ROOT / "data" / "dem" / f"{pid}.png").convert("RGB")).astype(np.float64)
    E = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    gy, gx = np.gradient(E, meta["mpp"])
    nx, ny, nz = -gx * 2.5, gy * 2.5, 1.0
    l = np.array([-0.6, 0.6, 0.53])
    sh = (nx * l[0] + ny * l[1] + nz * l[2]) / np.sqrt(nx ** 2 + ny ** 2 + nz ** 2)
    v = np.clip(70 + 185 * sh, 0, 255)
    rgb = np.dstack([v * 0.93 + 18, v * 0.9 + 16, v * 0.82 + 14]).clip(0, 255).astype(np.uint8)
    return Image.fromarray(rgb).resize((size, size), Image.BICUBIC)


def how():
    ims = shoot([
        job("how-band", "huangshan", 540, 900, page="dev.html", dem="data/dem/huangshan.png", mpp=100, style="ink", comp="shenyuan", zoom=0.92, debug="band"),
        job("how-wash", "huangshan", 540, 900, page="dev.html", dem="data/dem/huangshan.png", mpp=100, style="ink", comp="shenyuan", zoom=0.92, debug="wash"),
        job("how-final", "huangshan", 540, 900, insc="0"),
    ], "how")
    panels = [(terrain_panel("huangshan", 540), "1  Real elevation · 真实地形"),
              (ims["how-band"], "2  Layered ranges · 层峦"),
              (ims["how-wash"], "3  Washes hang from ridges · 墨分五色"),
              (ims["how-final"], "4  Brush, mist, paper · 皴擦、云气、宣纸")]
    pad, lab = 40, 70
    W = sum(p.width for p, _ in panels) + pad * (len(panels) + 1)
    H = 900 + 2 * pad + lab
    c = Image.new("RGB", (W, H), WALL)
    d = ImageDraw.Draw(c)
    f = font("noto-serif-sc-NotoSerifSC[wght]-600.ttf", 26)
    x = pad
    for im, label in panels:
        y = pad + (900 - im.height) // 2
        shadowed(c, im, x, y, blur=10, offset=5, alpha=50)
        tw = d.textlength(label, font=f)
        d.text((x + (im.width - tw) / 2, pad + 900 + 20), label, font=f, fill=INK)
        x += im.width + pad
    save_jpg(c, DOCS / "how-it-works.jpg", width=2200)


def samples():
    picks = ["huangshan", "fuji", "guilin", "matterhorn", "emeishan", "lofoten", "huashan", "eiger", "taishan"]
    ims = shoot([job(f"sample-{p}", p, 480, 800, insc="1", lang="zh") for p in picks], "samples")
    for p in picks:
        save_jpg(ims[f"sample-{p}"], DOCS / "samples" / f"{p}.jpg", q=84)


def thumbs():
    """The gallery buttons: every gallery mountain at its default view, without inscription."""
    ids = [g["id"] for g in json.loads((ROOT / "data" / "gallery.json").read_text(encoding="utf-8"))]
    ims = shoot([job(f"thumb-{pid}", pid, 360, 600, insc="0") for pid in ids], "thumbs")
    for pid in ids:
        save_jpg(ims[f"thumb-{pid}"].resize((180, 300), Image.LANCZOS), ROOT / "img" / "thumbs" / f"{pid}.jpg", q=82)


def social():
    ims = shoot([job(f"social-{p}", p, 300, 500, insc="1", lang="zh") for p in ["huangshan", "emeishan", "matterhorn"]], "social")
    W, H = 1280, 640
    c = Image.new("RGB", (W, H), WALL)
    d = ImageDraw.Draw(c)
    d.text((80, 150), "卧游", font=font("MaShanZheng-Regular.ttf", 128), fill=INK)
    d.text((86, 318), "Ink Peaks", font=font("cormorant-garamond-CormorantGaramond[wght]-600.ttf", 62), fill=RED)
    d.text((88, 412), "把地球上真实的山，画成一幅宋画", font=font("noto-serif-sc-NotoSerifSC[wght]-400.ttf", 26), fill=INK)
    latin = font("cormorant-garamond-CormorantGaramond[wght]-400.ttf", 30)
    d.text((88, 456), "Real mountains,", font=latin, fill=(90, 82, 72))
    d.text((88, 492), "painted like the Song dynasty", font=latin, fill=(90, 82, 72))
    x = 590
    for i, im in enumerate(ims.values()):
        im = im.resize((210, 350), Image.LANCZOS)
        shadowed(c, im, x + i * 228, 150 if i % 2 == 0 else 128, blur=10, offset=6, alpha=60)
    save_jpg(c, DOCS / "social-preview.jpg", q=90)


if __name__ == "__main__":
    steps = sys.argv[1:] or ["hero", "styles", "formats", "how", "samples", "thumbs", "social"]
    for s in steps:
        globals()[s]()
