// Fails when the local Sonar analysis of the commit checked out has an open finding, old or new.
// The quality gate reads only the new code, and a change can cause a finding on a line it does not touch.
//
// Usage: istarci quality --json | node scripts/check_sonar_findings.mjs
import { readFileSync } from 'node:fs'
const { reports, errors } = JSON.parse(readFileSync(0, 'utf8'))
const problems = errors.map((error) => typeof error === 'string' ? error : JSON.stringify(error))
if (reports.length === 0) problems.push('there is no Sonar analysis')
for (const { source, analysed, verdict, scopes } of reports) {
  if (!analysed?.current) problems.push(`${source.project}: the last analysis is not of the commit checked out`)
  if (verdict?.state !== 'passed') problems.push(`${source.project}: the quality gate is ${verdict?.state}`)
  if (!scopes?.all) { problems.push(`${source.project}: the report has no list of findings`); continue }
  for (const { severity, file, line, message, rule } of scopes.all.findings) problems.push(`${severity} ${file}:${line} ${message} ${rule}`)
  if (scopes.all.total > scopes.all.findings.length) problems.push(`${source.project}: ${scopes.all.total} findings in total`)
}
for (const problem of problems) console.error(problem)
if (problems.length > 0) process.exit(1)
console.log('No open Sonar finding')
