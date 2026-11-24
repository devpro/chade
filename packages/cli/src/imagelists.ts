import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OsvListed } from './osv.js'

// The packages that osv-scanner read in an image, kept as they do not change while the ID of the image is the same.
// Only the packages are kept and never the findings, as each scan matches them against the newest databases.

interface KeptList {
  format: number
  image: string
  scanner: string
  version: string
  packages: OsvListed[]
}

// A change of what a list holds, or of how the image is read, makes every image be read again.
const FORMAT = 1

const fileOf = (folder: string, image: string): string => join(folder, `${image.replace(/^sha256:/, '')}.json`)

function isPackage(value: unknown): value is OsvListed {
  if (typeof value !== 'object' || value === null) return false
  const { ecosystem, name, version, purl } = value as Record<string, unknown>
  return typeof ecosystem === 'string' && typeof name === 'string' && typeof version === 'string' && (purl === undefined || typeof purl === 'string')
}

// A list of another version of the scanner, or one that cannot be read, is no list, so the image is read again.
export async function readKept(folder: string, image: string, scanner: string, version: string): Promise<OsvListed[] | undefined> {
  // Two versions that cannot be named are not known to be the same.
  if (version === 'unknown') return undefined
  try {
    const kept = JSON.parse(await readFile(fileOf(folder, image), 'utf8')) as KeptList
    const same = kept.format === FORMAT && kept.image === image && kept.scanner === scanner && kept.version === version
    return same && Array.isArray(kept.packages) && kept.packages.every(isPackage) ? kept.packages : undefined
  } catch {
    return undefined
  }
}

// A list that cannot be kept only makes the next scan read the image again.
export async function keepList(folder: string, image: string, scanner: string, version: string, packages: OsvListed[]): Promise<void> {
  const value: KeptList = { format: FORMAT, image, scanner, version, packages }
  const file = fileOf(folder, image)
  const temp = `${file}.${process.pid}.tmp`
  try {
    await mkdir(folder, { recursive: true })
    // A scan that stops in the middle leaves no half list.
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
    await rename(temp, file)
  } catch {
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

// The lists of the images that Docker no longer holds. Any other file of the folder stays.
export async function dropLists(folder: string, images: string[]): Promise<void> {
  const held = new Set(images.map((image) => fileOf(folder, image)))
  for (const name of await readdir(folder).catch(() => [])) {
    if (/^[0-9a-z]+\.json(\.\d+\.tmp)?$/.test(name) && !held.has(join(folder, name))) await rm(join(folder, name), { force: true }).catch(() => undefined)
  }
}
