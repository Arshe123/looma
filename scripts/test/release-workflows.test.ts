import fs from 'node:fs'
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
  it('uses native runner pairs and identical toolchain pins', () => {
    expect(ci.jobs.verify.strategy.matrix.include).toEqual([
      { id: 'windows-x64', runner: 'windows-2022', platform: 'win32', arch: 'x64' },
      { id: 'macos-arm64', runner: 'macos-15', platform: 'darwin', arch: 'arm64' },
    ])
    for (const job of [ci.jobs.verify, release.jobs.build]) {
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
})
