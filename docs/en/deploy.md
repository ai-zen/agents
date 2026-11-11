---
title: Deployment & Remote Access
description: The server binds loopback only while wss:// is a client capability, the three access shapes (local / tunnel / reverse proxy) with the entry point and the knobs each one needs, a complete nginx reverse-proxy sample with its three default-value traps (no Upgrade headers means a 400 handshake, client_max_body_size defaults to 1m and turns content.upload into a 413, proxy_read_timeout defaults to 60s and cuts idle connections), why AI_ZEN_ALLOWED_ORIGINS must carry the origin a browser arrives with, the client's address and credential precedence (--server / AI_ZEN_SERVER_URL / the discovery file, AI_ZEN_SERVER_TOKEN / run/token) and why there is no --token, the known behaviour that a tunnel still forwards the local working directory, what the credential separates and what it does not, and a troubleshooting table.
outline: deep
---

# Deployment & Remote Access

This page answers "where the server runs and how a client gets to it". What the wire says is in [Wire Protocol](protocol.md) — that page only states what is allowed; this one states how it is actually set up, and which defaults break it.

## Premise: the server binds loopback only

`agents-server serve` listens on loopback only (`127.0.0.1:8790` by default) and refuses to start on anything else. It **never implements TLS and never binds a non-loopback address**: remote access always puts a segment in front of it (a tunnel or a reverse proxy), and the plaintext leg stays on the machine's loopback.

That boundary sits at "the same machine", not at "is there authentication" — the credential exists (see "Authentication" in [Wire Protocol](protocol.md)), but putting a service whose capability set includes `exec` straight onto a network-facing port is still not the default this project wants.

| Thing | Who does it |
|---|---|
| plaintext WS (`ws://127.0.0.1:<port>`) | the server |
| tunnel / TLS termination | SSH, tailscale, nginx |
| `ws://` or `wss://` | the **client** (`--server` / `AI_ZEN_SERVER_URL`) |

`wss://` is a client capability, not a server mode — there is no "turn on TLS" switch to configure on the server side.

## The three access shapes

| Shape | What the client connects to | What the server needs | What the client needs |
|---|---|---|---|
| local (default) | the `ws://127.0.0.1:<port>` in the discovery file | nothing | nothing |
| tunnel | `ws://127.0.0.1:<the tunnel's local port>` | nothing | an explicit address + `AI_ZEN_SERVER_TOKEN` |
| reverse proxy | `wss://your.domain[/path]` | `AI_ZEN_ALLOWED_ORIGINS` (when a browser connects) | an explicit address + `AI_ZEN_SERVER_TOKEN` |

The three differ only in the middle segment; not one word between server and client changes.

## Local (default)

Nothing to configure. The client finds the server through `<aiZenDir>/run/server.json` (spawning one if there is none) and reads the credential from `<aiZenDir>/run/token` in the same directory. Address and credential are two halves of one question (where to connect + what gets you in), so they live under the same `run/` — in the local case nobody has to carry either one by hand.

## Tunnel

The entry point is still a loopback address — that port just lives on the other end:

```bash
# pull the remote machine's 127.0.0.1:8790 onto this machine's 9999
ssh -N -L 9999:127.0.0.1:8790 you@remote

export AI_ZEN_SERVER_TOKEN="$(ssh you@remote cat '~/.ai-zen/run/token')"
ai --server ws://127.0.0.1:9999
```

The same holds for tailscale and `kubectl port-forward`: all of them open a loopback port on this machine and connect it to a loopback port on the other end.

**The credential has to be given explicitly.** "The file is right here" does not hold in this shape — this machine's `<aiZenDir>/run/token` has nothing to do with the lock on the remote machine. The client tries the local file first, and the message it produces when refused is exactly that sentence (see "How the client connects" below).

### A known behaviour: the working directory is still sent as if local

Over a `ws://127.0.0.1:PORT` tunnel the client **cannot tell** from the address that the peer is not this machine — the entry point is a loopback address. So it does what it does locally and sends **this machine's working directory** up as the workspace; the remote machine usually does not have that path, and the server answers `workspace-path-missing`.

This is the current behaviour, not a bug: the client decides "who owns the workspace" purely by whether the address's host is loopback (`local-host.ts`), and the address really cannot separate "a local daemon" from "the far end of a tunnel".

Two ways out: create that path on the remote machine first, or switch to the reverse-proxy shape — `wss://your.domain/ai-zen` is not a loopback address, so the client sends no local directory and the workspace comes from the server's default (`--workspace`, or the directory it was started from).

## Reverse proxy (nginx terminating TLS)

The premise is that nginx and the server run on the **same machine**: nginx speaks `wss://` outward and connects to `ws://127.0.0.1:8790` inward — which lands exactly on the server's loopback assertion.

### The nginx config

```nginx
# /etc/nginx/conf.d/ai-zen.conf
server {
    listen 443 ssl;
    server_name your.domain;

    ssl_certificate     /etc/letsencrypt/live/your.domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your.domain/privkey.pem;

    # sub-path mount: location matches the prefix only and proxy_pass carries no URI,
    # so upstream receives the path unchanged (/ai-zen)
    location /ai-zen {
        proxy_pass http://127.0.0.1:8790;

        # 1. the WebSocket handshake (the three traps are below)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 2. payload ceiling: 1m by default, so content.upload turns into a 413
        client_max_body_size 64m;

        # 3. idle ceiling: 60s by default, which cuts a conversation in half
        proxy_read_timeout 3600s;

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

To mount on the root path, replace `location /ai-zen` with `location /` — the client then connects to `wss://your.domain`.

