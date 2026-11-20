## What we saw

- `chade init`, `chade discover` and a short configuration file are all it takes to start.
- `chade snapshot` commits the configuration of the machine, secrets masked, and `chade diff` tells what changed.
- `chade ui` shows every repository of the machine in one page, and works on them without a terminal.
- `chade report` tells what takes disk and memory, and how to clean it.

---

## The web interface and git

![The browser signs in with a token to a server on 127.0.0.1, which runs a fixed list of git actions, each value checked against what git lists](../assets/chade-ui-dark.svg#gh-dark-mode-only)
![The browser signs in with a token to a server on 127.0.0.1, which runs a fixed list of git actions, each value checked against what git lists](../assets/chade-ui.svg#gh-light-mode-only)

---

## Tips

- One store for every machine: each one writes its own folder, and the Store page lists them all.
- The store in a folder under `repos` gets a link to its page, where its snapshots are pushed from.
- A daily snapshot from a timer or a scheduled task, `chade snapshot --push`, keeps the history without thinking about it.
- On WSL, one run captures the distribution and its Windows host.

---

## How to start

```bash
npm config set @devpro:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken <token>
npm install --global @devpro/chade
chade init --store ~/system-snapshots
chade discover
chade snapshot
chade ui
```

The token is a GitHub token with the `read:packages` scope.

---

## Thank you

Source and documentation: [github.com/devpro/chade](https://github.com/devpro/chade)

Free for any noncommercial use, under the PolyForm Noncommercial license.
