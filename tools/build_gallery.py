"""Build data/gallery.json: the curated mountains with their default view and inscription.

    python tools/build_gallery.py

Terrain metadata comes from data/gallery-dem.json (written by tools/bake_gallery.py) and the data
credits from tools/gallery_credits.json (written by tools/gallery_credits.py). The view presets
below are hand-tuned: `az` is the direction the viewer faces (degrees clockwise from north),
`comp` is one of the three distances (gaoyuan / shenyuan / pingyuan).
Poem lines are classical (public domain) and quoted with their source.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

WANG_WEI_RIVER = ("江流天地外，山色有无中", "王维《汉江临泛》")
WANG_WEI_CLOUD = ("行到水穷处，坐看云起时", "王维《终南别业》")
WANG_WEI_RAIN = ("空山新雨后，天气晚来秋", "王维《山居秋暝》")
DU_FU_CLOUD = ("荡胸生曾云，决眦入归鸟", "杜甫《望岳》")
FALLS = ("千岩万壑不辞劳，远看方知出处高", "《瀑布联句》")
SNOW = ("千山鸟飞绝，万径人踪灭", "柳宗元《江雪》")

PRESETS = {
    # China (terrain at a 100 m grid)
    "huangshan": dict(az=0, comp="shenyuan", style="ink", poem=("黄山四千仞，三十二莲峰", "李白《送温处士归黄山白鹅峰旧居》")),
    "huashan": dict(az=180, comp="gaoyuan", style="ink", poem=("只有天在上，更无山与齐", "寇准《咏华山》")),
    "taishan": dict(az=0, comp="shenyuan", style="qianjiang", zoom=0.8, poem=("会当凌绝顶，一览众山小", "杜甫《望岳》")),
    "lushan": dict(az=300, comp="shenyuan", style="qianjiang", poem=("横看成岭侧成峰，远近高低各不同", "苏轼《题西林壁》")),
    "emeishan": dict(az=270, comp="shenyuan", style="qinglu", poem=("峨眉山月半轮秋，影入平羌江水流", "李白《峨眉山月歌》")),
    "sanqingshan": dict(az=0, comp="shenyuan", style="qinglu", poem=WANG_WEI_RAIN),
    "guilin": dict(az=0, comp="pingyuan", style="qinglu", water=0.07, smooth=1.0, poem=("江作青罗带，山如碧玉簪", "韩愈《送桂州严大夫同用南字》")),
    "zhangjiajie": dict(az=0, comp="shenyuan", style="ink", poem=FALLS),
    "yulong": dict(az=0, comp="gaoyuan", style="snow", poem=SNOW),
    "gongga": dict(az=270, comp="gaoyuan", style="snow", poem=SNOW),
    "meili": dict(az=270, comp="shenyuan", style="ink", poem=SNOW),
    "wudang": dict(az=0, comp="shenyuan", style="qianjiang", poem=WANG_WEI_CLOUD),
    "yandang": dict(az=0, comp="shenyuan", style="qinglu", poem=WANG_WEI_RIVER),
    # Elsewhere
    "fuji": dict(az=180, comp="gaoyuan", style="ink", poem=WANG_WEI_RIVER),
    "matterhorn": dict(az=225, comp="gaoyuan", style="snow", poem=DU_FU_CLOUD),
    "yosemite": dict(az=75, comp="shenyuan", style="qianjiang", zoom=0.85, poem=WANG_WEI_CLOUD),
    "tre-cime": dict(az=180, comp="gaoyuan", style="ink", zoom=0.85, poem=FALLS),
    "fitzroy": dict(az=300, comp="gaoyuan", style="ink", poem=DU_FU_CLOUD),
    "eiger": dict(az=180, comp="gaoyuan", style="snow", poem=DU_FU_CLOUD),
    "montblanc": dict(az=180, comp="shenyuan", style="ink", poem=SNOW),
    "lofoten": dict(az=0, comp="shenyuan", style="ink", poem=WANG_WEI_RIVER),
    "tablemountain": dict(az=180, comp="pingyuan", style="ink", poem=WANG_WEI_RIVER),
    "rainier": dict(az=135, comp="gaoyuan", style="snow", poem=SNOW),
    "amadablam": dict(az=45, comp="gaoyuan", style="ink", poem=DU_FU_CLOUD),
    "seoraksan": dict(az=0, comp="shenyuan", style="ink", poem=WANG_WEI_RAIN),
    "milford": dict(az=300, comp="shenyuan", style="ink", poem=WANG_WEI_RIVER),
    "aoraki": dict(az=0, comp="gaoyuan", style="qianjiang", poem=SNOW),
    "denali": dict(az=180, comp="pingyuan", style="snow", poem=SNOW),
}

# Display order: the strongest paintings first.
ORDER = ["huangshan", "guilin", "fuji", "matterhorn", "lofoten", "yulong", "emeishan", "tre-cime",
         "huashan", "seoraksan", "taishan", "lushan", "sanqingshan", "zhangjiajie", "yosemite",
         "fitzroy", "eiger", "milford", "gongga", "meili", "wudang", "yandang",
         "montblanc", "aoraki", "tablemountain", "rainier", "amadablam",
         "denali"]


def main():
    dem = {e["id"]: e for e in json.loads((ROOT / "data" / "gallery-dem.json").read_text(encoding="utf-8"))}
    credits = json.loads((ROOT / "tools" / "gallery_credits.json").read_text(encoding="utf-8"))
    out = []
    for pid in ORDER:
        if pid not in dem or pid not in PRESETS:
            continue
        e, p = dem[pid], dict(PRESETS[pid])
        poem, src = p.pop("poem", ("", ""))
        out.append({
            "id": pid,
            "zh": e["nameZh"],
            "en": e["nameEn"],
            "lat": e["lat"],
            "lon": e["lon"],
            "radiusKm": e["radiusKm"],
            "mpp": e["mpp"],
            "sea": e["sea"],
            "china": e["china"],
            "source": e["source"],
            "credit": credits.get(pid, {}).get("credit", []),
            "view": p,
            "poem": poem,
            "poemSrc": src,
        })
    path = ROOT / "data" / "gallery.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(out)} places -> {path}")


if __name__ == "__main__":
    main()
