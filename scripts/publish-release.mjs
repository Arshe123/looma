// Fail-closed aggregate publisher. No shell commands; HTTP is injectable for tests.
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expectedArtifacts, safeBasename, validateUpdateMetadata, validateVersion as validateArtifactVersion } from './release-artifacts.mjs'

function validateVersion(version) {
  validateArtifactVersion(version)
  if (version !== version.trim()) fail('Version must be an exact stable N.N.N version')
  return version
}

export const REPOSITORY = 'Arshe123/looma'
class ReleasePublicationError extends Error {}
const fail = message => { throw new ReleasePublicationError(message) }
export function publicationFailureMessage(error) {
  const detail = error instanceof ReleasePublicationError ? `: ${error.message}` : '; inspect workflow checks'
  return `Release publication failed${detail}. Any unpublished draft is retained.`
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const equalNames = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every(name => b.includes(name))

export function validatePublishEnvironment({ version, env }) {
  validateVersion(version)
  if (env.GITHUB_REPOSITORY !== REPOSITORY) fail('Unexpected GITHUB_REPOSITORY')
  if (env.GITHUB_REF_NAME !== version) fail('GITHUB_REF_NAME must equal the exact bare version')
  if (typeof env.GITHUB_SHA !== 'string' || env.GITHUB_SHA.length !== 40 || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA)) fail('GITHUB_SHA must be a full lowercase commit SHA')
  if (typeof env.GITHUB_TOKEN !== 'string' || !env.GITHUB_TOKEN.trim() || /[\r\n]/.test(env.GITHUB_TOKEN)) fail('GITHUB_TOKEN is required')
  return { version, repository: REPOSITORY, sha: env.GITHUB_SHA, token: env.GITHUB_TOKEN }
}

export function assertNewerVersion(version, latest) {
  validateVersion(version)
  if (latest === null) return
  const tag = latest?.tag_name
  if (typeof tag !== 'string' || latest.draft !== false || latest.prerelease !== false) fail('Invalid latest stable release')
  const current = tag.startsWith('v') ? tag.slice(1) : tag
  validateVersion(current)
  const requestedParts = version.split('.').map(BigInt)
  const currentParts = current.split('.').map(BigInt)
  for (let index = 0; index < 3; index++) {
    if (requestedParts[index] > currentParts[index]) return
    if (requestedParts[index] < currentParts[index]) fail('Requested version must be newer than latest stable release')
  }
  fail('Requested version must be newer than latest stable release')
}

export function parseChecksums(text) {
  const entries = new Map()
  for (const line of text.split('\n').filter(Boolean)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line)
    if (!match) fail('Invalid SHA256SUMS entry')
    const [, hash, name] = match
    safeBasename(name)
    if (name === 'SHA256SUMS' || entries.has(name)) fail('Duplicate or self-referencing SHA256SUMS entry')
    entries.set(name, hash)
  }
  if (!entries.size) fail('Empty SHA256SUMS')
  return entries
}

