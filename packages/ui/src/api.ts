const TOKEN_KEY = 'chade-token'

// Why a read gave nothing: no token, a token the server no longer knows, an answer that is an error, or no answer.
export class ApiError extends Error {
  constructor(
    readonly kind: 'signed-out' | 'ended' | 'refused' | 'offline',
    message: string,
  ) {
    super(message)
  }
}

// What the address names after the #: the repository shown and the commit chosen, and the token when chade ui opened the page.
// A page other than the list and a repository is named first, as in #store?machine=PC or #report, and read here as the value of page.
export function route(): URLSearchParams {
  const hash = location.hash.slice(1)
  const mark = hash.indexOf('?')
  const name = mark < 0 ? hash : hash.slice(0, mark)
  if (name === '' || name.includes('=')) return new URLSearchParams(hash)
  const params = new URLSearchParams(mark < 0 ? '' : hash.slice(mark + 1))
  params.set('page', name)
  return params
}

export function address(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(values)) if (value !== undefined && name !== 'page') params.set(name, value)
  if (values.page === undefined) return `#${params}`
  return `#${values.page}${params.size > 0 ? `?${params}` : ''}`
}

// The token arrives in the fragment of the address chade ui opens, and leaves the address bar and the history at once.
function takeToken(): string | null {
  const params = route()
  const given = params.get('token')
  if (given) {
    sessionStorage.setItem(TOKEN_KEY, given)
    params.delete('token')
    history.replaceState(null, '', location.pathname + (params.size > 0 ? address(Object.fromEntries(params)) : ''))
  }
  return sessionStorage.getItem(TOKEN_KEY)
}

export function get<T>(name: string, query: Record<string, string> = {}): Promise<T> {
  const search = new URLSearchParams(query)
  return call<T>(`api/${name}${search.size > 0 ? `?${search}` : ''}`, {})
}

// Asks the server to change something, where get only reads.
export function post<T>(name: string, body: unknown): Promise<T> {
  return call<T>(`api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  const token = takeToken()
  if (!token) throw new ApiError('signed-out', 'Not signed in. The chade ui command opens this page with the address that signs in.')
  let response: Response
  try {
    response = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } })
  } catch {
    throw new ApiError('offline', 'The server does not answer. The chade ui command starts it.')
  }
  if (response.status === 401) {
    // The token of a server that was stopped since: the next chade ui gives a new one.
    sessionStorage.removeItem(TOKEN_KEY)
    throw new ApiError('ended', 'The session ended with the server it came from. The chade ui command opens a new one.')
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new ApiError('refused', body.error ?? `The server answered ${response.status}.`)
  return body
}
