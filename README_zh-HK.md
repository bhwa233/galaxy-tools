# 花箋 · Electron 遷移版

現行版本採用 Electron 45、TypeScript、React 19 和 Vite 8，首版目標為 Windows 11 x64。

開發、打包和資料目錄請參閱 [現行說明](README.md)；架構與驗證記錄見 [Electron 遷移說明](Docs/electron-migration.md)。上游 Tauri 自動更新已停用。歷史上游文件保留在 `Docs/upstream/`，MIT 授權及來源聲明維持保留。

原關閉按鈕及 Ctrl+W 現在儲存並折疊為貼邊膠囊；右鍵選單提供「隱藏到托盤」。支援懸浮膠囊、共用邊緣隊列、主膠囊整列控制和不搶焦點的預覽。詳見 [膠囊說明](Docs/edge-capsules.md)。
