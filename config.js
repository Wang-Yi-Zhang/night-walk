// 部署 Apps Script 後，把「網頁應用程式」網址（結尾是 /exec）貼在 apiUrl 的引號裡。
// 網址留空時，網頁會顯示「報名系統準備中」。
// 本機測試：網址後面加 ?mock 可用假資料預覽（?mock=wait、?mock=full、?mock=rain、?mock=deadline、?mock=empty、?mock=captcha）。
window.NIGHT_WALK_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/AKfycbx_yzXDGrH76dt-NfNWK3TmQoZo7Ao60VNLxJg8w-96HG0x7GtzaFLzUwsMPugECH9Skg/exec',
  // 「🗓 Apple／其他」加入行事曆按鈕；改成 false 即關閉（關閉時可在網址加 ?applecal 單獨測試）。
  appleCalendar: true,
  // Cloudflare Turnstile 的網站金鑰（site key，公開的那一把）。留空就不顯示防機器人驗證。
  // 密鑰（secret key）不要貼在這裡，要放在 Apps Script 的指令碼屬性 TURNSTILE_SECRET。
  // 本機測試：?mock 時改用 Cloudflare 的測試金鑰；沒填網站金鑰時可加 ?turnstile 試用。
  turnstileSiteKey: '0x4AAAAAAFtoJFMTm-ZANicy',
};
