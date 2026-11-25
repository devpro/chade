import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { Scan } from '@chade/daemon'
import { parseConfig } from '../src/config.js'
import { NOT_FOUND, run as realRun, type Run } from '../src/exec.js'
import { parseGoBuild } from '../src/gobinary.js'
import { parseNpmGlobal, parsePolicy, parseWinget } from '../src/installed.js'
import { inventory, inventoryFile, readInventory, renderInventory, saveInventory } from '../src/inventory.js'
import { accepts, composeImages, dependenciesOf, dockerfileImages, npmRegistries, nugetReferences, terraformProviders, usesNugetOrg } from '../src/manifests.js'
import { newestTag, parseImage, Registries, releaseVersion } from '../src/registries.js'
import type { Host } from '../src/system.js'

const linuxOnly = { skip: process.platform === 'win32' }

// A Go binary as the linker writes it: 16 bytes of header, the two texts, and the marks around the modules.
function goBinary(module: string, version: string): Buffer {
  const text = (value: Buffer): Buffer => Buffer.concat([Buffer.from(value.length < 128 ? [value.length] : [(value.length & 0x7f) | 0x80, value.length >> 7]), value])
  const header = Buffer.alloc(32)
  header.write('\xff Go buildinf:', 'latin1')
  header[15] = 2
  const modules = Buffer.concat([Buffer.alloc(16, 1), Buffer.from(`path\t${module}/cmd/tool\nmod\t${module}\t${version}\th1:abc=\n`), Buffer.alloc(16, 2)])
  return Buffer.concat([Buffer.alloc(64), header, text(Buffer.from('go1.26.4')), text(modules)])
}

test('a Go binary gives its module and its release without a run', () => {
  assert.deepEqual(parseGoBuild(goBinary('github.com/fluxcd/flux2/v2', 'v2.9.2+dirty')), { module: 'github.com/fluxcd/flux2/v2', version: '2.9.2' })
  assert.deepEqual(parseGoBuild(goBinary('helm.sh/helm/v3', '(devel)')), { module: 'helm.sh/helm/v3' })
  assert.deepEqual(parseGoBuild(goBinary('github.com/a/b', 'v0.18.1-0.20260123060032-9949c60f2672')), { module: 'github.com/a/b' })
  assert.equal(parseGoBuild(Buffer.from('\xff Go buildinf:', 'latin1')), undefined)
  assert.equal(parseGoBuild(Buffer.from('#!/bin/sh\n')), undefined)
})

test('the output of apt, npm and winget gives the versions', () => {
  const policy = 'terraform:\n  Installed: 1.17.2-1\n  Candidate: 1.17.3-1\n  Version table:\n *** 1.17.2-1 500\nskopeo:\n  Installed: (none)\n  Candidate: 1.0\n'
  assert.deepEqual([...parsePolicy(policy)], [['terraform', { installed: '1.17.2-1', candidate: '1.17.3-1' }]])
  assert.deepEqual(parseNpmGlobal('{"dependencies":{"npm":{"version":"11.0.0"},"own":{"version":"1.0.0","resolved":"file:../own"}}}'), [{ name: 'npm', version: '11.0.0' }])
  const winget = ['Nom                      ID                Version        Disponible', '', '----------------------------------------------------------------------', '', 'Google Chrome            Google.Chrome.EXE 158.0.8127.37  158.0.8127.89', '3 mises a niveau disponibles.'].join('\r\n')
  assert.deepEqual(parseWinget(winget), [{ name: 'Google Chrome', id: 'Google.Chrome.EXE', version: '158.0.8127.37', latest: '158.0.8127.89' }])
  assert.deepEqual(parseWinget('No installed package found.'), [])
})

