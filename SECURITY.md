# 安全问题

请通过本仓库 GitHub 的 Security → Report a vulnerability 私密报告漏洞；不要在公开 issue 中粘贴 Cookie、令牌、私钥或个人导出数据。

QTV 使用平台公开网络接口和本地 WebView。图片代理只绑定 loopback，使用随机路径并限制上游 CDN；局域网共享仅在手动开启时运行，使用随机配对码，关闭同步窗口即停止。局域网共享不是端到端加密服务，请仅在可信网络使用。

当前安装包使用 ad-hoc 签名，未进行 Apple Developer ID 公证。请核对下载地址和 SHA256。
