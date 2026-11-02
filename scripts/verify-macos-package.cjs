// Local macOS artifact inspection only; never installs, publishes or opens user notes.
// node scripts/verify-macos-package.cjs /absolute/Looma.dmg /absolute/Looma.zip
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const exec = promisify(execFile)
const scratchBase = path.join(os.homedir(), '.hermes/cache/scratch')
fs.mkdirSync(scratchBase, { recursive: true })
const directory = fs.mkdtempSync(path.join(scratchBase, 'looma-macos-artifact-check-'))
const report = { startedAt: new Date().toISOString(), artifactDirectory: directory, commands: [], failures: [], untested: ['Installed application launch and Finder association registration', 'Native OS clipboard', 'Developer ID signing, notarization and Gatekeeper distribution trust'] }
const save = () => fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
async function command(file, args, options = {}) {
  const entry = { file, args, startedAt: new Date().toISOString() }
  report.commands.push(entry)
  try {
    const result = await exec(file, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options })
    Object.assign(entry, { exitCode: 0, stdout: result.stdout, stderr: result.stderr })
    save()
    return result
  } catch (error) {
    Object.assign(entry, { exitCode: error.code, stdout: error.stdout, stderr: error.stderr, error: String(error) })
    save()
    throw error
  }
}
async function sha256(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function main() {
  assert.equal(process.platform, 'darwin', '只能在 macOS 上检查 macOS 安装产物')
  assert.equal(process.argv.length, 4, '需要 DMG 和 ZIP 两个绝对路径')
  const [dmg, zip] = process.argv.slice(2)
  for (const file of [dmg, zip]) assert.ok(path.isAbsolute(file) && fs.statSync(file).isFile(), '产物必须是现有文件的绝对路径')
  assert.equal(path.extname(dmg), '.dmg')
  assert.equal(path.extname(zip), '.zip')
  report.before = { dmg: { path: dmg, bytes: fs.statSync(dmg).size, sha256: await sha256(dmg) }, zip: { path: zip, bytes: fs.statSync(zip).size, sha256: await sha256(zip) } }
  await command('/usr/bin/hdiutil', ['verify', dmg])
  await command('/usr/bin/unzip', ['-t', '-q', zip])
  const mount = path.join(directory, 'mounted')
  fs.mkdirSync(mount)
  let attached = false
  try {
    await command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg])
    attached = true
    const app = path.join(mount, 'Looma.app')
    await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
    await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(app, 'Contents/Frameworks/Electron Framework.framework')])
    const info = JSON.parse((await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')])).stdout)
    const expectedVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version
    assert.equal(info.CFBundleIdentifier, 'com.looma')
    assert.equal(info.CFBundleShortVersionString, expectedVersion)
    assert.ok(info.CFBundleDocumentTypes.some(type => type.CFBundleTypeExtensions?.includes('md') && type.LSHandlerRank === 'Alternate'))
    report.bundle = { version: info.CFBundleShortVersionString, id: info.CFBundleIdentifier, documentTypes: info.CFBundleDocumentTypes }
    const executable = path.join(app, 'Contents/MacOS', info.CFBundleExecutable)
    const sidecar = path.join(app, 'Contents/Resources/looma-agent-service/looma-agent-service')
    report.architectures = []
    for (const file of [executable, sidecar]) {
      const architecture = (await command('/usr/bin/file', ['-b', file])).stdout.trim()
      assert.match(architecture, new RegExp('\\b' + process.arch + '\\b'))
      assert.ok(fs.statSync(file).mode & 0o111, '可执行文件需保留执行权限')
      report.architectures.push({ file, architecture })
    }
    const signing = await command('/usr/bin/codesign', ['--display', '--verbose=4', app])
    report.signing = signing.stderr.split('\n').filter(line => /^(Signature=|TeamIdentifier=|Authority=)/.test(line))
    const home = path.join(directory, 'sidecar-home')
    fs.mkdirSync(home)
    await command(sidecar, ['--packaging-self-test'], { env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home, LOOMA_SETTINGS_PATH: path.join(home, 'settings.json'), RAG_SERVICE_EXTERNAL: '1', RAG_SERVICE_URL: 'http://127.0.0.1:1' } })
  } finally {
    if (attached) await command('/usr/bin/hdiutil', ['detach', mount])
  }
  report.after = { dmgSha256: await sha256(dmg), zipSha256: await sha256(zip) }
  assert.equal(report.after.dmgSha256, report.before.dmg.sha256)
  assert.equal(report.after.zipSha256, report.before.zip.sha256)
}
main().then(() => { report.exitCode = 0 }).catch(error => {
  report.exitCode = 1
  report.failures.push({ error: String(error), stack: error.stack })
  console.error(error)
}).finally(() => {
  report.completedAt = new Date().toISOString()
  save()
  console.log('MAC_ARTIFACT_EXIT=' + report.exitCode, 'REPORT=' + path.join(directory, 'report.json'))
  process.exitCode = report.exitCode
})
