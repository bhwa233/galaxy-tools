# uTools 离线包格式与来源

2026-11-04。仅支持已核实的离线格式；新格式或需要平台服务的包明确拒绝。解析时不执行原生模块、preload 或安装脚本。

| 格式 | 当前处理                                                                             |
| ---- | ------------------------------------------------------------------------------------ |
| UPX  | gzip 包裹的 ASAR；亦识别原始 ASAR 容器                                               |
| UPXS | 小端 uint32 元数据长度、XChaCha20-Poly1305 元数据、AES-256-CBC 包裹的 gzip/ASAR 正文 |

UPXS 元数据的 `encrypt2` 绑定插件 ID 和时间戳，清单 `name` 必须与包身份一致。商店下载还要求其与目录条目 ID 一致，并比较实际清单版本与详情版本。使用静态格式参数不能证明作者身份，ASAR 哈希与本地计算的 SRI 也不作为官方数字签名。

## 复用与来源

使用 Electron 官方 `@electron/asar@4.3.1` 读取归档头与清单，使用 MIT 的 `@noble/ciphers@2.4.0` 处理 XChaCha20-Poly1305。AES 和 gzip 使用 Node 内置实现。归档完整性校验、路径限制、流式写入和安装事务复用／接入宿主现有边界，不使用第三方 CLI 或执行下载的 addon。

格式参考：MIT 项目 [utools-devtools，固定版本 eeb80c6](https://github.com/farfarfun-action/utools-devtools/tree/eeb80c614188e73fdaf35f9fc1aa25c39c9bab0e)。所需格式参数通过只读检查下列官方二进制确认，参数存储于 `utools-upxs-profile.ts`，原二进制不随应用分发，也不在安装插件时下载：

- 官方 uTools 8.0.2 Linux DEB：`https://open.u-tools.cn/download/utools_8.0.2_amd64.deb`，SHA-256 `3904b1081ae0562cd1ae4c3f3d33592521f3a9001f72392b5b0228cde3c23056`。
- 其中 `linux-x64.node`：SHA-256 `b8f96f70e87d2f5c07f1fae9182d6d1472b66403d4ede8a73cd3bfdf1ae96086`。

完整 MIT 版权及许可文本保留于 `THIRD_PARTY_NOTICES.md`。本实现没有账号、支付或联网授权的替代路径；此类必要能力不可用时保留原有明确诊断。

## 实际产物

- [Excalidraw 公开 UPX，release 0.20.2](https://github.com/FoundTheWOUT/utools-excalidraw/releases/download/0.20.2/utools-excalidraw.upx)：2,860,739 bytes，SHA-256 `f5cf2671a1df209136093792fa57f248b1dcd4bacc0a3cbaa60af2198d786b77`。原清单没有版本字段，因此按原兼容规则规范化为 `0.0.0-utools.h…`，不把发布页标签伪装成包内版本。
- [Markdown 笔记 UPXS 1.15.0](https://res.u-tools.cn/plugins/zwslt5e4y1bbt4isabmsjabjdokmwwtb.upxs)：3,800,803 bytes，SHA-256 `c266626a18b951c1b88e30db7b2e1bcde074d12351048843eb570315ccfbf8b4`。
- [Excalidraw 商店 UPXS 0.21.0](https://res.u-tools.cn/plugins/kudymmhszr0u3bpygyvj9hlfuom7zgh6.upxs)：实际目录、详情、下载、解包和原页面更新验收见 [验证记录](evidence/utools-store-install-update-2026-11-04.md)。

部分官方导出包重写了 `plugin.json`，却保留旧的 ASAR 清单哈希。仅对这个文件保留明确的预览提示，继续校验实际包哈希、元数据身份、目录身份和实际版本；其他文件的完整文件 SHA-256 不匹配则拒绝，不宣称清单旧哈希已经通过。

## 解包边界

先校验所有路径、条目数量、文件偏移和体积，再写入仅属于本任务的临时目录。拒绝路径穿越、Windows 特殊文件名、大小写／Unicode 冲突、链接、外部 unpacked 文件、截断和超限。正文解压和文件校验采用流，不整体保留展开包。预算与 npm 导入共用 `PluginPackageLimits`。

Electron 将 `.asar` 路径作为虚拟文件系统，因此临时原始载荷使用 `.bin` 后缀，交给 ASAR 库读取真实字节。正式代码与数据仍由现有不可变版本和备份事务持有。
