# Commands

`--config <path>` applies to every command.

Command                     | Effect
----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------
`chade init --store <path>` | Writes the [configuration](configuration.md), creates the store folder, and a git repository when the folder is in none
`chade discover`            | Prints the known configuration files present on the system and missing from the configuration, and the Debian configuration files changed since their installation
`chade snapshot`            | Collects, redacts, writes and commits the snapshot
`chade diff [rev]`          | Compares the last snapshot with the previous one, or with `rev`
`chade ui`                  | Opens the [web interface](web-interface.md), starting its server in the background when it is not running
`chade daemon <action>`     | `start`, `stop`, `status` or `run` the server of the web interface
`chade report`              | Measures disk and memory and suggests what to clean, without changing anything, see [system clean-up](cleanup.md)
`chade clean`               | Runs the `cleanup` steps of the configuration after a confirmation

## Options

Command          | Option             | Effect
-----------------|--------------------|-----------------------------------------------------------
`chade init`     | `--force`          | Overwrites an existing configuration
`chade snapshot` | `--dry-run`        | Lists what would be written, without writing or committing
`chade snapshot` | `--push`           | Pushes the repository of the store after the commit
`chade snapshot` | `--no-secret-scan` | Commits without the gitleaks scan
`chade diff`     | `--since <date>`   | Compares with the last snapshot before that date
`chade diff`     | `--stat`           | Lists the files only
`chade diff`     | `--machine <name>` | Reads another machine folder
`chade ui`       | `--no-open`        | Prints the address without opening it
`chade ui`       | `--port <number>`  | Chooses the port of a server it starts
`chade daemon`   | `--port <number>`  | Chooses the port of `start`
`chade report`   | `--json`           | Prints the report as JSON
`chade clean`    | `--dry-run`        | Shows the steps without running them
`chade clean`    | `--yes`            | Runs the steps without asking, for a timer or a script
