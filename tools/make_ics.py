"""產生「加入行事曆」用的 event.ics（給 iPhone／Android 行事曆）。

iPhone 不接受網頁臨時產生的行事曆檔，必須是網站上真的存在的 .ics 檔，
所以每次改日期、時間或地點，都要重新產生並推上 GitHub。
網頁會自動比對這個檔案和試算表的日期時間，不一致時就隱藏「Apple／其他」按鈕，避免加錯日期。

用法（在 repo 根目錄執行）：
    python tools/make_ics.py --date 2026-10-26 --start 19:00 --end 21:00
"""
import argparse
from datetime import datetime, timedelta, timezone

TAIPEI = timezone(timedelta(hours=8))


def esc(text):
    return text.replace('\\', '\\\\').replace(';', '\\;').replace(',', '\\,').replace('\n', '\\n')


def fold(line):
    """RFC 5545：每行最多 75 bytes，續行以一個空白開頭；不切斷中文字。"""
    out, cur, limit = [], b'', 75
    for ch in line:
        b = ch.encode('utf-8')
        if len(cur) + len(b) > limit:
            out.append(cur)
            cur, limit = b' ', 75
        cur += b
    out.append(cur)
    return b'\r\n'.join(out)


def utc(date, hhmm):
    dt = datetime.strptime(f'{date} {hhmm}', '%Y-%m-%d %H:%M').replace(tzinfo=TAIPEI)
    return dt.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', required=True, help='YYYY-MM-DD，與試算表「活動日期」相同')
    ap.add_argument('--start', default='19:00')
    ap.add_argument('--end', default='21:00')
    ap.add_argument('--title', default='麟光夜行・富陽生態公園')
    ap.add_argument('--place', default='捷運麟光站 1 號出口')
    ap.add_argument('--route', default='富陽自然生態公園')
    ap.add_argument('--bring', default='手電筒、長袖長褲、鞋子（建議雨鞋）、愉快的心情')
    ap.add_argument('--rain', default='當天 15:00 台北市降雨機率 ≥ 70% 即取消，16:00 前於報名網頁公告。')
    ap.add_argument('--url', default='https://wang-yi-zhang.github.io/night-walk/')
    ap.add_argument('--uid', default='', help='同一場活動固定不變；預設用日期')
    ap.add_argument('--out', default='event.ics')
    a = ap.parse_args()

    details = '\n'.join(['本活動需事先報名，名額有限', f'集合：{a.place}', f'路線：{a.route}', f'記得帶：{a.bring}', a.rain, a.url])
    lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//night-walk//zh-TW',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        f'UID:night-walk-{a.uid or a.date}@wang-yi-zhang.github.io',
        'DTSTAMP:' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'),
        'DTSTART:' + utc(a.date, a.start),
        'DTEND:' + utc(a.date, a.end),
        'SUMMARY:' + esc(a.title),
        'LOCATION:' + esc(a.place),
        'DESCRIPTION:' + esc(details),
        'URL:' + a.url,
        'BEGIN:VALARM',
        'TRIGGER:-PT2H',
        'ACTION:DISPLAY',
        'DESCRIPTION:' + esc(a.title),
        'END:VALARM',
        'END:VEVENT',
        'END:VCALENDAR',
    ]
    with open(a.out, 'wb') as f:
        f.write(b'\r\n'.join(fold(l) for l in lines) + b'\r\n')
    print('saved', a.out)


if __name__ == '__main__':
    main()
