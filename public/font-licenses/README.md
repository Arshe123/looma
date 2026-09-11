# 内置字体来源与兼容性

本目录保留官方字体许可证；`sources.json` 记录原始下载地址、文件大小及 SHA256。字体文件未经修改，保存在 `src/renderer/assets/fonts/`。

思源黑体与思源宋体使用 Adobe 官方发布的 **CN 地区子集可变字体**，不是完整泛 CJK 字库；未覆盖的字符沿用 CSS 中的系统字体回退。此前使用的完整 SC WOFF2 在 Electron 28.3.3 / Chromium 120 中出现 `Failed to convert WOFF 2.0 font to SFNT`，会使两个方案同时回退为系统字体。不能仅凭新版 Chrome 加载成功判断桌面应用兼容。

更换字体后，从仓库根目录运行 `npx electron scripts/verify-fonts.cjs`。该脚本使用项目自带 Electron、隔离临时配置及本地文件，检查三套正文常规/强调字体和代码字体的实际字形来源，并将字体解码错误或系统回退视为失败。无需启动开发服务器，也不会访问用户笔记。
