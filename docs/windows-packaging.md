# Windows 安装包构建

Looma 的 Windows 安装程序使用 electron-builder 和 NSIS 生成。

## 构建命令

```bash
npm run make
```

该命令会依次：

1. 使用 PyInstaller 构建内置 Python Agent/RAG 服务；
2. 构建 Electron preload、Main 和 Vue Renderer；
3. 将应用及 Python 服务打入 NSIS 安装程序。

生成文件位于：

```text
out/make/nsis/Looma-<version>-Setup.exe
```

## 安装程序能力

- 使用非一键式安装向导；
- 支持当前用户或所有用户安装；
- 支持用户选择安装目录；
- 创建桌面快捷方式和开始菜单快捷方式；
- 在 Windows“已安装的应用”中注册卸载程序；
- 卸载应用时默认保留用户的 Looma 配置和工作空间数据。

NSIS 配置位于 `electron-builder.yml`。修改安装行为后，必须实际执行 `npm run make`，不能只验证 Electron 的普通生产构建。
