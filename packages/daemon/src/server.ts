import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join } from 'node:path'

export interface ServerOptions {
  port: number
  // Folder of the built web interface, served as it is.
  uiDir: string
  // The routes of the API, each one answering a GET with what it returns, as JSON.
  api: Record<string, (query: URLSearchParams) => Promise<unknown>>
  // The routes that change something, each one answering a POST of a JSON body.
  actions?: Record<string, (body: unknown) => Promise<unknown>>
}

export interface Server {
  // Address of the web interface, without the token.
  address: string
  // Address that signs the browser in, the token in its fragment, which a browser never sends to a server nor to another site.
  url: string
  token: string
  close: () => Promise<void>
}

// A request the server cannot answer as asked, with the status that says why.
export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

// Other machines have no business with this server, so it listens on the loopback address only.
const HOST = '127.0.0.1'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const HEADERS = {
  // The interface is its own files and nothing else, so a script injected through a repository name or a commit subject has nowhere to run from.
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}

function send(response: ServerResponse, status: number, type: string, body: string | Buffer, head = false): void {
  response.writeHead(status, { ...HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) })
  response.end(head ? undefined : body)
}

function refuse(response: ServerResponse, status: number, error: string): void {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify({ error }))
}

const MAX_BODY = 1024 * 1024

async function readJson(request: IncomingMessage): Promise<unknown> {
  // A form of another site can post text or form fields without asking, and never JSON.
  if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) throw new RequestError(415, 'the body of a request is JSON')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new RequestError(413, 'the body of the request is too large')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError(400, 'the body of the request is not valid JSON')
  }
}

// Digests have one length, which timingSafeEqual needs, and comparing them tells nothing about the token.
function sameToken(given: string, token: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(given), digest(token))
}

export async function startServer(options: ServerOptions): Promise<Server> {
  // The files are read once, by name, so no request can name a path outside of the folder.
  const files = new Map<string, Buffer>()
  for (const name of await readdir(options.uiDir)) {
    if (CONTENT_TYPES[extname(name)]) files.set(`/${name}`, await readFile(join(options.uiDir, name)))
  }
  if (!files.has('/index.html')) throw new Error(`${options.uiDir} holds no index.html`)
  // A token for each start, so one that leaked stops working when the server does.
  const token = randomBytes(32).toString('base64url')
  let hosts = new Set<string>()

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // A web page of another site can make the browser resolve its own name to 127.0.0.1, and that request carries the name of that site as its host.
    if (!hosts.has(request.headers.host ?? '')) return refuse(response, 403, 'this host is not the one chade serves')
    // The browser names the site a request comes from, and no other site has a request to send here.
    const origin = request.headers.origin
    if (origin !== undefined && !hosts.has(origin.replace(/^http:\/\//, ''))) return refuse(response, 403, 'this request comes from another site')
    const url = new URL(request.url ?? '/', `http://${HOST}`)
    const path = url.pathname
    const head = request.method === 'HEAD'
    if (path.startsWith('/api/')) {
      const given = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]
      if (given === undefined || !sameToken(given, token)) return refuse(response, 401, 'chade ui gives the address that signs in')
      const name = path.slice('/api/'.length)
      const action = options.actions?.[name]
      if (request.method === 'POST') {
        if (!action) return refuse(response, options.api[name] ? 405 : 404, options.api[name] ? 'this route only reads' : 'no such route')
        return send(response, 200, 'application/json; charset=utf-8', JSON.stringify(await action(await readJson(request))))
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(response, 405, 'a route is read with GET, or changed with POST')
      const route = options.api[name]
      if (!route) return refuse(response, action ? 405 : 404, action ? 'this route is called with POST' : 'no such route')
      return send(response, 200, 'application/json; charset=utf-8', JSON.stringify(await route(url.searchParams)), head)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(response, 405, 'a page is read with GET')
    const name = path === '/' ? '/index.html' : path
    const file = files.get(name)
    if (!file) return refuse(response, 404, 'no such page')
    send(response, 200, CONTENT_TYPES[extname(name)], file, head)
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) return response.destroy()
      refuse(response, error instanceof RequestError ? error.status : 500, error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE' ? new Error(`port ${options.port} is taken, --port chooses another one`) : error)
    })
    server.listen(options.port, HOST, resolve)
  })
  const { port } = server.address() as AddressInfo
  hosts = new Set([`${HOST}:${port}`, `localhost:${port}`])
  const address = `http://${HOST}:${port}`
  return {
    address,
    url: `${address}/#token=${token}`,
    token,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
