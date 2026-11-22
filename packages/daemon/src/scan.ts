// What chade scan finds on the disk, as the command saves it, gives it with --json and the interface shows it.

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown'

export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'unknown']

// One advisory on one package of a place.
export interface Finding {
  ecosystem: string
  package: string
  version: string
  // The identifier of the advisory first, then its aliases.
  ids: string[]
  summary: string
  severity: Severity
  // The first version without it, absent when there is none yet.
  fixed?: string
  // Named by OSV as malicious, which no update fixes: the package is removed, and the machine looked at.
  malicious: boolean
  // The scanners that reported it, as one tool misses what another finds.
  tools: string[]
}

export type PlaceKind = 'machine' | 'repository' | 'cache' | 'image'

// Where packages are installed: a folder of the machine, of a repository or of a cache, or a container image.
export interface Place {
  system: string
  kind: PlaceKind
  label: string
  // As the system writes it, the ID for an image.
  path: string
  bytes?: number
  packages: number
  findings: Finding[]
  // What the reading said beyond the findings, such as an operating system past its end of life.
  notes: string[]
  // Why nothing seems to use the place, and the command that removes it.
  unused?: { reason: string; command: string }
  // The scanners that read it.
  tools: string[]
}

// A scanner of one system, with its version, or why it did not run: not installed, or failed.
export interface ToolUse {
  system: string
  part: 'packages' | 'images'
  tool: string
  version?: string
  problem?: string
}

// A part of the scan that no scanner could run, with why and what makes it run.
export interface Skipped {
  system: string
  part: string
  reason: string
}

export interface Scan {
  machine: string
  date: string
  places: Place[]
  tools: ToolUse[]
  skipped: Skipped[]
}

// The order findings are read in: a malicious package first, then by severity.
export function severityRank(finding: Finding): number {
  return finding.malicious ? -1 : SEVERITIES.indexOf(finding.severity)
}

// What a scan comes to: the counts the report and the top of the page give.
export interface Counts {
  malicious: number
  severities: Record<Severity, number>
  unusedBytes: number
  unused: number
}

export function countsOf(value: Scan): Counts {
  const counts: Counts = { malicious: 0, severities: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, unusedBytes: 0, unused: 0 }
  for (const place of value.places) {
    for (const finding of place.findings) {
      if (finding.malicious) counts.malicious++
      else counts.severities[finding.severity]++
    }
    if (place.unused) {
      counts.unused++
      counts.unusedBytes += place.bytes ?? 0
    }
  }
  return counts
}