// Read-only verification: unlike the staging verifier, never regenerate supplied sums.
export async function loadReleaseAssets({ source, version }) {
  validateVersion(version)
  const directory = await lstat(source)
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail('Source must be a regular directory')
  const names = await readdir(source)
  const assets = []
  for (const name of names.sort()) {
    safeBasename(name)
    const file = path.join(source, name)
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) fail(`Not a nonempty regular release file: ${name}`)
    const bytes = await readFile(file)
    assets.push({ name, size: bytes.length, sha256: sha256(bytes), bytes })
  }
  const sums = assets.find(asset => asset.name === 'SHA256SUMS')
  if (!sums) fail('Missing SHA256SUMS')
  const entries = parseChecksums(sums.bytes.toString('utf8'))
  if (!equalNames([...entries.keys()], names.filter(name => name !== 'SHA256SUMS'))) fail('SHA256SUMS has extra or missing files')
  for (const asset of assets.filter(asset => asset !== sums)) {
    if (entries.get(asset.name) !== asset.sha256) fail(`SHA256SUMS mismatch: ${asset.name}`)
  }
  const expected = ['SHA256SUMS']
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64']]) {
    const spec = expectedArtifacts({ platform, arch, version })
    expected.push(spec.manifest)
    const manifestAsset = assets.find(asset => asset.name === spec.manifest)
    if (!manifestAsset) fail(`Missing manifest: ${spec.manifest}`)
    const manifest = JSON.parse(manifestAsset.bytes.toString('utf8'))
    if (manifest.schemaVersion !== 1 || manifest.version !== version || manifest.platform !== platform || manifest.arch !== arch || !Array.isArray(manifest.files)) fail('Manifest identity mismatch')
    const selected = [...spec.required, ...spec.optional.filter(name => names.includes(name))]
    if (!equalNames(manifest.files.map(file => file.name), selected)) fail('Manifest has extra or missing entries')
    for (const entry of manifest.files) {
      const asset = assets.find(asset => asset.name === entry.name)
      if (!asset || asset.size !== entry.bytes || asset.sha256 !== entry.sha256) fail('Manifest integrity mismatch')
    }
    expected.push(...selected)
    await validateUpdateMetadata({ source, platform, arch, version })
  }
  if (!equalNames(names, expected)) fail('Unexpected or missing release assets')
  return assets
}

