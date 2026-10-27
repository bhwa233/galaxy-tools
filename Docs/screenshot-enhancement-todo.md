# spark233 截图能力补强 TODO

日期：2026-10-27。范围：截图历史、GIF 编码回补、部分选字增强。

配套 [一期实施 TODO](launcher-todo.md)。新增项从 P4.19 连续编号；**部分选字已有 P4.7 / P4.9 / P4.14 覆盖，不重复建号**，本文件只补其实现定位与具体缺口。行号基于 `codex/spark233-refactor` 当前工作区，改动后需重新核对。

---

## 0. 结论摘要

| 项              | 编号                | 性质          | 实际状态                                                                              |
| --------------- | ------------------- | ------------- | ------------------------------------------------------------------------------------- |
| 截图历史        | P4.19               | **❌ 不做**   | 已被剪贴板插件完整覆盖；降级为"截图→剪贴板→图库"链路验证                              |
| GIF 换回 gifski | P4.20               | 回补 upstream | **不是配置降级**：gifski 实现被整段删除，且 gifski 是 Rust 库，回补需引入 Rust 构建树 |
| 部分选字        | P4.7 / P4.9 / P4.14 | 增强 + 验收   | **功能已实现**（前端行级选字），缺字符级拖选、Ctrl+A、跨行、缩放映射                  |

建议顺序：**部分选字增强 → P4.19 链路验证 → P4.20**。

---

## 1. P4.19 截图历史 —— 结论：不做

核心判断：截图"回看/找图"的需求已被剪贴板插件覆盖，且覆盖得比独立实现更彻底。不做第二套存储。

### 1.1 覆盖证据

| 能力             | 代码位置                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| 图片格式识别     | `electron/plugins/official/clipboard-history.ts:154-157` 识别 `PNG` / `CF_DIB`(8) / `CF_DIBV5`(17)         |
| 图片落盘         | `clipboard-history.ts:218-241` `imageFile()` 处理 PNG 直存与 DIB→BMP                                       |
| 类型筛选         | `src/features/clipboard/ClipboardWorkspace.tsx:66-71` `kinds` 含 `{ id: "image", label: "图片" }`          |
| 图库分组         | 同上 `:347`、`:463`                                                                                        |
| 图片预览         | 同上 `:663-665` `imageDataUrl`                                                                             |
| 图片动作         | 同上 `:758-772` 复制为图片文件 / 粘贴                                                                      |
| **图片直连 OCR** | 同上 `:47` `imageOcrAvailable`                                                                             |
| 保留策略         | `clipboard-history.ts:38/48` `retentionDays` 默认 `null`（不限天数）；`:638-639` 收藏项不受 age/count 限制 |

即：框选 → `Ctrl+C` → 剪贴板记录 → 图库按"图片"筛选、预览、复制、直连 OCR。

### 1.2 截图侧真实行为（重要前提）

"截图自动进剪贴板"严格说不成立，实际是**用户主动复制才进**：

- `electron/plugins/official/capture.ts` **全程不调用 clipboard API**。
- 复制由 ScreenCapture 原生承担：`Ctrl+C` 或**双击**才写剪贴板；点保存或关闭则不写。
- 基础截图不产生 `capture.json`（`capture.ts:369-370`，只有 `action: "ocr"` 才写），**宿主对基础截图完全无感知**。

正确分工是：**截图负责产出，剪贴板负责留存**，宿主不插手。

### 1.3 原方案为何多余（代码事实，留作证据）

| 环节     | 位置                         | 事实                                                                           |
| -------- | ---------------------------- | ------------------------------------------------------------------------------ |
| 结果构造 | `capture.ts:377-389`         | `CaptureImage` 无创建时间、无截图来源                                          |
| 落盘     | `capture.ts:375-376`         | 只写裸 PNG 到 `dataDir/images/<sessionId>.png`                                 |
| 宿主接收 | `electron/main.ts:1180-1186` | 只写内存 Map + `emit("screenshot-result")`                                     |
| 内存缓存 | `electron/main.ts:352`       | `pluginImages: Map`，进程内                                                    |
| 生命周期 | `electron/main.ts:1165-1171` | 插件 dispose 即清空                                                            |
| 事件消费 | 全仓                         | `screenshot-result` 仅 `main.ts:1182` 一处 emit，**`src/` 无监听者 —— 死事件** |
| 视图路由 | `windowRoutes.ts:1`          | `AppView` 仅 6 项，无历史视图                                                  |

