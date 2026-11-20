# 行事曆一律一次性匯入，Apple 用網站上的固定 .ics 檔

訂閱式行事曆可以在改期時自動更新，但更新延遲不可控、報名者不會知道活動改了，iPhone 預設還會移除訂閱行事曆的提醒，等於改期後大家默默看到新日期、卻沒有提醒。所以只提供一次性匯入，改期時由主辦者個別通知。iOS 不接受網頁臨時產生的檔案，所以 Apple 行事曆連到網站上真實存在的 `event.ics`；網頁會比對它的時間和目前設定，不一致就隱藏按鈕。

## Considered Options

- **網頁用 data: 或 Blob 臨時產生 .ics**：iOS 不接受網頁臨時產生的行事曆檔。
- **LINE 內建瀏覽器直接開 .ics**：LINE 會把它當成「訂閱行事曆」並改用 http，GitHub Pages 轉址後訂閱失敗（iOS 26 實測）。所以在 LINE 裡改成複製連結、請報名者貼到 Safari。
- **LINE 裡用 `x-safari-https://` 直接打開 Safari**（iPhone 限定，iOS 17 起）：Apple 沒有正式文件，LINE 可能擋掉，失敗時網頁不會有任何反應。2026-11-20 在 iPhone 的 LINE 實測可以直接跳到 Safari，所以 iPhone 的 LINE 一律用這個做法；按下 1.5 秒後網頁還在前景，就改成複製連結當備案（給 iOS 16 以下或之後 LINE 擋掉的情況）。Android 的 LINE 維持複製連結。
