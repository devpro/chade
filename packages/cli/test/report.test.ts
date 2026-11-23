import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Config } from '../src/config.js'
import { NOT_FOUND, run, type Run } from '../src/exec.js'
import {
  disabledSnaps,
  formatBytes,
  parseDockerDf,
  parseIni,
  parseLxss,
  parseMeminfo,
  parsePs,
  parseRobocopy,
  parseSize,
  parseTasklist,
  renderReport,
  report,
  scheduledTimers,
  topProcesses,
} from '../src/report.js'
import type { Host } from '../src/system.js'
import { Windows } from '../src/windows.js'

test('sizes read in the units of Docker and of journalctl', () => {
  assert.equal(parseSize('22.24GB'), 22_240_000_000)
  assert.equal(parseSize('163.8kB'), 163_800)
  assert.equal(parseSize('0B'), 0)
  assert.equal(parseSize('676.6M', 1024), Math.round(676.6 * 1024 ** 2))
  assert.equal(parseSize('n/a'), undefined)
  assert.equal(formatBytes(262_038_499_328), '262.0 GB')
  assert.equal(formatBytes(512), '512 B')
})

test('docker system df gives the size and what is reclaimable of each type', () => {
  const output = [
    '{"Active":"3","Reclaimable":"22.24GB (78%)","Size":"28.5GB","TotalCount":"68","Type":"Images"}',
    '{"Active":"0","Reclaimable":"9.926GB","Size":"22.08GB","TotalCount":"379","Type":"Build Cache"}',
  ].join('\n')
  assert.deepEqual(parseDockerDf(output), [
    { type: 'Images', size: 28_500_000_000, reclaimable: 22_240_000_000, total: 68, active: 3 },
    { type: 'Build Cache', size: 22_080_000_000, reclaimable: 9_926_000_000, total: 379, active: 0 },
  ])
})

test('the WSL registry gives the name and folder of each distribution', () => {
  const output = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{187ed7b1}',
    '    DistributionName    REG_SZ    Ubuntu',
    '    BasePath    REG_SZ    C:\\Users\\me\\AppData\\Local\\Packages\\Ubuntu\\LocalState',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{29aa}',
    '    BasePath    REG_SZ    \\\\?\\D:\\wsl\\debian',
    '    DistributionName    REG_SZ    Debian',
  ].join('\r\n')
  assert.deepEqual(parseLxss(output), [
    { name: 'Ubuntu', basePath: 'C:\\Users\\me\\AppData\\Local\\Packages\\Ubuntu\\LocalState' },
    { name: 'Debian', basePath: 'D:\\wsl\\debian' },
  ])
})

test('.wslconfig reads as section.key, comments left out', () => {
  assert.deepEqual(parseIni('[wsl2]\nmemory=42GB # half\n\n[experimental]\nautoMemoryReclaim = gradual\n'), {
    'wsl2.memory': '42GB',
    'experimental.automemoryreclaim': 'gradual',
  })
})

test('meminfo values are in bytes', () => {
  assert.deepEqual(parseMeminfo('MemTotal:       43135108 kB\nSwapFree:              0 kB\n'), { MemTotal: 43135108 * 1024, SwapFree: 0 })
})

test('a timer is scheduled when it has a next run', () => {
  const output = [
    'Wed 2026-10-28 16:00:00 CET 25min Wed 2026-10-28 15:00:00 CET 34min ago anacron.timer anacron.service',
    '-                                - -                                   - fstrim.timer                 fstrim.service',
  ].join('\n')
  assert.deepEqual(scheduledTimers(output), ['anacron.timer'])
})

test('processes of the same name add up', () => {
  assert.deepEqual(topProcesses(parsePs(' 1000 java\n 500 java\n 800 claude\n 10 bash\n'), 2), [
    { label: 'java', bytes: 1500 * 1024 },
    { label: 'claude', bytes: 800 * 1024 },
  ])
})

