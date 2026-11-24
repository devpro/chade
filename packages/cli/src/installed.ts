import { existsSync } from 'node:fs'
import { access, constants, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, posix } from 'node:path'
import type { InstalledTool, Inventory, Problem } from '@chade/daemon'
import { NOT_FOUND } from './exec.js'
import { readGoBuild } from './gobinary.js'
import type { Latest, Registries } from './registries.js'
import type { Host, System } from './system.js'
import { versionOf } from './tools.js'

// The tools installed on a system, with their source and their newest version.

interface Known {
  // The repository of GitHub that releases the tool.
  github?: string
  // What comes before the version in the tag of a release.
  prefix?: string
  // The arguments that print the version, for a file that does not hold it.
  version?: string[]
  note?: string
}

// chade runs only the commands that this list names.
const CATALOG: Record<string, Known> = {
  argocd: { github: 'argoproj/argo-cd' },
  aztfexport: { github: 'Azure/aztfexport', version: ['--version'] },
  bun: { github: 'oven-sh/bun', prefix: 'bun-', version: ['--version'] },
  cosign: { github: 'sigstore/cosign' },
  docker: { version: ['--version'] },
  dotnet: { version: ['--version'] },
  flux: { github: 'fluxcd/flux2' },
  gh: { github: 'cli/cli', version: ['--version'] },
  gitleaks: { github: 'gitleaks/gitleaks', version: ['version'] },
  glab: { version: ['--version'] },
  go: { version: ['version'] },
  grype: { github: 'anchore/grype' },
  helm: { github: 'helm/helm', version: ['version', '--short'], note: 'Helm 4 is another major version than Helm 3: read its migration guide first' },
  helmfile: { github: 'helmfile/helmfile' },
  jq: { github: 'jqlang/jq', prefix: 'jq-', version: ['--version'] },
  k3d: { github: 'k3d-io/k3d', version: ['--version'] },
  k9s: { github: 'derailed/k9s' },
  kind: { github: 'kubernetes-sigs/kind' },
  kubectl: { github: 'kubernetes/kubernetes', note: 'kubectl supports clusters of one minor version older or newer' },
  kubeseal: { github: 'bitnami/sealed-secrets', note: 'Use the version of the controller of the cluster' },
  kustomize: { github: 'kubernetes-sigs/kustomize', prefix: 'kustomize/' },
  node: { version: ['--version'] },
  'osv-scanner': { github: 'google/osv-scanner' },
  poutine: { github: 'boostsecurityio/poutine' },
  skopeo: { version: ['--version'] },
  sops: { github: 'getsops/sops' },
  syft: { github: 'anchore/syft' },
  task: { github: 'go-task/task' },
  terraform: { github: 'hashicorp/terraform' },
  tofu: { github: 'opentofu/opentofu' },
  trivy: { github: 'aquasecurity/trivy' },
  trufflehog: { github: 'trufflesecurity/trufflehog', version: ['--version'] },
  uv: { github: 'astral-sh/uv', version: ['--version'] },
  yq: { github: 'mikefarah/yq' },
  zizmor: { github: 'zizmorcore/zizmor', version: ['--version'] },
}

export interface ToolResult {
  tools: InstalledTool[]
  problems: Problem[]
  apt?: Inventory['apt'][number]
}

export interface Environment {
  path: string
  // The folders where a file is put by hand, so each one is read in full.
  direct: string[]
}

