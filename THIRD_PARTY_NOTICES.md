# 第三方来源与许可

QTV 是面向 macOS 的 DTV 派生项目。项目整体采用 AGPL-3.0-only；本说明不替换各组件原有的版权声明。

| 来源 | 用途与关系 | 许可与声明 |
| --- | --- | --- |
| [chen-zeong/DTV](https://github.com/chen-zeong/DTV) | 基础代码，起点提交 `539bc9c` | MIT，Copyright (c) 2025 c.zeong；见 [原始许可](LICENSES/DTV-MIT.txt) |
| [saermart/DouyinLiveWebFetcher](https://github.com/saermart/DouyinLiveWebFetcher) | 继承的抖音 `sign.js` 和协议定义；签名脚本与提交 `40a904bdb0561a5a9c958a95634a29681cc4fbf4` 的文件一致 | AGPL-3.0；完整许可随源码及应用分发 |
| [biliup/biliup](https://github.com/biliup/biliup) | 斗鱼 Android 签名算法的 Rust 移植 | MIT，Copyright (c) 2019 ForgQi；[许可](src-tauri/resources/biliup-LICENSE.txt) |
| [brix/crypto-js](https://github.com/brix/crypto-js) | 斗鱼签名 JavaScript 的加密辅助库 | MIT，Jeff Mott / Evan Vosberg；[许可](src-tauri/resources/crypto-js-LICENSE.txt) |
| [xfgryujk/blivedm](https://github.com/xfgryujk/blivedm) | 原项目 B 站弹幕实现参考 | MIT；未将其 Python 源文件作为独立组件打包 |
| [ihmily/DouyinLiveRecorder](https://github.com/ihmily/DouyinLiveRecorder) | 原项目直播协议参考 | MIT |

原 DTV README 还列出了 `wbt5/real-url` 与 `pure_live` 作为协议参考。QTV 对比研究过 SimpleLive、IINA+、PureLive 的画质获取行为；本次没有复制它们的 GPL 源码实现到项目中。协议字段、接口行为与参考实现应作区分；发现具体来源或许可遗漏，欢迎提供对应文件与依据。

抖音协议文件中保留了原始字段来源注释。依赖通过 pnpm / Cargo 安装，准确版本由两个锁文件记录，依赖的许可证以各包随附的声明为准。界面不再分发原来的 OPPO 字体和捐赠二维码，使用系统字体。

QTV 图标由内置图像生成工具按“简约双翼电视”的原创提示生成，生产记录见 [图标记录](docs/branding/generation.json)。平台图标及商标的权利不属于 QTV。

QTV modifications Copyright (c) 2026 qinxianhahaha and contributors.
