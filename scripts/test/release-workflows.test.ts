import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { assertNativeEnvironment, binaryArchitectures, validateVersion } from '../ci-release.mjs'

const metadata = {
  version: '1.6.1', lockVersion: '1.6.1', lockRootVersion: '1.6.1',
  changeLog: '# 更新日志\n\n## 1.6.1\n\n测试版本\n', tag: '1.6.1',
}
const loadWorkflow = (name: string): any => yaml.load(fs.readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))

describe('release version gates', () => {
  it('accepts matching stable metadata and CRLF notes', () => {
    expect(validateVersion({ ...metadata, changeLog: metadata.changeLog.replaceAll('\n', '\r\n') })).toBe('1.6.1')
  })
  it.each(['v1.6.1', '1.6.1-beta', '01.6.1', '1.6.1\nmalicious', '1.6'])('rejects unsupported version %s', version => {
    expect(() => validateVersion({ ...metadata, version })).toThrow()
  })
  it.each(['lockVersion', 'lockRootVersion', 'tag'] as const)('rejects mismatched %s', field => {
    expect(() => validateVersion({ ...metadata, [field]: '1.6.0' })).toThrow()
  })
  it('does not accept the notes of a different or prefix-matching version', () => {
    expect(() => validateVersion({ ...metadata, changeLog: '## 1.6.10\nother release' })).toThrow()
  })
})

describe('native runtime gates', () => {
  const windows = { platform: 'win32', arch: 'x64', machine: 'AMD64', pythonPlatform: 'win32', pythonMachine: 'AMD64', pythonBits: 64 }
  it('accepts native Windows x64 and macOS arm64', () => {
    expect(() => assertNativeEnvironment({ platform: 'win32', arch: 'x64' }, windows)).not.toThrow()
    expect(() => assertNativeEnvironment({ platform: 'darwin', arch: 'arm64' }, {
      platform: 'darwin', arch: 'arm64', machine: 'arm64', pythonPlatform: 'darwin', pythonMachine: 'arm64', pythonBits: 64,
    })).not.toThrow()
  })
  it.each([
    { arch: 'arm64' }, { machine: 'ARM64' }, { pythonMachine: 'ARM64' }, { pythonBits: 32 }, { pythonPlatform: 'linux' },
  ])('rejects mixed native architectures %j', mismatch => {
    expect(() => assertNativeEnvironment({ platform: 'win32', arch: 'x64' }, { ...windows, ...mismatch })).toThrow()
  })
  it('reads a synthetic PE header without treating the NSIS x86 stub as x64', () => {
    const bytes = Buffer.alloc(80)
    bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(0x8664, 68)
    expect(binaryArchitectures(bytes)).toEqual(['x64'])
    bytes.writeUInt16LE(0x014c, 68)
    expect(binaryArchitectures(bytes)).not.toContain('x64')
    bytes.writeUInt32LE(100, 60)
    expect(() => binaryArchitectures(bytes)).toThrow()
  })
  it('reads synthetic arm64 and universal Mach-O headers', () => {
    const thin = Buffer.alloc(8)
    thin.writeUInt32LE(0xfeedfacf); thin.writeUInt32LE(0x0100000c, 4)
    expect(binaryArchitectures(thin)).toEqual(['arm64'])
    const fat = Buffer.alloc(48)
    fat.writeUInt32BE(0xcafebabe); fat.writeUInt32BE(2, 4)
    fat.writeUInt32BE(0x01000007, 8); fat.writeUInt32BE(0x0100000c, 28)
    expect(binaryArchitectures(fat)).toEqual(['x64', 'arm64'])
    expect(() => binaryArchitectures(fat.subarray(0, 12))).toThrow()
    expect(() => binaryArchitectures(Buffer.alloc(4))).toThrow()
  })
})

