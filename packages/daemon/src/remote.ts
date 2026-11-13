// The host a repository is pushed to, told by the address of its remote.
export type Forge = 'github' | 'gitlab' | 'azure' | 'git'

export interface Remote {
  name: string
  forge: Forge
  // Absent for a remote that is a folder or a name of the local network.
  host?: string
}

// Where each forge shows a branch, after the address of the repository.
const BRANCH_PAGES: Record<string, string> = { 'github.com': '/tree/', 'gitlab.com': '/-/tree/', 'bitbucket.org': '/src/' }

// The address on the web of a remote at git@host:owner/name.git or https://host/owner/name.git, before any page of it.
function webBase(remote: string): URL | undefined {
  let base: string
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(remote)
  if (scp) base = `https://${scp[1]}/${scp[2]}`
  else {
    let url: URL
    try {
      url = new URL(remote)
    } catch {
      return undefined
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return undefined
    // The port of ssh is no port of the web, and the name and password of a remote stay out of a link.
    base = url.protocol === 'http:' || url.protocol === 'https:' ? `${url.protocol}//${url.host}${url.pathname}` : `https://${url.hostname}${url.pathname}`
  }
  const web = new URL(base.replace(/\/+$/, '').replace(/\.git$/, ''))
  // A host without a dot is a folder read as scp, C:/repos/name, or a name of the local network.
  if (!web.hostname.includes('.') || web.pathname.split('/').filter(Boolean).length < 2) return undefined
  return web
}

// The page on the web of a repository whose remote is at the address given, at the branch given on the hosts that have a page for it.
export function webAddress(remote: string, branch?: string): string | undefined {
  const web = webBase(remote)
  if (!web) return undefined
  const page = BRANCH_PAGES[web.hostname]
  if (page && branch) web.pathname += page + branch.split('/').map(encodeURIComponent).join('/')
  return web.href
}

// A forge known by its host, its own instance or one a company runs under a name holding the name of the forge.
export function forgeOf(remote: string): { forge: Forge; host?: string } {
  const host = webBase(remote)?.hostname
  if (!host) return { forge: 'git' }
  const azure = host === 'dev.azure.com' || host.endsWith('.dev.azure.com') || host.endsWith('.visualstudio.com')
  const forge: Forge = azure ? 'azure' : /(^|[.-])github([.-]|$)/.test(host) ? 'github' : /(^|[.-])gitlab([.-]|$)/.test(host) ? 'gitlab' : 'git'
  return { forge, host }
}

// The remote a repository is known by: the one the branch tracks, or origin, or the only one.
export function mainRemote(names: string[], tracked?: string): string | undefined {
  if (tracked && names.includes(tracked)) return tracked
  if (names.includes('origin')) return 'origin'
  return names.length === 1 ? names[0] : undefined
}

// Reads the output of git config --get-regexp ^remote\..*\.url$, a remote whose name holds a dot included.
export function parseRemoteUrls(text: string): Map<string, string> {
  const urls = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^remote\.(.+)\.url (.*)$/.exec(line)
    // A remote with several addresses is known by the first, the one git fetches from.
    if (match && !urls.has(match[1])) urls.set(match[1], match[2].trim())
  }
  return urls
}
