# Looma 剩余 Windows 原生验收交接

本文件是待执行清单，不是通过报告。对应 `large-file-editor-todo.md` 第 9～10 项；Mac/隔离 Electron 的历史通过数量不得写成 Windows 结果。不要求本机 macOS 执行 Windows 测试；由 Windows agent 在真实 Windows 桌面执行。只验收，不改生产代码、不提交、不发布。发现问题先留证据，修复须另获授权。

## 1. 安全与环境门禁（W01）

- 必须真实 Windows 交互会话，记录版本/build、CPU/OS 架构、Node/Electron/Python sidecar 实际架构、DPI/分辨率、字体配置与微软拼音版本/兼容模式。WSL、Wine、macOS 模拟 `win32`、强制 `platform:'darwin'` 均不合格。远程桌面须注明；候选窗/截图键被远程层截获则记 blocked，改本地会话后重测。
- 使用独立 Windows 测试账户（或专用干净 Windows VM 中的交互桌面），只打开新建临时工作空间和外部临时笔记。不要使用用户真实笔记、真实 Looma profile 或真实聊天凭证。隔离账户首次启动前确认无真实工作空间自动恢复。
- **操作真实系统剪贴板前，先取得用户对本次读写、截图、文件复制的明确授权。** 只允许测试账户的隔离剪贴板；关闭该账户的跨设备剪贴板同步/远程剪贴板共享，避免测试内容外泄。未经授权不读、不备份、不清空、不恢复、不转储真实用户 clipboard，相关项 blocked。不得向聊天收集密码、密钥或验证码；需要登录用受控凭证工具或用户本地完成。
- 当前安装配置只声明 Windows **x64** NSIS，文件名不含架构，不能凭文件名推断。ARM Windows 上的 x64 仿真必须标注，不算原生 ARM64 包。Electron、Python、sidecar 的 PE 架构须相符；仅 `node -p process.arch` 不能证明安装产物架构。
- 在测试账户下选择实际 Windows checkout，不能把 `/Users/shimengmeng/looma` 当 Windows 路径。保留当前集成的未提交/未跟踪文件；仅 commit hash 不足以标识本轮源码。不得自动 stash/reset/clean。

在 PowerShell 中替换首行真实仓库路径，证据存仓库外：

```powershell
Set-Location 'C:\实际路径\looma'
$Repo = (Get-Location).Path
$Run = Join-Path $env:LOCALAPPDATA ('LoomaAcceptance\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $Run | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $HOME '.hermes\cache\scratch') | Out-Null
Start-Transcript -Path (Join-Path $Run 'session.log')
git rev-parse HEAD
git status --short
Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture
Get-CimInstance Win32_Processor | Select-Object Name,Architecture
node --version
node -p "JSON.stringify({platform:process.platform,arch:process.arch,versions:process.versions})"
npm --version
uv --version
uv python find 3.12
```

`uv python find` 失败时记录缺依赖并在隔离账户按其安装流程准备 Python 3.12；不要把缺失解释为产品通过。保存源码清单，执行前后各一次，后者文件名改成 `source-after.json`。只枚举 Git 已跟踪及非忽略的待集成源码；不递归收集运行数据、缓存、profile。**不得读取或哈希 `.env`、凭据文件、个人账户配置或真实笔记**；若它们被误跟踪，先从清单排除并记录省略原因，不打开内容。

```powershell
$SourceFiles = @('package.json','package-lock.json','electron-builder.yml')
$SourceFiles += git ls-files --cached --others --exclude-standard -- src scripts resources public looma-agent-service |
  Where-Object { $_ -notmatch '(^|[\\/])(\.env(\.[^\\/]+)?|node_modules|\.venv|__pycache__|\.cache)([\\/]|$)' }
$SourceFiles | Sort-Object -Unique | ForEach-Object {
  $f = Get-Item -LiteralPath $_
  [pscustomobject]@{path=$f.FullName;bytes=$f.Length;sha256=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash}
} | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $Run 'source-before.json')
```

## 2. 构建、安装与真实启动（W02）

先核对本次 checkout 的 package scripts/config 与本文件一致。构建需可用 Node/npm/uv 与 Windows Python 3.12；`build-python-service.mjs` 使用 uv 隔离构建 PyInstaller 6.16.0 并自动执行 sidecar `--packaging-self-test`。网络或依赖失败留日志与退出码，不伪造安装包。

