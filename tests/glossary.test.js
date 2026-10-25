// 用語檢查：GLOSSARY.md 每個詞條的「_避免_」用詞，不出現在程式、測試和文件裡。
// 新增避免用詞時自動納入檢查。有合法用法、只能靠審查判斷的詞列在 REVIEW_ONLY。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** 有合法用法的避免用詞：程式判斷不了是不是指同一件事，留給審查。 */
const REVIEW_ONLY = {
  '活動': '整個系列也叫活動，而且是「活動狀態」「活動日期」等設定項目的名稱',
  '延期': '是活動狀態的選項之一',
  '通知': '「通知信」，以及主辦者個別通知報名者',
  '正式': '「正式資料」「正式網站」指上線環境',
  'ID': '「LINE ID」',
  '狀態': '「活動狀態」',
  '表單': '「Google 表單」「報名表單」',
  '驗證': 'Google 的「尚未驗證這個應用程式」，以及前端驗證',
  '個資': '個資保護、個資說明等法律意義，不只指聯絡方式',
  '自動遞補': '說明「不會自動遞補」時要用到',
  '訂閱行事曆': '說明為什麼不提供訂閱時要用到',
  'A-2': '確認表的段落編號',
};

/** 含避免用詞但意思不同的固定說法。 */
const ALLOWED_PHRASES = ['使用者故事', '使用者輸入', '帳戶的使用者', '真實姓名'];

/** 讀 GLOSSARY.md，回傳 [{ term, use }]：term 是避免用詞，use 是該用的詞條名稱。 */
function avoidedTerms() {
  const out = [];
  let headword = '';
  for (const line of fs.readFileSync(path.join(ROOT, 'GLOSSARY.md'), 'utf8').split('\n')) {
    const head = /^\*\*(.+?)\*\*：/.exec(line);
    if (head) headword = head[1];
    if (!line.startsWith('_避免_：')) continue;
    line.slice('_避免_：'.length).replace(/（[^）]*）/g, '').split('、').map(t => t.trim()).filter(Boolean)
      .forEach(term => out.push({ term, use: headword }));
  }
  return out;
}

const SKIP_DIRS = new Set(['.git', '.claude', 'node_modules', '__pycache__']);
const SKIP_FILES = new Set(['GLOSSARY.md', path.join('tests', 'glossary.test.js')]);
const TEXT = /\.(js|gs|py|html|css|md|yml|json)$/;

function files(dir = ROOT) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : files(full);
    const rel = path.relative(ROOT, full);
    return TEXT.test(e.name) && !SKIP_FILES.has(rel) ? [rel] : [];
  });
}

test('GLOSSARY 的避免用詞都有被解析出來', () => {
  const terms = avoidedTerms().map(t => t.term);
  assert.ok(terms.includes('使用者') && terms.includes('聯絡資料'), terms.join('、'));
  for (const term of Object.keys(REVIEW_ONLY)) assert.ok(terms.includes(term), 'REVIEW_ONLY 的「' + term + '」已經不在 GLOSSARY 裡，請移除');
});

test('程式、測試和文件不使用 GLOSSARY 的避免用詞', () => {
  const checked = avoidedTerms().filter(t => !(t.term in REVIEW_ONLY));
  const hits = [];
  for (const rel of files()) {
    fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
      const text = ALLOWED_PHRASES.reduce((s, p) => s.split(p).join(''), line);
      for (const { term, use } of checked) {
        if (text.includes(term)) hits.push(rel + ':' + (i + 1) + '：「' + term + '」請改用「' + use + '」');
      }
    });
  }
  assert.deepStrictEqual(hits, []);
});