test('an image reference gives its registry, and a newer tag keeps the variant', () => {
  assert.deepEqual(parseImage('node:24-alpine'), { registry: 'docker.io', path: 'library/node', name: 'node', tag: '24-alpine' })
  assert.deepEqual(parseImage('mcr.microsoft.com/dotnet/sdk:10.0'), { registry: 'mcr.microsoft.com', path: 'dotnet/sdk', name: 'mcr.microsoft.com/dotnet/sdk', tag: '10.0' })
  assert.equal(parseImage('localhost:5000/app')?.registry, 'localhost:5000')
  for (const text of ['scratch', 'node:${VERSION}', '-v', 'a b', 'node@sha256:short']) assert.equal(parseImage(text), undefined)
  assert.equal(newestTag('16.1-alpine', ['16.4-alpine', '17.2-alpine', '18.0', '18-alpine', '17.2-bookworm', 'latest']), '17.2-alpine')
  assert.equal(newestTag('24.1-alpine3.20', ['24.1-alpine3.21', '24.1-alpine3.9']), '24.1-alpine3.21')
  assert.equal(newestTag('24', ['26', '20260101']), '26')
  assert.equal(newestTag('latest', ['1.0']), undefined)
})

test('a range accepts what npm installs for it', () => {
  assert.deepEqual([accepts('^1.2.3', '1.9.0'), accepts('^1.2.3', '2.0.0'), accepts('~1.2.3', '1.2.9'), accepts('~1.2.3', '1.3.0'), accepts('^0.2.3', '0.3.0'), accepts('1.2.3', '1.2.4')], [true, false, true, false, false, false])
})

test('the files of a repository give the dependencies without a run', async () => {
  const files: Record<string, string> = {
    'package.json': '{"name":"root","dependencies":{"a":"^1.0.0","own":"1.0.0","local":"file:../x"}}',
    'packages/own/package.json': '{"name":"own","devDependencies":{"b":"~2.0.0","c":"workspace:*"}}',
    'package-lock.json': '{"packages":{"node_modules/a":{"version":"1.4.0"},"packages/own/node_modules/b":{"version":"2.0.5"}}}',
    'pnpm/package.json': '{"dependencies":{"d":"^3.0.0"}}',
    'pnpm/pnpm-lock.yaml': "importers:\n  .:\n    dependencies:\n      d:\n        specifier: ^3.0.0\n        version: 3.1.0(e@1.0.0)\n",
    'bad/package.json': '{',
    'src/App.csproj': '<Project><!-- <PackageReference Include="Old" Version="1.0.0" /> --><PackageReference Include="X" Version="1.2.3" /><PackageReference Include="Y"><Version>4.5.6</Version></PackageReference><PackageReference Include="Z" Version="$(V)" /></Project>',
    'Directory.Packages.props': '<Project><PackageVersion Include="P" Version="7.0.0" /></Project>',
    Dockerfile: 'FROM --platform=linux/amd64 node:24 AS build\nFROM build\nFROM ${BASE}\n',
    'compose.yaml': 'services:\n  db:\n    image: postgres:16-alpine\n  app:\n    image: app\n    build: .\n',
    'infra/.terraform.lock.hcl': 'provider "registry.terraform.io/hashicorp/aws" {\n  version     = "6.1.0"\n}\n',
    'test/fixtures/package.json': '{"dependencies":{"hidden":"1.0.0"}}',
  }
  const found = await dependenciesOf(Object.keys(files), async (file) => files[file])
  assert.deepEqual(
    found.map((one) => [one.kind, one.file, one.name, one.current]),
    [
      ['npm', 'package.json', 'a', '1.4.0'],
      ['npm', 'packages/own/package.json', 'b', '2.0.5'],
      ['npm', 'pnpm/package.json', 'd', '3.1.0'],
      ['nuget', 'src/App.csproj', 'X', '1.2.3'],
      ['nuget', 'src/App.csproj', 'Y', '4.5.6'],
      ['nuget', 'Directory.Packages.props', 'P', '7.0.0'],
      ['image', 'Dockerfile', 'node:24', 'node:24'],
      ['image', 'Dockerfile', '${BASE}', '${BASE}'],
      ['image', 'compose.yaml', 'postgres:16-alpine', 'postgres:16-alpine'],
      ['terraform', 'infra/.terraform.lock.hcl', 'hashicorp/aws', '6.1.0'],
    ],
  )
  assert.equal(found[1].command?.('3.0.0'), 'npm install b@3.0.0 --workspace=packages/own')
  assert.equal(found[3].command?.('2.0.0'), 'dotnet add src/App.csproj package X --version 2.0.0')
  assert.equal(found[5].replace?.('8.0.0'), 'Version="8.0.0"')
})

