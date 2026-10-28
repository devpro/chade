import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'
import { configPath, initialConfig, parseConfig, type Config } from './config.js'
import { diff } from './diff.js'
import { discover } from './discover.js'
import { run } from './exec.js'
import { expandHome } from './paths.js'
import { snapshot, type Logger } from './snapshot.js'
import { git, repositoryRoot } from './store.js'
import { detectHost, isWsl } from './system.js'

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
    await writeFile(file, initialConfig(store, isWsl(process.env)))
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

program.parseAsync().catch((error: unknown) => {
  console.error(`chade: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
