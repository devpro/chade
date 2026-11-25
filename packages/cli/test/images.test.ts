import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Result, Run } from '../src/exec.js'
import { readKept } from '../src/imagelists.js'
import { parallelImages, scanImages, type ImageOptions } from '../src/images.js'
import { osvListPurl, osvMissing } from '../src/osv.js'
import type { Scanner, Tool } from '../src/tools.js'

interface FakeImage {
  id: string
  name?: string
  packages: { name: string; version: string; ecosystem: string; purl?: string }[]
}

const deb = (name: string, ecosystem = 'Debian:12') => ({ name, version: '1.0+b1', ecosystem, purl: `pkg:deb/debian/lib${name}@1.0%2Bb1?arch=amd64&distro=bookworm&source=${name}` })
const rpm = (name: string) => ({ name, version: '1.0', ecosystem: 'Red Hat', purl: `pkg:rpm/rhel/${name}@1.0?distro=rhel-9.9` })
const ok = (stdout = ''): Result => ({ code: 0, stdout, stderr: '' })
const noDatabase = (name: string): Result => ({ code: 127, stdout: '{"results":[]}', stderr: `could not load db for ${name} ecosystem: no offline version` })

const folders: string[] = []
after(async () => {
  for (const folder of folders) await rm(folder, { recursive: true, force: true })
})

// The scanners and docker over a few images, with the vulnerable packages by their name.
class Machine {
  images: FakeImage[] = []
  vulnerable = new Map<string, string>()
  calls: string[][] = []
  version = '2.7.1'
  scanners: Scanner[] = ['osv-scanner', 'trivy', 'grype']
  // Answers in place of the fake when it returns a result.
  answer: (command: string, args: string[]) => Result | undefined = () => undefined
  running = 0
  most = 0
  log: string[] = []
  temp = ''
  lists = ''

  async start(): Promise<this> {
    this.temp = await mkdtemp(join(tmpdir(), 'chade-test-images-'))
    folders.push(this.temp)
    this.lists = join(this.temp, 'image-lists')
    return this
  }

  entries(packages: FakeImage['packages']) {
    return packages.map((pkg) => {
      const id = this.vulnerable.get(pkg.name)
      return id ? { package: pkg, groups: [{ ids: [id], aliases: [id], max_severity: '7.5' }], vulnerabilities: [{ id, summary: id }] } : { package: pkg }
    })
  }

  run: Run = async (command, args, options) => {
    this.calls.push([command, ...args])
    const special = this.answer(command, args)
    if (special) return special
    const named = (text: string) => this.images.find((image) => image.name === text || image.id === text || text.includes(image.id.slice(7)))
    if (command === 'docker') {
      if (args[1] === 'ls') return ok(this.images.map((image) => JSON.stringify({ ID: image.id, Repository: image.name?.split(':')[0] ?? '<none>', Tag: image.name?.split(':')[1] ?? '<none>', Size: '1GB' })).join('\n'))
      if (args[1] === 'inspect') return ok(`${named(args.at(-1) ?? '')?.id}\n`)
      return ok()
    }
    const image = named(args.at(-1) ?? '') ?? named((args[0] ?? '').replace('docker:', ''))
    if (image && command !== 'trivy') {
      assert.ok(options?.env?.TMPDIR?.startsWith(join(this.temp, 'chade-images-')))
      this.running++
      this.most = Math.max(this.most, this.running)
      await new Promise((resolve) => setTimeout(resolve, 2))
      this.running--
    }
    if (command === 'trivy') return ok(JSON.stringify({ Metadata: { OS: { Family: 'debian', Name: '10', EOSL: true } }, Results: [] }))
    if (command === 'grype') return ok('{"matches":[]}')
    if (args[1] === 'source') {
      const { components } = JSON.parse(await readFile(args.at(-1) ?? '', 'utf8')) as { components: { name: string; version: string; purl: string }[] }
      const packages = components.map(({ name, version, purl }) => ({ name, version, ecosystem: purl.startsWith('pkg:deb/ubuntu') ? 'Ubuntu:24.04:LTS' : purl.startsWith('pkg:npm') ? 'npm' : 'Debian:12', purl }))
      return { ...ok(JSON.stringify({ results: [{ source: { path: 'list' }, packages: this.entries(packages) }] })), code: 1 }
    }
    const listOnly = args.includes('vulnmatch/osvlocal')
    const packages = listOnly ? (image?.packages ?? []).map((pkg) => ({ package: pkg })) : this.entries(image?.packages ?? [])
    return { ...ok(JSON.stringify({ results: [{ source: { path: 'status' }, packages }] })), code: listOnly ? 0 : 1 }
  }