test('a copied command holds no path that a shell reads as another command', async () => {
  const files: Record<string, string> = { 'a;b/App.csproj': '<PackageReference Include="X" Version="1.0.0" />', 'package.json': '{}', 'a;b/package.json': '{"dependencies":{"x":"1.0.0"}}', 'package-lock.json': '{}' }
  const found = await dependenciesOf(Object.keys(files), async (file) => files[file])
  assert.deepEqual(found.map((one) => one.command), [undefined, undefined])
})

test('the small parsers read their format', () => {
  assert.deepEqual(dockerfileImages('from a:1 as x\nFROM X\n'), ['a:1'])
  assert.deepEqual(composeImages('not: [valid'), [])
  assert.deepEqual(nugetReferences('<PackageReference Include="A" Version="[1.0,2.0)" />'), [])
  assert.deepEqual(terraformProviders('provider "registry.example.test/a/b" {\n  version = "1.0.0"\n}'), [])
  assert.deepEqual([...npmRegistries('@corp:registry=https://npm.example.test/\n//npm.example.test/:_authToken=secret\n')], [['@corp:registry', 'https://npm.example.test/']])
  assert.equal(usesNugetOrg('<add key="other" value="https://x.test" />'), true)
  assert.equal(usesNugetOrg('<clear /><add key="other" value="https://x.test" />'), false)
  assert.equal(usesNugetOrg('<packageSourceMapping>'), false)
  assert.deepEqual([releaseVersion('v1.2.3'), releaseVersion('helm-v2.1.0'), releaseVersion('jq-1.8.1', 'jq-')], ['1.2.3', undefined, '1.8.1'])
})

// The registries of the run. A host that is not here fails the test that asks it.
function registry(asked: string[]): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    asked.push(`${init?.method ?? 'GET'} ${url}`)
    const redirect = (location: string): Response => new Response(null, { status: 302, headers: { location } })
    if (url === 'https://github.com/fluxcd/flux2/releases/latest') return redirect('https://github.com/fluxcd/flux2/releases/tag/v2.10.1')
    if (url === 'https://github.com/bitnami-labs/sealed-secrets/releases/latest') return redirect('https://github.com/bitnami/sealed-secrets/releases/latest')
    if (url === 'https://github.com/bitnami/sealed-secrets/releases/latest') return redirect('https://github.com/bitnami/sealed-secrets/releases/tag/helm-v2.0.0')
    if (url.startsWith('https://api.github.com/repos/bitnami-labs/sealed-secrets/')) return Response.json([{ tag_name: 'helm-v2.0.0' }, { tag_name: 'v0.41.2', html_url: 'https://github.com/x', published_at: '2026-11-01' }])
    if (url.includes('/v3-flatcontainer/x/')) return Response.json({ versions: ['1.2.3', '1.4.0', '2.0.0-beta'] })
    if (url === 'https://registry.terraform.io/v1/providers/hashicorp/aws') return Response.json({ version: '6.74.0', published_at: '2026-11-23' })
    if (url.startsWith('https://auth.docker.io/token')) return Response.json({ token: 'anonymous' })
    if (url.startsWith('https://registry-1.docker.io/')) {
      if (!new Headers(init?.headers).get('authorization')) return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' } })
      if (url.endsWith('/library/postgres/tags/list')) return Response.json({ tags: ['16-alpine', '18-alpine'] })
      if (url.endsWith('/library/node/tags/list')) return Response.json({ tags: ['24', 'latest'] })
      if (url.endsWith('/library/node/manifests/24')) return new Response(null, { headers: { 'docker-content-digest': 'sha256:new' } })
    }
    if (url === 'https://nodejs.org/dist/index.json') return Response.json([{ version: 'v26.1.0', date: '2026-11-01' }, { version: 'v24.23.0', date: '2026-11-02' }])
    return new Response(null, { status: 404 })
  }
}

const hostOf = (home: string, run: Run): Host => ({ machine: 'TEST-PC', home, run, systems: [{ kind: 'linux', id: 'linux' }] })

