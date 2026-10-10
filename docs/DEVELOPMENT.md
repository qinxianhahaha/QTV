# 开发与发布

## 项目结构

- `web/src`：关注管理、主题、路由、播放控制与恢复策略。
- `src-tauri/src`：平台解析、弹幕、受限本地代理和 macOS 窗口操作。
- `web/tests`：输入解析、排序、刷新、队列、播放策略、窗口配置和导出回归测试。
- `tests/rust`：直接引用生产模块的轻量测试，不需要构建 Tauri / V8。
- `src-tauri/resources`：随安装包分发的许可证。

## 检查

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm -C web build
RUSTUP_TOOLCHAIN=nightly cargo check --release --manifest-path src-tauri/Cargo.toml
pnpm audit
```

RustSec 检查：安装 `cargo-audit` 后运行 `cargo audit --file src-tauri/Cargo.lock`。锁文件必须提交；依赖升级后重新测试四个平台播放与窗口切换。

项目使用原生 AppKit 约束窗口比例。不要恢复通过 JS resize 事件反复改窗口尺寸的实现；这会导致拖动抖动。`useFloatingWindow` 负责串行切换和收尾。

内部保留部分 `dtv_*` 存储键和 JSON 导入协议，以便迁移旧数据。它们不是界面品牌遗漏。QTV 的应用标识为 `io.github.qinxianhahaha.qtv`。

## macOS 构建

默认构建本机架构：

```sh
pnpm tauri build --bundles app,dmg
```

在 Apple Silicon 上构建 Intel 包：

```sh
cd src-tauri
rustup target add x86_64-apple-darwin
cd ..
pnpm tauri build --target x86_64-apple-darwin --bundles app,dmg
```

每个架构单独构建和验证，避免把 ARM 可执行文件误标为 Intel。GitHub Actions 的 macOS 发布工作流也会构建两种架构。

Release 构建关闭 Rust LTO，以避免 Apple 链接器与 V8/Rust bitcode 的兼容性问题。当前配置使用 ad-hoc 签名；没有 Developer ID 和公证时，不应宣称已经通过 Apple 验证。

`Entitlements.plist` 中的 JIT 权限用于内嵌 V8 签名引擎；不要移除后只验证能否启动首页。运行 `python3 scripts/verify-macos-app.py 路径/QTV.app arm64`（Intel 使用 `x86_64`）检查签名、权限、架构与许可文件。

## 发布步骤

1. 同步根 package.json、web/package.json、Cargo.toml 与 tauri.conf.json 的版本。
2. 更新 CHANGELOG，执行检查，实测首页、主题、四平台播放、小窗、置顶及关闭恢复。
3. 提交源码，打 `vX.Y.Z` 标签。工作流创建草稿 Release 并上传安装包。
4. 核对 DMG、ZIP、架构、许可证、SHA256 校验值与说明，再公开 Release。
5. 将 Cask 中的版本与对应 DMG SHA256 一起更新。

请勿提交 Cookie、个人配置导出、访问令牌、Apple 签名私钥、开发机备份或直播签名 URL。日志提交到 issue 前也应去掉上述信息。

## 文档截图

`docs/screenshots` 使用应用真实界面与虚构的演示数据。文档预览工具仅用于生成介绍图，不参与生产构建，也不连接真实直播账号。
