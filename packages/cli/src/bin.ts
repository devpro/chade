import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { createActions, createApi, startServer } from '@chade/daemon'
import { Command } from 'commander'
import { planCleanup, renderPlan, runCleanup } from './clean.js'
import { DEFAULT_PORT, removeState, runningDaemon, signInUrl, startDaemon, stopDaemon, writeState, type DaemonState } from './daemon.js'
import { configPath, initialConfig, parseConfig, type Config } from './config.js'
import { diff } from './diff.js'
import { discover } from './discover.js'
import { run, runInherit } from './exec.js'
import { openBrowser } from './open.js'
import { expandHome } from './paths.js'
import { diskUsage, formatBytes, renderReport, report } from './report.js'
import { repositoryRoots } from './roots.js'
import { snapshot, type Logger } from './snapshot.js'
import { git, repositoryRoot } from './store.js'
import { detectHost, systemKinds, type Host } from './system.js'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

const home = process.env.HOME ?? homedir()

const log: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.error(`warning: ${message}`),
}

const program = new Command()
  .name('chade')
  .description('Snapshot the configuration of this system into a git repository, one folder per machine')
  .version(version)
  .option('--config <path>', 'configuration file, CHADE_CONFIG or ~/.chade/config.yml otherwise')

function configFile(): string {
  const option = program.opts<{ config?: string }>().config
  return option ? resolve(option) : configPath(process.env, home)
}

async function loadConfig(): Promise<Config> {
  const file = configFile()
  if (!existsSync(file)) throw new Error(`no configuration at ${file}, chade init creates it`)
  try {
    return parseConfig(await readFile(file, 'utf8'), home)
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`)
  }
}

program
  .command('init')
  .description('Write the configuration and create the store, a git repository, when it does not exist')
  .requiredOption('--store <path>', 'folder the snapshots are written to, a git repository or a folder in one')
  .option('--force', 'overwrite an existing configuration')
  .action(async (options: { store: string; force?: boolean }) => {
    const file = configFile()
    if (existsSync(file) && !options.force) throw new Error(`${file} already exists, --force overwrites it`)
    const store = resolve(expandHome(options.store, home))
    const root = await repositoryRoot(run, store)
    if (root) {
      await mkdir(store, { recursive: true })
      log.info(root === store ? `Using the git repository ${root} as the store` : `Using ${store} as the store, in the git repository ${root}`)
    } else {
      if (existsSync(store) && readdirSync(store).length > 0) throw new Error(`${store} is neither empty nor in a git repository`)
      await mkdir(store, { recursive: true })
      await git(run, store, ['init', '--quiet', '--initial-branch=main'])
      log.info(`Created the store ${store}, a new git repository`)
    }
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, initialConfig(store, systemKinds()))
    log.info(`Wrote ${file}`)
    log.info('chade discover suggests files for it, and the store keeps system details: its remote, if any, stays private.')
  })

program
  .command('snapshot')
  .description('Collect the files and inventories of the configuration into the store, and commit them')
  .option('--dry-run', 'list what would be written, without writing or committing')
  .option('--push', 'push the store once the snapshot is committed')
  .option('--no-secret-scan', 'commit without the gitleaks scan')
  .action(async (options: { dryRun?: boolean; push?: boolean; secretScan: boolean }) => {
    const config = await loadConfig()
    const host = await detectHost({ machine: config.machine })
    const result = await snapshot(config, host, log, options)
    for (const [system, entries] of result.entries) {
      const files = entries.filter((entry) => entry.path.startsWith('files/')).length
      log.info(`${host.machine}/${system.id}: ${files} file(s), ${entries.length - files} inventory(ies)`)
      if (options.dryRun) for (const entry of entries) log.info(`  ${entry.path}`)
    }
    if (options.dryRun) return
    log.info(result.commit ? `Committed ${result.commit} in ${config.store}` : 'No change since the last snapshot')
  })

program
  .command('diff')
  .description('Show what changed on this machine between two snapshots, the last two by default')
  .argument('[rev]', 'snapshot commit to compare the last one with')
  .option('--since <date>', 'compare with the last snapshot before this date, "2 weeks ago" or 2026-10-01 for instance')
  .option('--stat', 'list the changed files only')
  .option('--machine <name>', 'machine folder to compare, this machine by default')
  .action(async (rev: string | undefined, options: { since?: string; stat?: boolean; machine?: string }) => {
    const config = await loadConfig()
    const machine = options.machine ?? (await detectHost({ machine: config.machine })).machine
    process.exitCode = await diff(config, machine, run, rev, options)
  })

program
  .command('discover')
  .description('Suggest configuration files that exist on this system and are not in the configuration yet')
  .action(async () => {
    const config = await loadConfig()
    const host = await detectHost({ machine: config.machine })
    const discoveries = await discover(config, host)
    if (discoveries.every((discovery) => discovery.files.length === 0)) {
      log.info('Nothing to add, every known file is already in the configuration')
      return
    }
    log.info(`# Files to add to ${configFile()}, under the files of their system`)
    for (const { system, files } of discoveries) {
      if (files.length === 0) continue
      log.info(`${system.kind}:\n  files:`)
      for (const file of files) log.info(`    - ${system.kind === 'windows' ? `'${file}'` : file}`)
    }
  })