test('a release of a moved repository is found, and each name is asked once', async () => {
  const asked: string[] = []
  const registries = new Registries(hostOf('/home/me', async () => ({ code: 1, stdout: '', stderr: '' })), registry(asked))
  assert.equal((await registries.github('bitnami-labs/sealed-secrets')).version, '0.41.2')
  const count = asked.length
  await registries.github('bitnami-labs/sealed-secrets')
  assert.equal(asked.length, count)
  assert.equal((await registries.node('24')).version, '24.23.0')
  await assert.rejects(registries.github('../x/y'), /is not a repository/)
  await assert.rejects(registries.imageTags({ registry: '169.254.169.254', path: 'x', name: 'x', tag: '1' }), /does not read the registry/)
  await assert.rejects(registries.npm('a && b'), /is not a name of npm/)
})

async function write(folder: string, files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(folder, file)), { recursive: true })
    await writeFile(join(folder, file), text)
  }
}

test('the inventory joins the tools, the dependencies and the fixes of the scan', linuxOnly, async () => {
  const home = await mkdtemp(join(tmpdir(), 'chade-inventory-'))
  const repository = join(home, 'repos', 'app')
  await write(repository, {
    'package.json': '{"dependencies":{"a":"1.0.0","@corp/private":"1.0.0"}}',
    '.npmrc': '@corp:registry=https://npm.example.test/\n',
    'App.csproj': '<PackageReference Include="X" Version="1.2.3" />',
    Dockerfile: 'FROM node:24\nFROM internal.example.test/app:1.0\n',
    'compose.yaml': 'services:\n  db:\n    image: postgres:16-alpine\n',
    'infra/.terraform.lock.hcl': 'provider "registry.terraform.io/hashicorp/aws" {\n  version = "6.1.0"\n}\n',
  })
  await write(join(home, 'repos', 'skipped'), { 'package.json': '{"dependencies":{"never":"1.0.0"}}' })
  for (const name of ['app', 'skipped']) {
    execFileSync('git', ['init', '--quiet', join(home, 'repos', name)])
    execFileSync('git', ['-C', join(home, 'repos', name), 'add', '--all'])
  }
  const bin = join(home, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'flux'), goBinary('github.com/fluxcd/flux2/v2', 'v2.9.2+dirty'))
  await writeFile(join(bin, 'terraform'), 'elf')
  await writeFile(join(bin, 'company'), goBinary('git.example.test/company', 'v1.0.0'))
  await writeFile(join(bin, 'notes.txt'), 'not a tool')
  await symlink(join(repository, 'tool.sh'), join(bin, 'linked'))
  await writeFile(join(repository, 'tool.sh'), '#!/bin/sh\n')
  for (const file of [join(bin, 'flux'), join(bin, 'terraform'), join(bin, 'company'), join(repository, 'tool.sh')]) await chmod(file, 0o755)
  const calls: string[] = []
  const run: Run = async (command, args, options) => {
    calls.push([command, ...args].join(' '))
    const answer = (stdout: string, code = 0) => ({ code, stdout, stderr: '' })
    if (command === 'git') return realRun(command, args, options)
    if (command === 'dpkg') return args[1].endsWith('/terraform') ? answer(`terraform: ${args[1]}\n`) : answer('', 1)
    if (command === 'apt-cache') return answer('terraform:\n  Installed: 1.17.2-1\n  Candidate: 1.17.3-1\n')
    if (command === 'apt') return answer('Listing...\nx/stable 2 amd64 [upgradable from: 1]\n')
    if (command === 'docker') return answer('["node@sha256:old"]')
    if (command === 'npm' && args[0] === 'view') return answer(JSON.stringify([{ version: '1.0.5', time: { '1.0.5': '2026-11-20' } }]))
    if (command === 'npm' && args[0] === 'config') return answer('undefined\n')
    if (command === 'npm') return answer('{"dependencies":{}}')
    return answer('', NOT_FOUND)
  }
  const finding = { ecosystem: 'npm', package: 'a', version: '1.0.0', ids: ['GHSA-1'], summary: '', severity: 'high' as const, malicious: false, tools: [] }
  const scan: Scan = {
    machine: 'TEST-PC',
    date: '2026-11-24T00:00:00.000Z',
    tools: [],
    skipped: [],
    places: [{ system: 'linux', kind: 'repository', label: 'app', path: `${repository}/node_modules`, packages: 1, notes: [], tools: [], findings: [{ ...finding, fixed: '1.0.2' }, { ...finding, ids: ['GHSA-2'], fixed: '2.0.0' }] }],
  }
  const config = parseConfig(`store: ${home}/store\nlinux:\n  repos: [${home}/repos]\ninventory:\n  skip: ['~/repos/skipped']\n`, home)
  const asked: string[] = []
  const result = await inventory(config, hostOf(home, run), { scan, fetch: registry(asked), environment: { path: bin, direct: [bin] } })

  const tools = new Map(result.tools.map((tool) => [tool.name, tool]))
  assert.deepEqual([...tools.keys()], ['company', 'flux', 'linked', 'terraform'])
  assert.deepEqual([tools.get('flux')?.source, tools.get('flux')?.version, tools.get('flux')?.latest], ['direct', '2.9.2', '2.10.1'])
  assert.deepEqual([tools.get('terraform')?.source, tools.get('terraform')?.latest], ['apt', '1.17.3-1'])
  assert.equal(tools.get('linked')?.source, 'repository')
  // A tool of a company is not asked of anyone.
  assert.match(tools.get('company')?.note ?? '', /inventory\.tools/)
  assert.equal(result.apt[0].upgradable, 1)

  const found = new Map(result.dependencies.map((one) => [one.name, one]))
  assert.deepEqual([found.get('a')?.latest, found.get('a')?.fixes, found.get('a')?.date], ['1.0.5', 1, '2026-11-20'])
  assert.equal(found.get('X')?.latest, '1.4.0')
  assert.deepEqual([found.get('node')?.rebuilt, found.get('node')?.command], [true, 'docker pull node:24'])
  assert.deepEqual([found.get('postgres')?.latest, found.get('postgres')?.replace], ['18-alpine', 'postgres:18-alpine'])
  assert.equal(found.get('hashicorp/aws')?.latest, '6.74.0')

  // The private names and the private hosts stay on the machine.
  assert.equal(calls.some((call) => call.includes('@corp/private') || call.includes('never')), false)
  assert.equal(asked.some((url) => url.includes('example.test')), false)
  assert.deepEqual(result.problems.map((problem) => problem.reason.split(',')[0]).sort((a, b) => a.localeCompare(b)), ['1 package(s) not read', 'chade does not read the registry internal.example.test'])
  // No tool of a repository runs.
  assert.deepEqual([...new Set(calls.map((call) => call.split(' ')[0]))].sort((a, b) => a.localeCompare(b)), ['apt', 'apt-cache', 'docker', 'dpkg', 'git', 'npm'])

  const file = inventoryFile(join(home, 'config.yml'))
  assert.equal(await readInventory(file), undefined)
  await saveInventory(file, result)
  assert.equal((await readInventory(file))?.tools.length, 4)
  assert.match(renderInventory(result), /flux 2\.9\.2 -> 2\.10\.1[\s\S]*npm a 1\.0\.0 -> 1\.0\.5, fixes 1 known/)
  await assert.rejects(inventory(config, hostOf(home, async (command, args, options) => (command === 'git' ? realRun(command, args, options) : { code: 1, stdout: '', stderr: 'offline' })), { fetch: async () => Promise.reject(new Error('offline')), environment: { path: '', direct: [] } }), /no registry answered/)
})

test('the configuration of the inventory is checked', () => {
  assert.deepEqual(parseConfig('store: /s\ninventory:\n  skip: [~/repos/labs]\n  tools:\n    - name: x\n      github: o/x\n', '/h').inventory, { skip: ['~/repos/labs'], tools: [{ name: 'x', github: 'o/x' }] })
  assert.throws(() => parseConfig('store: /s\ninventory:\n  tools: [{ name: x, github: https://x }]\n', '/h'), /inventory\.tools/)
  assert.throws(() => parseConfig('store: /s\ninventory: { other: 1 }\n', '/h'), /unknown key/)
})
