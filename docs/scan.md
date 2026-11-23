# Packages and images

`chade scan` reads what is installed on the disk, packages and container images, and changes nothing.
It reports the packages that are malicious or have a known vulnerability, and what nothing uses, with the command that removes it.

The scan reads what an install left, never the code: the lock files and manifests of a repository are the code of its commits, which IstarCI reads.
Only the disk as it is now is read, never the history of a repository.

## Scan

```bash
chade scan
```

Each system of the machine is read by its own tools, Windows and the distribution both on WSL.

Place                     | What is read                                                                                                                      | Unused when
--------------------------|-----------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------
Installed for the user    | Global npm and pnpm packages, each Node.js of nvm, pipx, dotnet tools, Go binaries                                                | A Node.js of nvm on Linux is neither the default nor the one running chade
Installed in a repository | `node_modules`, `.terraform`, `.venv`, and `obj/project.assets.json` of a restored .NET project, under the `repos` of each system | Nothing happened in the repository for 30 days, see below
Cache                     | The npx cache, the NuGet cache, the Terraform plugin cache                                                                        | Always for npx and NuGet, which their tool fills again
Container image           | Every image Docker holds                                                                                                          | No container, running or stopped, was created from it

Every place is read by each scanner installed on its system, as each one misses what another finds, and a missing one only takes its layer away.
What several scanners report of one advisory is one finding, which names them all, as [Scanners](#scanners) says.

The output gives the malicious packages, the places with the most severe findings, the notes, such as an operating system past its end of life,
what nothing uses with its command, largest first, the scanners of each system with their versions, and the parts skipped with why.
Every finding is in `chade scan --json`, and on the Security page of the [web interface](web-interface.md).

The scan is saved to `scan.json`, beside the [configuration](configuration.md), where `chade report` and the web interface read it.
The server of the web interface runs it [once a day](web-interface.md#daily-runs).
A part left out keeps what the last scan found of it.
`chade scan` exits with 1 when a malicious package is on the disk, so a script running it does not miss one.

Option       | Effect
-------------|--------------------------------------------------------------
`--json`     | Prints the scan as JSON
`--packages` | Reads the packages only
`--images`   | Reads the container images only
`--offline`  | Downloads no database, and reads those already on the machine

## Scanners

Scanner     | Packages                                                                        | Images                                 | Checked with
------------|---------------------------------------------------------------------------------|----------------------------------------|-----------------
osv-scanner | Reads each place, matches against OSV, the one source of malicious packages     | Reads each image through `docker save` | 2.7.0, 2.7.1
trivy       | Reads each place, matches against the database of Aqua                          | Reads each image from Docker           | 0.76.2
grype       | Matches the packages osv-scanner and trivy read against the database of Anchore | Reads each image from Docker           | 0.104.4, 0.122.1

grype reads lock files and not what an install left, `node_modules` giving it nothing, so it is given the packages the two others read, as a CycloneDX list.
The packages chade lists itself, the NuGet cache and a restored .NET project, go to the three of them, so grype alone still reads those.

Each scanner names an advisory its own way: a GHSA, the CVE behind it, `UBUNTU-CVE-2026-1` for the CVE of a distribution, `v1.7.30` for the version `1.7.30` of a Go module.
Two findings are one when they have the package, the version once a leading `v` or `go` is left out, and an identifier or a CVE in common.
The merged finding keeps every identifier and every scanner, the most severe level any of them gives, and the lowest version that fixes it.
A finding one scanner alone reports is no less real: it is often an advisory the others do not know yet.

A scanner that is not installed or fails is named under the scanners of its system, and the others still run.
A part is skipped only when none of the three is installed on its system, the images then being listed for what nothing uses, without their vulnerabilities.
docker lists the images and the containers created from them.

## Installing the scanners

Each comes from the release of its publisher, checked against the checksums of that same release, the binary owned by root.
The versions are the latest checked, and a later one is expected to work.

```bash
v=2.7.1
base="https://github.com/google/osv-scanner/releases/download/v${v}"
curl -fsSLO "${base}/osv-scanner_linux_amd64"
curl -fsSLO "${base}/osv-scanner_SHA256SUMS"
grep ' osv-scanner_linux_amd64$' osv-scanner_SHA256SUMS | sha256sum --check
sudo install -o root -g root -m 0755 osv-scanner_linux_amd64 /usr/local/bin/osv-scanner
```

```bash
v=0.76.2
base="https://github.com/aquasecurity/trivy/releases/download/v${v}"
curl -fsSLO "${base}/trivy_${v}_Linux-64bit.tar.gz"
curl -fsSLO "${base}/trivy_${v}_checksums.txt"
sha256sum --check --ignore-missing "trivy_${v}_checksums.txt"
tar -xzf "trivy_${v}_Linux-64bit.tar.gz" trivy
sudo install -o root -g root -m 0755 trivy /usr/local/bin/trivy
```

```bash
v=0.122.1
base="https://github.com/anchore/grype/releases/download/v${v}"
curl -fsSLO "${base}/grype_${v}_linux_amd64.tar.gz"
curl -fsSLO "${base}/grype_${v}_checksums.txt"
sha256sum --check --ignore-missing "grype_${v}_checksums.txt"
tar -xzf "grype_${v}_linux_amd64.tar.gz" grype
sudo install -o root -g root -m 0755 grype /usr/local/bin/grype
```

`~/.local/bin` works as well without `sudo`, for a machine where the user is not an administrator.

On Windows, winget installs the three, checking each against the hash its manifest gives:

```bat
winget install --id Google.OSVScanner --exact
winget install --id AquaSecurity.Trivy --exact
winget install --id Anchore.Grype --exact
```

A WSL started before an install does not see the new `PATH` of Windows, so chade also looks in the folder of winget, `%LOCALAPPDATA%\Microsoft\WinGet\Packages`.

`chade scan` prints the version of each scanner it found, under Scanners, which checks an install.

## Vulnerability databases

The list of the packages never leaves the machine: each scanner downloads its database, and matches the packages on the machine.

Scanner     | Database                                                                          | Updated
------------|-----------------------------------------------------------------------------------|---------------------------------
osv-scanner | The OSV database of each ecosystem it meets, `~/.cache/osv-scalibr`, about 260 MB | By each scan
trivy       | The database of Aqua, `~/.cache/trivy`, its Java database only for a jar          | Once per scan
grype       | The database of Anchore, `~/.cache/grype`                                         | By grype, when it is out of date

`--offline` reads them as they are: an ecosystem osv-scanner never downloaded makes it fail, and the others still run.
An image read less than a day before by the same scanners is not read again, its ID saying its content.

A package is malicious when OSV names it so, with an identifier starting with `MAL-` or the weakness CWE-506, so osv-scanner is the scanner not to go without.
A malicious package may have run at its install, so it is removed rather than updated, and the machine looked at.

## Unused

A repository's `node_modules`, `.terraform` or `.venv` is unused when the repository has no commit, no change in its working tree,
and no install in the folder, for `scan.unusedDays` days, 30 by default.

Unused                   | Command
-------------------------|--------------------------------------------------------------------
A folder of a repository | `rm -rf <path>` on Linux, `rmdir /s /q "<path>"` on Windows
A Node.js of nvm         | `nvm uninstall <version>`
The npx cache            | `rm -rf ~/.npm/_npx`, `rmdir /s /q "%LOCALAPPDATA%\npm-cache\_npx"`
The NuGet cache          | `dotnet nuget locals global-packages --clear`
A container image        | `docker image rm <names>`, or its ID when it has none

The size of an image counts the layers it shares with others, so removing it frees up to that size.

## Configuration

```yaml
scan:
  unusedDays: 60
  skip: [images]
```

Key          | Content
-------------|------------------------------------------------------------------------------------------------------------
`unusedDays` | Days without a commit, a change or an install after which a folder of a repository is unused, 30 by default
`skip`       | Parts the scan leaves out, `packages` or `images`, which `--packages` and `--images` override

## Limits

- A Go advisory often has no CVSS score, and reads as `unknown` severity.
- Only Go binaries say what they hold, so another binary is not read.
- Docker Desktop shares one engine between Windows and WSL, so the images are read once, by Linux.
- Only the images of Docker are read, not those of podman.
- A first scan of many images takes a quarter of an hour, osv-scanner exporting each one, and the next ones read only what changed.
- A folder of a repository deeper than four levels is not looked for.
