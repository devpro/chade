# Contributor guide

## Requirements

- Node.js 24 or later, with npm
- git
- [Task](https://taskfile.dev) 3.x, which runs every workflow of this guide
- [gitleaks](https://github.com/gitleaks/gitleaks), optional, the test of the secret scan is skipped without it

## Repository layout

```txt
├── .github/workflows/
│   ├── ci.yaml             markup lint, build and tests
│   └── pkg.yaml            publication of chade to npmjs.org
├── docs/
│   └── cleanup.md          clean-up steps the report links to
├── packages/
│   ├── cli/                chade, the published package
│   │   ├── bin/chade.js    entry point of the chade command
│   │   ├── src/            sources, bundled into dist/bin.js
│   │   ├── test/           unit tests
│   │   └── smoke.sh        packaging smoke test
│   ├── daemon/             HTTP server of chade ui and reading of the git repositories, bundled into dist/bin.js
│   │   ├── src/
│   │   └── test/
│   └── ui/                 web interface, built into dist/ui of the published package
│       ├── e2e/            end to end tests, their page objects and their server
│       ├── public/         page
│       ├── src/            script and style sheet
│       └── test/           unit tests
├── scripts/                scripts shared by the packages
├── package.json            npm workspaces root, never published
├── sonar-project.properties  Sonar analysis settings
└── Taskfile.yml            every workflow below as a task
```

## Local development

1. Install the dependencies.

   ```bash
   task install
   ```

2. Run the CLI from its sources, the arguments after `--`.

   ```bash
   task run -- --help
   task run -- snapshot --dry-run
   ```

3. Put the `chade` command of the working tree on the `PATH`, when a run outside of the repository is needed.

   ```bash
   task link
   ```

   `npm unlink --global chade` removes it.

`chade ui` serves the interface `task build` built, from a server that keeps running in the background.
A change to `packages/ui` or to the server shows after `task build` and `task run -- daemon stop`, as the next `task run -- ui` starts a new server.
`task run -- daemon run` keeps the server in the terminal instead, with its output.

> [!NOTE]
> A run reads `~/.chade/config.yml` and commits to its store.
> `--config <path>` points a run at a test configuration and its own store.

## Tasks

`task` alone lists every task.

Task                      | Effect
--------------------------|--------------------------------------------------------------------------------------------------------
`task install`            | Installs the npm workspaces
`task build`              | Typechecks and bundles the CLI into `packages/cli/dist`, and the web interface into its `ui` folder
`task run -- <arguments>` | Runs the CLI from its sources
`task link`               | Builds and links the `chade` command globally
`task typecheck`          | Typechecks the sources and the tests of every package
`task test`               | Runs the unit tests of every package
`task test:coverage`      | Runs the unit tests with a coverage report, also written to `packages/cli/coverage/lcov.info` for Sonar
`task test:e2e`           | Runs the end to end tests of the web interface in Chromium, after a build
`task ui:screenshots`     | Runs them in the light theme, the dark theme and at phone width, and saves a screenshot of each state for review
`task test:pkg`           | Runs the packaging smoke test
`task check`              | Runs what CI runs: typecheck, build, unit tests, packaging smoke test, end to end tests

## Testing

### Unit tests

```bash
task test
```

The tests run with the Node.js test runner, through `tsx`, against real git repositories in a temporary folder.
A fake command runner stands in for the Windows tools (`cmd.exe`, `wslpath`, `winget.exe`) and for the package managers, so the tests behave the same on WSL, on Linux and in CI.
`tsx` does not check types, so `task typecheck` goes with them.

The tests of `packages/daemon` start the server on a free port and call it over HTTP, and read repositories made for the test.
Those of `packages/ui` cover what the interface computes, and the end to end tests cover the page.

### Packaging smoke test

```bash
task test:pkg
```

`packages/cli/smoke.sh` packs the tarball, installs it into an empty project and runs the installed `chade` command: init, snapshot, redaction, diff, clean-up, report and web interface.
It catches what the unit tests cannot see, such as a file missing from `files` in `package.json` or a dependency missing from the bundle.
It uses a home folder of its own and a Linux section only, so it never reads the configuration of the machine, nor reaches Windows.

### End to end tests

```bash
npx --workspace=packages/ui playwright install chromium   # once
task build
task test:e2e
```

The Playwright specs of `packages/ui/e2e` drive Chromium against the server of `chade ui`, started by `e2e/serve.ts` over the built interface.
That server reads real repositories, made for the run in a temporary folder, one in each state the interface tells apart: clean, ahead, behind, changed, in conflict, never pushed, detached, unreadable.
A spec signs in the way `chade ui` does, with the address that carries the token, and reaches the page through the page objects of `e2e/pages`, so a change of markup is a change in one place.

```bash
task ui:screenshots
```

The same run with `SCREENSHOTS=1` also saves a screenshot of each state a spec reaches, in `packages/ui/e2e/screenshots`, for a review of a change of the interface.
The specs tagged `@layout`, those that capture a page, then run in the dark theme and at phone width as well.
The screenshots are not compared with earlier ones, and are not committed.

### Manual test of the web interface

```bash
task build
task run -- daemon stop
task run -- ui
```

The browser opens the list of the repositories under `repos` of `~/.chade/config.yml`.
On WSL, the Windows section lists the repositories of Windows, and the browser is the one of Windows.

### Manual test on WSL

The Windows inventories only run for real on WSL.

```bash
task run -- --config /tmp/chade/config.yml init --store /tmp/chade/store
task run -- --config /tmp/chade/config.yml discover
task run -- --config /tmp/chade/config.yml snapshot
```

The second snapshot of an unchanged system reports no change, and any difference it commits is a value that changes on every run, to normalize.

### Manual test on Windows

The Windows section also runs for real with the Node.js and git of Windows, from WSL, without opening a Windows terminal.
`scripts/run_on_windows.sh` copies the CLI `task build` built to `%TEMP%\chade-wintest`, and runs it there through `cmd.exe`, with its own configuration.

```bash
task build
scripts/run_on_windows.sh init --store '%TEMP%\chade-wintest\store'
scripts/run_on_windows.sh discover
scripts/run_on_windows.sh snapshot
scripts/run_on_windows.sh report
scripts/run_on_windows.sh clean --dry-run
scripts/run_on_windows.sh --check
scripts/run_on_windows.sh --remove
```

The configuration `init` writes has a `windows` section only, and the store gets a single `windows` folder, the same one a run from WSL writes.
The configuration is `%TEMP%\chade-wintest\cfg\config.yml`, `/mnt/c/Users/<user>/AppData/Local/Temp/chade-wintest/cfg/config.yml` from WSL, edited there to add files or `cleanup` steps.
The report has no Linux section, and `clean --dry-run` shows the Linux steps of `cleanup` as skipped.
`--remove` deletes the copy, its configuration and its store.

`scripts/run_on_windows.sh --check` runs what the Windows job of CI runs: a copy of the working tree, `npm ci` by the npm of Windows, then typecheck, build, unit tests and smoke test.

From a Command Prompt on Windows, in a clone of the repository, `node packages\cli\bin\chade.js --config %TEMP%\chade\config.yml <command>` runs the same commands.

## Pipelines

### CI

`.github/workflows/ci.yaml` runs on every pull request and every push to `main`.

Job                    | Content
-----------------------|------------------------------------------------------------------------------------------------------------------------
Markup                 | Markdown and YAML lint
Git                    | Tells whether anything other than documentation changed
Build & Test           | Typecheck, build, unit tests with coverage, packaging smoke test, end to end tests and Sonar analysis, skipped for a documentation change
Build & Test (Windows) | Typecheck, build, unit tests and packaging smoke test on `windows-latest`, skipped for a documentation change

The end to end tests run with their screenshots, which the job keeps in its `node-test-results` artifact, under `report/screenshots`.
The Windows job runs the npm scripts with Git Bash, and checks out without `core.autocrlf`, which the runner image sets, so the scripts keep their LF.
The unit tests of a Linux host are skipped on Windows, and the smoke test configures a `windows` section there.

### Sonar

The Build & Test job analyzes the code on [SonarCloud](https://sonarcloud.io/dashboard?id=devpro_chade).
`sonar-project.properties` gives the sources, the tests and the coverage report, and the pipeline gives the rest from the repository settings.

Setting             | Kind     | Value
--------------------|----------|----------------------------------------------
`SONAR_ORG`         | Variable | SonarCloud organization, `devpro`
`SONAR_PROJECT_KEY` | Variable | SonarCloud project key, `devpro_chade`
`SONAR_HOST_URL`    | Variable | Optional, `https://sonarcloud.io` when absent
`SONAR_TOKEN`       | Secret   | Token of the SonarCloud organization

The coverage report comes from `npm run test:coverage` at the root, so its paths start at the root, as the scan expects.

### Local run

[IstarCI](https://github.com/devpro/istarci) runs the same pipeline in Docker before a push, with the settings of `.istarci.yml`.
It skips the Windows job, which `scripts/run_on_windows.sh --check` runs on the Windows of a WSL machine.
`istarci add` and `istarci install-hook` set it up for this repository.

### Publication

`.github/workflows/pkg.yaml` publishes `chade` to npmjs.org on every push to `main`, when the version of `packages/cli/package.json` is not published yet.
A release is a change of that version.
The publication uses npm trusted publishing, configured on npmjs.com for the `devpro/chade` repository and the `pkg.yaml` workflow, so no token is stored.