### The three default-value traps

| Directive | Default | What happens without it | What to write | Why that value |
|---|---|---|---|---|
| `proxy_http_version` + `Upgrade` / `Connection` | upstream is spoken to over HTTP/1.0, and `Upgrade` is **not forwarded** | upstream receives an ordinary HTTP request rather than an upgrade → the handshake is a **400**; and that request looks like every other one in the log | `proxy_http_version 1.1` + the two `proxy_set_header` lines | a WS handshake *is* an `Upgrade` request; HTTP/1.0 has no such notion, and not forwarding those two headers says nothing at all |
| `client_max_body_size` | **1m** | the bytes of `content.upload` travel as binary frames; over the ceiling nginx answers **413**, while the client is waiting for a WS message — it cannot read an HTTP response, so all it shows is an unexplained connection error | **64m** | it lines up with the WS layer's "one message ≤ 64 MiB" ceiling (see "Size ceilings" in [Wire Protocol](protocol.md)). Smaller shuts out something the protocol allows; larger means nothing |
| `proxy_read_timeout` | **60s** | after 60 idle seconds nginx cuts the upstream WS. The user sees "it dropped halfway through the conversation", while neither end reports an error | **3600s** | within one turn both "the model is thinking" and "the human went for tea" can be quiet for a long time, and the wire has **no** heartbeat requirement (the server initiates no requests and sends no ping) |

All three are the "it works with the config empty, it just works wrong" kind — none of them fails at startup.

### After the config is in place

The server side has to carry the **origin a browser will arrive with** in `AI_ZEN_ALLOWED_ORIGINS`, or your own web UI gets refused by your own server (403):

```bash
AI_ZEN_ALLOWED_ORIGINS=https://your.domain agents-server serve
# under systemd that is one line: Environment=AI_ZEN_ALLOWED_ORIGINS=https://your.domain
```

A value is `scheme://host[:port]` (several separated by commas, each entry trimmed, empty entries dropped); the criteria — including "no `Origin` at all is admitted" — are in "Origin check" in [Wire Protocol](protocol.md). Clients that send no `Origin` (the CLI, the desktop app, scripts) are unaffected by this setting.

## How the client connects

| What | Precedence (highest first) |
|---|---|
| address | `--server <url>` > `AI_ZEN_SERVER_URL` > `<aiZenDir>/run/server.json` |
| credential | `AI_ZEN_SERVER_TOKEN` > `<aiZenDir>/run/token` > none |

```bash
# the credential only comes from the environment (here: fetched from the remote machine)
export AI_ZEN_SERVER_TOKEN="$(ssh you@remote cat '~/.ai-zen/run/token')"
ai --server wss://your.domain/ai-zen
```

Four hard properties:

- **The URL accepts `ws:` / `wss:` / `http:` / `https:`**, the last two mapped as `http → ws` and `https → wss` — the address a user has in hand is usually `https://your.domain` (the string in the browser's address bar). **Paths are supported** (nginx sub-path mounts): `wss://your.domain/ai-zen` means the `/ai-zen` in the URL.
- **There is no `--token`, deliberately**: an address is not a secret and may live in argv; a credential is, and anything in argv stays in `ps` output and in shell history. So a credential has exactly two sources: the environment and a file.
- **An explicit address never spawns a local server**: a process started by local `npx` is definitely not at that address, so spawning would just wait out a timeout and then report something pointing the wrong way.
- **Address and credential must come from the same resolution**: once the address can point at a remote machine, the credential can no longer be read from the local file only. "It connects but the handshake is refused" is the hardest half-remote state to debug, so the client resolves both at one point, and the `unauthorized` message is phrased by "who gave the address × where the credential came from" — one of those sentences is exactly "this address may not be a local daemon; if it is an SSH forward / nginx / tailscale tunnel, set `AI_ZEN_SERVER_TOKEN`".

## Security boundary

The credential separates you from **other users and other networks**: without it, anything that can reach this port (or that domain on nginx) has `exec`.

It does **not** separate you from **other processes of the same user**: the credential file is mode 0600, and the same user naturally can read their own 0600 file — any script that user runs can take this key. That is not a hole, it is where the boundary is drawn: the boundary of a single-user tool is "this user", not "this process".

## Troubleshooting

| Symptom | Most likely cause |
|---|---|
| a browser gets 403 as soon as it connects | `AI_ZEN_ALLOWED_ORIGINS` does not carry that `https://your.domain` |
| the WS handshake is a 400 and the nginx log says nothing useful | `proxy_http_version 1.1` and the `Upgrade` / `Connection` headers are missing |
| a large upload drops and the client reports only a connection error | `client_max_body_size` is still the default **1m** (over it: 413) |
| the connection drops after about a minute of idling | `proxy_read_timeout` is still the default **60s** |
| `unauthorized` | `AI_ZEN_SERVER_TOKEN` does not match `<aiZenDir>/run/token` on that machine; when unset, the client fell back to this machine's copy |
| `workspace-path-missing` | in the tunnel shape the client sent its local working directory (see the known behaviour under "Tunnel") |
