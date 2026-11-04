import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import yaml from 'js-yaml'
import { collectReleaseArtifacts, expectedArtifacts, verifyReleaseArtifacts } from '../release-artifacts.mjs'
import { assertRemoteAssets, createGitHubClient, loadReleaseAssets, main, parseChecksums, publicationFailureMessage, publishRelease, releaseNotes, validatePublishEnvironment } from '../publish-release.mjs'

const version = '1.6.1'
const sha = 'a'.repeat(40)
const env = { GITHUB_REPOSITORY: 'Arshe123/looma', GITHUB_SHA: sha, GITHUB_REF_NAME: version, GITHUB_TOKEN: 'synthetic-test-token' }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const hash = (bytes: Buffer | string, algorithm = 'sha256', encoding: any = 'hex') => createHash(algorithm).update(bytes).digest(encoding)

async function fixture() {
  const parent = path.join(os.homedir(), '.hermes/cache/scratch')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, 'looma-publisher-test-'))
  roots.push(root)
  const source = path.join(root, 'aggregate')
  await mkdir(source)
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64']]) {
    const raw = path.join(root, platform)
    const destination = path.join(root, `${platform}-stage`)
    await mkdir(raw)
    const spec = expectedArtifacts({ platform, arch, version })
    for (const name of spec.required.filter(name => name !== spec.metadata)) await writeFile(path.join(raw, name), `Synthetic bytes only: ${name}`)
    const files = []
    for (const name of spec.payloads) {
      const bytes = await readFile(path.join(raw, name))
      files.push({ url: name, size: bytes.length, sha512: hash(bytes, 'sha512', 'base64') })
    }
    const preferred = files.find(file => file.url.endsWith('.zip')) || files[0]
    await writeFile(path.join(raw, spec.metadata), yaml.dump({ version, files, path: preferred.url, sha512: preferred.sha512 }))
    await collectReleaseArtifacts({ source: raw, destination, platform, arch, version })
    for (const name of await readdir(destination)) await copyFile(path.join(destination, name), path.join(source, name))
  }
  await verifyReleaseArtifacts({ source, version })
  const changelogPath = path.join(root, 'changeLog.md')
  await writeFile(changelogPath, `## ${version}\n\n### Fixes\n\n- Synthetic test note.\n\n## 1.6.0\nOld note`)
  return { source, version, changelogPath, env }
}

function mockGitHub(assets: any[], opts: any = {}) {
  let release: any = opts.existing === false ? null : { id: 7, tag_name: version, target_commitish: sha, name: version, body: opts.body, draft: !opts.published, prerelease: false }
  const remote: any[] = opts.initial || []
  let tagChecks = 0
  const calls: any[] = []
  const fetchImpl = vi.fn(async (raw: string, init: any) => {
    const url = new URL(raw)
    calls.push({ url, ...init })
    const response = (data: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) })
    expect(['api.github.com', 'uploads.github.com']).toContain(url.hostname)
    expect(url.protocol).toBe('https:')
    expect(init.redirect).toBe('error')
    if (url.pathname.endsWith('/releases/latest')) {
      const count = calls.filter(call => call.url.pathname.endsWith('/releases/latest')).length
      if (opts.latestMissing) return response({}, 404)
      return response({ tag_name: opts.latest || (opts.advanceLatest && count > 1 ? '1.6.2' : 'v1.6.0'), draft: false, prerelease: false })
    }
    if (url.pathname.includes('/commits/')) {
      tagChecks++
      return response({ sha: opts.badTag || (opts.moveTag && tagChecks > 1) ? 'b'.repeat(40) : sha })
    }
    if (url.pathname.endsWith('/releases') && init.method === 'GET') return response(release ? [release] : [])
    if (url.pathname.endsWith('/releases') && init.method === 'POST') {
      release = { id: 7, ...JSON.parse(init.body) }
      return response(release, 201)
    }
    if (url.pathname.endsWith('/assets')) {
      if (init.method === 'GET') {
        if (opts.digestReadbackMismatch && remote.length === assets.length) return response(remote.map((asset, index) => index ? asset : { ...asset, digest: `sha256:${'0'.repeat(64)}` }))
        const result = opts.readbackMismatch && remote.length === assets.length ? remote.slice(1) : remote
        return response(result)
      }
      if (opts.uploadFails) return response({ message: 'SECRET must not be logged' }, 500)
      const name = url.searchParams.get('name')
      const bytes = init.body
      remote.push({ name, size: bytes.length, digest: `sha256:${hash(bytes)}`, state: 'uploaded' })
      return response(remote[remote.length - 1], 201)
    }
    if (init.method === 'PATCH') {
      release = { ...release, ...JSON.parse(init.body) }
      if (opts.publicMismatch) release.prerelease = true
      return response(release)
    }
    if (init.method === 'GET' && url.pathname.endsWith('/releases/7')) return response(release)
    throw new Error(`Unexpected mock HTTP path ${url.pathname}`)
  })
  return { fetchImpl, calls, get release() { return release }, get remote() { return remote } }
}
async function setup(opts: any = {}) {
  const f = await fixture()
  const assets = await loadReleaseAssets(f)
  const body = releaseNotes(await readFile(f.changelogPath, 'utf8'), version)
  const api = mockGitHub(assets, { body, ...opts })
  return { f, assets, api }
}
const remoteAsset = (asset: any) => ({ name: asset.name, size: asset.size, digest: `sha256:${asset.sha256}`, state: 'uploaded' })
const published = (api: any) => api.calls.some((call: any) => call.method === 'PATCH')

