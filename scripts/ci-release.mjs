import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const architectures = { AMD64: 'x64', x86_64: 'x64', ARM64: 'arm64', aarch64: 'arm64', arm64: 'arm64' }

export function validateVersion({ version, lockVersion, lockRootVersion, changeLog, tag }) {
  if (!stableVersion.test(version)) throw new Error('Only stable N.N.N versions are supported')
  if (lockVersion !== version || lockRootVersion !== version) {
    throw new Error('package.json and both package-lock.json versions must match')
  }
  if (tag !== undefined && tag !== version) throw new Error('Tag must exactly match package.json version (without v)')
  const heading = new RegExp(`^##[ \\t]+${version.replaceAll('.', '\\.')}[ \\t]*\\r?$`, 'm')
  if (!heading.test(changeLog)) throw new Error(`Missing changeLog.md section for ${version}`)
  return version
}

export function assertNativeEnvironment(expected, actual) {
  const machine = architectures[actual.machine] || actual.machine
  const pythonArch = architectures[actual.pythonMachine] || actual.pythonMachine
  if (actual.platform !== expected.platform || actual.arch !== expected.arch || machine !== expected.arch) {
    throw new Error('Runner OS/CPU and Node architecture must match the native build target')
  }
  if (actual.pythonPlatform !== expected.platform || pythonArch !== expected.arch || actual.pythonBits !== 64) {
    throw new Error('Python architecture must match the native build target')
  }
}

export function binaryArchitectures(bytes) {
  if (bytes.length < 8) throw new Error('Truncated executable')
  if (bytes.subarray(0, 2).toString('ascii') === 'MZ') {
    if (bytes.length < 64) throw new Error('Truncated PE header')
    const offset = bytes.readUInt32LE(60)
    if (offset > bytes.length - 6 || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0') throw new Error('Invalid PE header')
    const machine = bytes.readUInt16LE(offset + 4)
    return machine === 0x8664 ? ['x64'] : machine === 0xaa64 ? ['arm64'] : ['unsupported-pe']
  }
  const magic = bytes.readUInt32BE(0)
  const name = type => type === 0x0100000c ? 'arm64' : type === 0x01000007 ? 'x64' : 'unsupported-mach-o'
  if (magic === 0xcffaedfe) return [name(bytes.readUInt32LE(4))]
  if (magic === 0xfeedfacf) return [name(bytes.readUInt32BE(4))]
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = bytes.readUInt32BE(4)
    const entrySize = magic === 0xcafebabe ? 20 : 32
    if (count < 1 || count > 32 || bytes.length < 8 + count * entrySize) throw new Error('Invalid fat Mach-O header')
    return Array.from({ length: count }, (_, index) => name(bytes.readUInt32BE(8 + index * entrySize)))
  }
  throw new Error('Unsupported executable format')
}

function command(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: root, encoding: 'utf8', windowsHide: true, ...options })
  if (result.error || result.status !== 0) throw new Error(`${file} failed: ${result.error?.message || result.stderr || result.status}`)
  return result.stdout.trim()
}

function prepare() {
  const scratch = path.join(os.homedir(), '.hermes', 'cache', 'scratch')
  fs.mkdirSync(scratch, { recursive: true })
  fs.mkdirSync(path.join(root, 'out'), { recursive: true })
  if (!process.env.GITHUB_ENV) throw new Error('prepare is only intended for GitHub Actions')
  fs.appendFileSync(process.env.GITHUB_ENV, `TMPDIR=${scratch}\nTMP=${scratch}\nTEMP=${scratch}\n`)
}

function version(tag, checkMain) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const value = validateVersion({
    version: pkg.version,
    lockVersion: lock.version,
    lockRootVersion: lock.packages[''].version,
    changeLog: fs.readFileSync(path.join(root, 'docs', 'changeLog.md'), 'utf8'),
    tag,
  })
  if (checkMain) command('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'])
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${value}\n`)
  console.log(`Validated release version ${value}`)
}

function environment(platform, arch) {
  const python = JSON.parse(command('uv', ['run', '--isolated', '--python', '3.12', 'python', '-c',
    'import json,platform,struct,sys; print(json.dumps([sys.platform,platform.machine(),struct.calcsize("P")*8]))']))
  assertNativeEnvironment({ platform, arch }, {
    platform: process.platform, arch: process.arch, machine: os.machine(),
    pythonPlatform: python[0], pythonMachine: python[1], pythonBits: python[2],
  })
  console.log(`Native runner, Node and Python verified: ${platform}/${arch}`)
}

function verifyPackage(platform, arch, strictSigning) {
  const output = path.join(root, 'out', 'make')
  const bundle = platform === 'win32'
    ? path.join(output, 'win-unpacked')
    : path.join(output, `mac-${arch}`, 'Looma.app')
  const executable = platform === 'win32'
    ? path.join(bundle, 'Looma.exe')
    : path.join(bundle, 'Contents', 'MacOS', 'Looma')
  const sidecar = platform === 'win32'
    ? path.join(bundle, 'resources', 'looma-agent-service', 'looma-agent-service.exe')
    : path.join(bundle, 'Contents', 'Resources', 'looma-agent-service', 'looma-agent-service')
  for (const file of [executable, sidecar]) {
    if (!binaryArchitectures(fs.readFileSync(file)).includes(arch)) throw new Error(`Wrong executable architecture: ${file}`)
  }
  command(sidecar, ['--packaging-self-test'], { timeout: 60_000 })
  if (platform === 'darwin') {
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
    if (strictSigning) {
      command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', bundle])
      command('/usr/bin/xcrun', ['stapler', 'validate', bundle])
    }
  } else if (strictSigning) {
    // Pass paths as environment data, never interpolate them into PowerShell code.
    for (const file of [executable, path.join(output, `Looma-${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}-Setup.exe`)]) {
      command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$s = Get-AuthenticodeSignature -LiteralPath $env:LOOMA_VERIFY_FILE; if ($s.Status -ne "Valid") { throw "Invalid Authenticode signature" }'],
      { env: { ...process.env, LOOMA_VERIFY_FILE: file } })
    }
  }
  console.log(`Packaged app and sidecar verified: ${platform}/${arch}; strict signing=${strictSigning}`)
}

export function main(args) {
  const [action, ...rest] = args
  const options = Object.fromEntries(rest.filter(value => value.startsWith('--') && value.includes('=')).map(value => value.slice(2).split('=')))
  if (action === 'prepare') return prepare()
  if (action === 'version') return version(options.tag, rest.includes('--check-main'))
  if (!['win32', 'darwin'].includes(options.platform) || !['x64', 'arm64'].includes(options.arch)) throw new Error('Specify supported --platform= and --arch=')
  if (action === 'environment') return environment(options.platform, options.arch)
  if (action === 'verify-package') return verifyPackage(options.platform, options.arch, process.env.REQUIRE_SIGNING === 'true')
  throw new Error('Unknown CI command')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
