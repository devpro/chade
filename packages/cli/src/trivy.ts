import type { Finding, Severity } from '@chade/daemon'
import { packageKey } from './merge.js'

// Checked with trivy 0.76.2 on 2026-11-22, the options of images being those IstarCI reads them with.
// rootfs reads what an install left, node_modules among it, where fs reads the lock files, which are the code.
// The version check and the telemetry are requests to Aqua with nothing to do with what is read.
export const TRIVY_QUIET = ['--quiet', '--skip-version-check', '--disable-telemetry']

const COMMON = ['--skip-db-update', '--scanners', 'vuln', '--list-all-pkgs', '--format', 'json', ...TRIVY_QUIET]

// The database alone, updated once before anything is read, rather than once for each place.
export function trivyDatabaseArgs(): string[] {
  return ['image', '--download-db-only', '--timeout', '60s', ...TRIVY_QUIET]
}

// The Java database, close to a gigabyte, is downloaded only for what holds a jar, and never offline.
const java = (offline: boolean) => (offline ? ['--skip-java-db-update'] : [])

export function trivyFolderArgs(folder: string, offline: boolean): string[] {
  return ['rootfs', ...COMMON, ...java(offline), folder]
}

// A list of packages chade wrote, for those only their folder names tell.
export function trivyListArgs(list: string, offline: boolean): string[] {
  return ['sbom', ...COMMON, ...java(offline), list]
}

// Only the image Docker holds, never one fetched from a registry under the same name.
export function trivyImageArgs(imageId: string, offline: boolean): string[] {
  return ['image', ...COMMON, ...java(offline), '--image-src', 'docker', imageId]
}

interface TrivyReport {
  Metadata?: { OS?: { Family?: string; Name?: string; EOSL?: boolean } }
  Results?: {
    Type?: string
    Packages?: { Name?: string; Version?: string; Identifier?: { PURL?: string } }[] | null
    Vulnerabilities?:
      | {
          VulnerabilityID?: string
          VendorIDs?: string[]
          PkgName?: string
          InstalledVersion?: string
          FixedVersion?: string
          Severity?: string
          Title?: string
          PkgIdentifier?: { PURL?: string }
        }[]
      | null
  }[]
}

export interface TrivyRead {
  // The key of each package read, its purl as merge.ts writes it.
  packages: string[]
  findings: Finding[]
  notes: string[]
}

const LEVELS = new Set<Severity>(['critical', 'high', 'medium', 'low'])

export function readTrivy(text: string): TrivyRead {
  const report = JSON.parse(text === '' ? '{}' : text) as TrivyReport
  const results = report.Results ?? []
  const packages = results.flatMap((result) => (result.Packages ?? []).map((pkg) => packageKey(pkg.Identifier?.PURL, result.Type ?? '', pkg.Name ?? '', pkg.Version ?? '')))
  const findings = results.flatMap((result) =>
    (result.Vulnerabilities ?? []).map((vulnerability): Finding => {
      const severity = (vulnerability.Severity ?? '').toLowerCase() as Severity
      return {
        ecosystem: result.Type ?? '',
        package: vulnerability.PkgName ?? '',
        version: vulnerability.InstalledVersion ?? '',
        // The GHSA trivy knows is what osv-scanner and grype name the same advisory by.
        ids: [vulnerability.VulnerabilityID ?? '', ...(vulnerability.VendorIDs ?? [])].filter(Boolean),
        summary: vulnerability.Title ?? '',
        severity: LEVELS.has(severity) ? severity : 'unknown',
        // trivy joins the fixed versions of several branches with a comma, the first being the nearest.
        ...(vulnerability.FixedVersion ? { fixed: vulnerability.FixedVersion.split(',')[0].trim() } : {}),
        malicious: false,
        tools: ['trivy'],
      }
    }),
  )
  const os = report.Metadata?.OS
  const notes = os?.EOSL ? [`${os.Family} ${os.Name} is past its end of life, so its packages get no more fixes`] : []
  return { packages: [...new Set(packages)], findings, notes }
}