原结论"落盘后与宿主脱钩"仍成立，但这是**有意分工而非缺陷**。

### 1.4 本项实际该做的事（验收）

- [ ] 框选 → `Ctrl+C` → 剪贴板历史出现该图，`kind = image`
- [ ] **确认 ScreenCapture 写入剪贴板的格式在识别范围内**——`clipboard-history.ts:154-157` 只认 `PNG`/`CF_DIB`(8)/`CF_DIBV5`(17)，**不认 `CF_BITMAP`**(2)。若它只写 `CF_BITMAP`，剪贴板会漏记截图。**这是本项最需要实测的一点。**
- [ ] 图库按"图片"筛选能定位该截图
- [ ] 剪贴板图片 → 直连 OCR 可用
- [ ] 双击缩略图复制为图片文件并粘贴到其他程序
- [ ] 框选后点保存、不按 `Ctrl+C` → 无记录（确认为预期行为）
- [ ] 清理死事件 `emit("screenshot-result")`（`main.ts:1182`）

### 1.5 重启条件

只有出现下列需求时才重新评估，且必须**扩展剪贴板既有表**（加 `source` 之类来源标记），不新建第二套存储：需要记录"没复制但确实截过"的图；需要区域/窗口/全屏来源元数据；需要截图历史与剪贴板清理策略解耦。

---

## 2. P4.20 GIF 编码回补（gifski）

### 2.1 现状：不是降级，是整段删除

`scripts/native-capture/adapt.ps1:62-71` 四步删除：

```powershell
62  # Recording is outside the MVP. Reuse the upstream's already-vendored cgif encoder
63  # instead of adding its author's unrelated Rust/gifski build tree.
65  Edit-Exact $gif '#include "gifski.h"' '// spark233: upstream cgif implementation below is sufficient for the MVP build.'
67  $begin = $gifText.IndexOf('    inline void createGif(GifParam* param)')
68  $end   = $gifText.IndexOf('    inline void createGif2(GifParam* param)', $begin)
70  [IO.File]::WriteAllText($gif, ...)   # 删除 createGif 整段函数体
71  Edit-Exact 'Win/CapVideo.cpp' 'VideoGif::createGif(...)' 'VideoGif::createGif2(...)'
```

①注释 `gifski.h` ②删除 `createGif()`（gifski 路径）函数体 ③调用点改指 `createGif2()`（cgif 路径）。

`sources.lock.json` 的 sources 只有 ScreenCapture / ImageReader / Ling / TinyOCR + opencv / onnxruntime / vcRuntime，**无 gifski、无 Rust 工具链**。回补需恢复被删函数体 + 重新引入 gifski 的 Rust 静态库构建。

### 2.2 三个候选

| 方案          | 做法                                                                                                                   | 成本                                            | 风险                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| A 恢复 gifski | 引入 Rust 工具链 + cargo 构建 gifski 静态库；恢复 `createGif` 与 include；`sources.lock.json` 增源与哈希；重算工具链锁 | **高**：新增 Rust 构建树、CI 时长上升、版本 pin | Rust 版本约束、构建可重复性、`THIRD_PARTY_NOTICES` 补充 |
| B 优化 cgif   | 调 cgif 参数（调色板量化、dithering、帧延迟）                                                                          | **低**：只改 `VideoGif.hpp` 的 `createGif2`     | 提升有限，追不平 gifski                                 |
| C 换输出格式  | 录屏主输出改 MP4 / 动图 WebP / APNG，GIF 仅作兼容                                                                      | **低–中**：需确认 `CapVideo` 输出链路           | 用户预期（GIF 可直接贴 IM）可能受损                     |

### 2.3 建议

**先做 B，同时评估 C 的 MP4 路径；A 只在确实需要高质量 GIF 且团队接受 Rust 工具链时才做。**

理由：`launcher-architecture.md` 明确把录屏/GIF 排除在一期必需之外，当前保留纯属 upstream 自带。为非一期功能引入第二条原生构建链不划算。**若决定不做 A，应把 `adapt.ps1:62-63` 的注释从"MVP 权宜"改为"明确不做"**，避免下次又被当成遗忘项。

### 2.4 验收

