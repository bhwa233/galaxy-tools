# 短关键词选择记忆：实现与验证续记

日期：2026-10-27。对应P3.16。实现与本条原范围验证已完成并勾选，当前总数60/108。最终501源Windows候选175测试/typecheck/lint/build、66项静态审计、固定样本及完整smoke/binder均通过。

默认关闭。用户明确启用后，仅保存规范化短关键词与最后一次成功的稳定目标，不保存展示标题、版本、路径、临时token、正文/AI输入或文件图片上下文。关键词先拒绝控制字符，再NFKC、首尾/连续空白归一和小写；超32码点不截断、不记录。最多128条，最近选择覆盖同关键词并置前；关闭后停写和停用排序，已有记录可以独立清空。沿用LauncherPreferences单原子写者，不让使用统计、引导、固定或别名写入覆盖学习设置。

普通命令必须来自当前宿主opaque主选择，实际匹配、有零输入且无provider/mode；应用仅主launch可学，reveal/copy/预览/分页不学。只在默认和官方应用模式的短关键词中使用偏好，正文模式、目录和有效捕获上下文排除。候选仍须经过现行插件身份、隐藏/启停、稳定ID和真实实例校验，记忆不启用插件或制造自动执行。

保持分组顺序。命令先按原literal/pinyin分值，再在同层比较学习目标；应用先保天然精确标题及精确个人别名，再比较学习，其余保原序。学习命中有解释标记。应用1.1.1在同一个现有查询中合并精确ID，天然score100先保留，onlyIds原序不变；宿主为include保留自然结果余量（上限100），饱和结果未返回某include时不武断写成missing。没有增加第二次inventory/pinyin请求。

执行建立独立receipt，保留原caller/session/request、短关键词和稳定target、当时的学习设置revision。对象身份作为本caller执行代次；自身开窗收口撤掉查询动作权限但保留receipt，新输入、取消、关闭/导航、设置清空/关闭或偏好更新则撤receipt，即使原query已经被自身收口删除。迟到A不能删除或学习到新B。main在实际hide前捕获原query身份，避免native hide事件丢失AsyncLocalStorage后误判自身收口。

Manager新增host-only activateOwned，返回真正执行实例的owner，包括查询时尚未启动的冷命令；不让迟到结果借新实例身份。实际activate成功、回复合法、原receipt仍有效、设置revision/身份/隐藏状态都现行时才原子保存。明确负向或cancelled/closed结果不学，成功void允许；写学习失败不改成业务执行失败。自动学习只发计数元数据事件，不撤查询或触发排序刷新，防止合法workspace回复因queryGeneration改变被丢弃；开关/清空仍按显式设置撤旧会话。前端拒旧全量状态，计数通知不改变执行结果代次。

`local-build/spark233/keyword-learning-backend-probe/summary.json`：现有偏好测试5/5（原4组及1新增组）通过，覆盖旧格式defaultoff、交错写、规范化/128淘汰/停用清空和真实rename失败内存不变。真实Windows旧262后台饱和红到1.1.1绿色的三组证明100include时两个同名天然精确目标保留、onlyIds逆序无pinyin、13别名单请求解析及删除旧ID拒绝。实际1.1.1 tgz13成员与source/helper/migration逐字节一致，所有所属进程退出；不换绑先前1.1.0归档。真实Controller与UI证据如下，保留各自原始输入身份。

`local-build/spark233/keyword-learning-controller-probe/summary.json`：真实Windows Controller/Manager及六个utility进程的三组验证通过，覆盖单次应用查询的天然精确/别名/学习分层、冷命令的真正执行owner及成功void、执行自身收口与显式取消的区别；新输入、旧A取消、跨caller、设置清空/关闭、隐藏或owner退休阻止迟到学习。明确失败/取消、正文或AI、reveal和仅浏览不学习。所有所属进程实际退出0。该报告保留原Controller源码`c67b18fd…`及编译`b7443330…`，不绑定后续P3.17接线。

`local-build/spark233/learning-main/final-summary.json`：真实Linux main/preload/renderer的17项与同profile重启通过，包含默认关闭、关闭保留及清空、稳定目标、notes.open自身收口成功学习、旧输入/Escape/真实caller关闭后的迟到成功拒绝、模式/正文/文件排除，以及计数通知不自动重查。两阶段主进程与所属utility实际退出0；11个偏好文件检查点和重启文件散列保留。仅原始reply的受控延迟shim，未替换学习或业务逻辑。200%界面检查通过；应用OS启动、真实AI网络、物理键盘/IME不据此宣称通过。

最终候选：`local-build/spark233/keyword-learning-2026-10-27/completion-summary.json`。冻结501源清单SHA256 `05d5c3e0debd41c45739e3dd787e08e550d310a6984756d6c2e540d662e0fcb1`；ASAR `1764d6b7ef990490ab345e8f1674665c01f5faf7c28a5dfbd94387190a0af93a`；NSIS `89f8fd6424117c17ecd72754c13101650bcb302ceb5ef845ef6637ae552871f2`；最终binder `c1b999d31779a95ebaf2e7306a7bd1b16a7086e649c0ad35017cf258a6419ff8`。Windows build/lint、36文件175测试、66审计及73编译文件/14原生payload/七插件逐字节绑定均通过。静态检查只证明字节及结构，不代替上述行为验证。

固定样本`seeded-smoke-n4dy8B`实际61.876秒、ExitCode0；完整fresh `0d9de500-22c5-48b7-9b90-7fff073a6a3a`实际220.695秒、程序及wrapper均0、未超时、report.ok=true/errors=[]。2026-10-26 18:01:17.9275487 UTC（北京时间10月27日）原CIM报告返回为空，但后续发现共用校验脚本的路径后缀误用了两个字面反斜杠，该旧空结果不作为排空证明；实际程序及utility退出0的记录仍有效。修正后的真实正控及覆盖整个共享stage的清理复核见[超级面板续记](spark233-context-panel-followup.md)。完整122文件release与501源均另行封存；准备脚本的语法/复制时序失败原日志保留，未改绑旧验收。

该候选未包含后续P3.17。没有执行安装器、发布npm、安装SYSTEM服务或操作用户真实数据；真实Shell文档/目录窗口、系统保存对话框、物理键盘/IME/多屏仍属各自最终验收。
