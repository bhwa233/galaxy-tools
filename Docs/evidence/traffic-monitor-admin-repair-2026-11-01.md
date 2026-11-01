# 流量服务安装故障修复与实际管理员验证

日期：2026-11-01。用户报告 `installer-failed:1` 后明确授权直接使用管理员权限安装。实际通过包内固定 helper 发起 UAC，未更改系统 UAC、安全软件设置或已有共享目录 ACL。

## 根因与修复

1. 既有 `C:\ProgramData\spark233` 的 owner 为 Administrators、DACL 已保护、SYSTEM/Administrators 为 FullControl，普通读取使用 Authenticated Users。旧 DirectoryGuard 只接受 Builtin Users，因此提权后立即报 `unsafe-directory-acl`，尚未创建 traffic 子目录。修复代码目录 BU/AU 只读执行的兼容性，仍拒绝普通用户写权限，私有历史目录仍不允许二者读取。
2. 安装后普通用户 bridge 尝试打开 SYSTEM 进程取得身份，实际返回 `pipe-server-identity-unavailable`。生产验证改为 pipe PID 与 SCM 的 Running/OWN_PROCESS/PID、LocalSystem/严格受保护 ImagePath、注册表权限及受保护版本目录交叉核验。兼容本机已有 Windows 服务 SID 的注册表权限，不修改 ACL；隔离分支继续验证同 SID 与固定 exe。
3. 实际进程出现后，可选 `message: undefined` 被 JSON 安全检查误判为非法数据，阻止插件升级。分页边界先按实际 JSON wire 语义规范化，再执行原有大小/深度/字段检查，并加强现有回归。
4. 安装器使用固定错误码返回阶段和原因，bridge 转为中文；renderer 去掉 Electron invoke 包装。另修开发归档竞态：旧进程安全退出前保留其可能仍读取的旧 tgz。

## 当前实际状态

- `spark233Traffic` 已安装，SCM 状态 Running，账号 LocalSystem，验证时 PID 43952。
- 当前账户范围已启用，普通用户 token 可认证、获取 lease，ETW 状态 collecting=true。
- 实际 production 详情读取 5 页、101 个应用、583 个进程实例；DOM 101 行、20 个已加载图标。
- 一次实际快照中 RX>0、TX>0 均有 3 个应用；真实历史查询返回 14 个应用，RX 10,181,995 B、TX 32,976,864 B，60 秒粒度。
- coverage gap 如实展示。上述是实际当前账户观测，未宣称完整整机覆盖或受控下载大小校验。
- 正常页面运行期间无 renderer/preload/页面 IPC 错误；关闭探针时有一条取消中的 capability 诊断，shutdown 正常完成。
- 用户开发环境已安装修正 bridge（SHA256 `3e250a7a42775088d44a0464e4a28e6f99821fa2c53dcdc43e6095c0287a2f0d`），八个官方插件无 lastError。探针未停用或清空真实服务与历史。

## 验证与产物

- 四个 native 项目 locked Release 零警告/错误，7 项权限/数据/生命周期回归、12 项隔离 pipe/bridge 验证通过。
- 相关三个 Vitest 文件 10 项通过，traffic TypeScript、renderer TypeScript、所改文件 lint 与 diff-check 通过。
- 普通用户实际服务身份验证：`local-build/spark233/native-traffic/server-identity/652f621d-3351-4391-9f6a-8072684e2fd2/report.json`。
- 管理员首次安装：`local-build/traffic-admin-repair/runs/61a8e0a9-0218-4912-9f52-bcd8e12f9f91/report.json`（安装成功，其后旧身份读取失败保留在报告中）。
- 修正版 bridge 连接与真实 ETW：`local-build/traffic-admin-repair/runs/dc2d5be4-a7ca-4e80-97a3-2a8eb22e12ca/report.json`。
- 真实完整插件与界面：`local-build/traffic-admin-repair/plugin-probe/runs/6b6b941e-03fb-4832-8d16-9204597ecf49/report.json`。
- 归档生命周期回归：`local-build/traffic-v2/archive-race-runs/3f74927e-9d64-4e2e-82b3-3f90ae540a51/report.json`。

修正版插件 `traffic-0.2.1.tgz` SHA256：`27c2de148a2f01dede938eab8e8d276b0bd19597915f9f38b0070a30acbaba36`。真实 UI probe 验证的是相同业务代码的 0.2.0 构建，0.2.1 仅提升补丁版本并重新打包，避免覆盖已提供的不可变版本。

本记录补充并取代首轮记录中“尚未安装服务／未实测 SYSTEM 采集”的状态。签名、安装升级失败回滚、长期压力、睡眠与物理混合 DPI 输入仍未完成专门验收。
