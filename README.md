# web-pdf-tools


純前端 PDF 工具，適合直接部署至 GitHub Pages。所有 PDF 處理都在使用者的瀏覽器記憶體中完成。

## 部署至 GitHub Pages

1. 將 `index.html`、`styles.css`、`app.js` 放在 repository 根目錄。
2. 推送到 GitHub。
3. 開啟 repository 的 **Settings → Pages**。
4. 在 **Build and deployment** 選擇 **Deploy from a branch**。
5. 選擇要部署的 branch（通常是 `main`）與 `/ (root)`，然後儲存。

網站使用相對路徑，不論部署在使用者首頁或 project Pages 子路徑都能正常載入本機檔案。

## 檔案

- `index.html`：頁面結構及外部套件載入
- `styles.css`：自訂樣式與深色模式細節
- `app.js`：PDF 處理、工具切換及匯出流程

## 注意事項

- PDF 瘦身、縮圖與匯出效能取決於使用者裝置的記憶體。
- 強力瘦身會將頁面轉成圖片，因此不保留文字搜尋、超連結、表單及電子簽章。
- 強力瘦身可自行選擇頁面預覽畫質，並支援進度顯示與取消。
- PDF 轉 Excel 可選擇使用 Tesseract.js OCR 處理沒有文字層的掃描頁面；首次使用需下載語言資料。
- 加密套件需由 CDN 動態載入；若載入或加密失敗，系統不會輸出未加密檔案。
