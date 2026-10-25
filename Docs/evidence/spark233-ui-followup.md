# Windows 无障碍续测与插件错误展示修复

日期：2026-10-25。分支：`codex/spark233-refactor`。用户自行启动隔离打包版后，明确要求直接用 Windows 无障碍测试，并在物理 Esc 停止后再次授权恢复。此次只操作启动器与插件管理，没有安装插件、确认 native 信任、启用剪贴板记录、操作系统服务或发布。

## 已观察的基线界面

运行输入是原 `87818-final-offline-catalog`，主进程 PID 27360、窗口 4918896，profile 为 `local-build/spark233/functional-integration/ui-1792913141284`。computer-use 实际操作和后续观察确认：

- 完成首次引导后，欢迎面板消失且命令列表仍可用。
- 通过无障碍组合框输入 `jietu`，得到“截图”“截图取字”等命令；按 Down 后选中项移至“截图取字”，未执行截图命令。
- 无障碍点击“插件”打开管理对话框；树中可读到七个官方离线目录条目、对应版本及“已安装”状态，已安装列表包含来源、更新源、能力与命令。
- npm 包名为空时“准备安装预览”禁用；关闭管理对话框后，启动器保留 `jietu` 查询及结果。

记录为该 profile 的 `windows-a11y-partial.json` 和 `windows-a11y-last.txt`。这些是局部实际操作证据，不是新增 Vitest 用例，也不证明安装确认、物理 IME、回贴、SYSTEM 服务或完整辅助技术验收。

截图工具的最后一次抓取出现目标不一致：无障碍树仍为 spark233，但图片包含前台 Codex。该图片没有保存为目标界面证据，没有依据它操作坐标或宣称修复效果；早先显示正确目标的截图仅用于当时的界面判断。后续原生截图验收必须先核对图片确实属于目标窗口。

## 发现与修复

不可连接代理下，自动更新的七条完整 FetchError 默认全部展开，挤满插件管理首屏，官方离线目录被压到下面。这是本次实际界面观察发现的缺陷。

修复限于 `PluginManagementDialog.tsx` 与中英文文案：保留 Alert，在首屏显示简短提示；原始错误放入默认折叠的原生 details，展开区域限高并可滚动。复用本页已有的 details/summary 模式，没有新依赖、UI 原语、通用助手或测试套件。具体错误不删除，失败仍明确呈现。

## 新产物及证据范围

输入标签为 `ui-error-details-followup`，与已完成 21 项代表链的原基线分别保留。原 `release-electron/` 未覆盖；构建完成时运行的 PID 27360 是旧版，后续已正常退出并切至下节修复版。

新目录入口：`local-build/spark233/ui-error-followup/release/win-unpacked/spark233.exe`。

新安装器：`local-build/spark233/ui-error-followup/release/spark233-1.2.0-x64.exe`，210,066,698 字节，SHA-256：

`514c1d671e97f82cb9e4894662f67ab64d6d513d500760c064872e1cbdd03175`

新 ASAR 为 36,606,545 字节，SHA-256 `24ffc934d2a8a01ab7166ef6e61638d13c5fb45007a6d8a2d4a16e8575ef1d0f`。目录文件总和 491,846,202 字节；七插件展开 152,814,813 字节；合计代码文件 644,661,015 字节，约 614.80 MiB。用户数据、缓存、索引、服务副本及回滚版本另计。

报告：`local-build/spark233/ui-error-followup/artifact-report.json`。项目 Node 26.12.1 / npm 12.2.1 已重新成功选用；没有重装或修改全局 Node，用户较早终端的选择失败原因没有确定。本轮 typecheck、lint、三文件格式检查、现有 32 文件/162 项测试、完整 build、独立目录包及 NSIS 构建通过。日志为该目录下 `build.log`、`test.log`、`pack.log`、`nsis.log`。

ASAR 的 dist 71 文件及 dist-electron 68 文件逐字节匹配本次编译输入；未包含测试源码或原生 EXE/DLL。复用既有分发检查器，对新目录中的七包执行真实有界解包、清单、目录名称绑定、SRI、成员散列及运行库/字体检查，报告为 `local-build/spark233/packaging/distribution-6Knqav/report.json`。解包得到的 14 个 native 文件与前次依赖审计散列全部相同，host matcher 与本次输入逐字节一致；不冒称对未改变字节重新执行了全部 dumpbin。

## 修复版 Windows 实际验收

用户明确要求由代理完成切换后，已先只读核对隔离 SQLite 的 paused=true、entries=2，再通过固定旧 exe 的 `--exit` 正常退出 PID 27360；没有强制结束进程。使用已有隔离配置，通过 Start-Process 的子进程 Environment 传入三项 SPARK233 路径/标志启动新 exe，PID 5104。此次没有创建新 profile、开启远程调试或设置网络代理，命令成功执行。前次组合命令被拒绝的具体规则仍不确定，不能推断为普遍禁止启动应用，也不再要求用户重复手动切换。

完成引导后的正常启动先驻留托盘，随后通过同一隔离路径的 `--show` 打开启动器。Windows 工具返回新路径窗口 2494736，CIM 确认主进程来自本次候选目录；全部交互继续使用 Windows 无障碍和原生键鼠。

