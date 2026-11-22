import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Place, Scan } from '@chade/daemon'
import { countsOf } from '@chade/daemon'
import { parseConfig } from '../src/config.js'
import { NOT_FOUND, type Run } from '../src/exec.js'
import { grypeListArgs, readGrype } from '../src/grype.js'
import { parseImages } from '../src/images.js'
import { matchIds, mergeFindings, packageKey, plainVersion } from '../src/merge.js'
import { compareVersions, cycloneDx, osvArgs, osvImageArgs, purlOf, readOsvOutput, severityOf } from '../src/osv.js'
import { labelOf, linuxSide, machineTargets, parseProjectAssets, removeCommand, repositoryTargets, resolveNvm, unusedReason } from '../src/places.js'
import { security } from '../src/report.js'
import { readScan, renderScan, saveScan, scan, sizeScript } from '../src/scan.js'
import type { Host } from '../src/system.js'
import { versionOf } from '../src/tools.js'
import { readTrivy, trivyFolderArgs, trivyImageArgs, trivyListArgs } from '../src/trivy.js'

const fixture = (name: string) => readFile(join(import.meta.dirname, 'fixtures', name), 'utf8')
const DAY = 24 * 3600 * 1000

test('osv-scanner reads only what an install left, and keeps the list of packages on the machine', () => {
  const args = osvArgs({ folders: ['/r/a/node_modules', '/r/b/.terraform'], lists: ['/t/0.cdx.json'], offline: false })
  assert.deepEqual(args.slice(0, 2), ['scan', 'source'])
  assert.ok(args.includes('--no-ignore') && args.includes('--offline-vulnerabilities') && args.includes('--download-offline-databases'))
  assert.ok(args.includes('--x-no-default-plugins'))
  assert.deepEqual(args.slice(-5), ['-L', '/t/0.cdx.json', '-r', '/r/a/node_modules', '/r/b/.terraform'])
  assert.ok(!osvArgs({ folders: [], lists: [], offline: true }).includes('--download-offline-databases'))
})

test('the output of osv-scanner 2.7.1 gives each advisory once, with its fix, and a malicious package as such', async () => {
  const sources = readOsvOutput(await fixture('osv-scanner-2.7.1.json'))
  const all = sources.flatMap((source) => source.findings)
  const malicious = all.find((finding) => finding.package === '@zalastax/nolb-_extri')
  assert.equal(malicious?.malicious, true)
  assert.equal(malicious?.ids[0], 'MAL-2025-10000')
  // event-stream has no MAL record, and is known by its CWE-506.
  assert.equal(all.find((finding) => finding.package === 'event-stream')?.malicious, true)
  const lodash = all.find((finding) => finding.package === 'lodash' && finding.ids[0] === 'GHSA-29mw-wpgm-hmr9')
  assert.equal(lodash?.version, '4.17.15')
  assert.equal(lodash?.fixed, '4.17.21')
  assert.equal(lodash?.malicious, false)
  assert.equal(lodash?.severity, 'medium')
  const stdlib = all.find((finding) => finding.package === 'stdlib')
  assert.equal(stdlib?.ecosystem, 'Go')
  assert.equal(stdlib?.fixed, '1.26.11')
  assert.ok(sources.every((source) => source.packages.length > 0))
  assert.ok(all.every((finding) => finding.tools.join() === 'osv-scanner'))
  assert.ok(sources.some((source) => source.packages.includes('pkg:npm/lodash@4.17.15')))
  assert.deepEqual(readOsvOutput(''), [])
})

test('a severity is read from the CVSS score, from the level of GitHub otherwise', () => {
  assert.equal(severityOf('9.8', []), 'critical')
  assert.equal(severityOf('7.5', []), 'high')
  assert.equal(severityOf('5.3', []), 'medium')
  assert.equal(severityOf('2.1', []), 'low')
  assert.equal(severityOf('', [{ id: 'G', database_specific: { severity: 'MODERATE' } }]), 'medium')
  assert.equal(severityOf(undefined, [{ id: 'GO-1' }]), 'unknown')
})

