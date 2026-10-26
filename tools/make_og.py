"""產生 LINE／社群分享預覽圖 og.png（1200×630）。

用法（在 repo 根目錄執行）：
    python tools/make_og.py --date "2026/10/26（一）" --time "19:00" \
        --place "捷運麟光站 1 號出口" --kicker "夜間生態觀察・第 1 場" --badge "因颱風改期"

通常不用直接執行：tools/sync_event.py 會從試算表讀取活動資料，再呼叫這裡的 render()。

需要 Pillow，以及 Windows 內建的 Noto Serif TC／Noto Sans TC 字型。
"""
import argparse
import json
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from PIL.PngImagePlugin import PngInfo

FONTS = 'C:/Windows/Fonts/'
W, H = 1200, 630


def font(name, size, variation):
    f = ImageFont.truetype(FONTS + name, size)
    try:
        f.set_variation_by_name(variation)
    except Exception:
        pass
    return f


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--title', default='夜行')
    ap.add_argument('--subtitle', default='富陽生態公園')
    ap.add_argument('--kicker', default='夜間生態觀察')
    ap.add_argument('--date', required=True, help='例如 2026/10/26（一）')
    ap.add_argument('--time', default='19:00')
    ap.add_argument('--place', default='捷運麟光站 1 號出口')
    ap.add_argument('--footer', default='限額 10 人 ‧ 免費 ‧ 線上即時看人數')
    ap.add_argument('--badge', default='', help='醒目標籤，例如「因颱風改期」；留空不顯示')
    ap.add_argument('--out', default='og.png')
    a = ap.parse_args()
    render(a.title, a.subtitle, a.kicker, a.date, a.time, a.place, a.footer, a.badge, a.out)


def render(title, subtitle, kicker, date, time, place, footer, badge, out, meta=None):
    """畫出預覽圖。meta 會以 JSON 存進 PNG 的文字欄位（night-walk），讓 sync_event.py 檢查是否過期。"""
    serif = font('NotoSerifTC-VF.ttf', 150, 'Black')
    serif_sub = font('NotoSerifTC-VF.ttf', 58, 'Bold')
    sans = font('NotoSansTC-VF.ttf', 38, 'Medium')
    sans_bold = font('NotoSansTC-VF.ttf', 34, 'Bold')
    sans_small = font('NotoSansTC-VF.ttf', 32, 'Regular')

    # 夜空漸層
    img = Image.new('RGB', (W, H))
    px = img.load()
    for y in range(H):
        t = y / H
        c = (int(13 - 3 * t), int(21 - 6 * t), int(48 - 17 * t))
        for x in range(W):
            px[x, y] = c

    # 左上角的手電筒光暈
    glow = Image.new('L', (W, H), 0)
    ImageDraw.Draw(glow).ellipse((-300, -420, 900, 380), fill=120)
    glow = glow.filter(ImageFilter.GaussianBlur(160))
    img = Image.composite(Image.new('RGB', (W, H), (255, 214, 120)), img, glow.point(lambda v: int(v * 0.45)))

    # 螢火蟲
    fire = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fire)
    random.seed(7)
    for _ in range(26):
        x, y = random.randint(40, W - 40), random.randint(80, H - 120)
        r = random.choice([3, 4, 5])
        fd.ellipse((x - r * 4, y - r * 4, x + r * 4, y + r * 4), fill=(255, 233, 140, 40))
        fd.ellipse((x - r, y - r, x + r, y + r), fill=(255, 243, 176, 230))
    img = Image.alpha_composite(img.convert('RGBA'), fire.filter(ImageFilter.GaussianBlur(1.2)))

    # 樹林剪影
    d = ImageDraw.Draw(img)
    random.seed(3)
    pts, x = [(0, H)], 0
    while x <= W:
        pts.append((x, H - 60 - random.randint(0, 50)))
        x += random.randint(30, 60)
    d.polygon(pts + [(W, H - 70), (W, H)], fill='#050811')

    # 文字
    X = 84
    d.text((X, 92), kicker, font=sans, fill='#ffd97a')
    if badge:
        kb = d.textbbox((X, 92), kicker, font=sans)
        bb = d.textbbox((0, 0), badge, font=sans_bold)
        bx, by = kb[2] + 24, 90
        d.rounded_rectangle((bx, by, bx + bb[2] - bb[0] + 36, by + 54), radius=27, fill='#ff8a7a')
        d.text((bx + 18, by + 27), badge, font=sans_bold, fill='#2a0d08', anchor='lm')
    d.text((X, 150), title, font=serif, fill='#f3f1ea')
    d.text((X + 6, 340), subtitle, font=serif_sub, fill='#c9d1e6')

    pill = f'{date}{time} ‧ {place}'
    bb = d.textbbox((0, 0), pill, font=sans)
    pw, ph, py = bb[2] - bb[0], bb[3] - bb[1], 438
    d.rounded_rectangle((X - 4, py - 14, X + pw + 32, py + ph + 22), radius=40, outline='#c9a24a', width=2, fill='#1a1d27')
    d.text((X + 14, py - bb[1] + 4), pill, font=sans, fill='#ffe6a8')

    d.text((X, 530), footer, font=sans_small, fill='#9aa6c4')

    info = PngInfo()
    if meta is not None:
        info.add_text('night-walk', json.dumps(meta, ensure_ascii=True, sort_keys=True))
    img.convert('RGB').save(out, optimize=True, pnginfo=info)
    print('saved', out)


if __name__ == '__main__':
    main()