export function environmentOf(home: string, env: NodeJS.ProcessEnv): Environment {
  return { path: env.PATH ?? '', direct: ['/usr/local/bin', posix.join(home, '.local', 'bin'), posix.join(home, 'go', 'bin'), ...(env.GOBIN ? [env.GOBIN] : [])] }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

interface Found {
  name: string
  path: string
  real: string
  shadowed: boolean
}

async function executable(path: string): Promise<string | undefined> {
  try {
    const real = await realpath(path)
    await access(real, constants.X_OK)
    return (await stat(real)).isFile() ? real : undefined
  } catch {
    return undefined
  }
}

// Each file of the direct folders, and the commands of the catalog in the other folders of the PATH.
async function findTools(environment: Environment): Promise<Found[]> {
  // The folders of Windows are on the PATH of WSL, and a snap is a link to the snap command.
  const onPath = environment.path.split(':').filter((folder) => folder.startsWith('/') && !folder.startsWith('/mnt/') && !folder.startsWith('/snap/'))
  const found: Found[] = []
  const first = new Map<string, string>()
  for (const folder of new Set([...onPath, ...environment.direct])) {
    const names = environment.direct.includes(folder) ? await readdir(folder).catch(() => []) : Object.keys(CATALOG)
    for (const name of names) {
      const path = posix.join(folder, name)
      const real = await executable(path)
      if (real === undefined) continue
      const runs = first.get(name)
      if (runs === undefined) first.set(name, real)
      // /bin and /usr/bin are one folder, and a link can repeat a file.
      if (found.some((other) => other.name === name && other.real === real)) continue
      found.push({ name, path, real, shadowed: runs !== undefined && runs !== real })
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

// A file under a git repository comes from that repository.
function inRepository(real: string, home: string): boolean {
  for (let folder = dirname(real); folder !== '/' && folder !== home; folder = dirname(folder)) if (existsSync(posix.join(folder, '.git'))) return true
  return false
}

async function owner(host: Host, real: string): Promise<string | undefined> {
  // dpkg can know a file of /usr/bin by its path in /bin.
  for (const path of [real, real.replace(/^\/usr(?=\/s?bin\/)/, '')]) {
    const result = await host.run('dpkg', ['-S', path])
    if (result.code === NOT_FOUND) return undefined
    const name = result.code === 0 ? /^([\w.+-]+)(?::\w+)?:/.exec(result.stdout)?.[1] : undefined
    if (name) return name
  }
  return undefined
}

// The installed version and the candidate of each package.
export function parsePolicy(text: string): Map<string, { installed: string; candidate: string }> {
  const found = new Map<string, { installed: string; candidate: string }>()
  for (const block of text.split(/^(?=\S[^\n]*:$)/m)) {
    const name = /^(\S+?):$/m.exec(block)?.[1]
    const installed = /^ {2}Installed: (\S+)$/m.exec(block)?.[1]
    const candidate = /^ {2}Candidate: (\S+)$/m.exec(block)?.[1]
    if (name && installed && candidate && installed !== '(none)') found.set(name, { installed, candidate })
  }
  return found
}

async function aptState(host: Host, system: System): Promise<Inventory['apt'][number] | undefined> {
  const list = await host.run('apt', ['list', '--upgradable'], { env: { LC_ALL: 'C' } })
  if (list.code !== 0) return undefined
  const stamp = (await stat('/var/lib/apt/periodic/update-success-stamp').catch(() => undefined)) ?? (await stat('/var/lib/apt/lists').catch(() => undefined))
  return { system: system.id, upgradable: list.stdout.split('\n').filter((line) => line.includes('[upgradable from')).length, ...(stamp ? { date: stamp.mtime.toISOString() } : {}) }
}

async function installedVersion(host: Host, one: Found, known: Known | undefined, embedded: string | undefined): Promise<string | undefined> {
  if (embedded !== undefined) return embedded
  if (!known?.version) return undefined
  const result = await host.run(one.path, known.version, { cwd: host.home, timeoutMs: 20_000 })
  // A tool writes its version with a prefix of its own, go1.27.3 or jq-1.8.1 for instance.
  const text = `${result.stdout}\n${result.stderr}`.replace(/\b(?:go|jq-)(?=\d)/g, '').replace(/\((?=v?\d)/g, ' ')
  const version = versionOf(text)
  return version === 'unknown' ? undefined : version
}

async function newest(name: string, version: string | undefined, known: Known | undefined, module: string | undefined, registries: Registries): Promise<Latest | undefined> {
  if (name === 'node' && version) return registries.node(version.split('.')[0])
  if (name === 'go') return registries.go()
  if (known?.github) return registries.github(known.github, known.prefix)
  // A module of a company stays on the machine: only the public hosts are asked.
  const repository = module?.split('/').slice(1, 3).join('/')
  if (module?.startsWith('github.com/') && repository) return registries.github(repository)
  if (module?.startsWith('golang.org/x/')) return registries.goModule(module)
  return undefined
}

async function readTool(host: Host, system: System, one: Found, extra: Record<string, Known>, registries: Registries): Promise<InstalledTool> {
  // A name of the file system can be one that each object inherits, constructor for instance.
  const known = [extra, CATALOG].find((entries) => Object.hasOwn(entries, one.name))?.[one.name]
  const tool: InstalledTool = { system: system.id, name: one.name, source: 'direct', path: one.path, ...(one.shadowed ? { shadowed: true } : {}) }
  if (inRepository(one.real, host.home)) return { ...tool, source: 'repository' }
  const apt = await owner(host, one.real)
  if (apt) return { ...tool, source: 'apt', package: apt }
  if (one.real.includes('/.nvm/versions/node/')) tool.source = 'nvm'
  const build = await readGoBuild(one.real)
  tool.version = await installedVersion(host, one, known, build?.version)
  try {
    const latest = await newest(one.name, tool.version, known, build?.module, registries)
    if (latest) Object.assign(tool, { latest: latest.version, url: latest.url })
    tool.note = latest ? known?.note : 'Unknown project: inventory.tools can name it'
  } catch (error) {
    tool.note = message(error)
  }
  if (tool.source === 'nvm' && tool.latest) tool.command = `nvm install ${tool.latest}`
  if (tool.note === undefined) delete tool.note
  if (tool.version === undefined) delete tool.version
  return tool
}

async function readApt(host: Host, tools: InstalledTool[]): Promise<void> {
  const owned = tools.filter((tool) => tool.source === 'apt' && tool.package)
  if (owned.length === 0) return
  const policy = await host.run('apt-cache', ['policy', ...new Set(owned.map((tool) => tool.package as string))], { env: { LC_ALL: 'C' } })
  const versions = parsePolicy(policy.stdout)
  for (const tool of owned) {
    const found = versions.get(tool.package as string)
    if (!found) continue
    tool.version = found.installed
    tool.latest = found.candidate
    if (found.installed !== found.candidate) tool.command = `sudo apt update && sudo apt install --only-upgrade ${tool.package}`
  }
}

// The global packages of npm. A linked package comes from a repository.
export function parseNpmGlobal(text: string): { name: string; version: string }[] {
  const { dependencies = {} } = JSON.parse(text) as { dependencies?: Record<string, { version?: string; resolved?: string; link?: boolean }> }
  return Object.entries(dependencies).flatMap(([name, { version, resolved, link }]) => (version && !link && !resolved?.startsWith('file:') ? [{ name, version }] : []))
}

async function npmGlobal(host: Host, system: System, registries: Registries): Promise<InstalledTool[]> {
  const result = await host.run('npm', ['ls', '--global', '--depth=0', '--json'], { cwd: host.home })
  if (result.stdout.trim() === '') return []
  const tools: InstalledTool[] = []
  for (const { name, version } of parseNpmGlobal(result.stdout)) {
    const tool: InstalledTool = { system: system.id, name, version, source: 'npm' }
    try {
      const latest = await registries.npm(name)
      Object.assign(tool, { latest: latest.version, url: latest.url, command: `npm install --global ${name}@${latest.version}` })
    } catch (error) {
      tool.note = message(error)
    }
    tools.push(tool)
  }
  return tools
}

export async function linuxTools(host: Host, system: System, environment: Environment, extra: Record<string, Known>, registries: Registries): Promise<ToolResult> {
  const tools: InstalledTool[] = []
  for (const one of await findTools(environment)) tools.push(await readTool(host, system, one, extra, registries))
  await readApt(host, tools)
  const apt = await aptState(host, system)
  tools.push(...(await npmGlobal(host, system, registries).catch(() => [])))
  return { tools, problems: [], ...(apt ? { apt } : {}) }
}

// winget prints a table, and its titles depend on the language of Windows.
// The columns keep their order: the name, the ID, the version, the available version.
export function parseWinget(text: string): { name: string; id: string; version: string; latest: string }[] {
  const lines = text.split(/\r?\n|\r/)
  const rule = lines.findIndex((line) => /^-{10,}\s*$/.test(line))
  if (rule < 1) return []
  // An empty line can come between the titles and the rule.
  const titles = lines.slice(0, rule).findLast((line) => line.trim() !== '') ?? ''
  const starts = [...titles.matchAll(/\S+/g)].map((match) => match.index)
  if (starts.length < 4) return []
  const found: { name: string; id: string; version: string; latest: string }[] = []
  for (const line of lines.slice(rule + 1)) {
    if (line.trim() === '') continue
    const cell = (index: number): string => line.slice(starts[index], starts[index + 1]).trim()
    // The line after the table counts its rows, and is not a row.
    if (!/^[\w.+-]+$/.test(cell(1)) || !/\d/.test(cell(3)) || /\s/.test(cell(3))) continue
    found.push({ name: cell(0), id: cell(1), version: cell(2), latest: cell(3) })
  }
  return found
}

export async function windowsTools(host: Host, system: System): Promise<ToolResult> {
  if (!host.windows) return { tools: [], problems: [] }
  const result = await host.windows.exec(['winget', 'upgrade', '--disable-interactivity', '--accept-source-agreements'], { timeoutMs: 180_000 })
  if (result.code === NOT_FOUND) return { tools: [], problems: [{ system: system.id, subject: 'winget', reason: 'not installed' }] }
  const tools = parseWinget(result.stdout).map(
    ({ name, id, version, latest }): InstalledTool => ({ system: system.id, name, version, latest, source: 'winget', package: id, command: `winget upgrade --id ${id} --exact` }),
  )
  return { tools, problems: [] }
}

export type ExtraTools = Record<string, Known>
