[简体中文](../CONTRIBUTING.md) | **繁體中文** | [English](CONTRIBUTING_en-US.md)

# 貢獻指南

感謝你對花箋（Floral Notepaper）的關注！這份指南會幫助你了解如何參與專案開發。

## 開發環境配置

### 依賴與 workspace

使用 Node.js **26.12.1** 與 pnpm **12.15.0**。現行桌面執行環境為 Electron，目標為 Windows 11 x64；原生外掛建置可能需要 Windows C++ 工具鏈，歷史 Tauri/Rust 指令不適用於現行建置。

依照[現行開發說明](../README.md#开发)選取專案工具鏈，不替換全域 Node。以下指令均從倉庫根目錄執行：

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm build
pnpm pack:win
```

`apps/desktop` 包含 Electron 與 React 應用；`packages/sdk`、`packages/ui`、`packages/official/*`、`examples/plugins/*` 各為獨立 workspace。依賴宣告在使用它的套件中，共用開發工具留在根目錄，全倉只維護根目錄的 `pnpm-lock.yaml`。單包任務使用 `pnpm --filter @spark233/desktop <指令>`。

## 分支與提交規範

本專案採用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 規範。

### Commit Message 格式

```
<type>: <簡短描述>
```

常用 type：

| type       | 說明                         |
| ---------- | ---------------------------- |
| `feat`     | 新功能                       |
| `fix`      | 修復 bug                     |
| `docs`     | 文件變更                     |
| `style`    | 格式調整（不影響程式碼邏輯） |
| `refactor` | 重構（既非新功能也非修復）   |
| `perf`     | 效能優化                     |
| `test`     | 新增或修改測試               |
| `chore`    | 構建、CI、依賴等雜項         |
| `ci`       | CI/CD 配置變更               |
| `revert`   | 回滾提交                     |

### 分支命名

分支名稱應與 commit type 對應：`feat/描述`、`fix/描述`、`refactor/描述` 等。

範例：

- `feat/note-tagging` → 新功能分支
- `fix/startup-crash` → 修復分支

## 程式碼風格與測試

提交 PR 前，請確保本機通過以下檢查。可以在每次 commit 前也跑一遍，避免 CI 掛掉後反覆修：

```bash
pnpm typecheck
pnpm lint
pnpm fmt --check
pnpm test
pnpm build
```

## Pull Request 流程

1. **先搜尋** [已有 PR](https://github.com/Achilng/floral-notepaper/pulls)，確認沒有雷同的提交，避免重複勞動
2. Fork 本倉庫，從 `main` 分支創建你的功能/修復分支
3. 開發完成後，確保本機檢查全部通過
4. 提交 PR 到 `main` 分支，**填寫 PR 模板**中的各項內容
5. CI 必須全部通過（構建 + lint + 測試）

   > 註：CI 檢出的是 PR 分支與 `main` 合併後的程式碼（`refs/pull/<編號>/merge`），而非你分支的原始提交。

6. 至少一位 maintainer **review 通過**後方可合併
7. Maintainer 使用 **squash merge** 合入，合入後自動刪除遠端分支

PR 標題同樣遵循 Conventional Commits 格式，例如 `feat: 添加筆記標籤功能`。

## 問題回饋

- 報告 bug：[提交 Issue](https://github.com/Achilng/floral-notepaper/issues/new?template=bug.yml)
- 功能請求：[提交 Issue](https://github.com/Achilng/floral-notepaper/issues/new?template=enhancement.yml)
- 一般討論：[GitHub Discussions](https://github.com/Achilng/floral-notepaper/discussions)
