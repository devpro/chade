import type { Finding, Severity } from '@chade/daemon'
import { packageKey } from './merge.js'

// Checked with grype 0.104.4 and 0.122.1 on 2026-11-22.
// Its reading of a folder knows lock files and not what an install left, node_modules giving nothing,
// so it is given the list of the packages osv-scanner and trivy read, a CycloneDX 1.5 it reads, where it refuses the 1.7 trivy writes.
// What it brings is its own database of advisories.

export function grypeListArgs(list: string): string[] {
  return [`sbom:${list}`, '--output', 'json', '--quiet']
}

// Only the image Docker holds.
export function grypeImageArgs(imageId: string): string[] {
  return [`docker:${imageId}`, '--output', 'json', '--quiet']
}

// The database is updated by grype itself before it reads, unless told not to.
export const GRYPE_OFFLINE = { GRYPE_DB_AUTO_UPDATE: 'false', GRYPE_CHECK_FOR_APP_UPDATE: 'false' }

interface GrypeReport {
  matches?: {
    vulnerability?: { id?: string; severity?: string; description?: string; fix?: { versions?: string[]; state?: string } }
    relatedVulnerabilities?: { id?: string; description?: string }[]
    artifact?: { name?: string; version?: string; type?: string; purl?: string }
  }[]
}

const LEVELS = new Set<Severity>(['critical', 'high', 'medium', 'low'])

// Each finding with the key of its package, which says the places it lies in, as a list holds the packages of many.
export function readGrype(text: string): { key: string; finding: Finding }[] {
  const report = JSON.parse(text === '' ? '{}' : text) as GrypeReport
  return (report.matches ?? []).map((match) => {
    const artifact = match.artifact ?? {}
    const vulnerability = match.vulnerability ?? {}
    const severity = (vulnerability.severity ?? '').toLowerCase() as Severity
    const fixed = vulnerability.fix?.state === 'fixed' ? vulnerability.fix.versions?.[0] : undefined
    const related = match.relatedVulnerabilities ?? []
    return {
      key: packageKey(artifact.purl, artifact.type ?? '', artifact.name ?? '', artifact.version ?? ''),
      finding: {
        ecosystem: artifact.type ?? '',
        package: artifact.name ?? '',
        version: artifact.version ?? '',
        ids: [vulnerability.id ?? '', ...related.map((one) => one.id ?? '')].filter(Boolean),
        summary: (vulnerability.description ?? related.find((one) => one.description)?.description ?? '').split('\n')[0],
        severity: LEVELS.has(severity) ? severity : 'unknown',
        ...(fixed ? { fixed } : {}),
        malicious: false,
        tools: ['grype'],
      },
    }
  })
}
