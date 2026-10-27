# spark233 词典与翻译

独立 npm 插件 `@spark233/plugin-translation@0.1.1`，ID 为 `spark233.translation`。后台在独立 utilityProcess 中运行；网页工作区通过宿主受控桥调用，不导入 Node 或 Electron。

## 离线基础词库

来源固定为 [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT) 的提交 `ab22ad36302cafc6349a050e2b60894855208055`，使用基础 `ecdict.csv`，未下载 811 MiB 完整版。原 CSV 66,009,548 字节，SHA-256：

`d1ecbdf9ee2b920afb6f430ca6b6bb9f559588cf0dff86e04bd255f9390843cc`

根目录 `scripts/dictionary/source-lock.json` 固定源文件大小、散列和许可证；Python 标准库 `csv` / `sqlite3` 处理正式 CSV 与数据库，不手写 CSV 解析器、不安装构建依赖。默认从仓库根目录执行：

```powershell
python scripts/dictionary/build.py
```

默认源缓存为 `local-build/spark233/translation/source/`，输出为本包的 `data/ecdict.sqlite`；可通过 `--source-dir` 和 `--output` 显式指定。缺少源文件时从固定提交下载，已有缓存大小或 SHA 不符会拒绝构建。生成临时数据库后运行 SQLite integrity_check，再原子替换输出，同时写 `provenance.json` 和原样 `ECDICT-LICENSE.txt`。

实际生成 770,611 词条、136,400 词形映射、366,599 短语。保留单词、音标、中英文释义、词性、标签、词形和频率排序；不携带原 CSV、音频和空 detail 字段。单词与短语共享标准化前缀索引；词形/原型从 CSV 的 `exchange` 派生。另一个 `lemma.en.txt` 文件头限制研究/教育用途，因此不用于本构建和发布。

最终 SQLite 为 **102,096,896 字节（约 97.37 MiB）**，SHA-256：

`2c6d9783d2888e6bce35ba56f2a4422f9a647af871607a1af00847031a591d8a`

ECDICT 固定提交的根许可证为 MIT，Copyright (c) 2025 Linwei；原文随包保留在 `data/ECDICT-LICENSE.txt`。Node 后台用 `node:sqlite` 的只读 `DatabaseSync` 和参数绑定查询，禁止扩展加载，词典文件不写入用户数据。

## 后台与宿主合同

| 命令              | 参数 action                             | 行为                                          |
| ----------------- | --------------------------------------- | --------------------------------------------- |
| search            | search / query / limit                  | 本地查词、词形与短语；返回详情选择 ID，不联网 |
| detail（内部）    | detail / id                             | 只打开已查询登记的词条详情                    |
| translate         | translate / text / target? / requestId? | 显式发起模型翻译                              |
| configure（内部） | configure / endpoint / model / key?     | 原子保存单个配置，只返回 hasKey               |
| status（内部）    | config_status                           | 读取不含密钥的当前配置                        |
| cancel（内部）    | cancel / requestId                      | 中止此请求的 HTTP 流                          |

`search` 清单标记 `search: "word"`，允许宿主即时本地查询；AI 命令没有自动查询标记。根查询会话保存返回 item 的 parameters；renderer 执行通过 opaque 选择 ID 路由，不能自行注入内部动作。

`TranslationWorkspace` 的 props 为 `{ initialResult?: unknown, onClose: () => void }`，代码在仓库 `src/features/translation/`。工作区通过 `translation_action` 调用查询、详情、状态、翻译和取消，通过专用 `translation_configure` 保存配置。宿主检查来源窗口、插件启用状态和清单命令；通用动作桥不应开放 configure。

后台通过 `translation-chunk` 事件发送 `{ requestId, text: delta, done }`；宿主验证活动实例后转发同名事件。最终返回 `{ kind: "translation", requestId, text, target, translatedText, cached }`。取消后保留界面已有文本，工作区关闭时取消未完成任务。

## 显式 AI 翻译

兼容 `POST /chat/completions` 的单一服务配置，发送 `stream: true`；endpoint 可为 `/v1` 基址或完整 `/chat/completions`。只允许 HTTPS，或 loopback 的 HTTP 本机服务；禁止 URL 内凭据、query 参数和重定向，避免把认证头转送到其他地址。配置不代表执行翻译，输入与查词不请求网络。

默认方向由后台和工作区共享 `language.mjs`：含平假名、片假名或韩文时译为简体中文，避免含汉字的日语被错判为中文；其余含汉字内容译为英文，其他输入译为简体中文。显式目标优先。纯汉字短语和混合语言仍可能歧义，用户可手动改译，不声称是完整语言识别器，也不增加语言判断网络请求。流式解析支持 UTF-8 跨块、LF/CRLF、SSE 注释与 `[DONE]`，也兼容服务返回的非流式 JSON。输入上限 20,000 字符，输出上限 256,000 字符，单帧/响应缓冲上限 512,000 字符，请求超时 90 秒。显式取消和插件停用都会中止 HTTP 请求。

配置只保存在插件私有 `data/provider.json`，使用文件同步与原子替换；它是本地私有文件存储，未声称硬件加密。状态与查询结果不回传密钥。提供方错误只保留 HTTP 状态或固定错误文本，不回显原始错误响应、认证头或配置。工作区的密码输入保存后清空，留空保留旧密钥，可单独勾选清除。

翻译结果按 endpoint/model/目标/原文的 SHA-256 键缓存到插件私有目录，最多 64 条和 4 MiB；缓存不含密钥，不缓存取消、错误或不完整结果。配置更新清空缓存。本地词典仍能在缺少配置或配置损坏时工作。

协议依据：[Node 24 SQLite 官方文档](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)、[OpenAI Chat Completions 官方参考](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。Context7 因月度额度耗尽无法查询，本次读取了这些官方页面。

## 已执行验证

实际 Electron 45 / Node 24.22.0 / SQLite 3.53.4 utilityProcess 中：`hello` 精确词条、`went` → `go` 词形、`take off` 短语、完整释义均通过，期间本地 HTTP 服务收到 0 次请求；单次 hello 查询 1.31 ms，不作为跨机器性能承诺。

使用仅绑定 127.0.0.1 的假兼容 HTTP 端点证明跨 UTF-8 分块和 CRLF 的 SSE 输出“你好”，缓存命中不再请求，显式取消关闭正在传输的连接。端点故意把测试密钥放进 401 错误体，后台只返回 HTTP 状态，配置结果、词典结果、译文结果与事件均未携带密钥。停用后资源数为 0。

原始报告：`local-build/spark233/translation/runs/2026-10-24T13-24-06-404Z/report.json`。只验证本地假服务的兼容协议，未调用真实外部模型，也不声称模型质量或第三方服务兼容性已验收。前端工作区保持功能实现，本阶段未做截图或 UI 验证。上述历史验证没有新增运行依赖或 Vitest 套件。2026-10-27 的默认方向续修新增两个现有 Vitest 功能用例，连同生命周期补修统一为 45 文件/199 项测试、lint、含 typecheck 的 build 通过；输入与范围见[功能续修记录](../../../Docs/evidence/spark233-translation-lifecycle-functional-tests.md)，不改写旧报告。