test('versions compare as numbers, a release after its pre-releases', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('v1.2', '1.2.0'), 0)
  assert.equal(compareVersions('2.0.0-rc1', '2.0.0'), -1)
  assert.equal(compareVersions('1.27.0-0', '1.26.10'), 1)
})

test('a list names packages of every ecosystem by their purl, in a CycloneDX 1.5 every scanner reads', () => {
  const purls = [purlOf({ ecosystem: 'npm', name: '@scope/a', version: '1.0.0' }), purlOf({ ecosystem: 'NuGet', name: 'newtonsoft.json', version: '12.0.1' })]
  assert.deepEqual(purls, ['pkg:npm/%40scope/a@1.0.0', 'pkg:nuget/newtonsoft.json@12.0.1'])
  const list = JSON.parse(cycloneDx(purls)) as { specVersion: string; components: { name: string; version: string; purl: string }[] }
  assert.equal(list.specVersion, '1.5')
  assert.deepEqual(
    list.components.map((component) => [component.name, component.version, component.purl]),
    [
      ['@scope/a', '1.0.0', 'pkg:npm/%40scope/a@1.0.0'],
      ['newtonsoft.json', '12.0.1', 'pkg:nuget/newtonsoft.json@12.0.1'],
    ],
  )
})

test('the report of trivy 0.76.2 gives the findings of an image and an operating system past its end of life', async () => {
  const { findings, notes } = readTrivy(await fixture('trivy-0.76.2.json'))
  assert.ok(findings.length > 0)
  assert.ok(findings.every((finding) => finding.ecosystem !== '' && finding.ids[0] !== '' && !finding.malicious && finding.tools.join() === 'trivy'))
  assert.deepEqual(notes, ['alpine 3.18.12 is past its end of life, so its packages get no more fixes'])
  assert.ok(trivyImageArgs('sha256:abc', true).includes('--skip-java-db-update'))
  assert.equal(trivyImageArgs('sha256:abc', false).at(-1), 'sha256:abc')
})

test('trivy 0.76.2 reads what an install left, and gives the GHSA of each CVE, which the other scanners name it by', async () => {
  const { packages, findings } = readTrivy(await fixture('trivy-0.76.2-rootfs.json'))
  assert.deepEqual(packages, ['pkg:pypi/pip@24.0', 'pkg:pypi/urllib3@1.26.4'])
  assert.deepEqual(findings[0].ids, ['CVE-2025-8869', 'GHSA-4xh5-x5gv-qwph'])
  assert.equal(findings[0].fixed, '25.3')
  assert.deepEqual(trivyFolderArgs('/r/.venv', false).slice(0, 1), ['rootfs'])
  assert.ok(trivyFolderArgs('/r/.venv', false).includes('--list-all-pkgs'))
  assert.deepEqual(trivyListArgs('/t/0.cdx.json', false).slice(0, 1), ['sbom'])
})

test('grype 0.104.4 matches a list against its own database, each finding with its package and the CVE it relates to', async () => {
  const matches = readGrype(await fixture('grype-0.104.4.json'))
  const newtonsoft = matches.find((match) => match.finding.package === 'newtonsoft.json')
  assert.equal(newtonsoft?.key, 'pkg:nuget/newtonsoft.json@12.0.1')
  assert.deepEqual(newtonsoft?.finding.ids, ['GHSA-5crp-9r3c-p9vr', 'CVE-2024-21907'])
  assert.equal(newtonsoft?.finding.severity, 'high')
  assert.equal(newtonsoft?.finding.fixed, '13.0.1')
  assert.deepEqual(newtonsoft?.finding.tools, ['grype'])
  assert.deepEqual(grypeListArgs('/t/all.cdx.json').slice(0, 1), ['sbom:/t/all.cdx.json'])
  assert.deepEqual(osvImageArgs('/t/a.tar', true, true), ['scan', 'image', '--format', 'json', '--offline-vulnerabilities', '--archive', '/t/a.tar'])
})

