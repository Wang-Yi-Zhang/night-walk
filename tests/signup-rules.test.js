// 報名規則：正取／候補／額滿、A-2、手動遞補、取消、判斷重複、換場次、自訂欄位。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { freshEvent, eq, phone } = require('./fake-apps-script');

/** 依序報名 from..to 號（暱稱「人N」、手機 phone(N)），回傳每筆的結果。 */
function signupRange(h, from, to, prefix = '人') {
  const results = [];
  for (let i = from; i <= to; i++) results.push(h.post({ nickname: prefix + i, phone: phone(i) }));
  return results;
}

test('正取 10 人額滿後轉候補，候補 5 人額滿後拒絕', () => {
  const h = freshEvent();
  signupRange(h, 1, 10).forEach((r, i) => {
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.status, '正取');
    assert.strictEqual(r.position, i + 1);
    assert.strictEqual(r.capacity, 10);
  });
  let st = h.get();
  assert.strictEqual(st.confirmed.length, 10);
  eq(st.registration, { open: true, mode: '候補', reason: null });

  signupRange(h, 11, 15, '候').forEach((r, i) => {
    assert.strictEqual(r.status, '候補');
    assert.strictEqual(r.position, i + 1);
  });
  st = h.get();
  eq(st.waitlist, ['候11', '候12', '候13', '候14', '候15']);
  eq(st.registration, { open: false, mode: null, reason: 'full' });

  const full = h.post({ nickname: '晚到', phone: phone(16) });
  assert.strictEqual(full.ok, false);
  assert.strictEqual(full.error, 'full');
  assert.strictEqual(h.rowOf('晚到'), undefined, '額滿時不寫入');
  assert.strictEqual(h.rowOf('人1')['身分'], '正取');
  assert.strictEqual(h.rowOf('候11')['身分'], '候補');
});

test('A-2：只要有人在候補，正取空出名額時新報名仍進候補', () => {
  const h = freshEvent();
  signupRange(h, 1, 10);
  signupRange(h, 11, 12, '候');

  h.editSignup('人3', '身分', '取消');
  let st = h.get();
  assert.strictEqual(st.confirmed.length, 9);
  eq(st.registration, { open: true, mode: '候補', reason: null }, '名額保留給候補中');

  const r = h.post({ nickname: '新人', phone: phone(20) });
  assert.strictEqual(r.status, '候補');
  assert.strictEqual(r.position, 3);
  assert.strictEqual(h.get().confirmed.length, 9, '不會自動遞補');
});

test('A-2：候補已滿時有人刪除整列，仍然額滿', () => {
  const h = freshEvent();
  signupRange(h, 1, 10);
  signupRange(h, 11, 15, '候');
  h.deleteSignupRow('人4');
  h.advance(31 * 1000);
  const st = h.get();
  assert.strictEqual(st.confirmed.length, 9);
  assert.strictEqual(st.registration.reason, 'full');
  assert.strictEqual(h.post({ nickname: '搶位', phone: phone(18) }).error, 'full');
});

test('手動遞補：主辦把候補改成正取後，新報名排在候補的最後', () => {
  const h = freshEvent();
  signupRange(h, 1, 10);
  signupRange(h, 11, 15, '候');
  h.deleteSignupRow('人4');
  h.editSignup('候11', '身分', '正取');

  const st = h.get();
  assert.strictEqual(st.confirmed.length, 10);
  assert.ok(st.confirmed.includes('候11'));
  eq(st.waitlist, ['候12', '候13', '候14', '候15']);

  const r = h.post({ nickname: '新', phone: phone(19) });
  assert.strictEqual(r.status, '候補');
  assert.strictEqual(r.position, 5);
});

test('候補全部遞補完、正取還有空位時，新報名回到正取', () => {
  const h = freshEvent();
  signupRange(h, 1, 10);
  signupRange(h, 11, 11, '候');
  h.editSignup('人1', '身分', '取消');
  h.editSignup('人2', '身分', '取消');
  h.editSignup('候11', '身分', '正取');
  const r = h.post({ nickname: '新', phone: phone(30) });
  assert.strictEqual(r.status, '正取');
  assert.strictEqual(r.position, 10);
});

test('調高正取上限不會自動改變任何人的身分', () => {
  const h = freshEvent();
  signupRange(h, 1, 10);
  signupRange(h, 11, 15, '候');
  h.setSetting('正取上限', '12');

  let st = h.get();
  assert.strictEqual(st.capacity, 12);
  assert.strictEqual(st.confirmed.length, 10);
  assert.strictEqual(st.waitlist.length, 5);
  assert.strictEqual(st.registration.reason, 'full', '候補還在排隊，所以仍然額滿');
  assert.strictEqual(h.rowOf('候11')['身分'], '候補');

  h.setSetting('候補上限', '6');
  const r = h.post({ nickname: '加開', phone: phone(16) });
  assert.strictEqual(r.status, '候補', '有人候補時，加開的正取名額也不給新報名');
  assert.strictEqual(r.capacity, 12);
  st = h.get();
  assert.strictEqual(st.confirmed.length, 10);
});

