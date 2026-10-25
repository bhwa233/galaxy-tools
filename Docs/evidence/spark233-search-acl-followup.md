# spark233 搜索：当前生产字节的实际 ACL 撤权补证

日期：2026-10-25；分支：`codex/spark233-refactor`。本轮补齐 P5.8/P5.10 中「真实 Windows ACL 变化后，已返回正文结果不可继续使用」的一个代表场景，复用现有 `scripts/native-search/production-smoke.cjs`。没有新增测试文件、依赖或原生适配；正式 adapter 与 adaptation 7 native 保持原字节。

最终报告：`local-build/evidence/search-production/4428a93a-721e-44b0-a868-e9701daae49f/report.json`，**24/24 检查通过、`ok: true`、`serviceInstallationExecuted: false`**。同目录 `current-source-native-binding.json` 记录当前源码、隔离编译 adapter、源包和实际 staging payload 的大小及 SHA-256；`processes-after.json` 为 `[]`。

## 实际撤权与恢复

所有样本、索引、插件安装、Electron/profile、native profile 与证据都在上述全新 `local-build/` run 内。唯一 ACL 变更对象是该 run 新建的 `files/acl-revocation/revocable.md`，未修改其父目录或其他路径。

1. 正式 PluginManager 从本地 `.tgz` staging 安装并启用搜索插件，通过正式 Search/Instant 查询该文件正文，取得真实 opaque selection。
2. PowerShell `Get-Acl` 保存该文件原始 Access SDDL，然后为当前 Windows SID 添加显式 `ReadData` DENY。保留元数据和 WRITE_DAC 权限以便恢复；没有改变 owner、继承规则、服务或全局权限。
3. 同一 Electron 调用者独立执行 `fs.readFileSync`，得到 **`EPERM`**。这证明操作系统确实拒绝正文读取，不是仅改变应用配置中的目录范围。
4. 使用撤权前返回的 selection 请求 preview 与 open，未得到 `searchPreview`，也没有调用记录型 open 回调。随后新发起的正式 Instant 查询不再返回该文件。
5. `finally` 用保存的 Access SDDL 恢复该文件。恢复后的 SDDL 与原始快照逐字相等，正文也重新可读且与初始字节相同；报告 `acl.restored: true`。

新增四项报告检查为 `actualAclRevocationDeniesCurrentCallerRead`、`aclRevocationRejectsReturnedContentPreviewAndOpen`、`instantDoesNotReturnAclRevokedContent`、`aclFixtureOriginalPermissionsRestored`。原有 20 项实际生产接入检查继续通过，包括文件身份/版本拒绝、私有根排除、取消/分页、停用清理和 Windows 1060。

初次执行只因探针把访问拒绝限定为 `EACCES` 而停止；实际 Windows/Electron 返回的是 `EPERM`，该次 `finally` 同样恢复成功。探针现接受 Node 的这两种访问拒绝错误码，最终报告完整通过。没有发现需要修改产品代码的缺陷。

## 复现与验证范围

使用项目选择的 Node **26.12.1** / npm **12.2.1**、Electron **45.0.0**：

```powershell
. ./scripts/use-toolchain.ps1
& ./node_modules/.bin/tsc.cmd -p electron/tsconfig.json --outDir local-build/spark233/search-acl/compiled
& ./node_modules/.bin/oxlint.cmd scripts/native-search/production-smoke.cjs
$env:SPARK233_SEARCH_COMPILED_ROOT = Join-Path (Get-Location) 'local-build/spark233/search-acl/compiled'
& ./node_modules/.bin/electron.cmd scripts/native-search/production-smoke.cjs
```

上述 Electron 编译、聚焦 lint 和完整生产 smoke 均通过。执行日志为 `local-build/spark233/search-acl/production-smoke.log`。本轮只改探针和本文档，没有运行完整仓库 typecheck/test/build、重新原生构建、七包生成或 Windows 打包；统一集成 gate 由主任务在各并行修改完成后执行。

本报告证明当前用户态生产 adapter/Instant 的受控文件撤权行为，不能扩展为 SYSTEM 服务、另一个普通账号的命名管道可见性、目录继承 ACL 变化或真实整卷索引已验收。UAC、SYSTEM 安装/升级/卸载、全卷 MFT/USN、损坏索引、离线/云占位、卷离线和 UI 验收等既有边界仍需分别完成。

## 当前精确字节

| 输入或 payload                               | SHA-256                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `scripts/native-search/production-smoke.cjs` | `a210b0e9c5c3a51a8c1cd13dde98fe39a0c924c5587318934ea1b26af2695f39` |
| `electron/plugins/official/search.ts`        | `b8d40312f29e2c52e0052b9f38f9bdaa73eb060cacd25c42ecc6b715431ba461` |
| `native/search/search.cpp`                   | `cfc1addd7af28d9a711f2d3286f5bfcc8603683269f9679fac620df8ac4866f0` |
| `scripts/native-search/build.ps1`            | `641b39c13f2a4b9dff17cad6097f8aeda88247cbec17d85980c3fb7b4445f330` |
| `spark233.Search.exe`                        | `80299ce859bb3b3500f287cbf4718809fc8631ae92ff2a16717b103ce73dd521` |
| `spark233.Index.exe`                         | `32ca4bd14e1633264b19386b9d317494866bf6c00e57759d3763310042fdf614` |
| `spark233.Document.exe`                      | `8b6a52713bb9aa9e8bac044be100e40804e9399db207d4e1fbc51e3dd51c1606` |
| `pdfium.dll`                                 | `04100c03e41cac1f979e36e5e26fb860bcb5a7461f53830d3c098716624a27a9` |

native 与 S20/a9a8a308 的 adaptation 7 完全相同；实际 staging 的 Search/Index 散列与源包相同。隔离编译 adapter JS 的 SHA-256 为 `ef28de9a8725447265a2cc701fea878c03154b6f3a5ebc502306928c2af5e68d`。本文不改写其他历史报告或把历史证据当作新验收。