  scan(options: Partial<ImageOptions> = {}) {
    this.calls = []
    this.log = []
    const tools = this.scanners.map((name): Tool => ({ name, command: name, version: this.version, temp: { local: this.temp, system: this.temp } }))
    return scanImages(this.run, { system: 'linux', offline: false, tools, lists: this.lists, parallel: 4, log: (line) => this.log.push(line), ...options })
  }

  // The images that osv-scanner read, to list their packages or in full.
  read(kind: 'list' | 'full'): string[] {
    return this.calls.filter((call) => call[0] === 'osv-scanner' && call[2] === 'image' && call.includes('vulnmatch/osvlocal') === (kind === 'list')).map((call) => call.at(-1) ?? '')
  }
}

async function machine(...images: FakeImage[]): Promise<Machine> {
  const value = await new Machine().start()
  value.images = images
  return value
}

const A: FakeImage = { id: 'sha256:aa11', name: 'a:1', packages: [deb('zlib'), deb('tar')] }

test('a kept list is matched again, and a new CVE is found on an image that did not change', async () => {
  const pc = await machine(A)
  const first = await pc.scan()
  assert.deepEqual(first.places[0].findings, [])
  assert.deepEqual(pc.read('list'), ['a:1'])
  pc.vulnerable.set('zlib', 'CVE-2026-1')
  const second = await pc.scan()
  assert.deepEqual(pc.read('list'), [])
  assert.deepEqual(pc.read('full'), [])
  const [finding] = second.places[0].findings
  assert.deepEqual([finding.package, finding.version, finding.ecosystem, finding.ids, finding.severity], ['zlib', '1.0+b1', 'Debian:12', ['CVE-2026-1'], 'high'])
  assert.deepEqual(second.places[0].notes, ['debian 10 is past its end of life, so its packages get no more fixes'])
  assert.deepEqual(second.places[0].tools, ['osv-scanner', 'trivy', 'grype'])
  // trivy and grype match each image at each scan, and each database is updated once.
  for (const name of ['trivy', 'grype']) assert.equal(pc.calls.filter((call) => call[0] === name && /aa11/.test(call.join(' '))).length, 1)
  assert.equal(pc.calls.filter((call) => call.includes('--download-db-only')).length, 1)
  assert.equal(pc.calls.filter((call) => call[0] === 'grype' && call[2] === 'update').length, 1)
  assert.equal(pc.calls.filter((call) => call.includes('--download-offline-databases')).length, 1)
})

test('a malicious package is found from a kept list', async () => {
  const pc = await machine({ id: 'sha256:aa11', name: 'a:1', packages: [{ name: 'evil', version: '1.0.0', ecosystem: 'npm', purl: 'pkg:npm/evil@1.0.0' }] })
  await pc.scan()
  pc.vulnerable.set('evil', 'MAL-2026-1')
  const result = await pc.scan()
  assert.deepEqual(pc.read('list'), [])
  assert.equal(result.places[0].findings[0].malicious, true)
})