test('正取上限設為 0：一開始就進候補', () => {
  const h = freshEvent();
  h.setSetting('正取上限', '0');
  const r = h.post({ nickname: '甲', phone: phone(1) });
  assert.strictEqual(r.status, '候補');
  assert.strictEqual(r.position, 1);
});

test('同一個聯絡方式重複報名本場：跨欄位判斷，回傳 field', () => {
  const h = freshEvent();
  h.post({ nickname: '螢火蟲', line: 'frog.king_1' });
  h.post({ nickname: '貓頭鷹', ig: 'night.owl_tw' });
  h.post({ nickname: '甲', phone: '0911111111' });

  let d = h.post({ nickname: '別人', line: '@FROG.KING_1' });
  assert.strictEqual(d.error, 'duplicate');
  assert.strictEqual(d.field, 'line');
  assert.ok(d.message.startsWith('這個 LINE ID'), d.message);

  d = h.post({ nickname: '別人', phone: '0944444444', ig: 'https://instagram.com/NIGHT.OWL_TW' });
  assert.strictEqual(d.error, 'duplicate');
  assert.strictEqual(d.field, 'ig');
  assert.ok(d.message.startsWith('這個 IG 帳號'), d.message);

  d = h.post({ nickname: '別人', phone: '+886-911-111-111' });
  assert.strictEqual(d.error, 'duplicate');
  assert.strictEqual(d.field, 'phone');
  assert.ok(d.message.startsWith('這支手機'), d.message);

  assert.strictEqual(h.rows().length, 3, '重複時不寫入');
  assert.strictEqual(h.post({ nickname: '螢火蟲', line: 'another_frog' }).ok, true, '暱稱可以重複');
});

test('舊資料（試算表吃掉開頭 0、或含連字號）的手機也納入重複比對', () => {
  const h = freshEvent();
  h.sheet('報名').appendRow([new Date(), "'2026-11-06", "'手打的", 912345678, '', '', '正取', '']);
  h.sheet('報名').appendRow([new Date(), "'2026-11-06", "'手打的2", "'0922-333-444", '', '', '候補', '']);
  assert.strictEqual(h.post({ nickname: '別人', phone: '0912345678' }).field, 'phone');
  assert.strictEqual(h.post({ nickname: '別人', phone: '0922333444' }).field, 'phone');
});

test('「取消」的列不計入人數，同一個聯絡方式可以重新報名', () => {
  const h = freshEvent();
  h.post({ nickname: '反悔', phone: phone(1), line: 'regret_id' });
  h.editSignup('反悔', '身分', '取消');
  assert.strictEqual(h.get().confirmed.length, 0);
  const r = h.post({ nickname: '回來了', phone: phone(1), line: 'regret_id' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.position, 1);
});

test('換場次代碼後人數歸零，同一個聯絡方式可以報新場次', () => {
  const h = freshEvent();
  signupRange(h, 1, 10);
  signupRange(h, 11, 15, '候');
  assert.strictEqual(h.get().registration.reason, 'full');

  h.setSetting('場次代碼', '2026-11-20');
  let st = h.get();
  assert.strictEqual(st.event.id, '2026-11-20');
  eq(st.confirmed, []);
  eq(st.waitlist, []);
  eq(st.registration, { open: true, mode: '正取', reason: null });

  const r = h.post({ nickname: '人5', phone: phone(5) });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.status, '正取');
  assert.strictEqual(r.position, 1);
  assert.strictEqual(h.rawOf('人5')['場次代碼'], "'2026-11-06", '舊場次的那一列不變');
  const rows = h.rows().filter(x => x['暱稱'] === '人5');
  eq(rows.map(x => x['場次代碼']), ['2026-11-06', '2026-11-20']);
  st = h.get();
  eq(st.confirmed, ['人5']);
});

test('主辦調整欄位順序、插入自己的欄位後，讀寫仍然正確', () => {
  const h = freshEvent();
  h.post({ nickname: '先來', line: 'first_one' });
  const data = h.sheet('報名').data;
  // 最前面插一欄「主辦備註」，並把「身分」搬到最後
  data.forEach((row, i) => row.splice(0, 0, i === 0 ? '主辦備註' : '會晚到'));
  const s = data[0].indexOf('身分');
  data.forEach(row => { const [v] = row.splice(s, 1); row.push(v); });

  const r = h.post({ nickname: '備註後', line: 'after_note', message: '你好' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.position, 2);
  const row = h.rowOf('備註後');
  assert.strictEqual(row['主辦備註'], '');
  assert.strictEqual(row['場次代碼'], '2026-11-06');
  assert.strictEqual(row['LINE ID'], 'after_note');
  assert.strictEqual(row['身分'], '正取');
  assert.strictEqual(row['給主辦的話'], '你好');
  assert.strictEqual(h.rowOf('先來')['主辦備註'], '會晚到');
  assert.strictEqual(h.header()[h.header().length - 1], '身分');
  eq(h.get().confirmed, ['先來', '備註後']);
  assert.strictEqual(h.post({ nickname: '重複', line: 'first_one' }).field, 'line');
});