test('one advisory reported by several scanners is one finding, named by all of them, at its most severe', () => {
  const base = { ecosystem: 'Go', package: 'golang.org/x/crypto', summary: '', malicious: false }
  const merged = mergeFindings([
    { ...base, version: '0.43.0', ids: ['GO-2026-5005', 'CVE-2026-1'], severity: 'unknown', fixed: '0.52.0', tools: ['osv-scanner'] },
    { ...base, version: 'v0.43.0', ids: ['CVE-2026-1'], severity: 'critical', fixed: '0.45.0', tools: ['trivy'] },
    { ...base, version: '0.43.0', ids: ['UBUNTU-CVE-2026-1'], severity: 'high', tools: ['grype'] },
    { ...base, version: '0.43.0', ids: ['CVE-2026-2'], severity: 'low', tools: ['grype'] },
    { ...base, version: '0.44.0', ids: ['CVE-2026-1'], severity: 'low', tools: ['grype'] },
  ])
  assert.equal(merged.length, 3)
  assert.deepEqual(merged[0], { ...base, version: '0.43.0', ids: ['GO-2026-5005', 'CVE-2026-1', 'UBUNTU-CVE-2026-1'], severity: 'critical', fixed: '0.45.0', tools: ['osv-scanner', 'trivy', 'grype'] })
  assert.equal(plainVersion('go1.24.1'), '1.24.1')
  assert.equal(plainVersion('version-2'), 'version-2')
  assert.deepEqual(matchIds('DEBIAN-CVE-2024-1234'), ['DEBIAN-CVE-2024-1234', 'CVE-2024-1234'])
  assert.equal(packageKey('pkg:npm/%40scope/a@1.0.0?arch=x', 'npm', '', ''), 'pkg:npm/@scope/a@1.0.0')
  assert.equal(packageKey(undefined, 'Go', 'Stdlib', '1.2'), 'go:stdlib@1.2')
  assert.equal(versionOf('osv-scanner version: 2.7.1\nosv-scalibr version: 0.5.3'), '2.7.1')
  assert.equal(versionOf('Application:   grype\nVersion:  0.104.4'), '0.104.4')
})

test('an image with two names is one image', () => {
  const output = [
    '{"ID":"sha256:97b8","Repository":"docker","Tag":"29-cli","Size":"163MB"}',
    '{"ID":"sha256:97b8","Repository":"docker","Tag":"cli","Size":"163MB"}',
    '{"ID":"sha256:0f0f","Repository":"<none>","Tag":"<none>","Size":"1.2GB"}',
  ].join('\n')
  assert.deepEqual(parseImages(output), [
    { id: 'sha256:97b8', names: ['docker:29-cli', 'docker:cli'], bytes: 163_000_000 },
    { id: 'sha256:0f0f', names: [], bytes: 1_200_000_000 },
  ])
})

test('a restored .NET project names its packages in project.assets.json', () => {
  const text = JSON.stringify({ libraries: { 'Newtonsoft.Json/12.0.1': { type: 'package' }, 'App.Core/1.0.0': { type: 'project' } } })
  assert.deepEqual(parseProjectAssets(text), [{ ecosystem: 'NuGet', name: 'Newtonsoft.Json', version: '12.0.1' }])
})

test('a place reads under the home of its system, and is removed in the shell of its system', () => {
  assert.equal(labelOf({ windows: false, home: '/home/me' }, '/home/me/.npm/_npx'), '~/.npm/_npx')
  assert.equal(labelOf({ windows: false, home: '/home/me' }, '/home/mel/x'), '/home/mel/x')
  assert.equal(labelOf({ windows: true, home: String.raw`C:\Users\Me` }, String.raw`c:\users\me\.nuget\packages`), String.raw`%USERPROFILE%\.nuget\packages`)
  assert.equal(removeCommand({ windows: false }, '/home/me/repos/a/node_modules'), 'rm -rf /home/me/repos/a/node_modules')
  assert.equal(removeCommand({ windows: false }, "/home/me/it's here"), String.raw`rm -rf '/home/me/it'\''s here'`)
  assert.equal(removeCommand({ windows: true }, String.raw`C:\p\a b\node_modules`), String.raw`rmdir /s /q "C:\p\a b\node_modules"`)
})