test('an image of Ubuntu keeps its ecosystem, which osv-scanner names another way from a list', async () => {
  const purl = 'pkg:deb/ubuntu/zlib1g@1.0?arch=amd64&distro=noble&source=zlib'
  const pc = await machine({ id: 'sha256:aa11', name: 'a:1', packages: [{ name: 'zlib', version: '1.0', ecosystem: 'Ubuntu:24.04', purl }] })
  pc.vulnerable.set('zlib', 'UBUNTU-CVE-2026-1')
  const result = await pc.scan()
  assert.equal(result.places[0].findings[0].ecosystem, 'Ubuntu:24.04')
  assert.deepEqual(pc.read('full'), [])
})

test('a new version of the scanner, and a list that cannot be read, make the image be read again', async () => {
  const pc = await machine(A)
  await pc.scan()
  pc.version = '2.8.0'
  await pc.scan()
  assert.deepEqual(pc.read('list'), ['a:1'])
  for (const text of ['{', '{"format":1,"image":"sha256:aa11","scanner":"osv-scanner","version":"2.8.0","packages":[{"name":1}]}', 'null']) {
    await writeFile(join(pc.lists, 'aa11.json'), text)
    await pc.scan()
    assert.deepEqual(pc.read('list'), ['a:1'])
  }
  await pc.scan()
  assert.deepEqual(pc.read('list'), [])
  // A version that cannot be read is not known to be the same.
  pc.version = 'unknown'
  await pc.scan()
  assert.equal(await readKept(pc.lists, A.id, 'osv-scanner', 'unknown'), undefined)
})

test('the list of an image that Docker no longer holds is deleted, and no other file', async () => {
  const pc = await machine(A, { id: 'sha256:bb22', name: 'b:1', packages: [deb('tar')] })
  await pc.scan()
  await writeFile(join(pc.lists, 'notes.txt'), '')
  await writeFile(join(pc.lists, 'bb22.json.1.tmp'), '')
  pc.images = [A]
  await pc.scan()
  assert.deepEqual((await readdir(pc.lists)).toSorted(), ['aa11.json', 'notes.txt'])
  pc.answer = (command, args) => (command === 'docker' && args[1] === 'ls' ? { code: 1, stdout: '', stderr: 'no daemon' } : undefined)
  assert.match((await pc.scan()).skipped ?? '', /no daemon/)
  assert.ok((await readdir(pc.lists)).includes('aa11.json'))
})

test('an image that a list cannot replace is read in full at each scan', async () => {
  const pc = await machine(A, { id: 'sha256:bb22', name: 'b:1', packages: [rpm('glibc')] }, { id: 'sha256:cc33', name: 'c:1', packages: [deb('tar', 'Debian:13')] })
  pc.vulnerable.set('glibc', 'RHSA-2026:1')
  for (const round of [1, 2]) {
    const result = await pc.scan()
    // The list gives Debian:12 for the third image, which is not what the image says.
    assert.deepEqual(pc.read('full').toSorted(), ['b:1', 'c:1'], `scan ${round}`)
    assert.deepEqual(result.places[1].findings[0].ids, ['RHSA-2026:1'])
    assert.deepEqual(
      result.places.map((place) => place.label),
      ['a:1', 'b:1', 'c:1'],
    )
  }
})

test('a match that fails reads the images in full, and a database that is missing is a failure', async () => {
  const pc = await machine(A)
  pc.vulnerable.set('zlib', 'CVE-2026-1')
  pc.answer = (command, args) => (command === 'osv-scanner' && args[1] === 'source' ? { code: 137, stdout: '', stderr: 'Killed' } : undefined)
  const killed = await pc.scan()
  assert.deepEqual(pc.read('full'), ['a:1'])
  assert.equal(killed.places[0].findings.length, 1)
  pc.answer = (command, args) => (command === 'osv-scanner' && args[1] === 'source' ? { ...noDatabase('Debian'), code: 1 } : undefined)
  const missing = await pc.scan()
  assert.deepEqual(missing.places[0].tools, ['trivy', 'grype'])
  assert.ok(missing.places[0].notes.includes('osv-scanner could not read it: no database for Debian'))
})

