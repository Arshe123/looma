# Looma 自动构建与发布

## 范围与触发

- `.github/workflows/ci.yml`：PR 到 main、push main，以及手动运行；只验证，不发布、不读取签名 secrets。
- `.github/workflows/release.yml`：push 裸版本 tag，例如 `1.6.1`；不接受 `v1.6.1`、预发布版本。发布仅在 `Arshe123/looma` 执行。
- Windows x64 使用 `windows-2022`；macOS arm64 使用 `macos-15`。不使用会迁移的 `latest` 标签，也不把 x64 仿真计作 arm64 构建。
- Node 固定 `22.23.4`，uv 固定 `0.11.21`，Python 使用原生 `3.12`。工作流中的第三方 Actions 全部固定到经官方仓库核对的完整 commit SHA。
- CI 的成功不代表原生微软拼音、剪贴板、安装/卸载或 Gatekeeper 已人工验收；自动化结果与平台手工验收分开报告。

## 发布链路

1. 校验 tag、package.json、package-lock.json 的顶层版本及根 package 版本完全一致；要求 `docs/changeLog.md` 有该版本的二级标题，并要求 tag 的提交属于 main 历史。
2. Windows/macOS 在原生 runner 上分别验证 Node/Python/CPU 架构，运行 `npm ci`、lint、类型检查及全部 Vitest。
3. 分别执行 `npm run make:win -- --publish never --x64`、`npm run make:mac -- --publish never --arm64`。保留现有 premake 生命周期：构建 Python sidecar、自检、构建应用，再打包。不在并行任务中使用 `release:win` / `release:mac`。
4. 核查打包后 Electron 和 sidecar 的 PE/Mach-O 架构，再执行打包资源中的 sidecar `--packaging-self-test`。NSIS 引导 stub 是 x86，并不意味着其安装的应用不是 x64；架构检查针对实际 payload。
5. 仅收集明确的本版本安装包、blockmap 和更新 YAML；校验更新元数据中的版本、路径、大小和 SHA512，生成每个平台的 SHA256 清单。
6. 两个平台全部成功后，最终任务只下载 `release-windows-x64` 与 `release-macos-arm64`，不下载测试报告；核对两个清单、所有载荷，生成 `SHA256SUMS`。
7. 最终任务使用 GitHub 自动提供的 `GITHUB_TOKEN` 创建或恢复草稿，上传缺失附件，再读取远端附件列表、大小与服务器 SHA256 digest。全部一致后才公开正式 Release，并读取 Release 状态确认。

只有最终 publish job 有 `contents: write`；构建和验证任务只有 `contents: read`。checkout 不持久化凭据。发布失败不会回退成“部分成功”：安装包构建失败则不执行 publish，上传中途失败则保留未公开草稿供排查/重跑。

## 首次启用

1. 在 GitHub 仓库 Settings → Actions → General 确认允许 Actions，并允许所使用的官方及 astral-sh Actions。若组织策略禁止 `GITHUB_TOKEN` 写 contents，需要管理员允许最终发布任务所请求的权限；不必为此创建个人 PAT。
2. 把工作流、脚本、测试、本文档及版本/锁文件变更一同提交到 main。当前待发版本为 `1.6.1`，不要再创建已发布的 `1.6.0`。
3. push main 后查看 CI 的 Windows/macOS 两个 job；首轮可能需要重新下载依赖。
4. main 验证通过后，在同一提交创建并推送 `1.6.1` tag。Release 会重新测试 tag 指向的源码，不依赖另一条 CI 的旧结果。
5. 查看 Actions → Release，确认最终公开 Release 的附件齐全。不要手工提前公开流水线正在使用的草稿。

示例（仅由操作者在确认提交内容后执行，搭建过程不会自动执行）：

```bash
git push origin main
git tag 1.6.1
git push origin 1.6.1
```

后续升级可以使用 `npm version 1.6.2 --no-git-tag-version` 同步 package/lock，再补充 `docs/changeLog.md`、提交并推送相应 tag。流水线不自动改版本并回推，避免循环触发和不可审计的版本变动。

## 签名与公证

默认保持已有的可选签名策略；未启用严格检查时，构建会明确发出 warning，不能称为“已认证签名/公证发行”。macOS 的本地完整性 codesign 校验不等于 Developer ID 签名或 Gatekeeper 信任。客户端 macOS 更新仍保持当前手动下载安装策略。

要强制可信发行，在仓库 Settings → Secrets and variables → Actions 设置：

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Variable | `REQUIRE_SIGNING=true` | 开启严格签名/公证门禁 |
| Secret | `WIN_CSC_LINK` | Windows 签名证书，按 electron-builder 的 CSC_LINK 格式提供 |
| Secret | `WIN_CSC_KEY_PASSWORD` | Windows 证书密码 |
| Secret | `MAC_CSC_LINK` | macOS Developer ID 证书，按 CSC_LINK 格式提供 |
| Secret | `MAC_CSC_KEY_PASSWORD` | macOS 证书密码 |
| Secret | `APPLE_ID` | Apple 公证账户 |
| Secret | `APPLE_APP_SPECIFIC_PASSWORD` | Apple 公证专用密码 |
| Secret | `APPLE_TEAM_ID` | Apple Developer Team ID |

凭据只通过 GitHub Secrets 配置，不写进源码、日志、Release 附件或聊天。证书相关 secret 只在对应平台的打包步骤可用。严格模式缺少凭据会失败；Windows 核查应用与安装包 Authenticode 状态，macOS 核查 codesign、Gatekeeper 和 stapler。当前接入使用可导入证书方式；硬件令牌/云签名需按实际签名服务另行接入，不要为了跑通而关闭严格模式。

## 产物与重跑

- Release 附件含 Windows NSIS、macOS DMG/ZIP、对应更新元数据/blockmap、两个平台清单和 `SHA256SUMS`。不要省略 `latest.yml` 或 `latest-mac.yml`。
- GitHub Actions 测试报告与构建载荷保留 14 天；测试失败时仍尝试留存 JUnit 报告。
- 全局 release concurrency 不会主动打断正在上传的版本；短时间推送多个 tag 仍需留意 GitHub 对 pending run 的调度。发布器另外检查版本必须高于当前正式版，防止旧重跑倒退 latest。
- 重跑已有草稿时只补缺少的附件；同名附件 hash 不同、出现额外附件、服务器缺少 SHA256 digest、tag 指向变化或该版本已经公开，都会失败关闭，不覆盖已发布附件。
- 若草稿内已有错误附件，先核对日志及对应提交，再由有权限的操作者处理草稿；不要移动已公开 tag 来重发不同源码。已公开版本应修复后升新版本。
- 本地 Windows 无法证明 macOS runner 构建成功；首次真实 GitHub run、签名/公证和安装版原生交互验收应分别确认。

## 本地检查

```bash
node scripts/ci-release.mjs version
node scripts/ci-release.mjs environment --platform=win32 --arch=x64
npx vitest run scripts/test/release-workflows.test.ts scripts/test/release-artifacts.test.ts scripts/test/publish-release.test.ts
```

发布器 CLI 需要正式 tag 环境及 GitHub 写权限，不应用本地真实 token 做随意试跑。其上传、失败保持草稿和远端回读门禁由模拟传输的单元测试覆盖；这不冒充实际远端发布成功。