```powershell
npm ci 2>&1 | Tee-Object (Join-Path $Run 'npm-ci.log')
$Code = $LASTEXITCODE; "npm-ci exit=$Code"; if ($Code -ne 0) { throw 'npm ci failed' }
npx vitest run 2>&1 | Tee-Object (Join-Path $Run 'vitest.log')
$Code = $LASTEXITCODE; "vitest exit=$Code"; if ($Code -ne 0) { throw 'vitest failed' }
npm run lint 2>&1 | Tee-Object (Join-Path $Run 'lint.log')
$Code = $LASTEXITCODE; "lint exit=$Code"; if ($Code -ne 0) { throw 'lint failed' }
npm run check 2>&1 | Tee-Object (Join-Path $Run 'check.log')
$Code = $LASTEXITCODE; "check exit=$Code"; if ($Code -ne 0) { throw 'check failed' }
npm run make:win -- --publish never 2>&1 | Tee-Object (Join-Path $Run 'make-win.log')
$Code = $LASTEXITCODE; "make-win exit=$Code"; if ($Code -ne 0) { throw 'Windows packaging failed' }
Get-ChildItem out\make -Recurse -File | Select-Object FullName,Length
Get-ChildItem out\make -File -Filter '*-Setup.exe' | Get-FileHash -Algorithm SHA256
```

精确链路：`npm run make:win` 自动先跑 **`premake:win → npm run build:release → build:python + build`**，再 `electron-builder --win nsis`；追加 `--publish never` 防止发布。不要跳过生命周期，不要用 `release:win`（其含 `--publish always`），不要设置发布 token 或上传。当前 package 版本 1.6.0、输出 `out/make/Looma-1.6.0-Setup.exe`，以本轮实际 package/产物为准；不要启动旧同名安装包。

- 留存 NSIS 安装流程、安装目录、签名状态、安装包/已安装 exe/sidecar 的版本、SHA256 与 PE machine（x64=0x8664；ARM64=0xAA64）。可用本机可信 PE 查看器读取，不要求虚构已有工具。构建输出和已安装 resources 中都检查 sidecar。
- 从 **已安装** 开始菜单/桌面快捷方式启动，而非 Vite 或 `npx electron`；确认窗口、图标、preload 正常，无白屏。记录实际 exe 路径及 PID；无关开发实例全部退出。
- 在隔离临时工作空间确认打包 sidecar 能启动且日志无架构/资源缺失；仅纯外部编辑窗口不应为验服务而强启无关 AI。若需网络凭证则该服务子项 blocked，不索取密钥。

## 3. 夹具与证据协议

在 `$Run` 下创建 `workspace`、`external`、`evidence`，所有笔记/图片仅用自造数据。普通小文件作交互基准，同内容复制并追加独特编号段落得到 ≥256 KiB 大文件；另建复杂 Markdown、多行及 **2,000,000 字符单物理行**。记录实际 bytes、字符数、最长物理行、编码/BOM/CRLF 或 LF、SHA256；不要只用文件名证明进入连续引擎。可在隔离应用 DevTools 只读检查 `.cm-editor`/连续表格 DOM 确认引擎，不能注入假平台或替换 IPC。

基础正文含 `前文 **粗体** *斜体* ~~删除~~ ==高亮== ` 与行内代码、嵌套格式、长链接、中文/空格文件名、列表/任务/引用/代码块。引用目标另建临时笔记。表格在普通与大文件中分别放置以下三组（各含表头+两行，前后有正文）：

```markdown
|  |  |  |
| --- | --- | --- |
|  |  |  |
|  |  |  |

||||
| --- | --- | --- |
||||
||||

| A中 | é👩‍💻 | 尾Z |
| --- | --- | --- |
| 中文 | a\|b | C:\测试\ |
| 左 | 中 | 右 |
```

每项/每子场景保存：带步骤编号的桌面截图或视频（IME 候选窗必须 OS 桌面捕获，renderer capturePage 可能漏掉）、操作/按键时间线、期望与实际、应用日志；关联同一源码 manifest/hash 与安装包版本/架构。编辑前后复制**完整文件字节**为 before/after 快照，记录长度与 SHA256；必要时保存预期文件做逐字节比较，不能仅断言“包含新词”。不编辑的导航/选择项要求前后字节相同；有意编辑要求差异只在预期位置，撤销回原文须逐字节比较。资产单独前后 hash。GUI 手工项退出码填 null 并说明不适用；命令/进程必须记录真实退出码，强杀记录实际信号/退出情况，不编造 0。

## 4. 原生操作矩阵（逐行及子场景填结果）