test('without a network, the databases on the machine match, and the scan says that they were not updated', async () => {
  const pc = await machine(A, { id: 'sha256:bb22', name: 'b:1', packages: [rpm('glibc')] })
  pc.vulnerable.set('zlib', 'CVE-2026-1')
  pc.vulnerable.set('glibc', 'RHSA-2026:1')
  pc.answer = (command, args) => {
    if (args.includes('--download-offline-databases')) return noDatabase('Debian')
    if (args.includes('--download-db-only') || (command === 'grype' && args[1] === 'update')) return { code: 1, stdout: '', stderr: 'no route to host' }
    return undefined
  }
  const result = await pc.scan()
  assert.deepEqual(
    result.places.map((place) => place.findings.length),
    [1, 1],
  )
  assert.deepEqual([...result.problems.keys()].toSorted(), ['grype', 'osv-scanner', 'trivy'])
})

test('offline, nothing is downloaded and the kept lists are matched', async () => {
  const pc = await machine(A)
  await pc.scan()
  pc.vulnerable.set('tar', 'CVE-2026-2')
  const result = await pc.scan({ offline: true })
  assert.equal(result.places[0].findings.length, 1)
  assert.deepEqual([...result.problems], [])
  assert.ok(!pc.calls.some((call) => ['--download-offline-databases', '--download-db-only', 'update'].some((arg) => call.includes(arg))))
})

test('a scanner that fails takes its layer away for the image, and the others still read it', async () => {
  const pc = await machine(A)
  pc.answer = (command, args) => (command === 'grype' && args[0].startsWith('docker:') ? { code: 1, stdout: '', stderr: 'first\nbroken' } : undefined)
  const result = await pc.scan()
  assert.deepEqual(result.places[0].tools, ['osv-scanner', 'trivy'])
  assert.ok(result.places[0].notes.includes('grype could not read it: broken'))
  pc.answer = () => undefined
  for (const name of ['osv-scanner', 'trivy', 'grype'] as const) {
    pc.scanners = [name]
    assert.deepEqual((await pc.scan()).places[0].tools, [name])
  }
})

test('a file that osv-scanner cannot read leaves the list of the others, which is not kept', async () => {
  const pc = await machine(A)
  pc.answer = (_command, args) =>
    args.includes('vulnmatch/osvlocal') ? { code: 127, stdout: JSON.stringify({ results: [{ source: { path: 's' }, packages: A.packages.map((pkg) => ({ package: pkg })) }] }), stderr: 'Error during extraction: a.whl' } : undefined
  pc.vulnerable.set('zlib', 'CVE-2026-1')
  assert.equal((await pc.scan()).places[0].findings.length, 1)
  assert.equal((await pc.scan()).places[0].findings.length, 1)
  assert.deepEqual(pc.read('list'), ['a:1'])
  assert.deepEqual(pc.read('full'), [])
  // Any other failure of the list reads the image in full.
  pc.answer = (_command, args) => (args.includes('vulnmatch/osvlocal') ? { code: 2, stdout: '', stderr: 'unknown plugin' } : undefined)
  assert.equal((await pc.scan()).places[0].findings.length, 1)
  assert.deepEqual(pc.read('full'), ['a:1'])
})

test('an image without a package is read, without a note, and its empty list is kept', async () => {
  const pc = await machine({ id: 'sha256:aa11', name: 'busybox:1', packages: [] })
  pc.answer = (_command, args) => (args.includes('image') && args.includes('vulnmatch/osvlocal') ? { code: 128, stdout: '', stderr: 'No package sources found, --help for usage information.' } : undefined)
  const result = await pc.scan()
  assert.deepEqual(result.places[0].tools, ['osv-scanner', 'trivy', 'grype'])
  assert.ok(!result.places[0].notes.some((note) => note.includes('osv-scanner')))
  await pc.scan()
  assert.deepEqual([...pc.read('list'), ...pc.read('full')], [])
  // The same code with another reason is a failure.
  pc.answer = (_command, args) => (args[1] === 'image' && args[0] === 'scan' ? { code: 128, stdout: '', stderr: 'broken' } : undefined)
  pc.version = '2.8.0'
  assert.ok((await pc.scan()).places[0].notes.includes('osv-scanner could not read it: broken'))
})

