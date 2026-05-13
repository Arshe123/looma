# Looma

Looma 是一款基于本地工作空间的桌面笔记应用，适合用文件夹组织 Markdown、纯文本和常见媒体文件。它使用 Electron 构建桌面端能力，使用 Vue 3 和 TypeScript 构建界面。

## 主要功能

- 工作空间管理：打开本地文件夹作为工作空间，也可以创建新的工作空间。
- 文件树浏览：在侧边栏中浏览、创建、重命名、移动和删除文件或文件夹。
- Markdown 编辑：支持 Markdown 文件编辑、预览和分屏视图。
- 纯文本编辑：支持 `.txt` 文件编辑。
- 媒体预览：支持在应用内预览常见媒体文件。
- 标签页：打开多个文件并在标签页之间切换。
- 状态恢复：保存已打开文件、展开目录、选择状态和编辑器会话信息。
- 主题切换：支持浅色、深色和跟随系统主题。
- 撤销与重做：支持部分文件操作的撤销和重做。

## 技术栈

- Electron：桌面应用运行环境。
- Vue 3：前端界面框架。
- TypeScript：类型系统和开发语言。
- Vite：前端构建工具。
- Pinia：状态管理。
- Tiptap：Markdown 富文本编辑与预览能力。
- CodeMirror：文本编辑器能力。
- Tailwind CSS：界面样式工具。

## 快速开始

安装依赖：

```bash
npm install
```

启动开发环境：

```bash
npm run dev
```

仅启动渲染进程开发服务：

```bash
npm run dev:renderer
```

类型检查：

```bash
npm run check
```

运行测试：

```bash
npm test
```

构建应用：

```bash
npm run build
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 构建 preload 后启动 Electron 开发环境 |
| `npm run dev:renderer` | 启动 Vite 渲染进程开发服务 |
| `npm run preview` | 预览 Vite 构建结果 |
| `npm run check` | 运行 TypeScript/Vue 类型检查 |
| `npm run lint` | 运行 ESLint |
| `npm run lint:fix` | 自动修复可修复的 ESLint 问题 |
| `npm test` | 运行 Vitest 测试 |
| `npm run start` | 使用 Electron Forge 启动应用 |
| `npm run package` | 使用 Electron Forge 打包应用 |
| `npm run make` | 使用 Electron Forge 生成安装包 |

## 项目状态

Looma 仍在持续开发中。当前核心体验围绕本地工作空间、文件树、Markdown/文本编辑和媒体预览展开；AI Assistant、Git History 和用户系统等入口仍处于开发中状态。