| ID | 执行步骤与判定 |
| --- | --- |
| W03 ColdOpen | 完全退出已安装 Looma，确认该测试实例进程结束；Explorer 打开临时大文件。记录启动→窗口→首个真实字形→可滚动首屏→全文加载可编辑的时间，至少 3 次。注明是冷进程，不冒称冷 OS 磁盘缓存；不清用户缓存。工作空间文件与纯外部文件各测；记录 CPU/RSS/堆（可测时）、文件形状、每次原始值，不用内存夹具 mount 代替。超长单行单列结果，卡顿如实 fail，不放宽为通过。 |
| W04 渐进加载 | 在足够大文件加载期间滚动、试输入、切文件/关闭再重开；部分加载应只读，首屏后继续后台加载，不抢焦点/跳阅读位置/触发无编辑保存，完成后允许编辑。小机器过快看不到过渡则该子项 untested，不假造慢盘；读取错误/重试仅在临时副本与可控方式下测，无法安全诱发记 blocked。记录首屏与完成时刻、完整末尾 sentinel、输入保存是否包含全文。 |
| W05 正文微软拼音 | 前台已安装应用，Windows 输入指示器确认“微软拼音/中文”，物理键或可信 OS 级按键逐字输入 `zhongwen`，**看见系统候选窗**，翻页/选候选/空格与 Enter 提交；另按 Esc 取消。普通正文、粗体/链接边界、长段落折行与跨视口边界重复。组合过程字符可见、不透明、不串位置，候选窗靠近当前光标；取消还原原文，提交恰好一次；Ctrl+Z 撤销整次组合，Ctrl+Y 重做，邻接编辑不丢失。仅 Input.insertText 或 Input.imeSetComposition 不算原生 IME。 |
| W06 表格微软拼音与字形 | 三类表全部九格，首/尾点击后重复 W05 更新/提交/取消/组合撤销；特别测空首格、末格、无 padding `||||`、以反斜杠结尾再输入。候选未提交时就须有真实可见字形，光标可见且在目标格，列对齐、无露出 pipe/匿名列、其他格不变。三套字体（simple/literary/handwritten）×明/暗至少覆盖空中格与末格；逐格全覆盖用默认字体并注明其余抽样范围。屏幕截图/视频必须包括组合中与提交后，不能仅 DOM rect/source 正确。 |
| W07 光标/删除/Unicode | 正文及每类表各格首尾点击、Tab/Shift+Tab，逐字输入中文、空格、`\\`；Backspace/Delete 后检查源与所属格。Unicode 使用 `中文 A😀 é 👩‍💻`（含 combining、代理对、ZWJ），不得留下半 surrogate/错误拆分，行为对照普通富文本。不误删表结构，删空整表后首格再次退格应与普通一致，整表删除一次 Ctrl+Z/Y 可逆。拍摄闪烁光标的真实像素，不仅检查 selection 存在。 |
| W08 方向键 | 对普通小文件先记录每格内容首尾的 ArrowLeft/Right 逐键落点，再在大文件重复；覆盖三类表正反完整遍历、表头跨行、前后文、Unicode grapheme、上下键与折行、Shift 选区、Ctrl+方向键。空格一键跨格不在隐藏 padding 停靠，不改源/history。普通基准的“后文开头左移越过表到前文末尾”须实际记录，不能凭直觉修改规则。源码模式仍按源码移动。 |
| W09 原生拖选/矩形 | 实际按住左键跨格正反向/整行/部分矩形拖选，按住未释放时截图；单格文字拖选、代码文字拖选及跨视口长选区另测。比较普通 CellSelection 与大文件矩形高亮，块外无整行条带，拖选中排版不跳。右键保留矩形，复制/剪切/粘贴/清空与一次 Ctrl+Z/Y 对照普通；记录当前 head-only 复制边界，不把“复制源码”行片段空输出伪报完整 TSV。失焦/切笔记/返回不留残影。 |
| W10 Ctrl 全格式族 | 真键盘 Ctrl+B/I/Shift+S/E/L，分别选中文字、空光标、跨行、嵌套、格式外输入；每个命令 Ctrl+Z/Y 验全源。Ctrl+=/- 验正文→H6→…→H1 与完整反向及端点；Ctrl+1～9 槽位、Ctrl+Shift+Enter 快速菜单核对配置。设置中各族改键/停用/恢复默认并重启验证，旧 TipTap 默认不得旁路执行，自定义键只触发一次；不能仅测加粗。Windows 标签显示 Ctrl，平台真实为 win32；Windows 键不得替代 Ctrl。 |
| W11 三模式共享历史 | 在富文本输入 A、源码改 B、分栏两侧依次改 C/D，再来回切三模式及笔记；焦点留在编辑器按 Ctrl+Z 逐项逆序直到原文，Ctrl+Y 完整重做。覆盖一次 IME、格式、矩形替换、图片插入；无丢历史/串笔记/模式切换造历史。另在文件树聚焦做临时文件删除/撤销，编辑器 Ctrl+Z 不应误撤文件操作。每一步保存内容快照与磁盘实际落盘对比。 |
| W12 系统 clipboard text/html | 仅授权隔离剪贴板：记事本复制测试 Unicode→Looma Ctrl+V；Looma 普通复制/复制源码→记事本对比。用浏览器本地自造 HTML 页原生 Ctrl+C 复制标题、嵌套格式、链接、列表、表格到 Looma（记录 text/html 实际存在的测试格式，不转储其他 clipboard）。确认转 Markdown、布局、完整源码与重开；跨视口全选复制必须含未挂载尾部。原生菜单粘贴也测；无需改变系统 clipboard 的 DOM DataTransfer 不能替代此项。 |
| W13 系统 clipboard files/screenshot | Explorer 复制测试 PNG 文件 Ctrl+C→Looma Ctrl+V，并用测试 PNG 真实拖入；用截图工具/Win+Shift+S 截取自造色块→Ctrl+V，分别检查 Windows files 与 bitmap 路径。实际 assets 文件存在、相对路径可重开、PNG 解码正确；文件复制/拖入与原 PNG 字节相同，截图应与本次生成 bitmap 内容对应（不同编码不强求原 PNG hash）。缩放、title/width、复制/删除/一次撤销重做通过。Markdown 不出现新增 `data:image/...;base64,` 或 `blob:`；不打印 Base64 全文。HTML 内嵌 data 图片应拒绝并中文提示，不冒充截图导入成功。 |
| W14 保存/关闭/恢复冲突 | 工作空间与外部文件各测自动保存、Ctrl+S、重开，完整 bytes 对比；富文本刚输入立刻关标签/窗口/退出，覆盖保存/放弃/取消（以出现的真实确认流程为准），取消保留现场。保存进行中继续输入不能丢字。仅杀指定隔离测试实例 PID，重启验证未保存草稿；另在应用退出后由记事本改临时磁盘文件，恢复草稿时不得静默覆盖外部修改，分别测取消与明确覆盖。若自动保存太快没捕获 dirty 窗口，记录 untested/blocked；不得伪造 renderer API 或关闭真实安全机制凑通过。 |
| W15 安装包 MD 关联 | Explorer `.md`“打开方式”有 Looma；安装前后默认程序不被强抢（NSIS 只注册 OpenWith）。测试冷启动/运行中、中文空格路径、同名不同目录、多文件、重复打开脏文档只聚焦不覆盖；外部文件不被导入工作空间，原位置 Ctrl+S 可重开。仅声明 `.md`，不要以脚本 argv 模拟证明 Explorer 注册成功。 |
| W16 卸载保留数据 | 最后在测试账户正常退出、记录工作空间/外部文件/assets、实际隔离 Looma appData/userData 的路径与字节清单；通过系统卸载入口移除本轮安装包，保存退出结果与截图。`deleteAppDataOnUninstall:false` 应保留用户数据和笔记，OpenWith 项应移除且原默认程序不被破坏；按清单回读 hash，必要时重装确认数据可读。不要清理用户数据来制造干净结果。 |
| W17 性能/长期补验 | 下面可直接运行的 endurance 最少 600000ms，保留实际时长、阶段、堆/RSS/DOM/GC 后增长、CPU 与大替换历史结果；另从已安装 UI 连续 10 分钟输入/滚动/切三模式/保存并定时观察进程内存，二者分列。恢复草稿 CPU/自动保存峰值无法分离就写未知，不把整体 CPU 归因于草稿。安装 UI 的可响应性与任何 budget 失败如实报告，不复用其他平台数字。 |

