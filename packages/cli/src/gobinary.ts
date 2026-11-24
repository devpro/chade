import { readFile } from 'node:fs/promises'

// What a Go binary says of itself: the module it was built from, and its version.
export interface GoBuild {
  module: string
  // Absent when the build gives no release, as (devel) or a commit.
  version?: string
}

const MAGIC = Buffer.from('\xff Go buildinf:', 'latin1')
const HEADER = 32
// The text of the modules lies between two marks of this length.
const MARK = 16

function varint(buffer: Buffer, start: number): { value: number; next: number } {
  let value = 0
  let next = start
  for (let shift = 0; shift < 35 && next < buffer.length; shift += 7) {
    const byte = buffer[next++]
    value += (byte & 0x7f) * 2 ** shift
    if (byte < 0x80) break
  }
  return { value, next }
}

// The file is read and not run. The format is the one of Go 1.18 and later.
export function parseGoBuild(buffer: Buffer): GoBuild | undefined {
  for (let at = buffer.indexOf(MAGIC); at >= 0; at = buffer.indexOf(MAGIC, at + 1)) {
    // A program that reads Go binaries also holds these bytes, but without the rest of the header.
    if (at % 16 !== 0 || (buffer[at + MAGIC.length + 1] & 2) === 0) continue
    const goVersion = varint(buffer, at + HEADER)
    const modules = varint(buffer, goVersion.next + goVersion.value)
    if (modules.value <= 2 * MARK || modules.next + modules.value > buffer.length) continue
    const text = buffer.subarray(modules.next + MARK, modules.next + modules.value - MARK).toString('utf8')
    const line = text.split('\n').find((one) => one.startsWith('mod\t'))
    if (!line) continue
    const [, module, version = ''] = line.split('\t')
    const release = /^v(\d+\.\d+\.\d+)(?:\+\w+)?$/.exec(version)?.[1]
    return { module, ...(release ? { version: release } : {}) }
  }
  return undefined
}

export async function readGoBuild(path: string): Promise<GoBuild | undefined> {
  const buffer = await readFile(path).catch(() => undefined)
  return buffer === undefined ? undefined : parseGoBuild(buffer)
}