export function releaseNotes(changelog, version) {
  validateVersion(version)
  const lines = changelog.replace(/\r\n/g, '\n').split('\n')
  const starts = lines.flatMap((line, index) => /^##\s+/.test(line) && line.trim().split(/\s+/)[1] === version ? [index] : [])
  if (starts.length !== 1) fail('Missing or duplicate changelog version section')
  const start = starts[0]
  let end = start + 1
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++
  if (!lines.slice(start + 1, end).join('\n').trim()) fail('Empty changelog version section')
  return `${lines.slice(start, end).join('\n').trim()}\n\n### 下载与校验\n\n- Windows：下载 x64 安装包（Setup.exe）。\n- macOS：下载适用于 Apple 芯片的 arm64 DMG 或 ZIP；本次不包含 Intel Mac 安装包。\n- SHA256SUMS 和平台清单用于校验文件完整性，不代表代码签名或 Apple 公证；签名状态请以实际安装包和构建记录为准。\n- 自动化构建与测试不等于安装版原生交互验收，输入法、剪贴板及安装卸载等场景仍需单独验证。\n`
}

export function assertRemoteAssets(remote, local, { complete = true } = {}) {
  if (!Array.isArray(remote)) fail('Invalid remote asset list')
  const seen = new Set()
  for (const asset of remote) {
    const expected = local.find(file => file.name === asset.name)
    if (seen.has(asset.name) || !expected) fail('Duplicate or unexpected remote asset')
    seen.add(asset.name)
    if (asset.state !== 'uploaded' || asset.size !== expected.size || asset.digest !== `sha256:${expected.sha256}`) fail(`Remote asset size/digest/state mismatch: ${expected.name}`)
  }
  if (complete && seen.size !== local.length) fail('Missing remote assets')
  return seen
}

export function createGitHubClient({ token, fetchImpl = globalThis.fetch, signal }) {
  async function request(method, pathname, { body, upload = false, allow404 = false } = {}) {
    const origin = upload ? 'https://uploads.github.com' : 'https://api.github.com'
    // Callers supply only repository-relative paths, never server-provided URLs.
    if (!pathname.startsWith(`/repos/${REPOSITORY}/`) || pathname.includes('..') || pathname.includes('#')) fail('Unsafe GitHub request path')
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    if (body !== undefined) headers['Content-Type'] = upload ? 'application/octet-stream' : 'application/json'
    let response
    try {
      response = await fetchImpl(`${origin}${pathname}`, { method, headers, redirect: 'error', signal, ...(body === undefined ? {} : { body: upload ? body : JSON.stringify(body) }) })
    } catch { fail('GitHub transport failed; any draft is retained') }
    if (allow404 && response.status === 404) return null
    if (!response.ok) fail(`GitHub ${method} failed (HTTP ${response.status}); any draft is retained`)
    try { return await response.json() } catch { fail('Invalid GitHub JSON response') }
  }
  async function list(pathname) {
    const all = []
    for (let page = 1; page <= 1000; page++) {
      const batch = await request('GET', `${pathname}?per_page=100&page=${page}`)
      if (!Array.isArray(batch)) fail('Invalid paginated GitHub response')
      all.push(...batch)
      if (batch.length < 100) return all
    }
    fail('GitHub pagination limit exceeded')
  }
  return { request, list }
}

function assertRelease(release, { version, sha, id, draft, body }) {
  if (!release || !Number.isSafeInteger(release.id) || release.id <= 0 || (id !== undefined && release.id !== id) || release.tag_name !== version || release.target_commitish !== sha || release.draft !== draft || release.prerelease !== false || release.body !== body) fail('Release identity/state/body mismatch')
}

export async function publishRelease({ version, source, env = process.env, fetchImpl = globalThis.fetch, changelogPath = 'docs/changeLog.md', signal }) {
  const config = validatePublishEnvironment({ version, env })
  const assets = await loadReleaseAssets({ source, version })
  const body = releaseNotes(await readFile(changelogPath, 'utf8'), version)
  const api = createGitHubClient({ token: config.token, fetchImpl, signal })
  const base = `/repos/${REPOSITORY}`
  const checkTag = async () => {
    const commit = await api.request('GET', `${base}/commits/${encodeURIComponent(`refs/tags/${version}`)}`)
    if (commit.sha !== config.sha) fail('Remote tag does not resolve to GITHUB_SHA')
  }
  const checkLatest = async () => assertNewerVersion(version, await api.request('GET', `${base}/releases/latest`, { allow404: true }))
  await checkTag()
  // Listing includes drafts for this token; tag lookup alone can miss drafts.
  const matches = (await api.list(`${base}/releases`)).filter(release => release.tag_name === version)
  if (matches.some(release => release.draft !== true)) fail('Published release already exists; refusing overwrite')
  if (matches.length > 1) fail('Multiple drafts exist for tag')
  await checkLatest()
  const release = matches[0] || await api.request('POST', `${base}/releases`, { body: { tag_name: version, target_commitish: config.sha, name: version, body, draft: true, prerelease: false, generate_release_notes: false } })
  assertRelease(release, { ...config, draft: true, body })
  const target = `${base}/releases/${release.id}`
  const existing = assertRemoteAssets(await api.list(`${target}/assets`), assets, { complete: false })
  for (const asset of assets) {
    if (existing.has(asset.name)) continue
    signal?.throwIfAborted()
    await api.request('POST', `${target}/assets?name=${encodeURIComponent(asset.name)}`, { body: asset.bytes, upload: true })
  }
  assertRelease(await api.request('GET', target), { ...config, id: release.id, draft: true, body })
  assertRemoteAssets(await api.list(`${target}/assets`), assets)
  await checkLatest()
  await checkTag()
  signal?.throwIfAborted()
  await api.request('PATCH', target, { body: { draft: false, prerelease: false, make_latest: 'true', tag_name: version, target_commitish: config.sha, name: version, body } })
  const published = await api.request('GET', target)
  assertRelease(published, { ...config, id: release.id, draft: false, body })
  assertRemoteAssets(await api.list(`${target}/assets`), assets)
  return { id: published.id, version, assets: assets.map(asset => asset.name) }
}

export async function main(args = process.argv.slice(2), options = {}) {
  const flags = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    if (!['--version', '--source'].includes(key) || Object.hasOwn(flags, key) || !args[i + 1] || args[i + 1].startsWith('--')) fail('Usage: publish-release.mjs --version VERSION --source DIR')
    flags[key] = args[i + 1]
  }
  if (!flags['--version'] || !flags['--source']) fail('Usage: publish-release.mjs --version VERSION --source DIR')
  return publishRelease({ ...options, version: flags['--version'], source: flags['--source'] })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController()
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort())
  main(process.argv.slice(2), { signal: controller.signal }).then(result => console.log(JSON.stringify(result))).catch(error => {
    // Do not print arbitrary exceptions: fetch implementations can include credentials.
    console.error(publicationFailureMessage(error))
    process.exitCode = 1
  })
}
