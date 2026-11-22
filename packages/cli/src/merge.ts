import { SEVERITIES, type Finding } from '@chade/daemon'
import { compareVersions } from './osv.js'

// A package as every scanner names it: its purl, without the qualifiers one tool adds and another does not.
export function packageKey(purl: string | undefined, ecosystem: string, name: string, version: string): string {
  if (purl) return decodeURIComponent(purl.split('?')[0].split('#')[0]).toLowerCase()
  return `${ecosystem}:${name}@${version}`.toLowerCase()
}

// trivy and grype write the version of a Go module as v1.7.30 and of Go itself as go1.24.1, where osv-scanner writes 1.7.30.
export function plainVersion(version: string): string {
  return version.replace(/^(v|go)(?=\d)/, '')
}

// The forms an identifier is matched by: itself, and the CVE a distribution names its own advisory after, as UBUNTU-CVE-2026-1 is CVE-2026-1.
export function matchIds(id: string): string[] {
  const upper = id.toUpperCase()
  const cve = /CVE-\d{4}-\d+/.exec(upper)?.[0]
  return cve && cve !== upper ? [upper, cve] : [upper]
}

// One advisory reported by several scanners is one finding: the same package, the same version, and an identifier in common,
// a GHSA of osv-scanner being the alias of the CVE trivy names, for instance.
// The merged finding keeps every identifier and every tool, the most severe level any tool gives, and the lowest fix.
export function mergeFindings(findings: Finding[]): Finding[] {
  const merged: Finding[] = []
  for (const finding of findings) {
    const ids = new Set(finding.ids.flatMap(matchIds))
    const version = plainVersion(finding.version)
    const same = merged.find(
      (known) =>
        known.package.toLowerCase() === finding.package.toLowerCase() &&
        plainVersion(known.version) === version &&
        known.ids.some((id) => matchIds(id).some((one) => ids.has(one))),
    )
    if (!same) {
      merged.push({ ...finding, ids: [...finding.ids], tools: [...finding.tools] })
      continue
    }
    for (const id of finding.ids) if (!same.ids.some((known) => known.toUpperCase() === id.toUpperCase())) same.ids.push(id)
    for (const tool of finding.tools) if (!same.tools.includes(tool)) same.tools.push(tool)
    if (SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf(same.severity)) same.severity = finding.severity
    if (finding.fixed && (!same.fixed || compareVersions(finding.fixed, same.fixed) < 0)) same.fixed = finding.fixed
    same.summary ||= finding.summary
    same.malicious ||= finding.malicious
  }
  return merged
}
