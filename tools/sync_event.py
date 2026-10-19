"""依試算表目前的活動設定，更新網站上的固定檔案：og.png、event.ics、index.html 的分享預覽文字。

LINE 抓預覽、iPhone 加入行事曆都不會執行網頁的 JavaScript，所以這三樣不會跟著試算表變，
要在改期或辦新場次後重新產生。這個工具直接讀取 Apps Script 的公開資料（跟網頁讀的是同一份），
不用再手動輸入日期、星期、時間和地點。

用法（在 repo 根目錄執行）：
    python tools/sync_event.py                       # 更新三個檔案（沒變的不會重寫）
    python tools/sync_event.py --badge "因颱風改期" --note "原 10/23 因颱風改期。"
    python tools/sync_event.py --check               # 只檢查是否過期；過期時結束代碼為 1

--check 只需要 Python 標準函式庫；更新 og.png 需要 Pillow 和 Windows 的 Noto 字型（見 make_og.py）。
"""
import argparse
import hashlib
import html
import json
import re
import struct
import sys
import urllib.request
from datetime import date as Date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # make_og／make_ics 用到時才載入
ROOT = Path(__file__).resolve().parent.parent
OG = ROOT / 'og.png'
ICS = ROOT / 'event.ics'
INDEX = ROOT / 'index.html'
SITE_URL = 'https://wang-yi-zhang.github.io/night-walk/'
WEEK = '一二三四五六日'


def api_url():
    m = re.search(r"apiUrl:\s*'([^']+)'", (ROOT / 'config.js').read_text(encoding='utf-8'))
    if not m:
        sys.exit('config.js 裡沒有 apiUrl')
    return m.group(1)


def load_state(path):
    if path:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    with urllib.request.urlopen(api_url(), timeout=60) as res:
        return json.load(res)


def parse_date(text):
    m = re.fullmatch(r'(\d{4})[-/](\d{1,2})[-/](\d{1,2})', text or '')
    return Date(int(m[1]), int(m[2]), int(m[3])) if m else None


def parse_time(text):
    m = re.fullmatch(r'(\d{1,2}):(\d{2})', text or '')
    return f'{int(m[1]):02d}:{m[2]}' if m else None


class Event:
    """從公開資料整理出產生檔案需要的欄位。"""

    def __init__(self, state, badge='', note='', kicker=''):
        ev = state['event']
        self.id = ev.get('id') or ''
        self.name = ev.get('name') or ''
        self.date_text = ev.get('date') or ''
        self.day = parse_date(self.date_text)
        self.start = parse_time(ev.get('start'))
        self.end = parse_time(ev.get('end'))
        if self.start and not self.end:  # 跟網頁一樣：沒填結束時間就當成 2 小時
            h, mi = map(int, self.start.split(':'))
            self.end = f'{min(h + 2, 23):02d}:{mi:02d}'
        self.place = ev.get('place') or ''
        self.route = ev.get('route') or ''
        self.fee = ev.get('fee') or ''
        self.bring = '、'.join(ev.get('bring') or [])
        self.rain = (ev.get('rainRule') or '').replace('本頁', '報名網頁')
        self.title = ev.get('title') or ''
        self.capacity = state.get('capacity')
        self.badge = badge
        self.note = note
        self.kicker = kicker or ('夜間生態觀察・' + self.title if self.title else '夜間生態觀察')

    def problems(self):
        out = []
        if not self.day:
            out.append('「活動日期」不是 2026-11-20 這種格式')
        if not self.start:
            out.append('「開始時間」不是 19:00 這種格式')
        return out

    @property
    def iso(self):
        return self.day.isoformat()

    @property
    def md(self):
        return f'{self.day.month}/{self.day.day}（{WEEK[self.day.weekday()]}）'

    def og_meta(self):
        """存進 og.png 的資料；跟試算表比對時只看日期、時間和地點。"""
        return {'date': self.iso, 'start': self.start, 'place': self.place,
                'name': self.name, 'kicker': self.kicker, 'badge': self.badge, 'capacity': self.capacity, 'fee': self.fee}

    def og_args(self):
        title, _, subtitle = self.name.partition('・')
        return dict(title=title, subtitle=subtitle or self.route, kicker=self.kicker,
                    date=f'{self.day.year}/{self.day.month}/{self.day.day}（{WEEK[self.day.weekday()]}）',
                    time=self.start, place=self.place,
                    footer=f'限額 {self.capacity} 人 ‧ {self.fee} ‧ 線上即時看人數', badge=self.badge)

    def ics(self):
        import make_ics
        return make_ics.build(self.iso, self.start, self.end, self.name, self.place, self.route,
                              self.bring, self.rain, SITE_URL, self.id or self.iso)

    def og_title(self):
        return f'{self.name}｜{self.md}{self.start}' + (f'（{self.badge}）' if self.badge else '')

    def description(self):
        visit = f'，夜訪{self.route}' if self.route else ''
        return f'{self.note}{self.place}集合{visit}。限額 {self.capacity} 人・{self.fee}・線上報名即時看人數。'


# ── 讀取現有檔案 ────────────────────────────────────────────────────

def png_meta(path):
    """讀 PNG 的 tEXt 欄位 night-walk（只用標準函式庫，CI 不必安裝 Pillow）。"""
    if not path.exists():
        return None
    data = path.read_bytes()
    i = 8
    while i + 8 <= len(data):
        length, kind = struct.unpack('>I4s', data[i:i + 8])
        chunk = data[i + 8:i + 8 + length]
        if kind == b'tEXt':
            key, _, value = chunk.partition(b'\0')
            if key == b'night-walk':
                return json.loads(value.decode('latin-1'))
        i += 12 + length
    return None


