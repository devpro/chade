import type { Finding, Severity } from '@chade/daemon'
import { packageKey } from './merge.js'

// Checked with osv-scanner 2.7.1 on 2026-11-22.
// What an install left reads only with the artifact plugins, node_modules/.package-lock.json, Go binaries and Python dist-info among them,
// and javascript/packagejson reads a global npm folder, where npm writes no lock file.
// The default lockfile plugins are left out: the lock files of a repository are its code, which IstarCI reads.
export const OSV_PLUGINS = ['artifact', 'javascript/packagejson', 'sbom']

// osv-scanner exits with 1 when it finds a vulnerability, and with 127 on an error, the code a shell gives a command it cannot find.
export const OSV_FOUND = 1

export interface OsvInput {
  // Folders read with the plugins, their subfolders included.
  folders: string[]
  // CycloneDX files chade wrote for the packages that only their folder names tell, such as the NuGet cache.
  lists: string[]
  // No download: the databases already on the machine are read, and an ecosystem without one fails the scan.
  offline: boolean
}

export function osvArgs(input: OsvInput): string[] {
  return [
    'scan',
    'source',
    '--format',
    'json',
    '--all-packages',
    // node_modules and .terraform are ignored by git, and are what is read here.
    '--no-ignore',
    '--allow-no-lockfiles',
    // The list of packages stays on the machine: the databases of OSV come to it instead.
    '--offline-vulnerabilities',
    ...(input.offline ? [] : ['--download-offline-databases']),
    '--x-no-default-plugins',
    ...OSV_PLUGINS.flatMap((plugin) => ['--x-plugins', plugin]),
    ...input.lists.flatMap((list) => ['-L', list]),
    ...(input.folders.length > 0 ? ['-r', ...input.folders] : []),
  ]
}

// The baseimage plugin sends the identifiers of the layers to a server, to name the public image they come from, which chade does not use.
const NO_BASE_IMAGE = ['--x-disable-plugins', 'baseimage']

// osv-scanner exits with 128 on an image without a package, such as busybox.
const OSV_NO_PACKAGE = 128

export function osvFoundNoPackage(code: number, stderr: string): boolean {
  return code === OSV_NO_PACKAGE && stderr.includes('No package sources found') && !stderr.includes('Error during extraction')
}

// An image Docker holds, read by its name, or from the archive docker save wrote of one without a name.
export function osvImageArgs(image: string, archive: boolean, offline: boolean): string[] {
  return ['scan', 'image', '--format', 'json', '--offline-vulnerabilities', ...(offline ? [] : ['--download-offline-databases']), ...NO_BASE_IMAGE, ...(archive ? ['--archive'] : []), image]
}

// The packages of an image without their match, as the match of one Ubuntu image loads a database for minutes.
// Checked with osv-scanner 2.7.1 on 2026-11-24.
export function osvImageListArgs(image: string, archive: boolean): string[] {
  return ['scan', 'image', '--format', 'json', '--offline-vulnerabilities', '--all-packages', ...NO_BASE_IMAGE, '--x-disable-plugins', 'vulnmatch/osvlocal', ...(archive ? ['--archive'] : []), image]
}

// A match of a list alone, the databases updated by the same call unless told not to.
export function osvListArgs(list: string, update: boolean): string[] {
  return ['scan', 'source', '--format', 'json', '--all-packages', '--allow-no-lockfiles', '--offline-vulnerabilities', ...(update ? ['--download-offline-databases'] : []), '--x-no-default-plugins', '--x-plugins', 'sbom', '-L', list]
}

// osv-scanner exits with the code of a found vulnerability even when a database is missing, so only its errors tell that an ecosystem was not matched.
export function osvMissing(stderr: string): string[] {
  return [...new Set([...stderr.matchAll(/could not load db for (.{1,40}?) ecosystem/g)].map((match) => match[1]))]
}

