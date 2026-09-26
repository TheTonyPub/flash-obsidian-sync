# server-provisioning Specification

## Purpose

Defines the user-run server installer and operator controls for a reproducible, inspectable sync infrastructure deployment on supported Linux hosts.

## Requirements

### Requirement: Source installation guide
The repository SHALL provide a root README with prerequisites for using `flash-sync`: a supported Obsidian version, reachable NATS WSS endpoint, pre-created vault bucket and credentials, and optional S3-dependent features. It SHALL explain how to download the matching `main.js` and `manifest.json` from a stable or prerelease GitHub Release, or from a development CI artifact, and manually install both under `.obsidian/plugins/flash-sync` in a desktop Obsidian vault. It SHALL direct users to install `styles.css` only when the selected build uses custom CSS, and distinguish these installation files from GitHub-generated Source code (zip) and Source code (tar.gz) archives. It SHALL give a basic connection check, describe source-build installation as an optional path, and distinguish manual installation from Community Plugins directory publication. It SHALL identify stable releases as the only Community Directory candidates.

#### Scenario: Manual installation from release
- **WHEN** a user downloads both assets from one stable or prerelease version and follows the README
- **THEN** the user can place them under `.obsidian/plugins/flash-sync`, enable the plugin, and identify the settings needed to connect to an existing server

#### Scenario: Manual installation from development artifact
- **WHEN** a user chooses a development CI artifact and follows the README
- **THEN** the user can install its two matching files manually and identify that it is a development build

#### Scenario: Manual installation from source
- **WHEN** a user follows the optional source-build path on a supported development machine
- **THEN** the user can build the plugin, place its required artifacts in the vault's plugin directory, enable it in Obsidian, and identify the settings needed to connect to an existing server

#### Scenario: Server is not yet available
- **WHEN** the user has no WSS endpoint or vault bucket
- **THEN** the README identifies those missing prerequisites and links to the manual server setup path without claiming the plugin can sync before server setup

#### Scenario: S3 is not available
- **WHEN** the user installs the plugin without external S3 configuration
- **THEN** the README explains that inline Markdown remains the intended NATS-only path and images are not synchronized until S3 is configured

### Requirement: Install fos from repository source
The repository SHALL provide separate Markdown guides for installing `fos` from this repository's source and for using its interactive and unattended commands. The installation guide SHALL cover supported server OS/architecture, Node.js/npm prerequisites, a reproducible source build, installation of the locally built `fos` package, verification of the installed executable and bundled admin worker, and updates from a later source revision. It SHALL NOT instruct operators to install `fos` from APT. Native-mode NATS and Caddy are separate, version-pinned stock-APT dependencies managed by `fos`; Docker and Podman modes require their supported Compose runtimes.

#### Scenario: Source install on a supported server
- **WHEN** an operator follows the `fos` installation guide from a repository clone on a supported server
- **THEN** the resulting `fos` command and its bundled admin worker run without a checked-out repository or host `node_modules` at runtime

#### Scenario: Operator usage reference
- **WHEN** an operator needs to bootstrap, inspect status, manage vaults, or recover a failed installation
- **THEN** a separate usage guide shows the relevant commands, protected secret-input/output practices, and mode-specific ownership boundaries

### Requirement: Guided and unattended setup
The `fos` CLI SHALL run on the target server and provide a guided interactive bootstrap and a documented noninteractive mode on supported Debian and Ubuntu releases. It SHALL require a domain for the endpoint, show a reviewable plan, and request confirmation before changing the host. It SHALL reject unsupported systems or missing domain configuration before mutation. It SHALL not connect to or orchestrate another host over SSH.

#### Scenario: First installation
- **WHEN** an operator starts bootstrap in a terminal on a supported host
- **THEN** the CLI prompts for install mode, endpoint domain, and optional operations; displays planned changes without secrets; and applies only confirmed choices

#### Scenario: Automation
- **WHEN** an operator supplies all required values in noninteractive mode
- **THEN** the CLI performs the same validation and deployment without terminal prompts and fails clearly if a required value is missing

