# 截图历史与入口重划（2026-10-28）

## 结论

截图与截图取字改为「操作」，插件入口改为「截图历史」。历史上限 50 条，覆盖所有完成路径（复制 / 保存 / 图钉 / 长截图 / 取字），不再只记录取字。OCR 插件退出应用与插件网格，仅保留「识别图片文字」操作（无图片上下文时弹文件选择）。

## 为什么必须改原生

改前 `SessionResult.h` 只有一处 publish，且 `action` 写死 `ocr`，只在 `Util::openWithImageReader` 的取字分支被调用。复制、保存、图钉、长截图退出时宿主只拿到退出码，**没有图片文件**，因此「所有截图都进历史」无法只靠宿主实现。

## 原生改动（需重建 exe）

- `native/capture/SessionResult.h`
  - 新增 `captureImage(w, h, bgra, action)`：WIC 编码写 `selection.png` 再发布 `capture.json`；`imagePublished` 原子标记保证一次会话只发布一次，失败时释放标记并删除半成品。
  - `writePng` 用 WIC 独立编码，不依赖 `Util.cpp` 的匿名命名空间函数。
- `scripts/native-capture/adapt.ps1`
  - `Util::saveToClipboard` 入口注入 `action=copy`。
  - `Util::saveToFile` 成功分支注入 `action=save`，并跳过取字通道自身的 `selection.png`。
  - 取字分支由 `saveToFile + capture()` 改为直接 `captureImage(..., L"ocr")`。

复制、保存、图钉、长截图都收敛到这两个 Util 函数，因此一处注入即覆盖全部完成路径。

## 宿主改动

- `capture.ts`：`capture.json` 的 `action` 放宽为 `copy | save | ocr`；所有动作都读图并 `onResult(image, action)`；只有 `ocr` 才转交 OCR 插件；非取字动作返回 `{ status: <action> }`。
- `capture-history.ts`（新增）：`<dataDir>/history/index.json` + `history/images/<id>.png`，新→旧排序，超出上限先删最旧图片再写索引；索引损坏时视为空表而不是抛错，避免阻断截图本身；`add` 失败只记录日志，不影响截图结果。
- `workspace-commands.ts`：新增 `screenshot_action`（`list / copy / save / ocr / remove / clear`），仅宿主工作区可用；`copy` 用 Electron 45 的 `ClipboardItem` + `Blob` 写入（该版本已无 `clipboard.writeImage`）。
- `official-runtimes.ts`：截图插件绑定 renderer（旧包缺 renderer 时降级，截图本身仍可用）；`history` 命令打开 `screenshot-history` 工作区。
- 入口调整：`pluginEntryCommands` 中截图改为 `history`、删除 OCR 条目；新增 `pluginActionCommands`（截图的 `capture`/`ocr`）让动作留在纵向操作列表。
- `build-official-plugins.mjs`：截图插件加入 `rendererPlugins`。
- 前端：新增 `ScreenshotHistoryWorkspace.tsx`（列表 / 复制 / 保存 / 取字 / 删除 / 清空）。

## 验证

- `pnpm typecheck`、`pnpm lint`（0 error）、`pnpm test`（59 文件 / 248 用例）、`pnpm test:ui`（9 文件 / 15 用例）通过；本次新增 `capture-history.test.ts`（6 用例）与 `capture.test.ts` 的 copy 不转 OCR 用例。
- 新 exe：1280000 字节，SHA-256 `ded536446d168b2626197f87d122bc76905b5b0e79538f253ddbf883f8d8d2e2`；二进制内已含 `copy` / `save` 动作字面量。
- 插件包 `screenshot-0.1.3.tgz` 已重建，`dist-plugins/index.json` 的版本与 integrity 一致，`resources.json` 记录新 exe 哈希。
- 格式：本次改动文件通过 `oxfmt --check`（仓库另有 15 个文件存在历史格式偏差，未在本次范围内处理）。

## 未验证边界

- 真实截图界面的复制 / 保存 / 图钉 / 长截图是否都产生历史行，需要在装配了 0.1.3 包的环境人工确认。
- 已安装 0.1.2 的旧包只发 `action=ocr`，需要更新到 0.1.3 才有历史；旧包下截图本身仍可用，历史入口会提示插件不可用。
- 历史图片在窗口内按原图加载（懒加载），50 条上限下的滚动与内存表现未做压力测试。