实际点击管理页的“检查更新”后，公开 registry 返回尚未发布这些包的错误。与旧轮代理阻断不同，本次不宣称物理离线或代理离线。观察确认：默认只有简短提示和“查看详细信息”，七条详细错误没有直接展开；点击无障碍 disclosure 可展开完整原因，详情保持有限高度；在详情内部滚动能看到后面的截图/搜索/翻译错误，下方目录位置不变；按空格键可收起详情并显示焦点框；关闭对话框回到启动器。界面显示的七个官方目录条目保持可用。

报告为 `local-build/spark233/ui-error-followup/native-ui/report.json`，10 项局部检查通过，包含事后只读核对剪贴板仍 paused=true、entries=2。同目录保存了 `collapsed.png`、`expanded.png`、`details-scrolled.png`、`keyboard-collapsed.png` 及无障碍树；保存前均核对图片确实属于 spark233。主进程现仍为 5104，旧 PID 已退出，修复版留在启动器供用户查看。

这证明本次修改的宿主管理页运行效果。相同隔离 profile 仍保留原安装的插件版本，不宣称重新安装全部新归档或重新完成 21 项综合 smoke；旧基线成功不改绑到新字节。安装器仍未执行、未签名、未发布，截图遮罩/真实回贴/UAC/SYSTEM/全卷及其余人工要求继续保留。

## 可逆管理操作补充

同一实例中，通过 Windows 无障碍实际点击 OCR 的“停用”，后续截图及树确认“已停用”、识别命令禁用；只读状态文件确认 OCR enabled=false，截图、便签和剪贴板仍 enabled=true。随后点击“启用”恢复，界面显示“已启用”，命令重新可用，状态文件确认 enabled=true。

再点击 OCR 的“卸载”打开提醒对话框，确认默认保留数据、删除数据复选框未选中，并显示永久删除提示；仅点击“取消”。后续观察回到管理页，状态文件保留 OCR 条目、版本目录和数据目录，仍然启用。最后关闭管理页回到启动器，七插件全部启用，隔离 SQLite 的 paused=true、entries=2，未进行实际删除。

报告为 `local-build/spark233/ui-error-followup/native-ui/management-lifecycle.json`；同目录保存 `ocr-disabled.png`、`ocr-restored.png`、`uninstall-confirmation.png`、`uninstall-cancelled.png` 与代表无障碍树。最初一次无截图树观察后的点击因 geometry unavailable 未执行，刷新窗口与截图几何后成功；不将工具几何恢复当作产品缺陷。OCR 切换时没有正在推理的任务，不用它替代已有 worker 取消/退出证据；这也不证明实际安装确认、更新、卸载及原生截图内降级已经验收。

## 本地 Web 包选择、确认安装与保存重开

复用已有 `local-build/spark233/desktop-host/runs/2026-10-25T06-20-07-667Z/hello-web.tgz`，包为 `@spark233/example-hello-web@0.1.0`、插件 ID `hello-web`，SHA-256 `08f1e717817c9e84dbc85f24a0cd942151c379f9b05246f44702f0ed114ffe4d`。六个归档成员已逐字节核对当前 `examples/plugins/hello-web/` 源码；仅申请 storage，无原生或 Node 后台。

实际点击管理页“导入本地 .tgz”，在 Windows 原生文件选择器的“文件名”中输入完整路径并打开。原生树及正确目标截图显示待确认项、包名、0.1.0、明确的本地来源、私有存储能力及确认/取消按钮；此时 state.json 仍只有七个官方插件，previews.json 有一项待确认，证明选文件没有直接安装。选择器及启动器的个别抓图错取前台其他程序，均未保存或作为目标界面证据；文件选择按原生无障碍字段完成。

computer-use 的操作规则要求通过 Windows 界面安装软件前取得当次确认。用户明确回答“确认安装到隔离实例”后，重新核对预览，再点击“确认安装”。状态文件出现 hello-web，capabilities 为 storage、native=false，pending 清空；七个官方插件均继续启用。预览阶段原始记录保留在 `native-ui/local-import-preview.json`，不把其中安装前的 false 状态当作安装后结论。

随后通过启动器的 `Open Hello Web` 命令打开真正的样例窗口，身份为 hello-web@0.1.0、主题 light。用无障碍输入合成文字“受控安装验收 spark233 / Hello Web 233”，点击保存后显示已存到插件私有存储；只读核对 `plugins/data/hello-web/web-storage.json` 内容一致。点击“保存并关闭页面”后窗口从列表消失，再从启动器打开，新窗口 ID 从 60231404 变为 10818344，输入框恢复原值。插件 instanceId 仍是同一个，不将页面重建称为宿主/插件实例重启。

报告为 `local-build/spark233/ui-error-followup/native-ui/local-install-functional.json`，包预览、打开、保存与重开截图同目录存档；分发报告已关联该运行证据。页面最后已关闭，样例按授权保留在隔离 profile 中：现有八个插件（七官方加一 Hello Web），七官方均启用、待确认零项，剪贴板仍 paused=true、entries=2。没有执行真实卸载、包升级、native 信任提升、SYSTEM 服务或公开发布。

结合此前状态/版本/能力/依赖与更新检查展示、错误详情、启停和卸载数据选项的代表操作，P2.11“管理页实现”标记完成。其余条目规定的第三方 native 信任、实际版本升级/卸载、活动业务并行和完整 UI/目标机验收继续保留，不用这条 Web 样例链代替。