test('an alias of nvm resolves to the highest version installed that it names', () => {
  const versions = ['v20.19.0', 'v24.1.0', 'v24.22.1']
  assert.equal(resolveNvm('24', versions), 'v24.22.1')
  assert.equal(resolveNvm('v24.1', versions), 'v24.1.0')
  assert.equal(resolveNvm('v2', versions), undefined)
  assert.equal(resolveNvm(undefined, versions), undefined)
})

test('a repository is unused when nothing happened in it for the days given, its install included', () => {
  const now = Date.parse('2026-11-22T00:00:00Z')
  const old = now - 90 * DAY
  const options = { unusedDays: 30, now }
  assert.equal(unusedReason(new Date(old).toISOString(), 0, old, options), 'no commit, no change and no install for 90 days')
  assert.equal(unusedReason(new Date(now - DAY).toISOString(), 0, old, options), undefined)
  assert.equal(unusedReason(new Date(old).toISOString(), 2, old, options), undefined)
  assert.equal(unusedReason(new Date(old).toISOString(), 0, now - DAY, options), undefined)
  assert.equal(unusedReason(undefined, 0, old, options), 'no commit, no change and no install for 90 days')
})

test('PowerShell is given the paths as JSON, quotes doubled', () => {
  const script = sizeScript([String.raw`C:\it's\node_modules`])
  assert.match(script, /^\$paths = '\["C:\\\\it''s\\\\node_modules"\]' \| ConvertFrom-Json/)
})

// A home with nvm, npx and the NuGet cache, and a repository whose install is old, made for one test.
async function machine(): Promise<{ home: string; repos: string; stale: string; active: string }> {
  const home = await mkdtemp(join(tmpdir(), 'chade-scan-'))
  for (const version of ['v20.19.0', 'v24.22.1']) await mkdir(join(home, '.nvm', 'versions', 'node', version, 'lib', 'node_modules', 'npm'), { recursive: true })
  await mkdir(join(home, '.nvm', 'alias'), { recursive: true })
  await writeFile(join(home, '.nvm', 'alias', 'default'), '24\n')
  await mkdir(join(home, '.npm', '_npx', 'abc'), { recursive: true })
  await mkdir(join(home, '.nuget', 'packages', 'newtonsoft.json', '12.0.1'), { recursive: true })
  const repos = join(home, 'repos')
  const git = (folder: string, ...args: string[]) =>
    execFileSync('git', ['-C', folder, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z' },
    })
  const made = async (name: string) => {
    const folder = join(repos, name)
    await mkdir(join(folder, 'node_modules', 'lodash'), { recursive: true })
    await writeFile(join(folder, '.gitignore'), 'node_modules\n')
    git(folder, 'init', '--quiet')
    git(folder, 'add', '.')
    git(folder, 'commit', '--quiet', '-m', 'start')
    return folder
  }
  const stale = await made('stale')
  const active = await made('active')
  // The install of the stale repository is as old as its commit, and the active one was just installed.
  await utimes(join(stale, 'node_modules'), new Date('2026-01-01'), new Date('2026-01-01'))
  await mkdir(join(active, 'src', 'obj'), { recursive: true })
  await writeFile(join(active, 'src', 'obj', 'project.assets.json'), JSON.stringify({ libraries: { 'Newtonsoft.Json/12.0.1': { type: 'package' } } }))
  return { home, repos, stale, active }
}

