// Local-only release staging. Native architecture/signing/smoke gates belong to CI.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

const MANIFESTS = ['windows-x64-manifest.json', 'macos-arm64-manifest.json']
const fail = (message) => { throw new Error(message) }

export function validateVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    fail('Version must be an exact stable N.N.N version')
  }
  return version
}

export function safeBasename(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    fail(`Unsafe artifact basename: ${String(name)}`)
  }
  return name
}

export function expectedArtifacts({ platform, arch, version }) {
  validateVersion(version)
  if (platform === 'win32' && arch === 'x64') {
    const installer = `Looma-${version}-Setup.exe`
    return { platform, arch, version, manifest: MANIFESTS[0], metadata: 'latest.yml',
      payloads: [installer], required: [installer, `${installer}.blockmap`, 'latest.yml'], optional: [] }
  }
  if (platform === 'darwin' && arch === 'arm64') {
    const dmg = `Looma-${version}-arm64.dmg`
    const zip = `Looma-${version}-arm64.zip`
    // ArchiveTarget in builder 26 emits an external ZIP blockmap. Keep it when
    // present, without requiring it from builders which embed the ZIP blockmap.
    return { platform, arch, version, manifest: MANIFESTS[1], metadata: 'latest-mac.yml',
      payloads: [dmg, zip], required: [dmg, `${dmg}.blockmap`, zip, 'latest-mac.yml'], optional: [`${zip}.blockmap`] }
  }
  fail(`Unsupported platform/architecture: ${platform}/${arch}`)
}

async function regularFile(directory, name) {
  safeBasename(name)
  const file = path.join(directory, name)
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`Not a regular artifact file: ${name}`)
  if (!Number.isSafeInteger(stat.size) || stat.size <= 0) fail(`Empty or invalid artifact: ${name}`)
  return { file, bytes: stat.size }
}

async function digest(directory, name, algorithm, encoding) {
  const { file, bytes } = await regularFile(directory, name)
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return { bytes, hash: hash.digest(encoding) }
}

function sameNames(actual, expected, label) {
  if (new Set(actual).size !== actual.length) fail(`Duplicate ${label}`)
  if (actual.length !== expected.length || expected.some(name => !actual.includes(name))) {
    fail(`Unexpected or missing ${label}: expected ${expected.join(', ')}; got ${actual.join(', ')}`)
  }
}

export async function validateUpdateMetadata({ source, platform, arch, version }) {
  const spec = expectedArtifacts({ platform, arch, version })
  const { file } = await regularFile(source, spec.metadata)
  const metadata = yaml.load(await readFile(file, 'utf8'), { schema: yaml.JSON_SCHEMA })
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('Invalid update YAML')
  if (metadata.version !== version) fail(`Update YAML version mismatch: ${spec.metadata}`)
  if (!Array.isArray(metadata.files)) fail('Missing update YAML files')
  const names = metadata.files.map(entry => safeBasename(entry?.url))
  sameNames(names, spec.payloads, 'update YAML files')
  for (const entry of metadata.files) {
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0) fail(`Invalid YAML size: ${entry.url}`)
    if (typeof entry.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(entry.sha512)) {
      fail(`Invalid YAML sha512: ${entry.url}`)
    }
    const actual = await digest(source, entry.url, 'sha512', 'base64')
    if (actual.bytes !== entry.size) fail(`YAML size mismatch: ${entry.url}`)
    if (actual.hash !== entry.sha512) fail(`YAML sha512 mismatch: ${entry.url}`)
  }
  safeBasename(metadata.path)
  const legacy = metadata.files.find(entry => entry.url === metadata.path)
  if (!legacy || legacy.sha512 !== metadata.sha512) fail('Update YAML path/sha512 mismatch')
  return metadata
}

