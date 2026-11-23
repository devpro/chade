import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Finding, Place } from '@chade/daemon'
import { NOT_FOUND, type Run } from './exec.js'
import { GRYPE_OFFLINE, grypeImageArgs, readGrype } from './grype.js'
import { mergeFindings } from './merge.js'
import { OSV_FOUND, osvImageArgs, readOsvOutput } from './osv.js'
import { parseSize } from './report.js'
import type { Tool } from './tools.js'
import { readTrivy, trivyDatabaseArgs, trivyImageArgs } from './trivy.js'

export interface DockerImage {
  // The full ID, sha256:…, which every name of the image shares.
  id: string
  names: string[]
  bytes: number
}

// A line of docker image ls --no-trunc --format json is one name of an image, so an image with two tags is two lines.
export function parseImages(output: string): DockerImage[] {
  const images = new Map<string, DockerImage>()
  for (const line of output.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    const row = JSON.parse(line) as Record<string, string>
    const image = images.get(row.ID) ?? { id: row.ID, names: [], bytes: parseSize(row.Size) ?? 0 }
    const name = `${row.Repository}:${row.Tag}`
    if (row.Repository !== '<none>' && row.Tag !== '<none>' && !image.names.includes(name)) image.names.push(name)
    images.set(row.ID, image)
  }
  return [...images.values()]
}

// The IDs of the images a container, running or stopped, was created from.
async function usedImages(run: Run): Promise<Set<string> | undefined> {
  const containers = await run('docker', ['ps', '--all', '--quiet', '--no-trunc'])
  if (containers.code !== 0) return undefined
  const ids = containers.stdout.split('\n').filter(Boolean)
  if (ids.length === 0) return new Set()
  const inspect = await run('docker', ['container', 'inspect', '--format', '{{.Image}}', ...ids])
  return inspect.code === 0 ? new Set(inspect.stdout.split('\n').filter(Boolean)) : undefined
}

export interface ImageOptions {
  system: string
  offline: boolean
  // The scanners of the system, each reading every image.
  tools: Tool[]
  // What a previous scan read of an image, kept for a day as its ID says its content, when the same scanners read it.
  previous: (id: string) => Place | undefined
}

export interface ImageResult {
  places: Place[]
  // Why the images could not be listed at all.
  skipped?: string
}

const lastLine = (text: string): string => text.trim().split('\n').at(-1) ?? ''

// What one scanner finds in one image, or why it could not read it.
async function readImage(run: Run, tool: Tool, image: DockerImage, offline: boolean): Promise<{ findings: Finding[]; notes: string[]; packages: string[] } | string> {
  const timeoutMs = 20 * 60_000
  if (tool.name === 'trivy') {
    const read = await run(tool.command, trivyImageArgs(image.id, offline), { cwd: tool.cwd, timeoutMs })
    return read.code === 0 ? readTrivy(read.stdout) : lastLine(read.stderr || read.stdout)
  }
  if (tool.name === 'grype') {
    const read = await run(tool.command, grypeImageArgs(image.id), { cwd: tool.cwd, timeoutMs, env: offline ? GRYPE_OFFLINE : undefined })
    return read.code === 0 ? { findings: readGrype(read.stdout).map((match) => match.finding), notes: [], packages: [] } : lastLine(read.stderr || read.stdout)
  }
  // osv-scanner exports an image by its name through docker itself, and one without a name is exported here.
  const archive = image.names.length === 0 ? join(tool.temp.local, `chade-${image.id.replace(/^sha256:/, '').slice(0, 12)}.tar`) : undefined
  try {
    if (archive) {
      const saved = await run('docker', ['save', '--output', archive, image.id], { timeoutMs })
      if (saved.code !== 0) return lastLine(saved.stderr)
    }
    const read = await run(tool.command, osvImageArgs(archive ?? image.names[0], archive !== undefined, offline), { cwd: tool.cwd, timeoutMs })
    if (read.code !== 0 && read.code !== OSV_FOUND) return lastLine(read.stderr || read.stdout)
    const sources = readOsvOutput(read.stdout)
    return { findings: sources.flatMap((source) => source.findings), notes: [], packages: sources.flatMap((source) => source.packages) }
  } finally {
    if (archive) await rm(archive, { force: true })
  }
}

export async function scanImages(run: Run, options: ImageOptions): Promise<ImageResult> {
  const listed = await run('docker', ['image', 'ls', '--no-trunc', '--format', 'json'])
  if (listed.code === NOT_FOUND) return { places: [], skipped: 'docker is not installed' }
  if (listed.code !== 0) return { places: [], skipped: `docker cannot list the images: ${(listed.stderr || listed.stdout).trim().split('\n')[0]}` }
  const images = parseImages(listed.stdout)
  const used = await usedImages(run)
  const names = options.tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b))
  // A database that cannot be updated still reads, as it was.
  const trivy = options.tools.find((tool) => tool.name === 'trivy')
  if (trivy && !options.offline) await run(trivy.command, trivyDatabaseArgs(), { cwd: trivy.cwd, timeoutMs: 90_000 })
  const places: Place[] = []
  for (const image of images) {
    const place = imagePlace(image, options.system, used)
    const previous = options.previous(image.id)
    if (previous?.tools.toSorted((a, b) => a.localeCompare(b)).join() === names.join()) {
      places.push({ ...place, findings: previous.findings, notes: previous.notes, tools: previous.tools, packages: previous.packages })
      continue
    }
    await readPlace(run, place, image, options)
    places.push(place)
  }
  return { places }
}

// The place of an image filled with what every scanner finds in it.
async function readPlace(run: Run, place: Place, image: DockerImage, options: ImageOptions): Promise<void> {
  const findings: Finding[] = []
  const packages = new Set<string>()
  for (const tool of options.tools) {
    const read = await readImage(run, tool, image, options.offline)
    if (typeof read === 'string') {
      place.notes.push(`${tool.name} could not read it: ${read}`)
      continue
    }
    findings.push(...read.findings)
    for (const pkg of read.packages) packages.add(pkg)
    for (const note of read.notes) if (!place.notes.includes(note)) place.notes.push(note)
    place.tools.push(tool.name)
  }
  place.findings = mergeFindings(findings)
  place.packages = packages.size
}

function imagePlace(image: DockerImage, system: string, used: Set<string> | undefined): Place {
  const short = image.id.replace(/^sha256:/, '').slice(0, 12)
  const place: Place = { system, kind: 'image', label: image.names.join(', ') || `<none> ${short}`, path: image.id, bytes: image.bytes, packages: 0, findings: [], notes: [], tools: [] }
  // Removing by name leaves an image other names still hold, and an image without a name goes by its ID.
  if (used && !used.has(image.id)) {
    place.unused = { reason: 'no container uses it', command: `docker image rm ${image.names.length > 0 ? image.names.join(' ') : short}` }
  }
  return place
}
