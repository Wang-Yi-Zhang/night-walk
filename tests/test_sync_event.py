"""tools/sync_event.py：event.ics 的結束時間與 UID，以及正式後端的版本比對。

執行（在 repo 根目錄）：python -m unittest discover -s tests -p "test_*.py"
只用 Python 標準函式庫；不產生 og.png，所以不需要 Pillow。
"""
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'tools'))
import sync_event  # noqa: E402

CASES = json.loads((HERE / 'default-end-cases.json').read_text(encoding='utf-8'))


def state(**event):
    ev = {'id': '2026-10-23', 'name': '麟光夜行・富陽生態公園', 'date': '2026-10-26',
          'start': '19:00', 'end': '21:00', 'place': '捷運麟光站 1 號出口'}
    ev.update(event)
    return {'event': ev, 'capacity': 10}


class DefaultEnd(unittest.TestCase):
    def test_same_cases_as_the_web_page(self):
        """跟 tests/calendar-time.test.js 用同一份案例，兩邊不一致時網頁會隱藏 Apple 按鈕。"""
        for start, end in CASES:
            with self.subTest(start=start):
                self.assertEqual(sync_event.Event(state(start=start, end='')).end, end)

    def test_filled_end_is_kept(self):
        self.assertEqual(sync_event.Event(state(start='19:00', end='20:15')).end, '20:15')


class Uid(unittest.TestCase):
    def uid(self, **event):
        return sync_event.ics_fields(sync_event.Event(state(**event)).ics())['UID']

    def test_uid_is_the_event_id_and_survives_rescheduling(self):
        self.assertEqual(self.uid(), 'night-walk-2026-10-23@wang-yi-zhang.github.io')
        self.assertEqual(self.uid(date='2026-10-30', start='18:30'), self.uid())

    def test_new_event_id_gets_a_new_uid(self):
        self.assertNotEqual(self.uid(id='2026-11-20'), self.uid())

    def test_missing_event_id_is_a_problem(self):
        self.assertIn('場次代碼', ''.join(sync_event.Event(state(id='')).problems()))


class CheckUid(unittest.TestCase):
    """--check 要抓到 event.ics 的 UID 跟試算表的場次代碼不一致。"""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        for name, path in (('OG', root / 'og.png'), ('ICS', root / 'event.ics'), ('INDEX', root / 'index.html')):
            original = getattr(sync_event, name)
            setattr(sync_event, name, path)
            self.addCleanup(setattr, sync_event, name, original)
        sync_event.INDEX.write_text('<html></html>', encoding='utf-8')

    def uid_problems(self, ics_state):
        sync_event.ICS.write_bytes(sync_event.Event(ics_state).ics())
        return [s for s in sync_event.check(sync_event.Event(state())) if 'UID' in s]

    def test_matching_uid_is_not_reported(self):
        self.assertEqual(self.uid_problems(state()), [])

    def test_uid_made_from_another_code_is_reported(self):
        problems = self.uid_problems(state(id='2026-10-26'))
        self.assertEqual(len(problems), 1)
        self.assertIn('night-walk-2026-10-26@', problems[0])
        self.assertIn('night-walk-2026-10-23@', problems[0])


class BackendVersion(unittest.TestCase):
    """--check 要抓到「改了 Code.gs 卻還沒重新部署」。"""

    def setUp(self):
        source = sync_event.CODE.read_text(encoding='utf-8')
        self.constant = re.search(r"const CODE_VERSION = '([^']*)';", source)[1]

    def test_same_hash_as_the_node_test(self):
        """tests/code-version.test.js 確認 CODE_VERSION 跟 Code.gs 相符；這裡確認兩邊算法相同。"""
        self.assertEqual(sync_event.code_version(sync_event.CODE.read_text(encoding='utf-8')), self.constant)

    def test_crlf_does_not_change_the_version(self):
        source = sync_event.CODE.read_text(encoding='utf-8')
        self.assertEqual(sync_event.code_version(source.replace('\n', '\r\n')), self.constant)

    def test_deployed_version_matches(self):
        self.assertEqual(sync_event.check_backend({'version': self.constant}), [])

    def test_old_or_missing_version_is_reported(self):
        self.assertIn('沒有回傳版本', ''.join(sync_event.check_backend({})))
        problem = ''.join(sync_event.check_backend({'version': '000000000000'}))
        self.assertIn('000000000000', problem)
        self.assertIn(self.constant, problem)


if __name__ == '__main__':
    unittest.main()
