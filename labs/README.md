# Labs

Interactive labs of chade, written for [sidelab](https://github.com/devpro/sidelab).

Lab             | Covers
----------------|----------------------------------------------------------------------------------------------------
[demo](demo/)   | Getting started on a fresh Debian machine: first snapshot, a diff, the web interface, the report

## Shape of a lab

A lab is a folder of numbered steps, each with an `index.md` and a `step.yaml`, and a `lab.yaml` at its root with the title, the machines, the versions and the secrets.
A fenced block marked ` ```bash exec ` renders a **Run** button, and `automation.yaml` drives the web interface from the links of the instructions.

`demo` runs chade on `laptop`, a `runtime: vm` machine with a kernel of its own, so chade sees a plain Linux whatever system runs the lab.
The browser of the lab is on another machine, and chade listens on `127.0.0.1` only, so the laptop declares `forward: [7843]`, which makes the lab's own `127.0.0.1:7843` the laptop's, the part an SSH tunnel plays on a real network.

## Secret

`CHADE_NPM_TOKEN`, a GitHub token with the `read:packages` scope, installs `@devpro/chade` from GitHub Packages.
Its value is entered in the launcher, never in this repository: under **Profile > Environment**, or through the API, as sidelab's `docs/courses.md` shows.

## Keeping a lab working

From this repository, with a sidelab checkout beside it (`../sidelab`, or `SIDELAB_DIR`), and the Firecracker setup of sidelab's `docs/firecracker-setup.md` done:

Task                          | Effect
------------------------------|---------------------------------------------------------------------------------------
`task lab:lint`               | Checks the lab without a launcher
`task lab:verify`             | Runs every block against a disposable launcher, `STEPS=1-3` for part of it
`task lab:record OUT=<file>`  | Records the lab as a WebM, `<file>` an absolute path ending in `.webm`
`task lab:stop`               | Stops a launcher left by `KEEP=1`, or by a run killed before its cleanup

A required secret is refused before any block runs, so the first run is `task lab:verify KEEP=1`, then the value goes in at the address it prints, then the next runs use that launcher:

```bash
LAUNCHER_URL=http://localhost:<port> ADMIN_USERNAME=admin ADMIN_PASSWORD=verify-course-local-pass \
  npm --prefix ../sidelab run verify:course -- "$PWD/labs/demo" --capabilities network
```

The lab installs the published `@devpro/chade` at `CHADE_VERSION`, not the working tree, so it shows what a release carries.
