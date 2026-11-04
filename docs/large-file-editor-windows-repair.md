# Windows 大文件编辑器门禁修复记录

## 范围与授权

- 基线：`8e185a8f5d1337802ec94c55e390f8bc907b4fd0`，包含最初实现提交 `d71aa1e687b6c733b7ea542421adbafe25975053`。
- 用户在本轮明确授权修复代码/测试，并允许在个人 Windows 账户执行；随后确认允许继续读取相关测试和定义、运行完整门禁及 Windows 打包。
- 本轮只使用临时自造笔记、独立 appData/userData/sessionData；没有读取真实笔记、Looma profile 或凭证，没有操作系统剪贴板、安装/卸载现有应用、提交或发布。
- 原始验收报告和每轮失败保留，不以修复后的结果覆盖历史。本记录是修复与自动化回归结果，不是 W01～W17 原生验收全部通过报告。

## 根因与修复

### 1. Windows Node 文件身份来源不一致

当前 Node 22.16.0/Windows 中，同一文件的路径 `lstat().dev` 为 0，打开句柄 `stat().dev` 为实际卷设备号，原先跨来源比较误判为路径被替换。独立探针还确认 Electron 28.3.3 内置 Node 18.18.2 不出现同样差异，因此不能把原 Node 单测失败直接写成安装版故障。

新增 `src/main/services/file/fileIdentity.ts`：

- 使用 BigInt，避免 Windows 文件 ID 超出安全整数范围而失真。
- 路径侧前后检查普通文件、非符号链接、设备号/文件 ID/创建时间一致。
- 通过只读打开句柄取得身份，跨操作比较时统一使用句柄侧设备号，而非忽略设备号。
- 创建校验、创建失败清理、模板变量提交失败后的回滚共用该逻辑。
- 新增覆盖设备号差异、不同卷/高精度 ID、路径替换、保守回滚的测试。

限制：多了一次只读打开；特殊的“可创建/写入但拒绝读取”ACL 会失败关闭。这不是原子文件操作保证，也未宣称消除了既有所有 TOCTOU 风险。

### 2. 符号链接权限不等于功能失败

- 目录夹具在 Windows 使用真实 junction，仍验证 `isSymbolicLink()`，实际执行链接越界/目录拒绝场景。
- 文件符号链接仅在临时目录实际探测返回 `win32 + EPERM + syscall=symlink` 时跳过；其他错误继续抛出。
- 拆分混合用例，基线、所有权、损坏记录、分页、范围等非链接校验继续执行。
- 没有提权、打开开发者模式、使用 hardlink 假冒符号链接或隐藏跳过项。

本机仍有 6 个文件符号链接场景因权限跳过；另 1 个原有真实复现文件用例缺少 `LOOMA_CODE_BOUNDARY_FIXTURE`，保持原有跳过。

### 3. 跨平台测试路径、换行与 Python 驱动

- preload/OpenWith 测试使用当前平台的 `path.resolve/join` 构造路径，不改生产路由。
- CSS 源码断言只对读入的测试文本规范化 CRLF，不改主题 CSS。
- 真实 Python bridge 依次使用 `RAG_PYTHON`、平台本地 venv、`uv run --isolated --python 3.12 --with-requirements`；使用正式 requirements 并启用 UTF-8。
- 不缓存 uv 临时隔离环境的 `sys.executable`，每次使用相同 uv 启动命令。8 项 Python 跨语言测试真实运行，不以 mock 或跳过代替。

### 4. 无 EditorView 的语法树夹具不稳定

CodeMirror 初始化/更新存在解析时间预算；裸 EditorState 没有 EditorView 后台解析器，完整套件负载下语法树可能未完成，造成表格命令、代码行号、菜单等断言随机失败。

新增 `test/parsed-markdown-state.ts`：完成解析后以空事务发布树，并断言树已可用。语法依赖夹具在创建/必要更新时准备完成的树；故意测试未解析源、只读、局部读取、长行读取预算的断言保留。新增用确定性时钟耗尽初始预算的回归，不使用 sleep/retry 或放宽功能断言。

