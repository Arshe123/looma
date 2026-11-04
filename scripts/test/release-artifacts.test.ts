import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import {
  collectReleaseArtifacts, expectedArtifacts, main, safeBasename,
  validateUpdateMetadata, validateVersion, verifyReleaseArtifacts,
} from '../release-artifacts.mjs'

const version = '1.6.1'
const roots: string[] = []
const script = fileURLToPath(new URL('../release-artifacts.mjs', import.meta.url))
async function temporaryDirectory() {
  // Synthetic unit-test fixtures only; never installers or native acceptance evidence.
  const parent = path.join(os.homedir(), '.hermes/cache/scratch')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, 'looma-release-artifacts-test-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(platform = 'win32', externalZipBlockmap = false) {
  const root = await temporaryDirectory()
  const source = path.join(root, 'source')
  const destination = path.join(root, 'collected')
  await mkdir(source)
  const arch = platform === 'win32' ? 'x64' : 'arm64'
  const spec = expectedArtifacts({ platform, arch, version })
  const selected = [...spec.required, ...(externalZipBlockmap ? spec.optional : [])]
  for (const name of selected.filter(name => name !== spec.metadata)) {
    await writeFile(path.join(source, name), `Synthetic unit-test bytes: ${name}\n`)
  }
  const files = []
  for (const name of spec.payloads) {
    const bytes = await readFile(path.join(source, name))
    files.push({ url: name, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') })
  }
  const preferred = files.find(file => file.url.endsWith('.zip')) || files[0]
  const metadata = { version, files, path: preferred.url, sha512: preferred.sha512, releaseDate: '2026-01-01T00:00:00.000Z' }
  await writeFile(path.join(source, spec.metadata), yaml.dump(metadata))
  return { root, source, destination, platform, arch, version, spec, metadata }
}
async function rewriteMetadata(f: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(path.join(f.source, f.spec.metadata), yaml.dump(f.metadata))
}
async function aggregate() {
  const windows = await fixture()
  const mac = await fixture('darwin')
  const source = path.join(windows.root, 'merged')
  await mkdir(source)
  for (const f of [windows, mac]) {
    await collectReleaseArtifacts(f)
    for (const name of await readdir(f.destination)) {
      await copyFile(path.join(f.destination, name), path.join(source, name))
    }
  }
  return { source, version, windows, mac }
}
async function mutateManifest(source: string, name: string, change: (value: any) => void) {
  const file = path.join(source, name)
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  change(manifest)
  await writeFile(file, JSON.stringify(manifest))
}

describe('release artifact contracts', () => {
  it.each(['v1.6.1', '1.6', '1.6.1-beta', '1.6.1+build', '01.6.1', '1.6.1\n', '', undefined])('rejects non-stable exact version %s', value => {
    expect(() => validateVersion(value)).toThrow(/version/i)
  })
  it('accepts exact stable versions', () => {
    expect(validateVersion('0.0.0')).toBe('0.0.0')
    expect(validateVersion(version)).toBe(version)
  })
  it.each(['../evil.exe', 'x/y', 'x\\y', 'C:evil', '/evil', 'https://evil', '%2e%2e', '.', '..', 'x\ny', undefined])('rejects unsafe basename %s', value => {
    expect(() => safeBasename(value)).toThrow(/basename/)
  })
  it.each([['win32', 'arm64'], ['darwin', 'x64'], ['linux', 'x64']])('rejects unsupported target %s/%s', (platform, arch) => {
    expect(() => expectedArtifacts({ platform, arch, version })).toThrow(/Unsupported/)
  })
})

describe('collectReleaseArtifacts', () => {
  it.each(['win32', 'darwin'])('collects only explicit %s files and an integrity manifest', async platform => {
    const f = await fixture(platform)
    await writeFile(path.join(f.source, 'old-installer.exe'), 'old')
    await writeFile(path.join(f.source, 'builder-debug.yml'), 'debug')
    await mkdir(path.join(f.source, 'win-unpacked'))
    const manifest = await collectReleaseArtifacts(f)
    expect((await readdir(f.destination)).sort()).toEqual([...f.spec.required, f.spec.manifest].sort())
    expect(manifest).toMatchObject({ schemaVersion: 1, platform, arch: f.arch, version })
    for (const entry of manifest.files) {
      const bytes = await readFile(path.join(f.destination, entry.name))
      expect(entry.bytes).toBe(bytes.length)
      expect(entry.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    }
  })
  it('retains an external mac ZIP blockmap when the builder emitted one', async () => {
    const f = await fixture('darwin', true)
    const result = await collectReleaseArtifacts(f)
    expect(result.files.map(entry => entry.name)).toContain(f.spec.optional[0])
  })
  it('rejects a nonempty destination without overwriting it', async () => {
    const f = await fixture()
    await mkdir(f.destination)
    await writeFile(path.join(f.destination, 'keep'), 'original')
    await expect(collectReleaseArtifacts(f)).rejects.toThrow(/empty/)
    expect(await readFile(path.join(f.destination, 'keep'), 'utf8')).toBe('original')
  })
  it('requires every declared artifact including blockmaps', async () => {
    const f = await fixture()
    await rm(path.join(f.source, f.spec.required[1]))
    await expect(collectReleaseArtifacts(f)).rejects.toThrow()
  })
  it('rejects directories masquerading as artifacts', async () => {
    const f = await fixture()
    await rm(path.join(f.source, f.spec.required[1]))
    await mkdir(path.join(f.source, f.spec.required[1]))
    await expect(collectReleaseArtifacts(f)).rejects.toThrow(/regular/)
  })
  it('rejects zero-byte blockmaps', async () => {
    const f = await fixture()
    await writeFile(path.join(f.source, f.spec.required[1]), '')
    await expect(collectReleaseArtifacts(f)).rejects.toThrow(/Empty/)
  })
})

describe('updater YAML validation', () => {
  it.each(['wrong-version', 'missing-version', 'unsafe-url', 'duplicate-url', 'unknown-url', 'missing-files', 'missing-reference', 'wrong-size', 'bad-size', 'wrong-hash', 'bad-hash', 'unsafe-path', 'wrong-path-hash'])('rejects %s', async kind => {
    const f = await fixture()
    const m: any = f.metadata
    if (kind === 'wrong-version') m.version = '1.6.0'
    if (kind === 'missing-version') delete m.version
    if (kind === 'unsafe-url') m.files[0].url = '../escape.exe'
    if (kind === 'duplicate-url') m.files.push({ ...m.files[0] })
    if (kind === 'unknown-url') m.files[0].url = 'other.exe'
    if (kind === 'missing-files') delete m.files
    if (kind === 'missing-reference') await rm(path.join(f.source, m.files[0].url))
    if (kind === 'wrong-size') m.files[0].size += 1
    if (kind === 'bad-size') m.files[0].size = '123'
    if (kind === 'wrong-hash') m.files[0].sha512 = createHash('sha512').update('wrong').digest('base64')
    if (kind === 'bad-hash') m.files[0].sha512 = 'invalid'
    if (kind === 'unsafe-path') m.path = 'https://example.com/installer.exe'
    if (kind === 'wrong-path-hash') m.sha512 = 'wrong'
    await rewriteMetadata(f)
    await expect(validateUpdateMetadata(f)).rejects.toThrow()
  })
  it('rejects duplicate YAML mapping keys', async () => {
    const f = await fixture()
    await writeFile(path.join(f.source, f.spec.metadata), 'version: 1.6.1\nversion: 1.6.0\n')
    await expect(validateUpdateMetadata(f)).rejects.toThrow(/duplicated/)
  })
  it('requires both mac payload references', async () => {
    const f = await fixture('darwin')
    f.metadata.files.pop()
    await rewriteMetadata(f)
    await expect(validateUpdateMetadata(f)).rejects.toThrow(/missing/)
  })
})

describe('merged release verification', () => {
  it('accepts and hashes the external ZIP blockmap when supplied by a mac builder', async () => {
    const f = await aggregate()
    const mac = await fixture('darwin', true)
    await collectReleaseArtifacts(mac)
    for (const name of await readdir(mac.destination)) {
      await copyFile(path.join(mac.destination, name), path.join(f.source, name))
    }
    expect((await verifyReleaseArtifacts(f)).files).toContain(mac.spec.optional[0])
  })
  it('rejects a required file omitted from the manifest even when present on disk', async () => {
    const f = await aggregate()
    await mutateManifest(f.source, f.windows.spec.manifest, m => { m.files.pop() })
    await expect(verifyReleaseArtifacts(f)).rejects.toThrow(/missing manifest entries/)
  })
  it('rejects an undeclared ZIP blockmap in the merged directory', async () => {
    const f = await aggregate()
    await writeFile(path.join(f.source, f.mac.spec.optional[0]), 'undeclared blockmap')
    await expect(verifyReleaseArtifacts(f)).rejects.toThrow(/release assets/)
  })
  it('verifies both manifests and generates deterministic SHA256SUMS including the manifests', async () => {
    const f = await aggregate()
    const result = await verifyReleaseArtifacts(f)
    const lines = result.sums.trim().split('\n')
    expect(lines.length).toBe(f.windows.spec.required.length + f.mac.spec.required.length + 2)
    for (const line of lines) {
      const [hash, name] = line.split('  ')
      expect(hash).toBe(createHash('sha256').update(await readFile(path.join(f.source, name))).digest('hex'))
    }
    expect(result.files).toContain('windows-x64-manifest.json')
    expect(result.files).toContain('macos-arm64-manifest.json')
    expect(result.files).not.toContain('SHA256SUMS')
    await writeFile(path.join(f.source, 'SHA256SUMS'), 'stale sums')
    expect((await verifyReleaseArtifacts(f)).sums).toBe(result.sums)
    expect(await readFile(path.join(f.source, 'SHA256SUMS'), 'utf8')).toBe(result.sums)
  })
  it.each(['extra', 'nested', 'missing-manifest', 'missing-artifact', 'tamper', 'yaml-tamper', 'duplicate-entry', 'cross-platform', 'wrong-version', 'wrong-arch', 'unknown-entry', 'unsafe-entry', 'invalid-hash', 'invalid-bytes'])('fails closed on %s', async kind => {
    const f = await aggregate()
    if (kind === 'extra') await writeFile(path.join(f.source, 'old.exe'), 'old')
    if (kind === 'nested') await mkdir(path.join(f.source, 'artifact-download'))
    if (kind === 'missing-manifest') await rm(path.join(f.source, f.mac.spec.manifest))
    if (kind === 'missing-artifact') await rm(path.join(f.source, f.windows.spec.required[0]))
    if (kind === 'tamper') await writeFile(path.join(f.source, f.windows.spec.required[1]), 'tampered blockmap')
    if (kind === 'yaml-tamper') await writeFile(path.join(f.source, 'latest.yml'), 'version: 0.0.0')
    if (['duplicate-entry', 'cross-platform', 'wrong-version', 'wrong-arch', 'unknown-entry', 'unsafe-entry', 'invalid-hash', 'invalid-bytes'].includes(kind)) {
      await mutateManifest(f.source, f.windows.spec.manifest, m => {
        if (kind === 'duplicate-entry') m.files.push({ ...m.files[0] })
        if (kind === 'cross-platform') { m.platform = 'darwin'; m.arch = 'arm64' }
        if (kind === 'wrong-version') m.version = '1.6.0'
        if (kind === 'wrong-arch') m.arch = 'arm64'
        if (kind === 'unknown-entry') m.files[0].name = 'other.exe'
        if (kind === 'unsafe-entry') m.files[0].name = '../escape.exe'
        if (kind === 'invalid-hash') m.files[0].sha256 = 'bad'
        if (kind === 'invalid-bytes') m.files[0].bytes = -1
      })
    }
    await expect(verifyReleaseArtifacts(f)).rejects.toThrow()
    expect(await readdir(f.source)).not.toContain('SHA256SUMS')
  })
  it('revalidates YAML even if a manifest was rewritten to match invalid metadata', async () => {
    const f = await aggregate()
    const metadata = path.join(f.source, 'latest.yml')
    const bytes = Buffer.from('version: 0.0.0\nfiles: []\n')
    await writeFile(metadata, bytes)
    await mutateManifest(f.source, f.windows.spec.manifest, m => {
      const entry = m.files.find((entry: any) => entry.name === 'latest.yml')
      entry.bytes = bytes.length
      entry.sha256 = createHash('sha256').update(bytes).digest('hex')
    })
    await expect(verifyReleaseArtifacts(f)).rejects.toThrow(/YAML version/)
  })
})

describe('CLI', () => {
  it('collects and verifies via the actual node entry point', async () => {
    const f = await aggregate()
    const destination = path.join(f.windows.root, 'cli-collected')
    const collected = JSON.parse(execFileSync(process.execPath, [script, 'collect', '--platform', 'win32', '--arch', 'x64', '--version', version, '--source', f.windows.source, '--destination', destination], { encoding: 'utf8' }))
    expect(collected.version).toBe(version)
    const verified = JSON.parse(execFileSync(process.execPath, [script, 'verify', '--version', version, '--source', f.source], { encoding: 'utf8' }))
    expect(verified.files).toContain('latest-mac.yml')
    expect(await readFile(path.join(f.source, 'SHA256SUMS'), 'utf8')).toBe(verified.sums)
  })
  it.each([[], ['verify'], ['verify', '--version', version, '--source', 'x', '--unknown', 'x'], ['verify', '--version', version, '--version', version, '--source', 'x'], ['collect', '--platform']])('rejects malformed arguments %j', async (...values) => {
    // it.each spreads array rows into arguments; recover the full argv row.
    await expect(main(values)).rejects.toThrow()
  })
  it('returns a nonzero process exit on invalid arguments', () => {
    const result = spawnSync(process.execPath, [script, 'verify', '--version', 'v1.6.1', '--source', '.'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('validation failed')
  })
})