test('the places of Linux are the folders of nvm, npx, the NuGet cache and what repositories installed, an old one marked unused', async () => {
  const { home, repos } = await machine()
  const side = linuxSide({ kind: 'linux', id: 'linux' }, home, {})
  const targets = await machineTargets(side, 'v20.19.0')
  const byLabel = new Map(targets.map((one) => [one.place.label, one]))
  // Both versions are kept: the default and the one running.
  assert.equal(byLabel.get('~/.nvm/versions/node/v24.22.1/lib/node_modules')?.place.unused, undefined)
  assert.equal(byLabel.get('~/.nvm/versions/node/v20.19.0/lib/node_modules')?.place.unused, undefined)
  const other = await machineTargets(side, 'v26.0.0')
  assert.equal(other.find((one) => one.place.label.includes('v20.19.0'))?.place.unused?.command, 'nvm uninstall v20.19.0')
  assert.equal(byLabel.get('~/.npm/_npx')?.place.kind, 'cache')
  assert.deepEqual(byLabel.get('~/.nuget/packages')?.list, [{ ecosystem: 'NuGet', name: 'newtonsoft.json', version: '12.0.1' }])
  const root = { system: 'linux', folder: repos, path: repos, separator: '/' as const, git: 'git' }
  const run: Run = async (command, args, options) => (await import('../src/exec.js')).run(command, args, options)
  const found = await repositoryTargets(side, root, [['stale'], ['active']], { unusedDays: 30, now: Date.parse('2026-11-22T00:00:00Z'), run })
  // The path of a place in a repository is written with the separator of its root.
  const staleModules = found.find((one) => one.place.path === `${repos}/stale/node_modules`)
  assert.match(staleModules?.place.unused?.reason ?? '', /^no commit, no change and no install for \d+ days$/)
  assert.equal(staleModules?.place.unused?.command, removeCommand({ windows: false }, `${repos}/stale/node_modules`))
  assert.equal(found.find((one) => one.place.path === `${repos}/active/node_modules`)?.place.unused, undefined)
  assert.deepEqual(found.find((one) => one.place.path.endsWith('project.assets.json'))?.list, [{ ecosystem: 'NuGet', name: 'Newtonsoft.Json', version: '12.0.1' }])
})