program
  .command('report')
  .description('Measure what takes disk and memory on this system, and suggest how to get it back, without changing anything')
  .option('--json', 'print the report as JSON')
  .action(async (options: { json?: boolean }) => {
    // The report needs no store, so it also runs before chade init.
    const config = existsSync(configFile()) ? await loadConfig() : undefined
    const host = await detectHost({ machine: config?.machine })
    const result = await report(config, host)
    log.info(options.json ? JSON.stringify(result, null, 2) : renderReport(result))
  })

program
  .command('clean')
  .description('Run the clean-up steps the configuration lists, after showing them and a confirmation')
  .option('--dry-run', 'show the steps and their commands, without running them')
  .option('--yes', 'run without asking, for a timer or a script')
  .action(async (options: { dryRun?: boolean; yes?: boolean }) => {
    const config = await loadConfig()
    if (config.cleanup.length === 0) throw new Error(`cleanup in ${configFile()} lists no step, chade report says which ones are worth it`)
    const host = await detectHost({ machine: config.machine })
    const planned = await planCleanup(config.cleanup, host, process.getuid?.() === 0)
    log.info(`Clean-up of ${host.machine}:\n${renderPlan(planned)}`)
    const runnable = planned.filter((step) => !step.skipped)
    if (options.dryRun || runnable.length === 0) return
    if (!options.yes) {
      // A script without a terminal cannot answer, and a step that removes data never runs on a guess.
      if (!process.stdin.isTTY) throw new Error('no terminal to confirm the clean-up, --yes runs it without asking')
      const prompt = createInterface({ input: process.stdin, output: process.stdout })
      const answer = await prompt.question(`Run ${runnable.length} step(s)? [y/N] `)
      prompt.close()
      if (!/^y(es)?$/i.test(answer.trim())) return log.info('Nothing was run')
    }
    const disk = process.platform === 'win32' ? 'C:\\' : '/'
    const before = await diskUsage(disk)
    const result = await runCleanup(planned, runInherit, log.info)
    const after = await diskUsage(disk)
    log.info(`\n${result.ran.length} step(s) ran${result.failed.length > 0 ? `, ${result.failed.join(', ')} failed` : ''}`)
    if (before && after) log.info(`Free space on ${disk}: ${formatBytes(before.available)} before, ${formatBytes(after.available)} after`)
    if (result.failed.length > 0) process.exitCode = 1
  })

