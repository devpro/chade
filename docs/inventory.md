# Inventory

`chade inventory` lists the tools of the machine and the dependencies of the repositories.
It asks the registries for the newest version of each one.
It changes nothing: it gives the command or the text to use, and the user decides.

## Run

```bash
chade inventory
```

Option   | Effect
---------|-----------------------------
`--json` | Prints the inventory as JSON

The inventory is saved to `inventory.json`, beside the [configuration](configuration.md).
The server of the web interface makes it [once a day](web-interface.md#daily-runs).
When no registry answers, the last inventory stays.

## Tools

The source of a tool decides how its newest version is found.

Source       | Found by                                                          | Newest version from
-------------|-------------------------------------------------------------------|------------------------------------------------------------
apt          | `dpkg -S` gives the package of the file                           | `apt-cache policy`, with the lists of the last `apt update`
Direct       | No package owns the file                                          | The releases of its project on GitHub, or `go.dev` for Go
nvm          | The file is in `~/.nvm/versions/node`                             | `nodejs.org`, in the same major version
npm          | `npm ls --global`                                                 | `npm view`
winget       | `winget upgrade`, which lists only the tools with a newer version | winget
A repository | The file is in a git repository                                   | None

- chade reads all the files of `/usr/local/bin`, `~/.local/bin`, `~/go/bin` and `GOBIN`.
- In the other folders of the `PATH`, it reads only the commands of its catalog.
- A Go binary holds its version, so chade reads the file and does not run it.
- chade runs `--version`, or the equivalent, only for the commands of its catalog.
- When two copies of a tool exist, the page marks the copy that does not run.
- apt decides for its own tools: a release that apt does not have is not an update.
- chade does not run `apt update`, which needs root, and shows the age of the lists.

## Dependencies

chade reads the direct dependencies from the files that git tracks.
It parses the files as text: it runs no tool of the repository.

Kind      | Files                                                                               | Version in use
----------|-------------------------------------------------------------------------------------|----------------------------------------------------
npm       | `package.json`                                                                      | `package-lock.json`, `pnpm-lock.yaml`, or the range
NuGet     | `*.csproj`, `*.fsproj`, `*.vbproj`, `Directory.Packages.props`, `Directory.Build.*` | The exact version in the file
Image     | `Dockerfile`, `Containerfile`, compose files                                        | The tag
Terraform | `.terraform.lock.hcl`                                                               | The version in the lock file

An image has an update in two cases:

- A newer tag exists with the same form, `16-alpine` then `18-alpine`.
- The registry has a new image under the same tag.
  chade compares it with the digest in the file, or with the image that Docker holds.

When the last [scan](scan.md) found a vulnerability that the newest version fixes, the update says so.

## Shared data

To know the newest version, chade sends names to the registries.
This is the same data that `npm outdated`, `dotnet list package --outdated`, `docker pull` or a release page receives when the user asks.

Receiver                                                 | Data sent
---------------------------------------------------------|--------------------------------------------------------------------
The registry of npm, as the settings of the user give it | The names of the packages, and the sign-in of the user, sent by npm
`api.nuget.org`                                          | The names of the packages
`registry.terraform.io`                                  | The names of the providers
The registry of each image, from the list below          | The names and the tags of the images
`github.com`, `api.github.com`                           | The names of the projects of the tools
`nodejs.org`, `go.dev`                                   | Nothing
`proxy.golang.org`                                       | The names of the `golang.org/x` modules of the tools
The sources of winget                                    | What winget sends

Each receiver also sees the IP address of the machine.
chade sends no version in use, no file, no path, no name of a repository and no name of the machine.
npm, winget and Docker can send more, as they do when the user runs them.

These rules keep private names on the machine:

- When a repository gives a registry of npm that the settings of the user do not have, its packages are not read.
- When a `nuget.config` removes nuget.org or maps the sources, the NuGet packages of the repository are not read.
- The images are read only from `docker.io`, `ghcr.io`, `quay.io`, `mcr.microsoft.com`, `registry.k8s.io`, `gcr.io`, `public.ecr.aws`, `registry.gitlab.com` and `registry.suse.com`, without a sign-in.
- A Go tool is looked for only when its module is on `github.com` or `golang.org/x`.

A private name with no registry of its own in the repository goes to the public registry, as it does with `npm install`.
`inventory.skip` leaves a repository out, and `daily: false` stops the daily runs.

## Configuration

```yaml
inventory:
  skip:
    - ~/repos/labs
  tools:
    - name: mytool
      github: owner/mytool
```

Key     | Content
--------|------------------------------------------------------------------------
`skip`  | Repositories, or folders of repositories, that the inventory leaves out
`tools` | Tools that the catalog does not have, with their repository on GitHub

## Limits

- A version that is a property of MSBuild, a floating version or a variable of a Dockerfile is not read.
- The version in use of `yarn.lock` is not read: the range gives it.
- A registry that asks for a sign-in is not read, except by npm.
