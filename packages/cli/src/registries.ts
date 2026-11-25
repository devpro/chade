import { isNewer, preRelease } from '@chade/daemon'
import type { Result } from './exec.js'
import type { Host } from './system.js'
import { isNativeWindows } from './system.js'

// The newest version of a package, an image or a tool, as its registry gives it.
// Each name is asked once for each inventory, whatever the number of repositories that use it.

export interface Latest {
  version: string
  date?: string
  url?: string
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

const TIMEOUT_MS = 20_000

// A name of npm, without a character that a shell reads.
const NPM_NAME = /^(?:@[a-z0-9~_][\w.~-]*\/)?[a-z0-9~_][\w.~-]*$/i
const NUGET_NAME = /^\w[\w.-]*$/
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/
export const VERSION = /^\d[\w.+-]*$/

// An image reference names the host to ask, and a cloned repository can name any host.
// Thus, chade asks the public registries only.
const IMAGE_REGISTRIES = new Set(['docker.io', 'ghcr.io', 'quay.io', 'mcr.microsoft.com', 'registry.k8s.io', 'gcr.io', 'public.ecr.aws', 'registry.gitlab.com', 'registry.suse.com'])

const MANIFESTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

export interface ImageReference {
  registry: string
  // The name that the registry knows, library/node for node.
  path: string
  // The name as the file gives it, without the tag.
  name: string
  tag: string
  digest?: string
}

// Absent for a reference with a variable, or for scratch.
export function parseImage(text: string): ImageReference | undefined {
  if (!/^[a-z0-9][\w./:@-]*$/i.test(text) || text === 'scratch') return undefined
  const [reference, digest] = text.split('@')
  const slash = reference.lastIndexOf('/')
  const colon = reference.indexOf(':', slash + 1)
  const name = colon < 0 ? reference : reference.slice(0, colon)
  const tag = colon < 0 ? 'latest' : reference.slice(colon + 1)
  if (tag === '' || (digest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(digest))) return undefined
  const first = name.split('/')[0]
  const hosted = name.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')
  const registry = hosted ? first : 'docker.io'
  const rest = hosted ? name.slice(first.length + 1) : name
  const path = registry === 'docker.io' && !rest.includes('/') ? `library/${rest}` : rest
  return { registry, path, name, tag, ...(digest ? { digest } : {}) }
}

// A tag as its prefix, its numbers and its variant, 16.1-alpine3.20 for instance.
function parseTag(tag: string): { prefix: string; numbers: string; suffix: string; shape: string } | undefined {
  const match = /^(v?)(\d+(?:\.\d+)*)((?:[-_].*)?)$/.exec(tag)
  if (!match) return undefined
  return { prefix: match[1], numbers: match[2], suffix: match[3], shape: match[3].replace(/\d+(?:\.\d+)*/g, '#') }
}

// The newest tag of the same form: the same count of numbers and the same variant.
export function newestTag(current: string, tags: string[]): string | undefined {
  const own = parseTag(current)
  if (!own) return undefined
  const parts = own.numbers.split('.')
  const numbersIn = (suffix: string): string => (suffix.match(/\d+/g) ?? ['0']).join('.')
  let best = { tag: current, ...own }
  for (const tag of tags) {
    const other = parseTag(tag)
    if (other?.prefix !== own.prefix || other.shape !== own.shape) continue
    const numbers = other.numbers.split('.')
    // A tag such as 20260101 is a date and not the next version of 24.
    if (numbers.length !== parts.length || numbers[0].length > parts[0].length + 1) continue
    const later = isNewer(other.numbers, best.numbers) || (other.numbers === best.numbers && isNewer(numbersIn(other.suffix), numbersIn(best.suffix)))
    if (later) best = { tag, ...other }
  }
  return best.tag === current ? undefined : best.tag
}

function newestOf(versions: string[]): string | undefined {
  return versions.filter((version) => VERSION.test(version) && !preRelease(version)).reduce<string | undefined>((best, version) => (best === undefined || isNewer(version, best) ? version : best), undefined)
}

// The version in a tag of a release, v1.2.3 for instance, or with the prefix that the catalog gives.
export function releaseVersion(tag: string, prefix = ''): string | undefined {
  if (!tag.startsWith(prefix)) return undefined
  return /^v?(\d+\.\d+(?:\.\d+)*)$/.exec(tag.slice(prefix.length))?.[1]
}

function headerField(header: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(header)?.[1]
}

export class Registries {
  private readonly answers = new Map<string, Promise<unknown>>()