#### Scenario: Unsupported operating system
- **WHEN** bootstrap runs outside the supported Debian/Ubuntu release set
- **THEN** it refuses installation without modifying services or files

#### Scenario: Missing domain
- **WHEN** the operator provides no valid endpoint domain
- **THEN** the CLI refuses installation before modifying services or files

#### Scenario: Remote target requested
- **WHEN** the operator supplies a remote host target to the CLI
- **THEN** the CLI rejects remote orchestration and instructs the operator to run it on the server, including through an existing SSH shell if desired

#### Scenario: Interactive cancellation
- **WHEN** the operator cancels an interactive prompt or plan confirmation
- **THEN** the CLI restores terminal input and exits without applying the unconfirmed plan

#### Scenario: Interactive bootstrap with explicit secrets output
- **WHEN** an operator runs bootstrap in a terminal and supplies `--secrets-output`
- **THEN** the CLI atomically writes generated credentials to the owner-readable protected destination and suppresses credential disclosure to the terminal

#### Scenario: Bootstrap credential recovery after persistence failure
- **WHEN** service application succeeds but managed-state or protected credential-record persistence fails
- **THEN** the CLI attempts credential delivery through the selected protected output and reports the original persistence failure even if recovery delivery also fails

### Requirement: Clear terminal and machine-readable output
The CLI SHALL provide command-specific help for root commands and nested vault actions. It SHALL use color only for interactive terminal output when color is enabled, and SHALL preserve plain text or explicitly requested JSON output when redirected or when color is disabled. Interactive choices SHALL explain available options and accept keyboard selection; output SHALL identify errors and relevant paths clearly.

#### Scenario: Command-specific help
- **WHEN** an operator requests help for a command or nested vault action
- **THEN** the CLI prints that command's usage, options, and examples, then exits without contacting a service or changing the host

#### Scenario: Redirected output
- **WHEN** an operator redirects human-readable command output or requests JSON
- **THEN** terminal color escapes are omitted and JSON output remains valid machine-readable JSON

### Requirement: Selectable installation modes
The CLI SHALL support native NATS and Caddy services, Docker Compose, and Podman Compose. Every mode SHALL generate and validate equivalent NATS and Caddy behavior: persistent JetStream data, hashed administrator and vault users, a private NATS client listener for server-local management, a private NATS WebSocket upstream, and a Caddy-terminated domain WSS endpoint. Only Caddy TCP 80/443 SHALL be publicly reachable. Native NATS SHALL bind its client and WebSocket listeners to loopback; Compose SHALL place NATS on an internal network without host-published NATS ports. No mode SHALL configure or expose NATS monitoring port 8222 in this change. Every mode SHALL report the external WSS URL. The CLI SHALL not install an S3 server.

#### Scenario: Native deployment
- **WHEN** the operator selects native installation
- **THEN** the CLI installs and configures NATS and Caddy as managed host services with persistent data

#### Scenario: Container deployment
- **WHEN** the operator selects Docker Compose or Podman Compose
- **THEN** the CLI validates the chosen runtime, deploys managed services with persistent storage and no host-published NATS ports, and retains a usable generated Compose configuration

#### Scenario: Missing pinned administration image
- **WHEN** a container-mode operation needs the pinned administration image and that image is absent locally
- **THEN** the CLI obtains the pinned image before running the administration operation

#### Scenario: Native deployment uses the same exposure policy
- **WHEN** the operator selects native installation
- **THEN** NATS client and WebSocket listeners bind only to loopback, NATS monitoring is disabled, and only Caddy accepts public connections on TCP 80/443

#### Scenario: S3 is not configured
- **WHEN** the operator does not provide external S3 settings
- **THEN** NATS-based inline Markdown setup remains usable, and the CLI clearly identifies attachments and oversized Markdown as unavailable until external S3 is configured

