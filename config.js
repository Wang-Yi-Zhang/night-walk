// 部署 Apps Script 後，把「網頁應用程式」網址（結尾是 /exec）貼在 apiUrl 的引號裡。
// 網址留空時，網頁會顯示「報名系統準備中」。
// 本機測試：網址後面加 ?mock 可用假資料預覽（?mock=wait、?mock=full、?mock=rain、?mock=deadline、?mock=empty）。
window.NIGHT_WALK_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/AKfycbx_yzXDGrH76dt-NfNWK3TmQoZo7Ao60VNLxJg8w-96HG0x7GtzaFLzUwsMPugECH9Skg/exec',
};