// The name of the database of an ecosystem, which Debian:12 and Debian:13 share.
export function osvDatabase(ecosystem: string): string {
  return ecosystem.split(':')[0]
}

// A package of an image, as osv-scanner names it, a system package by its source.
export interface OsvListed {
  ecosystem: string
  name: string
  version: string
  purl?: string
}

export function readOsvListed(text: string): OsvListed[] {
  const output = JSON.parse(text) as OsvOutput
  return (output.results ?? []).flatMap((result) =>
    (result.packages ?? []).map(({ package: { ecosystem, name, version, purl } }) => ({ ecosystem, name, version, ...(purl ? { purl } : {}) })),
  )
}

// osv-scanner names Ubuntu:24.04 the system of an image, and Ubuntu:24.04:LTS the same system of a list.
export function osvKey(pkg: OsvListed): string {
  return JSON.stringify([pkg.ecosystem.replace(/:LTS$/, ''), pkg.name, pkg.version])
}

// The purl that a list names a package by, or undefined when a list cannot name it as an image does.
// OSV names a package of Debian, Ubuntu and Alpine by its source, where the purl of the image names the binary.
// An rpm of a list loses its system, and all its findings with it.
export function osvListPurl(pkg: OsvListed): string | undefined {
  if (!pkg.purl || pkg.purl.startsWith('pkg:rpm/')) return undefined
  if (!/^pkg:(deb|apk)\//.test(pkg.purl)) return pkg.purl
  const distro = /[?&](distro=[^&]+)/.exec(pkg.purl)?.[1]
  if (!distro) return undefined
  const version = encodeURIComponent(pkg.version).replaceAll('%3A', ':')
  return `${pkg.purl.split('/', 2).join('/')}/${encodeURIComponent(pkg.name)}@${version}?${distro}`
}

// The packages of many images in one CycloneDX list, the name and the version as they are and not as the purl escapes them.
export function osvList(packages: OsvListed[]): string {
  const components = packages.map((pkg, index) => ({ type: 'library', 'bom-ref': String(index), name: pkg.name, version: pkg.version, purl: osvListPurl(pkg) }))
  return JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, components })
}

// The findings of each package of a list, by its key, a package without a finding included.
export function readOsvMatches(text: string): Map<string, Finding[]> {
  const output = JSON.parse(text) as OsvOutput
  return new Map((output.results ?? []).flatMap((result) => (result.packages ?? []).map((entry) => [osvKey(entry.package), findingsOf(entry)] as const)))
}

// What osv-scanner read in one file, a lock file, a binary, a package.json or a list.
export interface OsvSource {
  path: string
  // The key of each package read, its purl as merge.ts writes it.
  packages: string[]
  findings: Finding[]
}

interface OsvEvent {
  introduced?: string
  fixed?: string
}

interface OsvRecord {
  id: string
  aliases?: string[]
  summary?: string
  details?: string
  database_specific?: { severity?: string; cwe_ids?: string[] }
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { events?: OsvEvent[] }[] }[]
}

interface OsvPackage {
  package: { name: string; version: string; ecosystem: string; purl?: string }
  groups?: { ids: string[]; aliases?: string[]; max_severity?: string }[]
  vulnerabilities?: OsvRecord[]
}

interface OsvOutput {
  results?: { source: { path: string }; packages?: OsvPackage[] }[]
}

export function readOsvOutput(text: string): OsvSource[] {
  const output = JSON.parse(text === '' ? '{}' : text) as OsvOutput
  return (output.results ?? []).map((result) => ({
    path: result.source.path,
    packages: (result.packages ?? []).map(({ package: { ecosystem, name, version, purl } }) => packageKey(purl, ecosystem, name, version)),
    findings: (result.packages ?? []).flatMap(findingsOf),
  }))
}