// The scanners and docker as the real ones answer, over the folders and the lists they are given, each one present unless told otherwise.
function fakeTools(options: { osv?: boolean; trivy?: boolean; grype?: boolean; docker?: boolean } = {}): { run: Run; calls: string[][] } {
  const calls: string[][] = []
  const present: Record<string, boolean | undefined> = { 'osv-scanner': options.osv, trivy: options.trivy, grype: options.grype, docker: options.docker }
  const run: Run = async (command, args) => {
    calls.push([command, ...args])
    if (present[command] === false) return { code: NOT_FOUND, stdout: '', stderr: '' }
    if (args[0] === '--version' || args[0] === 'version') return { code: 0, stdout: `${command} version: 1.2.3\n`, stderr: '' }
    if (command === 'osv-scanner' && args[1] === 'source') {
      const folders = args.includes('-r') ? args.slice(args.indexOf('-r') + 1) : []
      const results = folders
        .filter((folder) => folder.includes('node_modules'))
        .map((folder) => ({
          // Under the folder as given, the way osv-scanner of Linux writes it, whatever the platform of the test.
          source: { path: `${folder}/evil/package.json`, type: 'lockfile' },
          packages: [
            {
              package: { name: 'evil', version: '1.0.0', ecosystem: 'npm', purl: 'pkg:npm/evil@1.0.0' },
              groups: [{ ids: ['MAL-2025-1'], aliases: ['MAL-2025-1'], max_severity: '' }],
              vulnerabilities: [{ id: 'MAL-2025-1', summary: 'Malicious code in evil (npm)' }],
            },
          ],
        }))
      const lists = args.flatMap((arg, index) => (args[index - 1] === '-L' ? [arg] : []))
      const listed = await Promise.all(
        lists.map(async (list) => ({
          source: { path: list, type: 'sbom' },
          packages: (JSON.parse(await readFile(list, 'utf8')) as { components: { name: string; version: string; purl: string }[] }).components.map((component) => ({
            package: { name: component.name, version: component.version, ecosystem: 'NuGet', purl: component.purl },
            groups: [{ ids: ['GHSA-5crp-9r3c-p9vr'], aliases: ['CVE-2024-21907'], max_severity: '7.5' }],
            vulnerabilities: [{ id: 'GHSA-5crp-9r3c-p9vr', summary: 'Improper Handling of Exceptional Conditions in Newtonsoft.Json', affected: [{ package: { name: component.name }, ranges: [{ events: [{ introduced: '0' }, { fixed: '13.0.1' }] }] }] }],
          })),
        })),
      )
      return { code: 1, stdout: JSON.stringify({ results: [...results, ...listed] }), stderr: '' }
    }
    if (command === 'osv-scanner' && args[1] === 'image') return { code: 0, stdout: '{"results":[]}', stderr: '' }
    if (command === 'trivy' && args[0] === 'rootfs') {
      const packages = args.at(-1)?.includes('node_modules') ? [{ Name: 'evil', Version: '1.0.0', Identifier: { PURL: 'pkg:npm/evil@1.0.0' } }] : []
      return { code: 0, stdout: JSON.stringify({ Results: [{ Type: 'node-pkg', Packages: packages }] }), stderr: '' }
    }
    if (command === 'trivy' && args[0] === 'sbom') {
      const vulnerability = { VulnerabilityID: 'CVE-2024-21907', VendorIDs: ['GHSA-5crp-9r3c-p9vr'], PkgName: 'newtonsoft.json', InstalledVersion: '12.0.1', FixedVersion: '13.0.1', Severity: 'HIGH' }
      return { code: 0, stdout: JSON.stringify({ Results: [{ Type: 'nuget', Packages: [{ Name: 'newtonsoft.json', Version: '12.0.1', Identifier: { PURL: 'pkg:nuget/newtonsoft.json@12.0.1' } }], Vulnerabilities: [vulnerability] }] }), stderr: '' }
    }
    if (command === 'trivy' && args[0] === 'image' && args.includes('--format')) return { code: 0, stdout: await fixture('trivy-0.76.2.json'), stderr: '' }
    if (command === 'grype') return { code: 0, stdout: await fixture('grype-0.104.4.json'), stderr: '' }
    if (command === 'docker' && args[0] === 'image') return { code: 0, stdout: '{"ID":"sha256:aa","Repository":"old","Tag":"1","Size":"1GB"}\n{"ID":"sha256:bb","Repository":"used","Tag":"2","Size":"2GB"}\n', stderr: '' }
    if (command === 'docker' && args[0] === 'ps') return { code: 0, stdout: 'c1\n', stderr: '' }
    if (command === 'docker' && args[0] === 'container') return { code: 0, stdout: 'sha256:bb\n', stderr: '' }
    if (command === 'du') return { code: 0, stdout: `1000\t${args.at(-1)}\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

test('a scan reads every place with every scanner, merges what they agree on, and says what nothing uses', async () => {
  const { home, repos } = await machine()
  const config = parseConfig(`store: ${home}/store\nlinux:\n  repos: [${repos}]\n`, home)
  const { run } = fakeTools()
  const host: Host = { machine: 'TEST-PC', home, run, systems: [{ kind: 'linux', id: 'linux' }] }
  const result = await scan(config, host, { packages: true, images: true, offline: false, unusedDays: 30, now: Date.parse('2026-11-22T00:00:00Z') })
  // The node_modules of nvm, of each repository, and npx are read, each with its malicious package, which OSV alone knows.
  assert.ok(countsOf(result).malicious >= 4)
  const evil = result.places.flatMap((place) => place.findings).find((finding) => finding.malicious)
  assert.deepEqual(evil?.tools, ['osv-scanner'])
  // The GHSA of osv-scanner and grype and the CVE of trivy are one finding of the three.
  const nuget = result.places.find((place) => place.label === '~/.nuget/packages')
  const newtonsoft = nuget?.findings.filter((finding) => finding.package.toLowerCase() === 'newtonsoft.json')
  assert.equal(newtonsoft?.length, 1)
  assert.deepEqual(newtonsoft?.[0].tools, ['osv-scanner', 'trivy', 'grype'])
  assert.deepEqual(nuget?.tools, ['osv-scanner', 'trivy', 'grype'])
  assert.equal(newtonsoft?.[0].fixed, '13.0.1')
  assert.deepEqual(
    result.tools.map((use) => [use.part, use.tool, use.version]),
    [
      ['packages', 'osv-scanner', '1.2.3'],
      ['packages', 'trivy', '1.2.3'],
      ['packages', 'grype', '1.2.3'],
      ['images', 'osv-scanner', '1.2.3'],
      ['images', 'trivy', '1.2.3'],
      ['images', 'grype', '1.2.3'],
    ],
  )
  const images = result.places.filter((place) => place.kind === 'image')
  assert.deepEqual(
    images.map((place) => [place.label, place.unused?.command]),
    [
      ['old:1', 'docker image rm old:1'],
      ['used:2', undefined],
    ],
  )
  assert.deepEqual(images[0].tools, ['osv-scanner', 'trivy', 'grype'])
  assert.deepEqual(images[0].notes, ['alpine 3.18.12 is past its end of life, so its packages get no more fixes'])
  assert.ok(images[0].findings.some((finding) => finding.tools.includes('grype')) && images[0].findings.some((finding) => finding.tools.includes('trivy')))
  assert.equal(result.places.find((place) => place.path === `${repos}/stale/node_modules`)?.bytes, 1000)
  assert.deepEqual(result.skipped, [])
  const text = renderScan(result)
  assert.match(text, /^TEST-PC, 2026-11-22 00:00 UTC$/m)
  assert.match(text, /^Malicious, removed rather than updated/m)
  assert.match(text, /^ {2}evil 1\.0\.0 {2}MAL-2025-1 {2}Malicious code in evil \(npm\)$/m)
  assert.match(text, /^ {4}docker image rm old:1$/m)
  assert.match(text, /^ {2}linux packages: osv-scanner 1\.2\.3, trivy 1\.2\.3, grype 1\.2\.3$/m)
})

test('a missing scanner takes its layer away and is named, and grype alone still matches the lists', async () => {
  const { home } = await machine()
  const { run } = fakeTools({ osv: false, trivy: false })
  const host: Host = { machine: 'TEST-PC', home, run, systems: [{ kind: 'linux', id: 'linux' }] }
  const result = await scan(undefined, host, { packages: true, images: false, offline: true, unusedDays: 30 })
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(
    result.tools.map((use) => [use.tool, use.problem]),
    [
      ['osv-scanner', 'not installed'],
      ['trivy', 'not installed'],
      ['grype', undefined],
    ],
  )
  // The NuGet cache is a list chade wrote, so grype reads it without the others.
  assert.deepEqual(result.places.find((place) => place.label === '~/.nuget/packages')?.findings[0]?.tools, ['grype'])
  assert.match(renderScan(result), /^ {2}linux packages: osv-scanner \(not installed\), trivy \(not installed\), grype 1\.2\.3$/m)
})

test('with no scanner, a part is skipped, and the images are still listed for what nothing uses', async () => {
  const { home } = await machine()
  const { run } = fakeTools({ osv: false, trivy: false, grype: false })
  const host: Host = { machine: 'TEST-PC', home, run, systems: [{ kind: 'linux', id: 'linux' }] }
  const result = await scan(undefined, host, { packages: true, images: true, offline: true, unusedDays: 30 })
  assert.deepEqual(
    result.skipped.map((skip) => [skip.part, skip.reason.split(',')[0]]),
    [
      ['packages', 'none of osv-scanner'],
      ['images', 'the images are listed without their vulnerabilities'],
    ],
  )
  assert.equal(result.places.filter((place) => place.kind === 'image' && place.unused).length, 1)
  const noDocker = fakeTools({ docker: false })
  const without = await scan(undefined, { ...host, run: noDocker.run }, { packages: false, images: true, offline: true, unusedDays: 30 })
  assert.deepEqual(without.skipped, [{ system: 'linux', part: 'images', reason: 'docker is not installed' }])
})

test('an image read less than a day ago by the same scanners is not read again', async () => {
  const { home } = await machine()
  const { run, calls } = fakeTools()
  const host: Host = { machine: 'TEST-PC', home, run, systems: [{ kind: 'linux', id: 'linux' }] }
  const read = (path: string, tools: string[]): Place => ({ system: 'linux', kind: 'image', label: path, path, packages: 0, findings: [], notes: ['read before'], tools })
  const previous: Scan = {
    machine: 'TEST-PC',
    date: new Date(Date.now() - 3600_000).toISOString(),
    skipped: [],
    tools: [],
    // The second was read before grype was installed.
    places: [read('sha256:aa', ['osv-scanner', 'trivy', 'grype']), read('sha256:bb', ['trivy'])],
  }
  const result = await scan(undefined, host, { packages: false, images: true, offline: true, unusedDays: 30, previous })
  assert.deepEqual(result.places.find((place) => place.path === 'sha256:aa')?.notes, ['read before'])
  assert.deepEqual(
    calls.filter((call) => call[0] === 'trivy' && call[1] === 'image' && call.includes('--format')).map((call) => call.at(-1)),
    ['sha256:bb'],
  )
})

test('a scan is saved and read back, and a missing or broken file is no scan', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'chade-scan-file-'))
  const value: Scan = { machine: 'PC', date: '2026-11-22T00:00:00.000Z', places: [], tools: [], skipped: [] }
  await saveScan(join(folder, 'scan.json'), value)
  assert.deepEqual(await readScan(join(folder, 'scan.json')), value)
  assert.equal(await readScan(join(folder, 'missing.json')), undefined)
  await writeFile(join(folder, 'broken.json'), '{')
  assert.equal(await readScan(join(folder, 'broken.json')), undefined)
})

test('the report sums up the last scan, says when it is old, and gives the largest removals', () => {
  assert.deepEqual(security(undefined).measures, [{ label: 'last scan', detail: 'never' }])
  const now = Date.parse('2026-11-22T00:00:00Z')
  const place = (label: string, bytes: number): Place => ({ system: 'linux', kind: 'image', label, path: label, bytes, packages: 0, findings: [], notes: [], tools: [], unused: { reason: 'no container uses it', command: `docker image rm ${label}` } })
  const scanned: Scan = {
    machine: 'PC',
    date: '2026-11-01T00:00:00.000Z',
    skipped: [],
    tools: [],
    places: [
      { ...place('a', 3e9), findings: [{ ecosystem: 'npm', package: 'evil', version: '1', ids: ['MAL-1'], summary: '', severity: 'unknown', malicious: true, tools: ['osv-scanner'] }] },
      place('b', 2e9),
      place('c', 1e9),
      place('d', 5e8),
    ],
  }
  const section = security(scanned, now)
  assert.deepEqual(
    section.measures.map((measure) => measure.detail ?? measure.bytes),
    ['2026-11-01 00:00', '1', 'none known', 6.5e9],
  )
  assert.match(section.hints[0], /^1 malicious package\(s\) are on the disk/)
  assert.equal(section.hints[1], 'The last scan is 21 days old, and chade scan reads the disk again.')
  assert.deepEqual(section.hints.slice(3), ['  docker image rm a', '  docker image rm b', '  docker image rm c'])
})

test('the scan settings are a number of days and the parts to leave out', () => {
  assert.equal(parseConfig('store: /s\n', '/h').scan, undefined)
  assert.deepEqual(parseConfig('store: /s\nscan:\n  unusedDays: 60\n  skip: [images]\n', '/h').scan, { unusedDays: 60, skip: ['images'] })
  assert.throws(() => parseConfig('store: /s\nscan:\n  unusedDays: 0\n', '/h'), /scan.unusedDays is a whole number/)
  assert.throws(() => parseConfig('store: /s\nscan:\n  skip: [caches]\n', '/h'), /caches is not one of packages, images/)
  assert.throws(() => parseConfig('store: /s\nscan:\n  days: 3\n', '/h'), /scan has an unknown key days/)
})
