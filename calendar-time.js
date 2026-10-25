// 加入行事曆的時間規則。產生 event.ics 的 tools/sync_event.py 也有一份（default_end），
// 兩邊算出的時間不同時，網頁會一直隱藏「Apple／其他」按鈕，所以由 tests/calendar-time.test.js 和
// tests/test_sync_event.py 用同一份案例（tests/default-end-cases.json）分別檢查。
window.NightWalkTime = {
  /** 沒填結束時間時用開始後 2 小時，最晚到當天 23:59（不跨日，跟設定檢查「結束要晚於開始」一致）。 */
  defaultEnd(t) {
    const minutes = Math.min(t.h * 60 + t.mi + 120, 23 * 60 + 59);
    return { h: Math.floor(minutes / 60), mi: minutes % 60 };
  },
};