test('a name that moved to another image during the scan is not read as this image', async () => {
  const pc = await machine(A)
  pc.answer = (_command, args) => (args[1] === 'inspect' ? ok('sha256:ff99\n') : undefined)
  const result = await pc.scan()
  assert.ok(result.places[0].notes.includes('osv-scanner could not read it: its name is now that of another image'))
  assert.equal(await readKept(pc.lists, A.id, 'osv-scanner', pc.version), undefined)
})

test('the images read at the same time hold in the free memory, the results and the log keeping each image', async () => {
  assert.deepEqual([0, 1, 3, 4, 8, 64].map((gigabytes) => parallelImages(gigabytes * 1024 ** 3)), [1, 1, 1, 2, 4, 4])
  const images = Array.from({ length: 8 }, (_, index): FakeImage => ({ id: `sha256:d${index}`, name: `d:${index}`, packages: [deb(`p${index}`)] }))
  const pc = await machine(...images)
  const result = await pc.scan({ parallel: 4 })
  assert.equal(pc.most, 4)
  assert.deepEqual(
    result.places.map((place) => place.label),
    images.map((image) => image.name),
  )
  assert.ok(pc.log.some((line) => line.startsWith('image 3 of 8: d:2: grype done')))
  pc.most = 0
  await pc.scan({ parallel: 1 })
  assert.equal(pc.most, 1)
})

test('a scan leaves no temporary file, and deletes those of a scan that was killed the day before', async () => {
  const pc = await machine({ id: 'sha256:aa11', packages: [deb('zlib')] })
  const [old, recent] = [join(pc.temp, 'chade-images-old'), join(pc.temp, 'chade-images-recent')]
  for (const folder of [old, recent]) await mkdir(folder)
  const before = new Date(Date.now() - 2 * 24 * 3600 * 1000)
  await utimes(old, before, before)
  const result = await pc.scan()
  assert.equal(result.places[0].tools.length, 3)
  assert.deepEqual((await readdir(pc.temp)).toSorted(), ['chade-images-recent', 'image-lists'])
})

test('a list names a system package by its source, and an rpm or a package without a purl cannot be listed', () => {
  assert.equal(osvListPurl(deb('tar')), 'pkg:deb/debian/tar@1.0%2Bb1?distro=bookworm')
  assert.equal(osvListPurl({ ecosystem: 'Alpine:v3.20', name: 'openssl', version: '3.3-r0', purl: 'pkg:apk/alpine/libssl3@3.3-r0?arch=x86_64&distro=3.20.6&origin=openssl' }), 'pkg:apk/alpine/openssl@3.3-r0?distro=3.20.6')
  assert.equal(osvListPurl({ ecosystem: 'Go', name: 'a.b/c', version: '1.0+incompatible', purl: 'pkg:golang/a.b/c@1.0%2Bincompatible' }), 'pkg:golang/a.b/c@1.0%2Bincompatible')
  assert.equal(osvListPurl(rpm('glibc')), undefined)
  assert.equal(osvListPurl({ ecosystem: 'Debian:12', name: 'a', version: '1', purl: 'pkg:deb/debian/a@1' }), undefined)
  assert.equal(osvListPurl({ ecosystem: 'GIT', name: 'a', version: '1' }), undefined)
  assert.deepEqual(osvMissing('could not load db for Red Hat ecosystem: x\ncould not load db for Go ecosystem: y\ncould not load db for Go ecosystem: y'), ['Red Hat', 'Go'])
})
