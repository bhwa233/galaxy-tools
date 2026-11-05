# UPXS 元数据布局兼容修复

2026-11-05。修复此前 14 个商店样本中 7 个在 UPXS 提取阶段被拒绝的问题。生产改动限于 `utools-package.ts`，继续复用现有解密库、归档校验和安装事务，没有新增依赖。

## 行为与校验

支持以下两种已经验证的离线元数据布局：

- 基础布局：`key/iv/timestamp`，允许显式的 `serverDecrypt: false`，拒绝未识别字段。
- 扩展布局：另含 `pluginId/encrypt2`；两项必须同时完整提供，并验证其绑定的插件 ID、时间戳和实际清单身份。

扩展字段只存在一项或值无效时拒绝，不回退到基础布局。需要服务端解密的包、认证数据损坏、未知布局仍拒绝。两种布局都使用同一有界解压及 ASAR 校验流程；商店候选继续绑定实际清单名称、实际上游版本及原包 SHA-512 SRI。

## 真实原包回测

通过生产安装器和真实 Electron `DesktopPluginHost` 验证。每个样本均完成：本地 `.upxs` 安装 → 官方目录下载检查 → 同代码来源绑定 → 完整宿主重启后恢复来源及版本；另外使用空安装状态的独立宿主，直接从官方目录准备并确认商店安装。

| 原包                                                                                            | 目录 ID      | 实际版本 | 本地安装 | 来源绑定及重启恢复 | 空状态商店安装 |
| ----------------------------------------------------------------------------------------------- | ------------ | -------- | -------- | ------------------ | -------------- |
| [JSON 编辑器](https://res.u-tools.cn/plugins/7lpnpo28z0ttxzoeuvzwgcwwscnm1pxw.upxs)             | `jsoneditor` | 1.7.1    | 通过     | 通过               | 通过           |
| [编码小助手](https://res.u-tools.cn/plugins/2mffwfhjdqtsvkjyjreasfn30kc7ptn6.upxs)              | `codehelper` | 2.1.1    | 通过     | 通过               | 通过           |
| [正则编辑器](https://res.u-tools.cn/plugins/pow7kpdg0giyobf6e627hov8ybjfvlao.upxs)              | `regex`      | 1.1.3    | 通过     | 通过               | 通过           |
| [简易计算器](https://res.u-tools.cn/plugins/buq5bwdfrcghbwnu8x8bjrmtwrmrsli6.upxs)              | `a4e6e47b`   | 1.1.3    | 通过     | 通过               | 通过           |
| [正则表达式测试工具](https://res.u-tools.cn/plugins/73c631678e6cee31086f04cf067d7b09.upxs)      | `a4a1ec40`   | 0.0.1    | 通过     | 通过               | 通过           |
| [计算器](https://res.u-tools.cn/plugins/qcjxd6sv63d7wm38pqurevuudjynzrbz.upxs)                  | `zlozslk3`   | 1.0.1    | 通过     | 通过               | 通过           |
| [加解密-编码工具 encoder](https://res.u-tools.cn/plugins/af6dd49cc128babb9e4499733f22f644.upxs) | `a7f1da14`   | 0.0.6    | 通过     | 通过               | 通过           |

最终报告：`local-build/utools-upxs-layout-20261105/e0fbdc8f-126a-414d-9ba9-d4b188b3a50c/report.json`。该目录保留原始 7 个 `.upxs`、原包 SHA-256、规范化安装版本、来源 SRI、来源绑定和全新商店安装结果。

驱动为 `local-build/utools-upxs-layout-live.mjs`，最终输出为 `local-build/utools-upxs-layout-live-complete.log`。此前一轮驱动错误地读取预览顶层 `pluginId`，导致断言失败；改为读取既有契约中的 `metadata.spark233.id` 后重新运行，旧报告保留。该问题没有修改生产契约。

安装信任由隔离驱动明确授予，用户数据与测试配置隔离。本轮未激活这 7 个插件的业务功能，因此结论限于安装和来源恢复，不新增运行 API 兼容通过记录。

后续已补充这 7 个样本的原页面、输入和进程重开测试，见 [运行兼容性回测](utools-runtime-compatibility-2026-11-05.md)。

## 回归与工程检查

- 扩展既有 `utools-compatibility.test.ts`，覆盖 UPX、两种 UPXS 布局的无执行导入，以及认证篡改、部分身份字段、服务端解密、未知布局、扩展身份与清单不符、基础布局的商店身份／版本不符。身份／版本不符时没有发布版本目录。
- 修复前，新增基础布局导入回归按预期失败，错误为「不支持此 UPXS 元数据或所需平台服务」；修复后该文件 4 项通过。日志：`local-build/utools-upxs-layout-{before,after}.log`。
- 全量 Node：84 个文件、352 项通过；类型检查、lint 和格式检查通过。日志：`local-build/utools-upxs-layout-{typecheck,lint,format-check,tests}.log`。
- Electron 后端单独编译通过，并使用该实际产物完成上述真实安装回测：`local-build/utools-upxs-layout-electron-build.log`。
- 完整 `pnpm build` 未通过。首次在原生文件搜索的 CMake 缓存中引用已不存在的便携 MSVC 路径。备份并重建生成缓存后，现有 VS 2022 / MSVC 19.43 被正确识别，随后原生搜索的 CMake 配置仍报 `Invalid character escape '\c'`，涉及 Windows 反斜杠源码路径。日志分别为 `local-build/utools-upxs-layout-build.log` 与 `utools-upxs-layout-build-refreshed.log`。本轮没有修改原生搜索构建源码，也未跳过原生校验来宣称完整构建通过。

本轮没有重新打 Windows 包，也没有重复无改动的浏览器回归；实际安装回测运行的是本次单独编译的生产 Electron 后端。