  constructor(
    private readonly host: Host,
    private readonly fetcher: Fetch = fetch,
  ) {}

  private once<T>(key: string, read: () => Promise<T>): Promise<T> {
    const known = this.answers.get(key)
    if (known) return known as Promise<T>
    const asked = read()
    this.answers.set(key, asked)
    return asked
  }

  private request(url: string, init: RequestInit = {}): Promise<Response> {
    return this.fetcher(url, { ...init, headers: { 'User-Agent': 'chade', ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  }

  private async json<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.request(url, { headers })
    if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`)
    return (await response.json()) as T
  }

  // The address of the newest release redirects to its tag, and has no limit for each hour, as the API has.
  // Absent when the newest release is of another part of the repository, a Helm chart for instance.
  private async redirectedRelease(repository: string, prefix?: string): Promise<Latest | undefined> {
    let url = `https://github.com/${repository}/releases/latest`
    // A repository that moved redirects to its new address first.
    for (let hop = 0; hop < 3; hop++) {
      const response = await this.request(url, { method: 'HEAD', redirect: 'manual' })
      const target = new URL(response.headers.get('location') ?? url, url)
      if (target.href === url || target.host !== 'github.com') return undefined
      const tag = /\/releases\/tag\/(.+)$/.exec(target.pathname)?.[1]
      if (tag !== undefined) {
        const version = releaseVersion(decodeURIComponent(tag), prefix)
        return version === undefined ? undefined : { version, url: target.href }
      }
      url = target.href
    }
    return undefined
  }

  private async listedRelease(repository: string, prefix?: string): Promise<Latest> {
    const releases = await this.json<{ tag_name: string; html_url: string; published_at: string; prerelease: boolean; draft: boolean }[]>(`https://api.github.com/repos/${repository}/releases?per_page=50`)
    for (const release of releases.filter((one) => !one.prerelease && !one.draft)) {
      const version = releaseVersion(release.tag_name, prefix)
      if (version !== undefined) return { version, url: release.html_url, date: release.published_at }
    }
    throw new Error(`GitHub gives no release of ${repository}`)
  }

  github(repository: string, prefix?: string): Promise<Latest> {
    return this.once(`github ${repository}`, async () => {
      if (!REPOSITORY.test(repository)) throw new Error(`${repository} is not a repository of GitHub`)
      return (await this.redirectedRelease(repository, prefix)) ?? this.listedRelease(repository, prefix)
    })
  }

  // The newest release of the same major version, as another major version is a choice of the user.
  node(major: string): Promise<Latest> {
    return this.once(`node ${major}`, async () => {
      const releases = await this.json<{ version: string; date: string }[]>('https://nodejs.org/dist/index.json')
      const version = newestOf(releases.map((release) => release.version.slice(1)).filter((one) => one.startsWith(`${major}.`)))
      if (!version) throw new Error(`nodejs.org gives no release of Node.js ${major}`)
      return { version, date: releases.find((release) => release.version === `v${version}`)?.date, url: `https://github.com/nodejs/node/releases/tag/v${version}` }
    })
  }

  go(): Promise<Latest> {
    return this.once('go', async () => {
      const releases = await this.json<{ version: string; stable: boolean }[]>('https://go.dev/dl/?mode=json')
      const version = newestOf(releases.filter((release) => release.stable).map((release) => release.version.replace(/^go/, '')))
      if (!version) throw new Error('go.dev gives no release')
      return { version, url: 'https://go.dev/doc/devel/release' }
    })
  }

  goModule(module: string): Promise<Latest> {
    return this.once(`module ${module}`, async () => {
      const { Version, Time } = await this.json<{ Version: string; Time?: string }>(`https://proxy.golang.org/${module}/@latest`)
      return { version: Version.replace(/^v/, ''), date: Time, url: `https://pkg.go.dev/${module}` }
    })
  }

  // npm reads the settings of the user, so a scope goes to the registry that the user gave for it.
  // It runs in the home folder, where it reads no .npmrc of a repository.
  private npmRun(args: string[]) {
    if (isNativeWindows(this.host) && this.host.windows) return this.host.windows.exec(['npm', ...args], { timeoutMs: 60_000 })
    return this.host.run('npm', args, { cwd: this.host.home, timeoutMs: 60_000 })
  }

  npm(name: string): Promise<Latest> {
    return this.once(`npm ${name}`, async () => {
      if (!NPM_NAME.test(name)) throw new Error(`${name} is not a name of npm`)
      const result = await this.npmRun(['view', name, 'version', 'time', '--json'])
      if (result.code !== 0) throw new Error(`npm view failed: ${npmReason(result)}`)
      const parsed = JSON.parse(result.stdout) as NpmView | NpmView[]
      const { version, time } = Array.isArray(parsed) ? parsed[0] : parsed
      if (typeof version !== 'string' || !VERSION.test(version)) throw new Error('npm view gave no version')
      const date = time?.[version]
      return { version, ...(date ? { date } : {}), url: `https://www.npmjs.com/package/${name}` }
    })
  }

  // A setting of npm, absent when the user gives none.
  npmSetting(key: string): Promise<string | undefined> {
    return this.once(`setting ${key}`, async () => {
      if (!/^(?:@[\w.~-]+:)?registry$/.test(key)) return undefined
      const value = (await this.npmRun(['config', 'get', key])).stdout.trim()
      return value === '' || value === 'undefined' ? undefined : value
    })
  }

  nuget(name: string): Promise<Latest> {
    return this.once(`nuget ${name.toLowerCase()}`, async () => {
      if (!NUGET_NAME.test(name)) throw new Error(`${name} is not a name of NuGet`)
      const { versions } = await this.json<{ versions: string[] }>(`https://api.nuget.org/v3-flatcontainer/${name.toLowerCase()}/index.json`)
      const version = newestOf(versions)
      if (!version) throw new Error('nuget.org gives no stable version')
      return { version, url: `https://www.nuget.org/packages/${name}/${version}` }
    })
  }

  // A provider of the public registry, as its namespace and its name.
  terraform(provider: string): Promise<Latest> {
    return this.once(`terraform ${provider}`, async () => {
      if (!REPOSITORY.test(provider)) throw new Error(`${provider} is not a provider`)
      const { version, published_at: date } = await this.json<{ version: string; published_at?: string }>(`https://registry.terraform.io/v1/providers/${provider}`)
      return { version, date, url: `https://registry.terraform.io/providers/${provider}/${version}` }
    })
  }

  private async image(image: ImageReference, resource: string, init: RequestInit = {}): Promise<Response> {
    if (!IMAGE_REGISTRIES.has(image.registry)) throw new Error(`chade does not read the registry ${image.registry}`)
    const host = image.registry === 'docker.io' ? 'registry-1.docker.io' : image.registry
    const url = `https://${host}/v2/${image.path}/${resource}`
    const response = await this.request(url, init)
    if (response.status !== 401) return response
    // A public image is read with a token that the registry gives to anyone.
    const challenge = response.headers.get('www-authenticate') ?? ''
    const realm = headerField(challenge, 'realm')
    if (!realm?.startsWith('https://')) throw new Error('the registry asks for a sign-in')
    const query = new URLSearchParams({ service: headerField(challenge, 'service') ?? '', scope: `repository:${image.path}:pull` })
    const { token, access_token: access } = await this.json<{ token?: string; access_token?: string }>(`${realm}?${query}`)
    return this.request(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token ?? access}` } })
  }

  imageTags(image: ImageReference): Promise<string[]> {
    return this.once(`tags ${image.registry}/${image.path}`, async () => {
      const response = await this.image(image, 'tags/list')
      if (!response.ok) throw new Error(`${image.registry} answered ${response.status}`)
      return ((await response.json()) as { tags?: string[] }).tags ?? []
    })
  }

  imageDigest(image: ImageReference): Promise<string | undefined> {
    return this.once(`digest ${image.registry}/${image.path}:${image.tag}`, async () => {
      const response = await this.image(image, `manifests/${image.tag}`, { method: 'HEAD', headers: { Accept: MANIFESTS } })
      if (!response.ok) throw new Error(`${image.registry} answered ${response.status}`)
      return response.headers.get('docker-content-digest') ?? undefined
    })
  }
}

// npm writes the code of its error as JSON, and the text of it apart.
function npmReason(result: Result): string {
  const code = /"code": *"(\w+)"/.exec(result.stdout)?.[1]
  return code ?? (result.stderr.trim().split('\n')[0] || `exit code ${result.code}`)
}

interface NpmView {
  version?: unknown
  time?: Record<string, string>
}