## 5. 已有脚本：哪些可直接补跑，哪些不能当 Windows 命令

共同前置：仓库依赖已安装，`$HOME/.hermes/cache/scratch` **父目录必须先建**（脚本 mkdtemp 不会递归建父级）；串行执行，不与 HMR/其他 agent 构建争抢。所有脚本结果仅为自动化层证据，不能填 W05/W06 原生 IME 或 W12/W13 系统剪贴板 pass。

**可直接补跑（仍需在 Windows 实际验证，不预承诺跨平台成功）：**

```powershell
npx electron scripts/verify-continuous-endurance.cjs 2>&1 | Tee-Object (Join-Path $Run 'endurance.log')
$Code = $LASTEXITCODE; "endurance exit=$Code"
```

该脚本自行固定构建，无需 Vite；默认 600000ms，支持 `LOOMA_ENDURANCE_MS`，低于十分钟只算诊断。其键盘分支按 process.platform 选择 Ctrl，但依然是隐藏窗口/CDP，不是安装版或系统输入法。

**有条件可跑：** 构建后 `npx electron scripts/verify-continuous-recovery-stress.cjs` 走冻结 main/preload/dist 和真实 IPC，非 Vite。它调用 `fs.symlinkSync(...,'dir')`；Windows 无目录符号链接权限/开发者模式时可能 EPERM，应 blocked，不擅自提权或修改脚本。本文件不要求为此打开开发者模式。保存真实退出码、ARTIFACTS/results；冷进程不等于冷磁盘缓存，强杀不等于断电。

