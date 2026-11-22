---
title: Deployment
description: The shape of a deployment — local and public instances, the listening address and the three port levels, single instance and the discovery file, credentials (who mints them, where they live, what revocation affects), the data root and the three files under run/, the three stages of an upgrade, and the exit codes.
outline: deep
---

# Deployment

This page is about how the host process exists: where it listens, who is the one host serving on a
machine, where credentials come from, where data lives, and who does what when the version changes.

## Two kinds of instance

The default is a local instance: it listens on the loopback address only, and writes one usable
credential into `<data root>/run/token`, so a client on the same machine is not handed a token by
hand.

A public instance is an explicit act: `--public` makes it listen on all interfaces and stops it from
writing `run/token` — on that machine credentials are minted by hand and handed to the devices that
connect.

| Invocation | Listens on | `run/token` |
|---|---|---|
| `agents-host serve` | `127.0.0.1:<port>` | written |
| `agents-host serve --public` | `0.0.0.0:<port>` | not written |
| `agents-host serve --public --host 10.0.0.7` | `10.0.0.7:<port>` | not written |
| `agents-host serve --host 10.0.0.7` | `10.0.0.7:<port>` | written |

The last row is the line between `--host` and `--public`: `--host` only replaces the listening
address, overriding the one `--public` implies, and does not itself change whether the instance counts
as local; `--public` does. In `packages/host/src/app.ts` the address is
`host ?? (local ? "127.0.0.1" : "0.0.0.0")`, and only `--public` touches `local`.

The host serves `ws://` only; there is no TLS switch. `wss://` is put in front of it by a tunnel or a
reverse proxy that terminates TLS — that belongs to the deployment, not to the host.

## Three port levels

The precedence is: the flag, then `<data root>/host.json`, then 8790
(`packages/host/src/modules/config/hostSettings.ts`).

- `--port 0` lets the system assign a port, and is only accepted at the flag level; the port that was
  actually bound is something only the discovery file can report.
- A port given explicitly that is not an integer between 0 and 65535 is rejected on the spot with the
  usage text and exit code 2; no service starts.
- A port already in use makes startup fail and exit; it does not move to another one. Moving would
  turn "the host a client connects to" and "the host actually serving" into two different processes.

## Single instance and the discovery file

`<data root>/run/host.json` is the only answer to "who is serving on this machine": pid, host, port,
version, local, startedAt.

It is read first at startup:

- if that pid is alive (liveness is `kill(pid, 0)` and nothing else), this process binds nothing, writes
  no discovery file, does not rewrite `run/token`, and only reports the address already in use;
- if the pid is gone, or the file is unreadable (an unreadable file is deleted — a broken discovery
  file must not be able to block a start), this process starts its own server and writes the file once
  its port is bound.

Starting `serve` a second time on the same data root is therefore safe: it either attaches to the host
already running, or confirms that one is gone and takes over.

## Credentials

Who mints them: `agents-host token create`. It opens the database, does its work and closes it; it
starts no service and binds no port. A local instance additionally makes sure `run/token` holds a
usable token at startup — the file missing, the content empty, or the token revoked all end the same
way: a new one is minted and written back, because otherwise that machine could never connect to
itself.

Where they live: the database keeps only the SHA-256 digest of the token, and the plaintext is printed
once, at creation. A local instance writes it into `<data root>/run/token`, which is the local
delivery file: the content carries one trailing newline, the permissions are set to `0600` on a best
effort basis and are not a security guarantee.

How they are used: every connection presents a token in its handshake (`connectionParams` as
`{ token }`); the token never travels in a query string, which would end up in access logs and browser
history. A connection that fails the check reaches no procedure: it gets an `unauthorized` and is
closed.

What revocation affects: only whether a later connection can be made. A connection that already shook
hands is not reached back into. The string in `run/token` stops working, and the next startup replaces
it. Several valid credentials can exist at the same time, which is what makes revoking one of them
useful.

