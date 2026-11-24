import { posix } from 'node:path'
import { isCompose, isDockerfile, type DependencyKind } from '@chade/daemon'
import { parse } from 'yaml'

// The direct dependencies that the files of a repository name.
// The files are parsed as text: no tool of the repository runs.

export interface Declared {
  kind: DependencyKind
  file: string
  name: string
  // The exact version in use, or the lowest one that the range accepts.
  current: string
  // The range, when no lock file gives the version that is in use.
  range?: string
  command?: (latest: string) => string | undefined
  replace?: (latest: string) => string
}

// The text of a tracked file, absent when it cannot be read.
export type ReadText = (file: string) => Promise<string | undefined>

// A text that a shell reads as one word, so a copied command holds no other command.
const PLAIN = /^(?!-)[\w./@-]+$/
const EXACT = /^v?\d+\.\d+(?:\.\d+)*(?:-[\w.]+)?$/
const RANGE = /^[\^~]?v?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)$/

const IGNORED = new Set(['node_modules', 'fixtures', 'testdata', 'vendor'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsed(text: string | undefined, read: (text: string) => unknown): Record<string, unknown> {
  if (text === undefined) return {}
  try {
    const value = read(text)
    return isObject(value) ? value : {}
  } catch {
    return {}
  }
}

const json = (text: string): unknown => JSON.parse(text.replace(/^﻿/, ''))

function field(value: Record<string, unknown>, name: string): Record<string, unknown> {
  const found = Object.hasOwn(value, name) ? value[name] : undefined
  return isObject(found) ? found : {}
}

// ─── npm ───────────────────────────────────────────────────────────────────

const GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies']

// The folders from the one of a file to the root, '' for the root.
function ancestors(folder: string): string[] {
  const found = [folder]
  for (let at = folder; at !== ''; ) {
    at = at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : ''
    found.push(at)
  }
  return found
}

const inFolder = (folder: string, name: string): string => (folder === '' ? name : `${folder}/${name}`)
const folderOf = (file: string): string => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '')

interface Lock {
  kind: 'npm' | 'pnpm' | 'yarn'
  folder: string
  content: Record<string, unknown>
}

const LOCKS: { name: string; kind: Lock['kind']; read?: (text: string) => unknown }[] = [
  { name: 'package-lock.json', kind: 'npm', read: json },
  { name: 'pnpm-lock.yaml', kind: 'pnpm', read: (text) => parse(text) as unknown },
  { name: 'yarn.lock', kind: 'yarn' },
]

async function lockOf(folder: string, tracked: Set<string>, read: ReadText, known: Map<string, Lock>): Promise<Lock | undefined> {
  for (const at of ancestors(folder)) {
    for (const { name, kind, read: content } of LOCKS) {
      const file = inFolder(at, name)
      if (!tracked.has(file)) continue
      const lock = known.get(file) ?? { kind, folder: at, content: content ? parsed(await read(file), content) : {} }
      known.set(file, lock)
      return lock
    }
  }
  return undefined
}

// The version that the lock file gives to a dependency of a folder.
function lockedVersion(lock: Lock, folder: string, name: string): string | undefined {
  const own = lock.folder === '' ? folder : folder.slice(lock.folder.length + 1)
  let version: unknown
  if (lock.kind === 'npm') {
    const packages = field(lock.content, 'packages')
    for (const at of ancestors(own)) {
      const entry = field(packages, inFolder(at, `node_modules/${name}`))
      if (entry.link === true) return undefined
      if ((version = entry.version) !== undefined) break
    }
  } else if (lock.kind === 'pnpm') {
    const importer = field(field(lock.content, 'importers'), own === '' ? '.' : own)
    version = GROUPS.map((group) => field(field(importer, group), name).version).find((one) => one !== undefined)
    if (typeof version === 'string') version = version.split('(')[0]
  }
  return typeof version === 'string' && EXACT.test(version) ? version : undefined
}

function npmCommand(lock: Lock | undefined, folder: string, name: string): Declared['command'] {
  if (lock === undefined || lock.kind !== 'npm') return undefined
  const own = lock.folder === '' ? folder : folder.slice(lock.folder.length + 1)
  if (own !== '' && !PLAIN.test(own)) return undefined
  return (latest) => `npm install ${name}@${latest}${own === '' ? '' : ` --workspace=${own}`}`
}

async function npmDependencies(files: string[], tracked: Set<string>, read: ReadText): Promise<Declared[]> {
  const manifests = new Map<string, Record<string, unknown>>()
  for (const file of files.filter((one) => posix.basename(one) === 'package.json')) manifests.set(file, parsed(await read(file), json))
  // A package of the repository is not one of a registry.
  const own = new Set([...manifests.values()].map((manifest) => manifest.name))
  const locks = new Map<string, Lock>()
  const found: Declared[] = []
  for (const [file, manifest] of manifests) {
    const folder = folderOf(file)
    const lock = await lockOf(folder, tracked, read, locks)
    for (const [name, range] of GROUPS.flatMap((group) => Object.entries(field(manifest, group)))) {
      const lowest = typeof range === 'string' ? RANGE.exec(range)?.[1] : undefined
      if (own.has(name) || typeof range !== 'string') continue
      // workspace:, file:, git and an address are not a version of a registry.
      const locked = lock && !/[:/]/.test(range) ? lockedVersion(lock, folder, name) : undefined
      const current = locked ?? lowest
      if (current === undefined) continue
      found.push({ kind: 'npm', file, name, current, ...(locked === undefined ? { range } : {}), command: npmCommand(lock, folder, name) })
    }
  }
  return found
}

// True when a range of npm already accepts a version, so an install takes it.
export function accepts(range: string, version: string): boolean {
  const lowest = RANGE.exec(range)?.[1]
  if (lowest === undefined || !/^[\^~]/.test(range)) return false
  const [left, right] = [lowest.split('.'), version.split('.')]
  // ^ keeps the first number that is not 0, and ~ keeps the first two.
  const kept = range.startsWith('~') ? 2 : left.slice(0, 2).findIndex((part) => part !== '0') + 1 || 3
  return left.slice(0, kept).every((part, index) => part === right[index])
}

// The registries that a .npmrc gives, by the name of their setting.
export function npmRegistries(text: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*((?:@[\w.~-]+:)?registry)\s*=\s*(\S+)/.exec(line)
    if (match) found.set(match[1], match[2])
  }
  return found
}