describe('publisher pure contracts', () => {
  it('reports controlled gate failures without printing arbitrary exceptions', () => {
    let failure: unknown
    try { validatePublishEnvironment({ version, env: { ...env, GITHUB_TOKEN: '' } }) } catch (error) { failure = error }
    expect(publicationFailureMessage(failure)).toContain('GITHUB_TOKEN is required')
    expect(publicationFailureMessage(new Error('private transport header'))).not.toContain('private transport header')
  })
  it.each([
    { GITHUB_REF_NAME: 'v1.6.1' }, { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_SHA: 'abc' }, { GITHUB_TOKEN: '' },
  ])('rejects invalid environment %j', changed => {
    expect(() => validatePublishEnvironment({ version, env: { ...env, ...changed } })).toThrow()
  })
  it.each(['v1.6.1', '01.6.1', '1.6.1-beta', '1.6.1\n'])('rejects nonstable version %s', value => {
    expect(() => validatePublishEnvironment({ version: value, env: { ...env, GITHUB_REF_NAME: value } })).toThrow()
  })
  it.each([`${'a'.repeat(64)}  ../private`, `${'a'.repeat(64)}  SHA256SUMS`, `${'a'.repeat(64)}  safe\n${'a'.repeat(64)}  safe`, ''])('rejects unsafe/duplicate checksums %s', text => {
    expect(() => parseChecksums(text)).toThrow()
  })
  it('extracts only exact version and does not invent signing/testing claims', () => {
    const notes = releaseNotes('## 1.6.1\nnew\n## 1.6.0\nold', version)
    expect(notes).toContain('new')
    expect(notes).not.toContain('\nold')
    expect(notes).toContain('不代表代码签名或 Apple 公证')
    expect(notes).toContain('本次不包含 Intel Mac 安装包')
    expect(() => releaseNotes('## 1.6.10\nwrong', version)).toThrow()
    expect(() => releaseNotes('## 1.6.1\n', version)).toThrow()
  })
  it('rejects foreign request paths before calling transport', async () => {
    const fetchImpl = vi.fn()
    await expect(createGitHubClient({ token: 'fake', fetchImpl }).request('GET', 'https://evil.test')).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('paginates without dropping the second page', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => Array.from({ length: 100 }, (_, id) => ({ id })) }).mockResolvedValueOnce({ ok: true, json: async () => [{ id: 100 }] })
    const list = await createGitHubClient({ token: 'fake', fetchImpl }).list('/repos/Arshe123/looma/releases')
    expect(list).toHaveLength(101)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it.each([[], [{ name: 'extra' }], [{ name: 'file', size: 1, state: 'uploaded' }]])('rejects incomplete/bad remote list %j', remote => {
    expect(() => assertRemoteAssets(remote, [{ name: 'file', size: 1, sha256: 'a'.repeat(64) }])).toThrow()
  })
  it('rejects malformed CLI flags without HTTP', async () => {
    await expect(main(['--version', version, '--source', 'x', '--source', 'y'])).rejects.toThrow(/Usage/)
  })
})

describe('read-only local validation', () => {
  it('loads every asset and preserves supplied checksums', async () => {
    const f = await fixture()
    const sums = await readFile(path.join(f.source, 'SHA256SUMS'))
    const assets = await loadReleaseAssets(f)
    expect(assets.map(asset => asset.name)).toEqual((await readdir(f.source)).sort())
    expect(await readFile(path.join(f.source, 'SHA256SUMS'))).toEqual(sums)
  })
  it.each(['tamper', 'missing', 'extra', 'directory', 'duplicate', 'unlisted-private'])('rejects %s locally before HTTP', async mode => {
    const f = await fixture()
    const sumsPath = path.join(f.source, 'SHA256SUMS')
    const text = await readFile(sumsPath, 'utf8')
    if (mode === 'tamper') await writeFile(path.join(f.source, `Looma-${version}-Setup.exe`), 'tampered')
    if (mode === 'missing') await rm(path.join(f.source, 'windows-x64-manifest.json'))
    if (mode === 'extra') await writeFile(sumsPath, `${text}${'a'.repeat(64)}  missing.exe\n`)
    if (mode === 'directory') await mkdir(path.join(f.source, 'directory'))
    if (mode === 'duplicate') await writeFile(sumsPath, `${text}${text.split('\n')[0]}\n`)
    if (mode === 'unlisted-private') await writeFile(path.join(f.source, 'private.key'), 'private')
    const fetchImpl = vi.fn()
    await expect(publishRelease({ ...f, fetchImpl })).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('rejects even a checksummed unknown private file', async () => {
    const f = await fixture()
    await writeFile(path.join(f.source, 'private.key'), 'private')
    const sumPath = path.join(f.source, 'SHA256SUMS')
    await writeFile(sumPath, `${await readFile(sumPath, 'utf8')}${hash('private')}  private.key\n`)
    await expect(loadReleaseAssets(f)).rejects.toThrow(/Unexpected/)
  })
})

describe('draft to public state machine (mock HTTP only)', () => {
  it('creates draft, uploads, reads back integrity, rechecks tag and publishes exact id', async () => {
    const { f, assets, api } = await setup({ existing: false })
    const result = await publishRelease({ ...f, fetchImpl: api.fetchImpl })
    expect(result.assets).toHaveLength(assets.length)
    expect(api.release).toMatchObject({ draft: false, prerelease: false, target_commitish: sha, tag_name: version })
    expect(api.calls.filter(call => call.url.pathname.includes('/commits/'))).toHaveLength(2)
    expect(api.calls.filter(call => call.method === 'POST' && call.url.hostname === 'uploads.github.com')).toHaveLength(assets.length)
    const creation = api.calls.find(call => call.method === 'POST' && call.url.pathname.endsWith('/releases'))!
    expect(JSON.parse(creation.body)).toMatchObject({ draft: true, prerelease: false, generate_release_notes: false })
  })
  it('reuses matching partial draft without overwriting', async () => {
    const { f, assets } = await setup()
    const api = mockGitHub(assets, { body: releaseNotes(await readFile(f.changelogPath, 'utf8'), version), initial: [remoteAsset(assets[0])] })
    await publishRelease({ ...f, fetchImpl: api.fetchImpl })
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(assets.length - 1)
    expect(api.calls.some(call => call.method === 'DELETE')).toBe(false)
  })
  it.each(['badTag', 'published', 'uploadFails', 'readbackMismatch', 'digestReadbackMismatch', 'moveTag'])('fails closed for %s without publishing', async mode => {
    const { f, api } = await setup({ [mode]: true })
    await expect(publishRelease({ ...f, fetchImpl: api.fetchImpl })).rejects.toThrow()
    expect(published(api)).toBe(false)
  })
  it.each(['size', 'digest', 'missingDigest', 'extra', 'duplicate'])('rejects existing draft asset %s', async mode => {
    const { f, assets } = await setup()
    const asset: any = remoteAsset(assets[0])
    if (mode === 'size') asset.size++
    if (mode === 'digest') asset.digest = `sha256:${'0'.repeat(64)}`
    if (mode === 'missingDigest') delete asset.digest
    if (mode === 'extra') asset.name = 'private.key'
    const initial = mode === 'duplicate' ? [asset, asset] : [asset]
    const api = mockGitHub(assets, { body: releaseNotes(await readFile(f.changelogPath, 'utf8'), version), initial })
    await expect(publishRelease({ ...f, fetchImpl: api.fetchImpl })).rejects.toThrow()
    expect(published(api)).toBe(false)
    expect(api.calls.some(call => call.method === 'POST')).toBe(false)
  })
  it('fails verification if final release is not stable', async () => {
    const { f, api } = await setup({ publicMismatch: true })
    await expect(publishRelease({ ...f, fetchImpl: api.fetchImpl })).rejects.toThrow(/identity/)
  })
  it.each(['1.6.1', 'v1.6.1', '1.6.2', '1.10.0', 'invalid'])('rejects latest %s before publication', async latest => {
    const { f, api } = await setup({ latest })
    await expect(publishRelease({ ...f, fetchImpl: api.fetchImpl })).rejects.toThrow()
    expect(published(api)).toBe(false)
    expect(api.calls.some(call => call.method === 'POST')).toBe(false)
  })
  it('rejects a concurrently advanced latest at final gate', async () => {
    const { f, api } = await setup({ advanceLatest: true })
    await expect(publishRelease({ ...f, fetchImpl: api.fetchImpl })).rejects.toThrow(/newer/)
    expect(published(api)).toBe(false)
    expect(api.release.draft).toBe(true)
  })
  it('allows first release when latest is 404', async () => {
    const { f, api } = await setup({ latestMissing: true })
    await publishRelease({ ...f, fetchImpl: api.fetchImpl })
    expect(published(api)).toBe(true)
  })
  it('honors cancellation without publication', async () => {
    const { f, api } = await setup()
    const controller = new AbortController()
    controller.abort()
    await expect(publishRelease({ ...f, fetchImpl: api.fetchImpl, signal: controller.signal })).rejects.toThrow()
    expect(published(api)).toBe(false)
  })
})