// A group is one advisory under its several identifiers, a GHSA and a CVE for instance.
function findingsOf(entry: OsvPackage): Finding[] {
  const { name, version, ecosystem } = entry.package
  return (entry.groups ?? []).map((group) => {
    const records = (entry.vulnerabilities ?? []).filter((record) => group.ids.includes(record.id))
    const ids = [...new Set([...group.ids, ...(group.aliases ?? []), ...records.flatMap((record) => record.aliases ?? [])])]
    const main = records[0]
    const fixed = fixedVersion(records, name, version)
    return {
      ecosystem,
      package: name,
      version,
      ids,
      summary: main?.summary ?? main?.details?.split('\n')[0] ?? '',
      severity: severityOf(group.max_severity, records),
      ...(fixed === undefined ? {} : { fixed }),
      malicious: ids.some((id) => id.startsWith('MAL-')) || records.some((record) => record.database_specific?.cwe_ids?.includes('CWE-506')),
      tools: ['osv-scanner'],
    }
  })
}

// The score of CVSS when the advisory has one, the level GitHub gives otherwise, as a Go advisory has neither.
export function severityOf(score: string | undefined, records: OsvRecord[]): Severity {
  const value = score ? Number(score) : Number.NaN
  if (Number.isFinite(value) && value > 0) {
    if (value >= 9) return 'critical'
    if (value >= 7) return 'high'
    if (value >= 4) return 'medium'
    return 'low'
  }
  const level = records.map((record) => record.database_specific?.severity?.toLowerCase()).find(Boolean)
  if (level === 'moderate') return 'medium'
  return level === 'critical' || level === 'high' || level === 'medium' || level === 'low' ? level : 'unknown'
}

// The lowest fixed version above the one installed, of the ranges of this package.
function fixedVersion(records: OsvRecord[], name: string, version: string): string | undefined {
  const fixes = records
    .flatMap((record) => record.affected ?? [])
    .filter((affected) => affected.package?.name?.toLowerCase() === name.toLowerCase())
    .flatMap((affected) => affected.ranges ?? [])
    .flatMap((range) => range.events ?? [])
    .map((event) => event.fixed)
    .filter((fixed): fixed is string => fixed !== undefined && compareVersions(fixed, version) > 0)
  return fixes.toSorted(compareVersions)[0]
}

// Close enough for the ranges of every ecosystem: numbers compared as numbers, and a release before its pre-releases.
export function compareVersions(a: string, b: string): number {
  const split = (text: string) => {
    const [release, ...pre] = text.replace(/^v/, '').split('-')
    return { numbers: release.split(/[.+]/).map((part) => Number.parseInt(part, 10) || 0), pre: pre.join('-') }
  }
  const left = split(a)
  const right = split(b)
  for (let index = 0; index < Math.max(left.numbers.length, right.numbers.length); index++) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre < right.pre ? -1 : 1
}

// A purl names a package of any ecosystem, so one list holds them all.
const PURL_TYPES: Record<string, string> = { NuGet: 'nuget', npm: 'npm', PyPI: 'pypi', Go: 'golang' }

export interface Listed {
  ecosystem: keyof typeof PURL_TYPES
  name: string
  version: string
}

export function purlOf(pkg: Listed): string {
  const name = pkg.ecosystem === 'npm' ? pkg.name.replace(/^@/, '%40') : pkg.name
  return `pkg:${PURL_TYPES[pkg.ecosystem]}/${name}@${pkg.version}`
}

// A CycloneDX 1.5 document, the one form of list osv-scanner, trivy and grype all read, osv-scanner from a file whose name ends in .cdx.json.
export function cycloneDx(purls: string[]): string {
  const components = purls.map((purl, index) => {
    const at = purl.lastIndexOf('@')
    const path = purl.slice(0, at).replace(/^pkg:[^/]+\//, '')
    return { type: 'library', 'bom-ref': String(index), name: decodeURIComponent(path), version: purl.slice(at + 1), purl }
  })
  return JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, components })
}
