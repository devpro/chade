# Setup

The lab has two machines: `laptop`, a Debian 12 virtual machine where chade runs, and `control`, the lab itself, whose browser shows the web interface.

> [!NOTE]
> These steps are shown on purpose, so nothing is done by "magic" and this demo can be reproduced on any Debian or Ubuntu machine.

## Git

chade reads git repositories and commits its snapshots with git.

1. Install Git and `less`, its pager, with the package manager:

   <!-- verify: requires=network timeout=300 expect="git version 2." -->

   ```bash exec target=laptop
   export DEBIAN_FRONTEND=noninteractive && \
   apt-get update -q > /dev/null && \
   apt-get install -y -q git less > /dev/null && \
   git --version
   ```

2. Set the identity recorded in commits, and `main` as the first branch of new repositories:

   ```bash exec target=laptop
   git config --global user.name "${GIT_USER_NAME}" && \
   git config --global user.email "${GIT_USER_EMAIL}" && \
   git config --global init.defaultBranch main
   ```

## npm

chade runs on Node.js 24 or later, which the machine already has, and installs with npm.

1. Check the Node.js version:

   <!-- verify: expect="v2" -->

   ```bash exec target=laptop
   node --version
   ```

2. Download the npm tarball with the metadata of this version, and compare its checksum with the one the registry publishes:

   <!-- verify: requires=network timeout=120 expect="integrity ok" -->

   ```bash exec target=laptop
   cd ~ && \
   wget -q "${NPM_REGISTRY_URL}/npm/-/npm-${NPM_VERSION}.tgz" -O npm.tgz && \
   wget -q "${NPM_REGISTRY_URL}/npm/${NPM_VERSION}" -O npm.json && \
   python3 -c 'import base64, hashlib, json, sys; want = json.load(open("npm.json"))["dist"]["integrity"]; got = "sha512-" + base64.b64encode(hashlib.sha512(open("npm.tgz", "rb").read()).digest()).decode(); print("integrity", "ok" if got == want else "MISMATCH"); sys.exit(got != want)'
   ```

3. Unpack it under `/usr/local`, where the global packages of npm go, then check its version:

   <!-- verify: expect="12." -->

   ```bash exec target=laptop
   mkdir -p /usr/local/lib/npm && \
   tar -C /usr/local/lib/npm --strip-components=1 -xzf ~/npm.tgz && \
   rm ~/npm.tgz ~/npm.json && \
   ln -sfn /usr/local/lib/npm/bin/npm-cli.js /usr/local/bin/npm && \
   ln -sfn /usr/local/lib/npm/bin/npx-cli.js /usr/local/bin/npx && \
   npm --version
   ```

## gitleaks

chade scans each snapshot with [gitleaks](https://github.com/gitleaks/gitleaks) before committing it, and warns when it is missing.

1. Download the release and its checksums, check the archive, and unpack the binary:

   <!-- verify: requires=network timeout=120 expect="tar.gz: OK" -->

   ```bash exec target=laptop
   cd ~ && \
   wget -q "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" && \
   wget -q "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_checksums.txt" && \
   sha256sum --check --ignore-missing "gitleaks_${GITLEAKS_VERSION}_checksums.txt" && \
   tar -xzf "gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" -C /usr/local/bin gitleaks && \
   rm gitleaks_*
   ```

2. Check the version:

   <!-- verify: expect="8." -->

   ```bash exec target=laptop
   gitleaks version
   ```

## chade

chade is published on GitHub Packages, under `@devpro`.

1. Give npm the token of GitHub Packages for `@devpro`:

   ```bash exec target=laptop
   npm config set @devpro:registry https://npm.pkg.github.com && \
   npm config set //npm.pkg.github.com/:_authToken "${CHADE_NPM_TOKEN}"
   ```

   > [!NOTE]
   > The token lands in `~/.npmrc`, a file chade is about to snapshot: we will see what becomes of it.

2. Install chade:

   <!-- verify: requires=network timeout=180 -->

   ```bash exec target=laptop
   npm install --global "@devpro/chade@${CHADE_VERSION}" --no-fund --no-update-notifier
   ```

3. Check the version:

   <!-- verify: expect="0." -->

   ```bash exec target=laptop
   chade --version
   ```