test('a disabled snap revision is the name and the revision', () => {
  const output = [
    'Name  Version  Rev   Tracking       Publisher  Notes',
    'cups  2.4.11   1266  latest/stable  openprinting✓  disabled',
    'cups  2.4.12   1272  latest/stable  openprinting✓  -',
    'core  16-2.61  2988  latest/stable  canonical✓     core,disabled',
  ].join('\n')
  assert.deepEqual(disabledSnaps(output), [
    { name: 'cups', revision: '1266' },
    { name: 'core', revision: '2988' },
  ])
})

// A Linux host reads the files and runs the tools of Linux, which Windows does not have.
const linuxOnly = process.platform === 'win32' && 'a Linux host on Windows'

test('a report of a Linux machine measures every source, and hints where it is worth it', { skip: linuxOnly }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'chade-report-'))
  await mkdir(join(home, '.npm'), { recursive: true })
  await writeFile(join(home, '.npm', 'blob'), 'x'.repeat(1000))
  const fakeRun: Run = async (command, args, options) => {
    if (command === 'docker') return { code: 0, stdout: '{"Active":"1","Reclaimable":"8GB (80%)","Size":"10GB","TotalCount":"9","Type":"Images"}\n', stderr: '' }
    if (command === 'journalctl') return { code: 0, stdout: 'Archived and active journals take up 1.5G in the file system.\n', stderr: '' }
    if (command === 'snap') return { code: NOT_FOUND, stdout: '', stderr: '' }
    if (command === 'ps') return { code: 0, stdout: ' 2000 java\n 400000 kubelite\n', stderr: '' }
    return run(command, args, options)
  }
  const host: Host = { machine: 'TEST-PC', home, run: fakeRun, systems: [{ kind: 'linux', id: 'linux' }] }
  const result = await report(undefined, host)
  const titles = result.sections.map((section) => section.title)
  assert.deepEqual(titles, ['Memory', 'Linux disk', 'Docker', 'Journal', 'Caches', 'Security'])
  const text = renderReport(result)
  assert.match(text, /docker image prune -a --filter until=168h -f/)
  assert.match(text, /journalctl --vacuum-size=500M/)
  assert.match(text, /sudo microk8s stop/)
  assert.match(text, /~\/\.npm\s+1\.0 kB/)
  assert.match(text, /^ {4}How to: chade ui, Docs, System clean-up, #journal$/m)
  // A cache under the threshold is measured, and gets no hint.
  assert.doesNotMatch(text, /npm cache clean/)
})

test('tasklist gives the memory of each process in kB, whatever the digit grouping of the locale', () => {
  const output = ['"System Idle Process","0","Services","0","8 K"', '"Code.exe","4120","Console","1","1 234 567 Ko"', '"Code.exe","4200","Console","1","1.000 K"', '"svchost.exe","900","Services","0","N/A"'].join('\r\n')
  assert.deepEqual(parseTasklist(output), [
    { name: 'System Idle Process', bytes: 8 * 1024 },
    { name: 'Code.exe', bytes: 1_234_567 * 1024 },
    { name: 'Code.exe', bytes: 1000 * 1024 },
  ])
})

const robocopySummary = (bytes: number): string =>
  ['', '              Total    Copi\u00e9   Ignor\u00e9 Discordance \u00c9CHEC  Extras', '   R\u00e9p. :  54  54  0  0  0  0', 'Fichiers :  155  155  0  0  0  0', `  Octets :  ${bytes}  ${bytes}  0  0  0  0`, '  Heures :   0:00:00   0:00:00   0:00:00   0:00:00', ''].join('\r\n')

test('robocopy gives the bytes of a folder, whatever the language of Windows', () => {
  assert.equal(parseRobocopy(robocopySummary(138_530_576)), 138_530_576)
  assert.equal(parseRobocopy('ERROR 2 (0x00000002) Accessing Source Directory'), undefined)
})