- [ ] 走 A：记录 `dist-plugins` 中 `ScreenCapture.exe` 体积变化；同段录屏与上游 2.5.15 官方版做体积/画质对比；`sources.lock.json` 可重放
- [ ] 走 B：记录参数调整前后体积与画质对比
- [ ] **不论哪个方案：录屏功能本身需要独立验收**（`launcher-todo.md` 中无任何录屏验收条目，属完全未验收路径）
- [ ] `THIRD_PARTY_NOTICES.md` 与 `legal/` 同步（走 A 需加 gifski 许可）

---

## 3. 部分选字（P4.7 / P4.9 / P4.14，不新建编号）

### 3.1 现状：功能已实现

`src/features/ocr/OcrWorkspace.tsx` 已有行级选字：

| 能力              | 位置       | 实现                                                                                                           |
| ----------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| 行选择状态        | `:43`      | `const [selected, setSelected] = useState<Set<number>>(new Set())`                                             |
| 点击 / Shift 扩展 | `:77`      | `selectLine(index, extend)`                                                                                    |
| 图上选区渲染      | `:216-245` | SVG `<polygon>` 用 `line.box` 覆盖原图，`fillOpacity` 0.25 / 0.04 区分选中态，支持点击与键盘（`aria-pressed`） |
| 文本区间取值      | `:122-123` | 优先 textarea 原生选区，否则回退整段                                                                           |
| 复制动作          | `:172`     | `t("ocr.copy")` 复制所选文字                                                                                   |
| 行→文本偏移       | `:48-51`   | `indexOf(line.text, cursor)` 建区间                                                                            |

原生侧：`adapt.ps1:78-86` 使 `--spark233-batch=true` 时 ImageReader 的 `WindowMain` **不 `show()` 且立即 `quit()`**，结果经 `SessionResult` 写入 `ocr.json`。

**架构结论**：原生 ImgViewer 选字 UI 被**有意绕过**，改由宿主前端承担（避免两套 UI 争焦点），因此 upstream 的选字能力不能直接复用。

### 3.2 真实缺口

| 缺口                        | 说明                                                               |
| --------------------------- | ------------------------------------------------------------------ |
| 1. 只有行级粒度             | `selected` 是 `Set<number>` 行索引，无法选中"某行中间几个字"       |
| 2. 无拖拽框选               | 只能点击行 + Shift 追加，不能拉框                                  |
| 3. Ctrl+A 仅作用于 textarea | `:160` `editor.current?.select()` 只全选文本框，图上选区无全选语义 |
| 4. 无跨行连续选择           | Shift 只能逐行增删                                                 |
| 5. 缩放映射未验证           | `:216` 注释称用图像像素 + viewBox 对齐，设计正确但无实测           |

### 3.3 改动清单

| 文件                                         | 改动                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/features/ocr/OcrWorkspace.tsx`          | `selected: Set<number>` → 文本区间模型（`{start,end}` 或 行索引+字符 offset）；加拖选、Ctrl+A、跨行连续 |
| 同上                                         | SVG 层加 `pointerdown/move/up`，与 `line.box` 做相交判定                                                |
| `electron/plugins/official/capture.ts:64-74` | `OcrResult.lines` 为 `{text, score, box}`，**已足够**，无需改动                                         |

### 3.4 文档债务：P4.9 描述已过时

P4.9 原文"保留 **ImageReader 原图与文字区双向选择**"基于"用 ImageReader 自己的 UI"，而当前实现是**绕过 ImgViewer、由宿主前端做选字**。需改写 P4.9 为"宿主前端的图文双向选区"后再验收，否则会按错的范式验。

### 3.5 验收（对应 P4.9 / P4.14）

- [ ] 单行**部分**选字（非整行）→ 复制结果只含所选字符
- [ ] 跨行拖选 → 复制结果为连续文本
- [ ] Ctrl+A 全选 → Ctrl+C
- [ ] 100% / 150% / 200% 缩放下 box 命中准确
- [ ] 多显示器跨屏坐标不错位（与 P4.17 合并验收）

---

## 4. 顺带发现（未列入待办）

1. `emit("screenshot-result")` 是死事件，可随 P4.19 接管或直接删除。
2. `launcher-architecture.md` 声明"长截图、录屏、GIF、贴图不作为一期必需"，但 `adapt.ps1` 未移除任何对应按钮（`btnIds` 中 pin/long/video/qr 全部保留）。实际是"**有功能但未验收、未进产品定位**"，建议明确标为"实验性/未验收"。
3. 录屏（`--enter=video`）在整个 TODO 清单中无任何验收条目，属完全空白路径。
