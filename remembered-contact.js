// 「在這支手機記住我的資料」：報名者自己選擇記住暱稱和聯絡方式，下次報名時自動帶入。
// 只存在報名者這支手機的瀏覽器，不會送到後端，主辦者看不到；試算表照樣在一個月內刪除聯絡方式。
// 規則見 SPEC.md「網頁行為」，測試在 tests/remembered-contact.test.js。
window.NightWalkRemember = (function () {
  'use strict';

  // 跟「已報名」狀態（night-walk:場次代碼）分開，場次代碼不會撞名
  const KEY = 'night-walk-remembered';
  const FIELDS = ['nickname', 'phone', 'line', 'ig'];
  const TTL_MS = 365 * 24 * 60 * 60 * 1000; // 最後一次用到之後一年沒再報名就清除

  function pick(data) {
    const out = {};
    FIELDS.forEach(f => { out[f] = String((data && data[f]) || ''); });
    return out;
  }

  /** 讀出記住的資料；沒有、壞掉或過期時回傳 null（過期的順便刪掉）。 */
  function read(storage, now) {
    let rec = null;
    try { rec = JSON.parse(storage.getItem(KEY) || 'null'); } catch (e) { return null; }
    if (!rec || typeof rec !== 'object' || !rec.nickname || typeof rec.usedAt !== 'number') return null;
    if (now - rec.usedAt > TTL_MS) {
      clear(storage);
      return null;
    }
    return Object.assign(pick(rec), { usedAt: rec.usedAt });
  }

  /** 記住這次送出的資料。「給主辦的話」只跟該場有關，不記。 */
  function save(storage, data, now) {
    try { storage.setItem(KEY, JSON.stringify(Object.assign(pick(data), { usedAt: now }))); } catch (e) { /* 無痕模式等 */ }
  }

  function clear(storage) {
    try { storage.removeItem(KEY); } catch (e) { /* 無痕模式等 */ }
  }

  /** 兩份資料（都已整理過格式）是否相同。 */
  function same(a, b) {
    return FIELDS.every(f => String((a && a[f]) || '') === String((b && b[f]) || ''));
  }

  /**
   * 報名成功後要問什麼：
   * - 'save'：還沒記住任何資料，問要不要記住
   * - 'replace'：記住的跟這次送出的不一樣（例如幫朋友報名），問要不要換掉，預設不換
   * - null：跟記住的一樣，不用問（但要更新最後使用時間，見 afterSignup）
   */
  function prompt(remembered, submitted) {
    if (!remembered) return 'save';
    return same(remembered, submitted) ? null : 'replace';
  }

  /** 報名成功後呼叫：回傳要問的問題；資料相同時順便延長期限。 */
  function afterSignup(storage, submitted, now) {
    const remembered = read(storage, now);
    const ask = prompt(remembered, submitted);
    if (ask === null) save(storage, submitted, now);
    return ask;
  }

  return { KEY, FIELDS, TTL_MS, read, save, clear, same, prompt, afterSignup };
})();