// Stands in for Windows, where C:\ is a folder of the test and every folder has the same size.
function windowsTools(drive: string, bytes: number): Run {
  const variables: Record<string, string> = { '%USERPROFILE%': String.raw`C:\Users\me`, '%LOCALAPPDATA%': String.raw`C:\Users\me\AppData\Local` }
  return (command, args) => {
    const answer = (stdout: string, code = 0) => Promise.resolve({ code, stdout, stderr: '' })
    if (command === 'cmd.exe') return args[2] === 'echo' ? answer(variables[args[3]] ?? args[3]) : answer('', NOT_FOUND)
    if (command === 'wslpath') return answer(join(drive, args[1].slice(3).replaceAll('\\', '/')))
    if (command === 'tasklist.exe') return answer('"Code.exe","4120","Console","1","2 000 K"\r\n')
    if (command === 'powershell.exe') return answer('66540240\r\n15509544\r\n')
    // A listing that finds files exits with 1.
    if (command === 'robocopy.exe') return answer(robocopySummary(bytes), 1)
    return answer('', NOT_FOUND)
  }
}

test('a report from WSL measures Windows and the distribution, each in its own sections', { skip: linuxOnly }, async () => {
  const drive = await mkdtemp(join(tmpdir(), 'chade-report-'))
  const home = await mkdtemp(join(tmpdir(), 'chade-report-'))
  const profile = join(drive, 'Users', 'me')
  await mkdir(join(profile, '.nuget', 'packages'), { recursive: true })
  await mkdir(join(profile, '.claude', 'projects', 'one'), { recursive: true })
  await writeFile(join(profile, '.claude', 'projects', 'one', 'session.jsonl'), '{}')
  await mkdir(join(profile, 'projects', 'portal', '.git'), { recursive: true })
  const fakeRun = windowsTools(drive, 17_000_000_000)
  const host: Host = {
    machine: 'TEST-PC',
    home,
    run: fakeRun,
    windows: new Windows(fakeRun),
    systems: [
      { kind: 'windows', id: 'windows' },
      { kind: 'linux', id: 'wsl-test' },
    ],
  }
  const config = { store: '', redact: [], cleanup: [], windows: { files: [], inventories: [], repos: [String.raw`%NOWHERE%\projects`, String.raw`%USERPROFILE%\projects`] } } as unknown as Config
  const result = await report(config, host)
  const titles = (system: string) => result.sections.filter((section) => section.system === system && !section.title.endsWith('disk')).map((section) => section.title)
  assert.deepEqual(titles('windows'), ['Memory', 'Caches', 'Agent sessions', 'Repositories', 'Security'])
  assert.deepEqual(titles('wsl-test').filter((title) => title !== 'Memory'), ['Security'])
  const text = renderReport(result)
  assert.match(text, /=== windows ===[\s\S]+=== wsl-test ===/)
  assert.match(text, /RAM\s+52\.3 GB used of 68\.1 GB/)
  assert.match(text, /%USERPROFILE%\\\.nuget\\packages holds 17\.0 GB, cleared from a Windows prompt with:/)
  assert.match(text, /%USERPROFILE%\\\.claude\\projects\s+17\.0 GB, 1 session\(s\), 0 older/)
  assert.match(text, /%USERPROFILE%\\projects\\portal\s+17\.0 GB/)
})

test('a report from Windows measures with Windows tools, and leaves the Linux sections out', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chade-report-'))
  const fakeRun: Run = async (command) => {
    if (command === 'tasklist.exe') return { code: 0, stdout: '"Code.exe","4120","Console","1","2 000 K"\r\n', stderr: '' }
    if (command === 'cmd.exe' || command === 'docker') return { code: NOT_FOUND, stdout: '', stderr: '' }
    throw new Error(`${command} is not a Windows tool`)
  }
  const host: Host = { machine: 'TEST-PC', home, run: fakeRun, windows: new Windows(fakeRun, true), systems: [{ kind: 'windows', id: 'windows' }] }
  const result = await report(undefined, host)
  // A C: drive exists when the test itself runs on Windows.
  assert.deepEqual(
    result.sections.map((section) => section.title).filter((title) => title !== 'Windows disk'),
    ['Memory', 'Security'],
  )
  // No distribution in the registry, so no settings of WSL to suggest.
  assert.ok(!result.sections.some((section) => section.title === 'WSL settings'))
  const text = renderReport(result)
  assert.match(text, /RAM\s+.+ used of /)
  assert.match(text, /process Code\.exe\s+2\.0 MB/)
  // A single system needs no heading of its own.
  assert.doesNotMatch(text, /===/)
})