def ics_fields(raw):
    """展開續行後回傳 { 欄位: 值 }，DTSTAMP 除外（每次產生都會變）。"""
    text = raw.decode('utf-8').replace('\r\n ', '').replace('\r\n', '\n')
    fields = {}
    for line in text.split('\n'):
        key, sep, value = line.partition(':')
        if sep and key != 'DTSTAMP':
            fields.setdefault(key, value)
    return fields


def taipei(stamp):
    """20261026T110000Z → 2026-10-26 19:00（台灣時間），方便閱讀。"""
    try:
        t = datetime.strptime(stamp, '%Y%m%dT%H%M%SZ') + timedelta(hours=8)
    except (TypeError, ValueError):
        return stamp
    return t.strftime('%Y-%m-%d %H:%M')


def og_version():
    return hashlib.sha1(OG.read_bytes()).hexdigest()[:10]


def set_meta(page, attr, name, value):
    pattern = re.compile(r'(<meta\s+' + attr + r'="' + re.escape(name) + r'"\s+content=")[^"]*(")')
    if not pattern.search(page):
        sys.exit(f'index.html 找不到 <meta {attr}="{name}">')
    return pattern.sub(lambda m: m[1] + html.escape(value, quote=True) + m[2], page, count=1)


def get_meta(page, attr, name):
    m = re.search(r'<meta\s+' + attr + r'="' + re.escape(name) + r'"\s+content="([^"]*)"', page)
    return html.unescape(m[1]) if m else ''


# ── 檢查與更新 ──────────────────────────────────────────────────────

def check(ev):
    stale = []
    meta = png_meta(OG)
    if not meta:
        stale.append('og.png 沒有記錄是哪一場（舊版工具產生的），請重新產生')
    else:
        for key, label, want in (('date', '日期', ev.iso), ('start', '開始時間', ev.start), ('place', '集合地點', ev.place)):
            if meta.get(key) != want:
                stale.append(f'og.png 的{label}是「{meta.get(key)}」，試算表是「{want}」')

    want = ics_fields(ev.ics())
    have = ics_fields(ICS.read_bytes()) if ICS.exists() else {}
    for key, label in (('DTSTART', '開始時間'), ('DTEND', '結束時間'), ('LOCATION', '集合地點')):
        if have.get(key) != want[key]:
            show = taipei if key != 'LOCATION' else str
            stale.append(f'event.ics 的{label}是「{show(have.get(key))}」，試算表是「{show(want[key])}」')

    page = INDEX.read_text(encoding='utf-8')
    title = get_meta(page, 'property', 'og:title')
    if f'{ev.md}{ev.start}' not in title:
        stale.append(f'index.html 的 og:title「{title}」沒有「{ev.md}{ev.start}」')
    if OG.exists() and f'?v={og_version()}' not in get_meta(page, 'property', 'og:image'):
        stale.append('index.html 的 og:image 版本號跟 og.png 不一致，LINE 可能繼續顯示舊圖')
    return stale


def write(ev):
    changed = []
    if png_meta(OG) != ev.og_meta():
        import make_og
        make_og.render(**ev.og_args(), out=str(OG), meta=ev.og_meta())
        changed.append('og.png')

    new_ics = ev.ics()
    if not ICS.exists() or ics_fields(ICS.read_bytes()) != ics_fields(new_ics):
        ICS.write_bytes(new_ics)
        changed.append('event.ics')

    page = INDEX.read_text(encoding='utf-8')
    new_page = page
    new_page = set_meta(new_page, 'name', 'description', ev.description())
    new_page = set_meta(new_page, 'property', 'og:title', ev.og_title())
    new_page = set_meta(new_page, 'property', 'og:description', ev.description())
    new_page = set_meta(new_page, 'property', 'og:image', f'{SITE_URL}og.png?v={og_version()}')
    if new_page != page:
        INDEX.write_text(new_page, encoding='utf-8', newline='')
        changed.append('index.html')
    return changed


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--check', action='store_true', help='只檢查，不寫入；過期時結束代碼為 1')
    ap.add_argument('--badge', default='', help='預覽圖上的醒目標籤，也會加在 og:title 後面，例如「因颱風改期」')
    ap.add_argument('--note', default='', help='加在分享描述最前面的一句話，例如「原 10/23 因颱風改期。」')
    ap.add_argument('--kicker', default='', help='預覽圖最上面那行字；預設是「夜間生態觀察・場次標題」')
    ap.add_argument('--state', default='', help='改用這個 JSON 檔當公開資料（離線測試用），不連線到 Apps Script')
    a = ap.parse_args()

    ev = Event(load_state(a.state), badge=a.badge, note=a.note, kicker=a.kicker)
    if not ev.date_text:
        print('試算表還沒填活動日期，略過。')
        return
    problems = ev.problems()
    if problems:
        sys.exit('試算表的設定有問題，請先在試算表點「🔦 夜行報名 → 檢查設定」：\n' + '\n'.join('・' + p for p in problems))

    print(f'試算表目前的場次：{ev.id}｜{ev.md}{ev.start}–{ev.end}｜{ev.place}')
    if a.check:
        stale = check(ev)
        if stale:
            print('\n網站上的固定檔案跟試算表對不上，請執行 python tools/sync_event.py 重新產生：')
            print('\n'.join('・' + s for s in stale))
            sys.exit(1)
        print('og.png、event.ics、index.html 都跟試算表一致。')
        return

    changed = write(ev)
    if changed:
        print('已更新：' + '、'.join(changed))
        print('推上 GitHub 後約 10 分鐘生效；記得貼一次連結到自己的 LINE 確認預覽圖。')
    else:
        print('三個檔案都已經是最新的，不用更新。')


if __name__ == '__main__':
    main()
