# spark233 剪贴板平台前置核查记录

日期：2026-10-24（Asia/Hong_Kong）。分支：`codex/spark233-refactor`。

已核对并在一次隔离运行中实际调用 `@crosscopy/clipboard` 的 Windows 原生 addon，确认它可以读取同一次复制中的文本、HTML、RTF 和文件引用，可以监听变化并停止，也可以读取 Windows 敏感标记。**库的单格式 setter 会替换其他格式，没有原子回放整次多格式快照的公开 API。** 因此不能仅用多个 setter 连续调用来实现已确定的 QcClip 保真规则。

当前工程约束是 **MVP 减少测试与设施，优先实现可用业务链路**。以下一次性隔离实验已经完成并退出，不作为后续每次必跑步骤；保留已工作的源码、实际证据与缺口，不继续扩展独立 logon / 权限验证设施。默认 smoke 入口不会创建 logon session 或凭据，遇到既有 station 时直接拒绝；`fresh` 原生入口仅保留为此次非产品实验的源码记录。

## 包与来源

实时查询 npm registry 的稳定 `latest` 为 `0.3.6`，发布时间为 `2026-02-09T08:03:24.583Z`。固定 gitHead 为 `88e338a051e90966164aae3140ba71dc8de014b4`。

| 产物                                  | 固定版本与完整性                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@crosscopy/clipboard`                | `0.3.6`；`sha512-h/LlfI5t/xsxLr63g3Os0mjoeITj7/8x8Goy5PZ+f4bk3DDgc1r5VXO462U3e8/+LjHixtvS9sTk/MoKEwSutw==` |
| `@crosscopy/clipboard-win32-x64-msvc` | `0.3.6`；`sha512-GZ0i9XoPYQV5DhTQWiHjArE3ZTuovHmHNL7yE6Pm/91icOtrm9Mk9tVnpU/rQR9bzOn3MqN8+AFsp5NKZqTg7Q==` |

来源：<https://github.com/CrossCopy/clipboard>。包声明 MIT；Windows `.node` 文件为 1,676,800 字节。此次使用已发布 N-API 二进制，没有修改该 addon、引入 FFI 库或编译 Rust 依赖。

仅在 `local-build/spark233/native-clipboard/` 下通过 `npm install --prefix ... --ignore-scripts --no-audit --no-fund --save-exact @crosscopy/clipboard@0.3.6` 安装；根 `package.json`、lockfile 和根 node_modules 未修改。npm SRI、原始 registry 元数据、隔离 lockfile、固定提交的 `src/lib.rs` / `Cargo.toml` 均保留在该目录。

官方类型文件与 Context7 文档相符，提供 `availableFormats`、`getBuffer` / `setBuffer`、文本 / HTML / RTF / 图片 / 文件 getter 和 setter，以及 `startWatch` 返回的 `stop` / `isRunning`。没有整次原始快照、单次多格式提交或原子 compare-and-capture API。

## 隔离原则、实际限制与一次性实验

没有读取、备份、覆盖或尝试恢复交互用户的真实剪贴板。原生探针在任何 `OpenClipboard` 之前核对实际 window station，要求与隔离启动器给出的 station 完全一致，并无条件拒绝 `WinSta0`；Node 在导入 clipboard addon 前先完成该原生核对。父进程保持 station / desktop 句柄直到子进程退出，以 Job 限制后代生命周期。

普通用户的隔离创建出现两个实际平台限制：

1. 显式命名 `CreateWindowStation` 返回错误 5。微软文档说明，仅 Administrators 可以指定 station 名称；当前是未提升的 medium token。
2. 采用系统分配名称的 `CreateWindowStation(NULL, CWF_CREATE_ONLY, ...)` 返回错误 183，表示当前 logon 对应的非交互 station 已经存在。探针拒绝加入已有对象，避免误用共享剪贴板。

为确定平台合同，曾完成一次 `LOGON_NETCREDENTIALS_ONLY` 临时 LSA logon LUID 实验，随后用系统生成名称和 `CWF_CREATE_ONLY` 创建独占 station / desktop。该 API 使用同一实际本地身份及虚构的测试字符串，不验证网络凭据；实验没有发起网络登录、创建账户、加载新 profile、修改交互 desktop ACL 或保存真实凭据。它只用于取得此次独立 station，**不作为产品功能，也不列为后续默认验证前置条件**。

实际 station 为 `Service-0x0-68c87bcc$`，desktop 为 `probe`。父启动器 PID `53852`、临时会话包装 PID `14900`、隔离 Node PID `48252` 均已终态退出。最终 launcher 报告 exit 0，`remainingProcesses: []`。后续不再运行新凭据 / logon 实验，按 MVP 约束推进业务所需的最小验证。

参考文档：

- [CreateWindowStationW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createwindowstationw)
- [CreateProcessWithLogonW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw)
- [Window stations](https://learn.microsoft.com/en-us/windows/win32/winstation/window-stations)

## 实际运行证据

完整报告：`local-build/spark233/native-clipboard/runs/20261024-185425-824/report.json`。

启动、退出与无残留记录：同目录 `launcher-report.json`；原生会话 stdout / stderr 也保留在该目录。

环境为 Node `v26.12.1`、Windows x64，原生薄桥使用共享 MSVC `19.51.36260`、Windows SDK 28000、CMake `4.4.4` 和 Ninja `1.13.2`。它是小范围技术原型，没有加入 Vitest 用例或测试框架。

另做了一次不调用剪贴板 API 的 Electron 二进制兼容检查：以本仓 `electron.exe` 的 `ELECTRON_RUN_AS_NODE=1` 模式导入同一 Windows `.node` addon，实际结果为 Electron `45.0.0`、内嵌 Node `24.22.0`、N-API `10`、x64，`moduleLoaded=true`。证据位于 `local-build/spark233/native-clipboard/electron-addon-load.json`；该检查只加载导出，不创建 ClipboardContext、不监听、不读写任何剪贴板，也没有创建新 logon / station。它证明二进制能在目标 Electron 运行时加载，不能扩大成 Electron 中的功能链路已经验收。

| 实际调用           | 观察结果                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同次混合内容       | 原生一次写入 `CF_UNICODETEXT`、`HTML Format`、`Rich Text Format`、`CF_HDROP`；addon 实际分别读出中文文本、HTML、RTF 和创建的本地文件路径                                               |
| 监听               | `startWatch` 收到真实剪贴板变化通知；首次混合写入后观察到 1 次通知                                                                                                                     |
| 自定义格式原始读取 | `getBuffer('HTML Format')` 返回 192 字节；`getBuffer('Rich Text Format')` 返回 33 字节                                                                                                 |
| 单 setter 语义     | 连续 `setText`、`setHtml`、`setRtf` 后，实际格式只剩 `Rich Text Format`，`hasText=false`、`hasHtml=false`、`hasRtf=true`                                                               |
| 文件 setter        | `setFiles` / `getFiles` 返回相同创建路径，语义为引用，没有备份文件内容                                                                                                                 |
| 最小原始回放适配   | 白名单四格式快照、覆盖、一次恢复、再次快照，623 字节的快照文件逐字节相同；实际文本和文件路径再次读取也相同                                                                             |
| 敏感标记           | addon 实际枚举到 `ExcludeClipboardContentFromMonitorProcessing`，并通过 `getBuffer` 读到 `CanIncludeInClipboardHistory` 小端 DWORD 0；原生快照拒绝捕获，退出状态为 3，未保存该敏感快照 |
| 停止监听           | `stop()` 后 `isRunning=false`；一次后续写入未产生新通知，随后 Node 正常退出                                                                                                            |
| 生命周期           | 父包装正常观察到 Node exit 0，关闭 Job / desktop / station；最终报告无匹配残留进程                                                                                                     |

原始回放快照 SHA-256：`91d32012bbe7812ee567f0d5b9d721a1cc63c37afc49266b5b94e7dd68a68952`。数据均来自本次隔离创建的样本，不含用户历史。

当前白名单桥源文件在 `10:54:20 UTC` 保存，运行所用 exe 在 `10:54:24 UTC` 构建；之后未修改该原生源文件。收口检查重新调用 CMake 构建得到 `ninja: no work to do`，原始 / 恢复快照哈希仍相同。源文件 SHA-256 为 `978DE334B9241B834B0A0FEFA7C5970D67F47C33DB9051B8AC88E3B029E6CA40`，exe 为 `D14865CCEC3EB496D1DE12C1C159258F27EEAD18223A9D62D4DB847435DFF79F`，记录于 `local-build/spark233/native-clipboard/artifact-manifest.json`。报告中的四格式原始读取 / 恢复对应当前原生桥代码；收口仅调整默认脚本不再启动临时 logon，未改白名单或回放实现。

## 平台合同结论与最小适配方向

当前所选库适合基础格式读取、原始注册格式读取和变化通知；它没有自动应用 QcClip 敏感内容规则。监听回调到达后，业务捕获入口必须先检查敏感标记，再读取或保存内容，不能仅在 UI 隐藏该历史项。

连续单格式 setter 会清空其他格式，已被真实调用证实。正式保真回放应使用一次 `OpenClipboard` / `EmptyClipboard` / 多个 `SetClipboardData` 的原生事务，并对同一次读取持有一致的剪贴板打开范围。当前 [Win32 原型](../../native/clipboard/boundary.cpp) 已演示这一最小能力；它只处理明确白名单的 HGLOBAL 字节，不复制任意 GDI / OLE 对象，不等于已交付完整平台服务。

原型白名单为 Unicode 文本、HTML、RTF、文件引用及可选 DIB / DIBV5 / PNG。此次只实际验证前四项；未以已存在代码推断图片分支通过。文件历史按 QcClip 保存引用，原文件消失后的行为仍须由后续业务层标明不可回贴。

正式实现还需对接插件归属、原始格式与预览分离、应用来源/排除、自写入标记和内容去重，并在生产桥接里处理失败恢复、容量限制和任务生命周期。高层 `getHtml` 返回了完整 HTML 文档，`getRtf` 保留尾部 NUL；预览处理不得破坏保存的原始字节。

## 尚未证明、当前不继续扩展的事项

- 实际前台应用的焦点恢复、键盘回贴、Windows 快捷键和真实应用文件粘贴，私有非交互 desktop 不能证明这些交互行为。
- 图片格式、文件移动/删除、多来源 OLE 延迟渲染、锁竞争等未做矩阵。MVP 阶段不因这些未测分支新建全面用例集。
- Electron 45 / 内嵌 Node 24 已实际导入 addon，但 ASAR 打包位置、Electron 中的剪贴板调用、插件停用/更新与 watcher 生命周期尚未接线；完整剪贴板操作此次仍在 Node 26 隔离进程内完成。
- 原型快照回放在一次 clipboard 打开范围内完成，但尚无 SetClipboardData 中途失败后的回滚设计；不能作为生产数据安全保证。
- 原生原型存在 station ASCII 输出转换的 C4244 编译提示；它未阻止本次构建和运行，但仍是正式接入前待清理的问题。当前优先保留最短平台合同和业务接入，不扩大隔离设施。

按当前 MVP 清单，P1V.4 的前置合同是受控样本证明原始多格式、文件引用恢复、敏感标记，并记录 QcClip 实现缺口；回贴焦点明确随 P6 真实界面接入验证。上述证据已满足这一收窄后的前置技术合同，可供主线程勾选 P1V.4。保持 QcClip 既定规则和功能范围，Electron 正式调用、焦点回贴与完整业务依然是 P6 后续工作。