describe('GitHub workflow safety contract', () => {
  const ci = loadWorkflow('ci')
  const release = loadWorkflow('release')
  it('keeps main/PR verification separate from tag releases', () => {
    expect(ci.on.push.branches).toEqual(['main'])
    expect(ci.on.pull_request.branches).toEqual(['main'])
    expect(release.on.push.tags).toEqual(['[0-9]*.[0-9]*.[0-9]*'])
    expect(release.on.pull_request_target).toBeUndefined()
    expect(release.on.workflow_run).toBeUndefined()
    expect(release.concurrency['cancel-in-progress']).toBe(false)
  })
  it('grants write permission only to aggregate publishing', () => {
    expect(ci.permissions).toEqual({ contents: 'read' })
    expect(release.permissions).toEqual({ contents: 'read' })
    expect(release.jobs.publish.permissions).toEqual({ contents: 'write' })
    expect(release.jobs.publish.needs).toEqual(['validate', 'build'])
    expect(release.jobs.validate.if).toBe("github.repository == 'Arshe123/looma'")
    expect(JSON.stringify(ci)).not.toContain('secrets.')
    expect(JSON.stringify(ci)).not.toContain('publish-release.mjs')
  })
  it('retries an existing tag using the main workflow and pins every job to the resolved commit', () => {
    expect(release.on.workflow_dispatch?.inputs?.tag).toMatchObject({ required: true, type: 'string' })
    expect(release.jobs.validate.outputs.sha).toBe('${{ steps.target.outputs.sha }}')
    expect(release.jobs.validate.outputs.tag).toBe('${{ steps.target.outputs.tag }}')
    const steps = release.jobs.validate.steps
    const target = steps.findIndex((step: any) => step.id === 'target')
    expect(target).toBeGreaterThan(0)
    const version = steps.findIndex((step: any) => step.id === 'version')
    expect(target).toBeLessThan(version)
    expect(steps[version].env.RELEASE_TAG).toBe('${{ steps.target.outputs.tag }}')
    for (const job of [release.jobs.build, release.jobs.publish]) {
      expect(job.steps.find((step: any) => step.uses?.startsWith('actions/checkout@')).with.ref)
        .toBe('${{ needs.validate.outputs.sha }}')
    }
    const publish = release.jobs.publish.steps.find((step: any) => step.run?.includes('publish-release.mjs'))
    expect(publish.env.RELEASE_SHA).toBe('${{ needs.validate.outputs.sha }}')
    expect(publish.env.RELEASE_TAG).toBe('${{ needs.validate.outputs.tag }}')
    expect(publish.run).toContain('GITHUB_REF_NAME="$RELEASE_TAG" GITHUB_SHA="$RELEASE_SHA" node ')
  })
  it('resolves only existing stable tags on main and rejects unsafe retry targets before running tag code', () => {
    const target = release.jobs.validate.steps.find((step: any) => step.id === 'target')
    expect(target).toBeDefined()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-release-target-'))
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
      return result.stdout.trim()
    }
    try {
      git('init', '-b', 'main')
      git('config', 'user.email', 'test@example.invalid')
      git('config', 'user.name', 'Release Test')
      git('commit', '--allow-empty', '-m', 'tag source')
      const sha = git('rev-parse', 'HEAD')
      git('tag', '-a', '1.6.1', '-m', 'annotated release')
      git('commit', '--allow-empty', '-m', 'workflow runner fix')
      const main = git('rev-parse', 'HEAD')
      git('update-ref', 'refs/remotes/origin/main', main)
      git('checkout', '--orphan', 'unrelated')
      git('commit', '--allow-empty', '-m', 'not on main')
      git('tag', '1.6.2')
      const run = (event: string, tag: string, ref = 'refs/heads/main', eventSha = main) => {
        git('checkout', '--detach', main)
        const output = path.join(root, 'output')
        fs.writeFileSync(output, '')
        const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', target.run], {
          cwd: root, encoding: 'utf8', env: { ...process.env,
            RELEASE_EVENT: event, RELEASE_TAG: tag, WORKFLOW_REF: ref,
            EVENT_SHA: eventSha, GITHUB_OUTPUT: output,
          },
        })
        return { status: result.status, output: fs.readFileSync(output, 'utf8'), head: git('rev-parse', 'HEAD') }
      }
      expect(run('workflow_dispatch', '1.6.1')).toEqual({ status: 0, output: `tag=1.6.1\nsha=${sha}\n`, head: sha })
      expect(run('push', '1.6.1', 'refs/tags/1.6.1', sha).status).toBe(0)
      for (const [event, tag, ref, eventSha] of [
        ['workflow_dispatch', 'v1.6.1', 'refs/heads/main', main],
        ['workflow_dispatch', '1.6.1\n', 'refs/heads/main', main],
        ['workflow_dispatch', '1.6.3', 'refs/heads/main', main],
        ['workflow_dispatch', '1.6.2', 'refs/heads/main', main],
        ['workflow_dispatch', '1.6.1', 'refs/tags/1.6.1', main],
        ['push', '1.6.1', 'refs/tags/1.6.1', main],
      ]) {
        const result = run(event, tag, ref, eventSha)
        expect(result.status).not.toBe(0)
        expect(result.output).toBe('')
        expect(result.head).toBe(main)
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('uses native runner pairs and identical toolchain pins', () => {
    expect(ci.jobs.verify.strategy.matrix.include).toEqual([
      { id: 'windows-x64', runner: 'windows-2022', platform: 'win32', arch: 'x64' },
      { id: 'macos-arm64', runner: 'macos-26', platform: 'darwin', arch: 'arm64' },
    ])
    for (const job of [ci.jobs.verify, release.jobs.build]) {
      const mac = job.strategy.matrix.include.find((target: any) => target.id === 'macos-arm64')
      expect(mac).toMatchObject({ runner: 'macos-26', platform: 'darwin', arch: 'arm64' })
      expect(mac.runner).not.toMatch(/-(?:large|xlarge|intel)$/)
      const node = job.steps.find((step: any) => step.uses?.startsWith('actions/setup-node@'))
      const uv = job.steps.find((step: any) => step.uses?.startsWith('astral-sh/setup-uv@'))
      expect(node.with['node-version']).toBe('22.23.4')
      expect(uv.with.version).toBe('0.11.21')
      expect(job.steps.some((step: any) => step.run?.includes('vitest run'))).toBe(true)
    }
  })
  it('pins all third-party actions to immutable full commit hashes', () => {
    for (const workflow of [ci, release]) for (const job of Object.values(workflow.jobs) as any[]) {
      for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/)
    }
  })
  it('does not upload from build jobs and downloads only the two release payloads', () => {
    const build = release.jobs.build.steps.find((step: any) => step.name === 'Build native installer without publishing')
    expect(build.run).toContain('--publish never')
    expect(JSON.stringify(release.jobs.build)).not.toContain('--publish always')
    expect(JSON.stringify(release.jobs.build)).not.toContain('GITHUB_TOKEN')
    const downloads = release.jobs.publish.steps.filter((step: any) => step.uses?.startsWith('actions/download-artifact@'))
    expect(downloads.map((step: any) => step.with.name)).toEqual(['release-windows-x64', 'release-macos-arm64'])
    const steps = release.jobs.publish.steps
    expect(steps.findIndex((step: any) => step.run?.includes('release-artifacts.mjs verify')))
      .toBeLessThan(steps.findIndex((step: any) => step.run?.includes('publish-release.mjs')))
  })
  const runInstallerShell = (platform: string, signing: string, credentials = {}) => {
    const step = release.jobs.build.steps.find((step: any) => step.name === 'Build native installer without publishing')
    // Run the real workflow shell (system Bash 3.2 on macOS), replacing only npm
    // so this test checks exact arguments without building or publishing an installer.
    return spawnSync(process.platform === 'darwin' ? '/bin/bash' : 'bash', [
      '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
      `npm() { printf 'ARG:%s\\n' "$@"; printf 'CERT:%s\\n' "\${CSC_LINK-<unset>}"; }\n${step.run}`,
    ], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env,
        BUILD_SCRIPT: platform === 'darwin' ? 'make:mac' : 'make:win',
        BUILD_PLATFORM: platform, BUILD_ARCH: platform === 'darwin' ? 'arm64' : 'x64',
        REQUIRE_SIGNING: signing,
        CSC_LINK: 'test-fixture', CSC_KEY_PASSWORD: 'test-fixture',
        APPLE_ID: 'test-fixture', APPLE_APP_SPECIFIC_PASSWORD: 'test-fixture', APPLE_TEAM_ID: 'test-fixture',
        ...credentials,
      },
    })
  }
  it.each([
    ['darwin', '', []],
    ['win32', '', []],
    ['darwin', 'true', ['--config.forceCodeSigning=true', '--config.mac.notarize=true']],
    ['win32', 'true', ['--config.forceCodeSigning=true']],
  ])('executes installer shell for %s with signing=%s without adding empty arguments', (platform, signing, options) => {
    const result = runInstallerShell(platform as string, signing as string)
    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('CERT:test-fixture\n')
    expect(result.stdout.split('\n').filter(line => line.startsWith('ARG:')).map(line => line.slice(4))).toEqual([
      'run', platform === 'darwin' ? 'make:mac' : 'make:win', '--', '--publish', 'never',
      platform === 'darwin' ? '--arm64' : '--x64', ...options,
    ])
  })
  it.each(['darwin', 'win32'])('unsets an empty certificate secret before invoking the %s packager', platform => {
    const result = runInstallerShell(platform, '', { CSC_LINK: '', CSC_KEY_PASSWORD: '' })
    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('CERT:<unset>\n')
    expect(result.stdout).toContain('ARG:never\n')
  })
  it.each([
    ['darwin', { CSC_LINK: '' }],
    ['win32', { CSC_KEY_PASSWORD: '' }],
    ['darwin', { APPLE_TEAM_ID: '' }],
  ])('does not invoke npm when strict signing credentials are missing for %s: %j', (platform, credentials) => {
    const result = runInstallerShell(platform, 'true', credentials)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('::error::')
    expect(result.stdout).not.toContain('ARG:')
  })
})