Credentials are not part of the contract surface: a client only remembers a password and manages its
connection; creating, listing and revoking are administrative actions on the host's command line.

## The data root

The data root is the `AI_ZEN_DIR` environment variable, default `~/.ai-zen`. `--ai-zen-dir <dir>`
writes that value into the variable before anything reads it, so the data root has exactly one way of
being resolved.

```
<data root>/
├── ai-zen.db              the whole machine's database
├── assets/                uploaded bytes
├── config.json            user config
├── host.json              the host's own settings (the port)
├── reasoning-presets.json thinking-level presets
├── mcp.json               user-level MCP entries
├── agents/  sub-agents/  skills/  tools/  mcp-oauth/
├── logs/host.log
└── run/
    ├── host.json          discovery file: who is serving on this machine
    ├── token              local credential delivery file
    └── next-version.json  upgrade pin: which version to launch next
```

The three files under `run/` are three different delivery points, saying three different things:
`host.json` says where to connect right now, `token` gives a client on this machine one usable
credential in plaintext, and `next-version.json` says which version should run next. All three are run
files this process writes for itself: `token` once it is settled that no other host is serving on the
machine, `host.json` and the pin after the port is bound, and the last two are cleared during shutdown.

## Upgrading in three stages

The host installs no packages and does not re-exec itself. An upgrade is split into three stages, and
a local host and a remote one take the same road:

| Stage | Who | What |
|---|---|---|
| ① pick a version | the client | take the highest semver across the dist-tags, and tell the host that number |
| ② verify, record, ask for a relaunch | the host | two criteria decide that this version is obtainable → write the pin → exit with `reason: "upgrade"` |
| ③ launch | however the host is started | read the pin, run `npx -y @ai-zen/agents-host@<pin> serve` |

The host only does stage ② (`packages/host/src/modules/update/service.ts`): it accepts one concrete
version number and recognises neither ranges nor tags. The two criteria are:

- the copy on disk is already the target version — the three shapes that get replaced in place (the
  desktop app, docker, `npm i -g`) are settled by this one, with no network call;
- otherwise, ask the registry whether that number exists — a host started by `npx` never changes its
  own copy.

When neither holds it answers `not_available` and does not exit, so "that version does not exist"
stops short of killing a working service.

The pin and the exit signal are two different things and stay separate. With only a pin, a normal
shutdown would leave the launcher reading the old pin and pulling the service back up; with only an
exit code, the launcher would not know which version to run next. A normal shutdown clears the pin, the
upgrade path keeps it, and the two exit with different codes.

## Exit codes

| Code | When |
|---|---|
| 0 | after a normal shutdown: `host.shutdown`, the `SIGTERM` that `stop` sends, or `SIGINT` |
| 75 | an upgrade: the pin is already written, and the launcher is asked to pull that version |
| 1 | startup failed, shutdown failed, or `stop` could not stop the host |
| 2 | the command line does not add up (unknown subcommand, missing value, a port outside 0 to 65535) |

75 is the "try again later" value from `sysexits.h`: it collides with none of the common error codes,
and none of the 126 / 127 / 128+n values the shell keeps for itself.

## The command line

| Command | Does |
|---|---|
| `agents-host serve` | start serving; this is also what runs when no subcommand is given |
| `agents-host stop [--yes]` | stop the host recorded in the discovery file, by pid, after one confirmation; without `--yes` in a non-interactive shell it refuses |
| `agents-host token create [--note <note>]` | mint a credential, print the plaintext once |
| `agents-host token list` | list credentials with their state |
| `agents-host token revoke <id>` | revoke one credential |
| `agents-host version` | print the package version |
| `agents-host help` | print usage |

The four options of `serve` (`--port`, `--host`, `--public`, `--ai-zen-dir`) are in
[Getting Started](getting-started.md). `--ai-zen-dir` is accepted by every subcommand except `version`
and `help`. The three `token` subcommands open the database and start no service; `stop` does not open
the database at all — it reads the discovery file, sends that one `SIGTERM`, and waits for the process
to really exit.