历史分页的真实反复 fsync/恢复测试单独设为 30 秒超时，不修改编辑器性能预算或全局测试超时。

### 5. 恢复脚本解除阻断后发现真实保存竞态

冻结构建连续两次复现：自动保存 A 仍在处理时，后续保存 B 取得旧 `loadedContent`；A 落盘后，B 的旧基线被 main 正确判为 `FILE_CHANGED_ON_DISK`，导致 B 未自动落盘。

- `workspace.ts` 增加按 store/工作空间/文件串行的保存队列。
- 排队后在实际保存时读取最新内容及前次保存完成的磁盘基线；排队期间继续输入不会被旧快照覆盖。
- 文件已关闭重开或工作空间已变化时，取消排队保存；旧回调不改写新文档状态。
- 保留真实外部修改的 CAS/确认保护，不自动覆盖外部更改。
- 新增 4 项串行化回归：最新输入/基线、真实外部冲突、不同文件独立保存、关闭重开取消及状态保护。

恢复 harness 使用真实 main/preload/dist 与 IPC；Windows dependency link 改真实 junction，最外层异常会记录并退出，不留下挂起 Electron。保留首次写入的 650ms 调度门，另冻结随后一次真实写入，确定性检查旧回调后的内容和基线；同时核对随后写入实际传入的 CAS hash。没有替换磁盘 API 或删除失败断言。

## 已执行验证

最后两轮完整 `npx vitest run` 均退出 0：

- 201 个测试文件，1602 项断言。
- 1595 passed，0 failed，7 skipped（上述 6 项文件 symlink 权限 + 1 项原有外部复现夹具）。
- `npm run lint`、`npm run check` 最终均退出 0。
- `npm run build` 通过。
- 修复后的冻结恢复脚本，`multiline`、`single2m`、`complex` 三种形状各自 cold/crash/recover/conflict 四阶段均通过；预期 crash 进程真实退出码为 73，其余阶段为 0，脚本整体退出 0。

上述恢复验证属于隐藏 Electron/CDP 自动化，不能替代微软拼音候选窗、真实桌面拖选、系统剪贴板、安装版 Explorer OpenWith 或卸载数据保留验收。前轮 endurance 的通过结果也不冒用为本轮修改后的十分钟结果。

完整 Windows 打包使用 `npm run make:win -- --publish never`；最终产物、退出码、架构/hash 和任何后续阻断以证据目录的修复结果 JSON 为准，不使用旧同名安装包。

本轮实际打包退出 0；打包资源目录中的 sidecar 再次执行 `--packaging-self-test` 也退出 0。ASAR 中 package 版本为 1.6.0，renderer index/main/preload 与本轮构建文件逐字节一致。

- 安装包：`E:\looma\out\make\Looma-1.6.0-Setup.exe`，173005059 bytes。
- SHA256：`4fbcdcafd8bb22e6631a87613b571851fab9aedaa9c09bfc92d9e98dbacfab51`。
- 应用 exe、sidecar exe、随包 Python 3.12 DLL 均为 PE x64 `0x8664`。NSIS 启动 stub 自身为 x86 `0x014c`，不把 stub 的架构冒称为 payload 架构。
- 实际 SignTool 验证提示 `No signature found`（退出 1）：本轮产物未签名，不宣称可信签名发布。PowerShell 签名模块加载失败后使用本机 electron-builder 缓存的 SignTool 复核，没有修改执行策略或证书。
- 未安装或卸载应用；安装版原生矩阵尚未完成。

## 证据

原始验收：`C:\Users\admin\AppData\Local\LoomaAcceptance\20261103-220935`。

本轮命令、每次失败/重跑、恢复脚本报告及修复结果：
`C:\Users\admin\AppData\Local\LoomaAcceptance\repair-20261103-224939`。

原始文档及结果模板不修改；本轮工作区变更尚未提交。