**不能原样作为 Windows 原生验收，先保留现状：**

- `verify-continuous-{composition,features,media,media-loading,references,table-selection,clipboard,performance}.cjs` 及 `verify-table-{arrow-parity,backslash,editing-parity}.cjs` 依赖 Vite 5189 的隔离 fixture；所用 `rich-text-parity.browser.html`、`chunked-editor.browser.html`、`continuous-media.browser.html`、`continuous-references.browser.html` 都硬编码 `platform:'darwin'`。即使在 Windows exit 0，也不能证明 Windows Ctrl/真实主进程路径。
- `verify-continuous-clipboard.cjs`、`verify-continuous-performance.cjs`、`verify-continuous-media-ipc.cjs` 另有硬编码 CDP `modifiers:4`（Meta）；`verify-table-editing-parity.cjs` 使用 `['meta']`/`['meta','shift']`。不能机械改为 Windows 通过或把结果计为 native。
- `verify-continuous-media-ipc.cjs` 默认 build 版真实 IPC，`--dev-renderer` 才使用 Vite；但其 Meta 撤销及合成 File.path/DOM 事件使它**不能原样作为 Windows native media/clipboard 验收**。不省略失败断言。
- composition/backslash 等使用 `Input.imeSetComposition` / `Input.insertText`；注释里的 native 是 Chromium DOM，不证明微软拼音候选窗。
- 若另获授权移植 harness，记录修改前后 diff/hash、真实 win32 preload、Ctrl 修饰与权限条件，独立报告为“Windows 自动化回归”，仍须完成前台手工矩阵。本轮不要改脚本。Vite 的真实启动命令是 `npx vite --mode test --host 127.0.0.1 --port 5189`，不是虚构的 Windows 验收 CLI。

原生 Ctrl 实现核查点：`src/preload/index.ts` 暴露 `process.platform`；`platform-shortcuts.ts` 非 darwin 要求 Ctrl 且非 Meta；`editor-shortcuts.ts` 五格式/标题/九槽位匹配配置；`app-shortcuts.ts` 文件作用域 Ctrl+Z/Y；`ChunkedMarkdownEditor.vue` 的 Mod-z/Mod-Shift-z/Mod-y 共享 history。代码存在不代表 Windows 已验证。

## 6. 回传文件与判定

复制相邻 `large-file-editor-windows-results.template.json` 到 `$Run/results.json` 后填实测；模板本身不改。每个 W 项可拆子结果，必须写出字体/主题/表型/模式覆盖，不能用部分通过覆盖未测组合。

- `pass`：所有该行必要子场景有实际证据且满足预期；`fail`：已运行并违反预期；`blocked`：授权/环境/工具阻断（写原因与解除条件）；`untested`：没有执行。缺截图/原生候选证据或关键 byte 对比不得 pass。
- 保留每次失败、独立重跑及其结果，不以最后一次成功覆盖原失败。状态统计从最终 JSON 程序计算，任何 fail/blocked/untested 都不能称“Windows 完整通过”。不把已有 Mac 测试数量相加。
- `$Run` 外的 profile/日志可只回传受控路径；确认所有证据只含测试数据。不上传完整真实剪贴板、账号信息或隐私日志。
- 完成时 `Stop-Transcript`；回传 **results.json 绝对路径、证据目录绝对路径、安装包路径/hash/版本/架构、源码前后清单、失败/阻断列表与复现步骤**。必须明确哪些是安装应用原生操作，哪些是隐藏 Electron/CDP 辅助；本交接文件本身不构成任何 Windows 通过结论。