// ─── NuGet ─────────────────────────────────────────────────────────────────

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1]
}

// A package element with its version, as an attribute or as a child.
export function nugetReferences(text: string): { name: string; version: string }[] {
  const found: { name: string; version: string }[] = []
  const content = text.replace(/<!--[\s\S]*?-->/g, '')
  for (const match of content.matchAll(/<(PackageReference|PackageVersion|GlobalPackageReference)(\s[^>]*)>/g)) {
    const tag = match[2]
    const name = attribute(tag, 'Include') ?? attribute(tag, 'Update')
    let version = attribute(tag, 'Version') ?? attribute(tag, 'VersionOverride')
    if (version === undefined && !tag.trimEnd().endsWith('/')) {
      const end = content.indexOf(`</${match[1]}>`, match.index)
      version = end < 0 ? undefined : /<Version>\s*([^<\s]+)\s*<\/Version>/.exec(content.slice(match.index, end))?.[1]
    }
    // A property of MSBuild and a floating version need MSBuild to be read.
    if (name !== undefined && version !== undefined && EXACT.test(version)) found.push({ name, version })
  }
  return found
}

// True when a nuget.config keeps nuget.org as the source of all packages.
export function usesNugetOrg(text: string): boolean {
  if (/<packageSourceMapping[\s>]/i.test(text)) return false
  return !/<clear\s*\/>/i.test(text) || /api\.nuget\.org/i.test(text)
}

async function nugetDependencies(files: string[], read: ReadText): Promise<Declared[]> {
  const found: Declared[] = []
  for (const file of files.filter((one) => /\.(?:cs|fs|vb)proj$/i.test(one) || /^directory\.(?:packages|build)\.(?:props|targets)$/i.test(posix.basename(one)))) {
    const project = /proj$/i.test(file)
    for (const { name, version } of nugetReferences((await read(file)) ?? '')) {
      const plain = project && PLAIN.test(file) && PLAIN.test(name)
      found.push({
        kind: 'nuget',
        file,
        name,
        current: version,
        command: plain ? (latest) => `dotnet add ${file} package ${name} --version ${latest}` : undefined,
        replace: project ? undefined : (latest) => `Version="${latest}"`,
      })
    }
  }
  return found
}

// ─── Images ────────────────────────────────────────────────────────────────

// The images that a Dockerfile starts from. The name of a stage is not an image.
export function dockerfileImages(text: string): string[] {
  const stages = new Set<string>()
  const found: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const words = line.trim().split(/\s+/)
    if (words[0]?.toUpperCase() !== 'FROM') continue
    const rest = words.slice(1).filter((word) => !word.startsWith('--'))
    if (rest[0] && !stages.has(rest[0].toLowerCase())) found.push(rest[0])
    if (rest[1]?.toUpperCase() === 'AS' && rest[2]) stages.add(rest[2].toLowerCase())
  }
  return found
}

// The images of a compose file. A service with a build makes its image itself.
export function composeImages(text: string): string[] {
  const services = field(parsed(text, (value) => parse(value) as unknown), 'services')
  return Object.values(services).flatMap((service) => (isObject(service) && service.build === undefined && typeof service.image === 'string' ? [service.image] : []))
}

async function imageDependencies(files: string[], read: ReadText): Promise<Declared[]> {
  const found: Declared[] = []
  for (const file of files) {
    const name = posix.basename(file)
    if (!isDockerfile(name) && !isCompose(name)) continue
    const text = (await read(file)) ?? ''
    const images = isCompose(name) ? composeImages(text) : dockerfileImages(text)
    for (const image of new Set(images)) found.push({ kind: 'image', file, name: image, current: image })
  }
  return found
}

// ─── Terraform ─────────────────────────────────────────────────────────────

// The providers of the public registry that a lock file holds.
export function terraformProviders(text: string): { name: string; version: string }[] {
  return [...text.matchAll(/^provider "registry\.terraform\.io\/([^"]+)" \{\s*version\s*=\s*"([^"]+)"/gm)].map((match) => ({ name: match[1], version: match[2] }))
}

async function terraformDependencies(files: string[], read: ReadText): Promise<Declared[]> {
  const found: Declared[] = []
  for (const file of files.filter((one) => posix.basename(one) === '.terraform.lock.hcl')) {
    for (const { name, version } of terraformProviders((await read(file)) ?? '')) {
      found.push({ kind: 'terraform', file, name, current: version, command: () => 'terraform init -upgrade' })
    }
  }
  return found
}

export async function dependenciesOf(tracked: string[], read: ReadText): Promise<Declared[]> {
  const files = tracked.filter((file) => !file.split('/').some((part) => IGNORED.has(part)))
  const found = [...(await npmDependencies(files, new Set(tracked), read)), ...(await nugetDependencies(files, read)), ...(await imageDependencies(files, read)), ...(await terraformDependencies(files, read))]
  // A name in two groups of one file is one dependency.
  const unique = new Map(found.map((one) => [`${one.kind}\n${one.file}\n${one.name}\n${one.current}`, one]))
  return [...unique.values()]
}
