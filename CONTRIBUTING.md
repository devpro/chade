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
│   └── cli/                chade, the published package
│       ├── bin/chade.js    entry point of the chade command
│       ├── src/            sources, bundled into dist/bin.js
│       ├── test/           unit tests
│       └── smoke.sh        packaging smoke test
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

> [!NOTE]
> A run reads `~/.chade/config.yml` and commits to its store.
> `--config <path>` points a run at a test configuration and its own store.

## Tasks

`task` alone lists every task.

Task                      | Effect
--------------------------|--------------------------------------------------------------------------------------------------------
`task install`            | Installs the npm workspaces
`task build`              | Typechecks and bundles the CLI into `packages/cli/dist`
`task run -- <arguments>` | Runs the CLI from its sources
`task link`               | Builds and links the `chade` command globally
`task typecheck`          | Typechecks the sources and the tests
`task test`               | Runs the unit tests
`task test:coverage`      | Runs the unit tests with a coverage report, also written to `packages/cli/coverage/lcov.info` for Sonar
`task test:pkg`           | Runs the packaging smoke test
`task check`              | Runs what CI runs: typecheck, build, unit tests, packaging smoke test

## Testing

### Unit tests

```bash
task test
```

The tests run with the Node.js test runner, through `tsx`, against real git repositories in a temporary folder.
A fake command runner stands in for the Windows tools (`cmd.exe`, `wslpath`, `winget.exe`) and for the package managers, so the tests behave the same on WSL, on Linux and in CI.
`tsx` does not check types, so `task typecheck` goes with them.

### Packaging smoke test

```bash
task test:pkg
```

`packages/cli/smoke.sh` packs the tarball, installs it into an empty project and runs the installed `chade` command: init, snapshot, redaction, diff and report.
It catches what the unit tests cannot see, such as a file missing from `files` in `package.json` or a dependency missing from the bundle.
It uses a home folder of its own and a Linux section only, so it never reads the configuration of the machine, nor reaches Windows.

### Manual test on WSL

The Windows inventories only run for real on WSL.

```bash
task run -- --config /tmp/chade/config.yml init --store /tmp/chade/store
task run -- --config /tmp/chade/config.yml discover
task run -- --config /tmp/chade/config.yml snapshot
```

The second snapshot of an unchanged system reports no change, and any difference it commits is a value that changes on every run, to normalize.

## Pipelines

### CI

`.github/workflows/ci.yaml` runs on every pull request and every push to `main`.

Job          | Content
-------------|------------------------------------------------------------------------------------------------------------------------
Markup       | Markdown and YAML lint
Git          | Tells whether anything other than documentation changed
Build & Test | Typecheck, build, unit tests with coverage, packaging smoke test and Sonar analysis, skipped for a documentation change

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
`istarci add` and `istarci install-hook` set it up for this repository.

### Publication

`.github/workflows/pkg.yaml` publishes `chade` to npmjs.org on every push to `main`, when the version of `packages/cli/package.json` is not published yet.
A release is a change of that version.
The publication uses npm trusted publishing, configured on npmjs.com for the `devpro/chade` repository and the `pkg.yaml` workflow, so no token is stored.