// The routes of the server over the repositories of the configuration.
function routes(host: Host): { api: ReturnType<typeof createApi>; actions: ReturnType<typeof createActions> } {
  const options = { version, machine: host.machine, roots: async () => repositoryRoots(await loadConfig(), host), run }
  return { api: createApi(options), actions: createActions(options) }
}

// A port the option names, or the usual one.
function portOf(value: string | undefined): number {
  const port = value === undefined ? DEFAULT_PORT : Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port ${value} is not a port number`)
  return port
}

// The running server, started when there is none, and replaced when another version of chade started it.
async function ensureDaemon(port: string | undefined): Promise<{ state: DaemonState; started: boolean }> {
  const file = configFile()
  await loadConfig()
  const running = await runningDaemon(file)
  if (running?.version === version) return { state: running, started: false }
  if (running) await stopDaemon(file)
  return { state: await startDaemon(file, portOf(port)), started: true }
}

program
  .command('ui')
  .description('Open the web interface in the browser, starting its server in the background when it is not running')
  .option('--port <number>', `port a server started by this command listens on, ${DEFAULT_PORT} by default`)
  .option('--no-open', 'print the address without opening the browser')
  .action(async (options: { port?: string; open: boolean }) => {
    const { state, started } = await ensureDaemon(options.port)
    log.info(`${started ? 'Started the server' : 'The server is running'} on ${state.address}, chade daemon stop stops it`)
    // The address holds the token, which the terminal of the user is the place for, and no log file.
    log.info(`Address that signs in: ${signInUrl(state)}`)
    if (!options.open) return
    const host = await detectHost({ machine: (await loadConfig()).machine })
    if (!(await openBrowser(signInUrl(state), host, run))) log.warn('no browser could be opened, the address above opens the interface')
  })

const daemon = program.command('daemon').description('The server of the web interface, a background process of this user')

daemon
  .command('start')
  .description('Start the server in the background, when it is not running')
  .option('--port <number>', `port to listen on, ${DEFAULT_PORT} by default`)
  .action(async (options: { port?: string }) => {
    const { state, started } = await ensureDaemon(options.port)
    log.info(`${started ? 'Started the server' : 'The server is already running'} on ${state.address}, chade ui opens it`)
  })

daemon
  .command('stop')
  .description('Stop the server')
  .action(async () => {
    const state = await stopDaemon(configFile())
    log.info(state ? `Stopped the server of ${state.address}` : 'The server is not running')
  })

daemon
  .command('status')
  .description('Tell whether the server is running, exit code 1 when it is not')
  .action(async () => {
    const state = await runningDaemon(configFile())
    log.info(state ? `The server is running on ${state.address} since ${state.startedAt}, version ${state.version}, process ${state.pid}` : 'The server is not running')
    if (!state) process.exitCode = 1
  })

daemon
  .command('run')
  .description('Run the server in this terminal, until Ctrl+C, which is what start runs in the background')
  .option('--port <number>', `port to listen on, ${DEFAULT_PORT} by default`)
  .action(async (options: { port?: string }) => {
    const file = configFile()
    const host = await detectHost({ machine: (await loadConfig()).machine })
    // A git command that would ask for a password in a terminal fails instead, as the server has none to ask in.
    process.env.GIT_TERMINAL_PROMPT = '0'
    // The interface is built beside the bundle, which a run from the sources reaches the same way.
    const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'ui')
    if (!existsSync(join(uiDir, 'index.html'))) throw new Error(`the web interface is not built in ${uiDir}, npm run build builds it`)
    const server = await startServer({
      port: portOf(options.port),
      uiDir,
      // The configuration is read at each call, so a folder added to repos shows without a restart.
      ...routes(host),
    })
    await writeState(file, { pid: process.pid, address: server.address, token: server.token, version, startedAt: new Date().toISOString() })
    const stop = () => {
      void removeState(file).then(() => process.exit(0))
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    log.info(`chade serves ${host.machine} on ${server.address}`)
  })

program.parseAsync().catch((error: unknown) => {
  console.error(`chade: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