async function directoryNames(directory) {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Not a regular directory: ${directory}`)
  return readdir(directory)
}

export async function collectReleaseArtifacts({ source, destination, platform, arch, version }) {
  const spec = expectedArtifacts({ platform, arch, version })
  const sourceNames = await directoryNames(source)
  const selected = [...spec.required, ...spec.optional.filter(name => sourceNames.includes(name))].sort()
  await validateUpdateMetadata({ source, platform, arch, version })
  const files = []
  for (const name of selected) {
    const { bytes, hash } = await digest(source, name, 'sha256', 'hex')
    files.push({ name, bytes, sha256: hash })
  }
  // Never mix a new release with stale output or overwrite a previous staging run.
  await mkdir(destination, { recursive: true })
  if ((await directoryNames(destination)).length) fail('Destination must be empty')
  const manifest = { schemaVersion: 1, platform, arch, version, files }
  for (const { name, bytes, sha256 } of files) {
    await copyFile(path.join(source, name), path.join(destination, name))
    const copied = await digest(destination, name, 'sha256', 'hex')
    if (copied.bytes !== bytes || copied.hash !== sha256) fail(`Artifact changed during collection: ${name}`)
  }
  await writeFile(path.join(destination, spec.manifest), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  return manifest
}

export async function verifyReleaseArtifacts({ source, version }) {
  validateVersion(version)
  const names = await directoryNames(source)
  const expected = [...MANIFESTS]
  const claimed = new Set()
  for (const [index, manifestName] of MANIFESTS.entries()) {
    const { file } = await regularFile(source, manifestName)
    const manifest = JSON.parse(await readFile(file, 'utf8'))
    if (!manifest || manifest.schemaVersion !== 1 || manifest.version !== version) fail(`Manifest version/schema mismatch: ${manifestName}`)
    const platform = index === 0 ? 'win32' : 'darwin'
    const arch = index === 0 ? 'x64' : 'arm64'
    if (manifest.platform !== platform || manifest.arch !== arch) fail(`Manifest platform/architecture mismatch: ${manifestName}`)
    const spec = expectedArtifacts({ platform, arch, version })
    if (!Array.isArray(manifest.files)) fail(`Missing manifest files: ${manifestName}`)
    const entries = manifest.files.map(entry => safeBasename(entry?.name))
    const optional = spec.optional.filter(name => entries.includes(name))
    sameNames(entries, [...spec.required, ...optional], 'manifest entries')
    for (const entry of manifest.files) {
      if (claimed.has(entry.name)) fail(`Duplicate artifact claim: ${entry.name}`)
      claimed.add(entry.name)
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        fail(`Invalid manifest integrity entry: ${entry.name}`)
      }
      const actual = await digest(source, entry.name, 'sha256', 'hex')
      if (actual.bytes !== entry.bytes || actual.hash !== entry.sha256) fail(`Manifest integrity mismatch: ${entry.name}`)
      expected.push(entry.name)
    }
    await validateUpdateMetadata({ source, platform, arch, version })
  }
  sameNames(names.filter(name => name !== 'SHA256SUMS'), expected, 'release assets')
  // A prior sums file is not trusted, but must not be a link or directory.
  if (names.includes('SHA256SUMS')) await regularFile(source, 'SHA256SUMS')
  const lines = []
  for (const name of expected.sort()) {
    const { hash } = await digest(source, name, 'sha256', 'hex')
    lines.push(`${hash}  ${name}`)
  }
  const sums = `${lines.join('\n')}\n`
  await writeFile(path.join(source, 'SHA256SUMS'), sums)
  return { version, files: expected, sums }
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...flags] = args
  if (!['collect', 'verify'].includes(command)) fail('Usage: release-artifacts.mjs collect|verify --version VERSION --source DIR [--platform win32|darwin --arch x64|arm64 --destination DIR]')
  const allowed = command === 'collect' ? ['platform', 'arch', 'version', 'source', 'destination'] : ['version', 'source']
  const options = {}
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index].startsWith('--') ? flags[index].slice(2) : ''
    if (!allowed.includes(key) || Object.hasOwn(options, key) || !flags[index + 1] || flags[index + 1].startsWith('--')) fail(`Invalid CLI option: ${flags[index]}`)
    options[key] = flags[index + 1]
  }
  if (allowed.some(key => !options[key])) fail(`Required options: ${allowed.join(', ')}`)
  const result = command === 'collect' ? await collectReleaseArtifacts(options) : await verifyReleaseArtifacts(options)
  console.log(JSON.stringify(result, null, 2))
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Release artifact validation failed: ${error.message}`); process.exitCode = 1 })
}