### Requirement: Versioned native APT compatibility lock
Every `fos` release SHALL declare its supported OS/package tuples and use only stock Debian or Ubuntu APT repositories. Version `0.1.0` SHALL support amd64 on Debian 13, Ubuntu 24.04, and Ubuntu 26.04 in native, Docker Compose, and Podman Compose modes. In native mode, `fos` version `0.1.0` SHALL lock Debian 13 amd64 to `nats-server=2.10.27-1+b2` and `caddy=2.6.2-12+deb13u1`, Ubuntu 24.04 amd64 to `nats-server=2.10.7-1ubuntu0.3` and `caddy=2.6.2-6ubuntu0.24.04.3`, and Ubuntu 26.04 amd64 to `nats-server=2.10.27-1build1` and `caddy=2.6.2-14`. It SHALL preflight the exact versions before mutation, install only those exact versions, and fail closed for an unsupported platform or unavailable locked package. It SHALL NOT download direct binaries or configure a third-party package repository.

#### Scenario: Exact Debian package versions are available
- **WHEN** `fos` version `0.1.0` runs in native mode on Debian 13 amd64 and both locked package versions are available from stock APT
- **THEN** it installs exactly `nats-server=2.10.27-1+b2` and `caddy=2.6.2-12+deb13u1`

#### Scenario: Exact Ubuntu package versions are unavailable
- **WHEN** `fos` version `0.1.0` runs in native mode on Ubuntu 24.04 amd64 and either locked package version is unavailable
- **THEN** it stops before writing managed configuration or starting services

#### Scenario: Ubuntu 26.04 is supported across modes
- **WHEN** `fos` version `0.1.0` runs on Ubuntu 26.04 amd64 in native, Docker Compose, or Podman Compose mode
- **THEN** it accepts the platform, and native mode preflights and installs exactly `nats-server=2.10.27-1build1` and `caddy=2.6.2-14`

### Requirement: Safe repeat operation and status
The CLI SHALL reconcile its owned resources without resetting existing KV content or replacing credentials unexpectedly. It SHALL expose status and actionable diagnostics for the selected mode and SHALL leave preexisting, unrelated host configuration intact.

#### Scenario: Repeated bootstrap
- **WHEN** bootstrap is rerun with unchanged settings
- **THEN** it reports no harmful change and preserves existing bucket data, users, and credentials

#### Scenario: Existing service conflicts
- **WHEN** ports, service names, or managed paths are occupied by unrelated services
- **THEN** the CLI stops and reports the conflict without overwriting unrelated configuration

### Requirement: Optional host operations
Bootstrap SHALL separately offer firewall management, dedicated service accounts where applicable, backup setup, upgrade management, and uninstall support. Omitted options SHALL not mutate those areas. Upgrade and uninstall commands SHALL require explicit confirmation and protect user data by default.

#### Scenario: Firewall choice is omitted
- **WHEN** the operator does not select firewall management
- **THEN** existing firewall rules remain unchanged and the CLI reports ports requiring manual access

#### Scenario: Firewall choice is selected
- **WHEN** the operator selects firewall management over an SSH session
- **THEN** the CLI identifies the active SSH access path and requests explicit confirmation before changing rules; it adds only the selected access and service allow rules and does not activate an inactive UFW firewall

#### Scenario: Firewall is already active
- **WHEN** the operator selects firewall management and UFW is active
- **THEN** the CLI adds the selected SSH and service allow rules, preserves established SSH access, and leaves unrelated firewall rules unchanged

#### Scenario: Backup choice is selected
- **WHEN** the operator selects backups and provides a destination and retention policy
- **THEN** the CLI provisions a recoverable backup workflow and offers a restoration verification procedure

#### Scenario: Upgrade or uninstall
- **WHEN** an operator invokes a supported upgrade or uninstall action
- **THEN** the CLI previews effects, requests confirmation, preserves data by default, and reports rollback or recovery instructions

### Requirement: Flash Sync plugin identity
The plugin SHALL use manifest ID and display name `flash-sync`.

#### Scenario: Fresh installation
- **WHEN** a user installs the plugin under `.obsidian/plugins/flash-sync`
- **THEN** Obsidian recognizes and displays it as `flash-sync`
