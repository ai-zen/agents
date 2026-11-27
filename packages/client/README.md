# @ai-zen/agents-client

The connection layer from a terminal or desktop client to `@ai-zen/agents-host`. One facade, five things:

| What you want | Where it comes from |
|---|---|
| A connection that has been probed: `api` / `subscribe` / `reconnect` / `close` | `connect` in `client.ts` |
| "Use one if it is there, start one if it is not" | `ensureHost` in `connection.ts` |
| Remember which host was used last, and in which language | `settings.ts` |
| How many reconnect attempts, and how long to wait | `reconnect.ts` |
| Upload images, fetch their bytes by id | `asset.ts` (`uploadAsset`, `uploadAssets`, `getAsset`) |

The wire contract is not restated here: the type of `api` is `TRPCClient<AppRouter>`, and `AppRouter` is re-exported from `@ai-zen/agents-host`, so `client.api.session.open.query({ sessionId })` type-checks against the host. At runtime not a byte of that package is imported — its entry point would pull the whole host (the app root, the SQLite worker, the SDK assembly) into the bundle.

## Getting a client

```ts
import { ensureHost } from "@ai-zen/agents-client";

const { client, target, started } = await ensureHost({
  dataRoot: "/home/me/.ai-zen",
  launchLog: "/home/me/.ai-zen/logs/cli/host-launch.log",
  versionRange: "^0.2.0-alpha.1",
});

const sessions = await client.api.session.list.query({ workspaceId });

const off = client.subscribe((event) => {
  // host events: session changes, agent events, notices
});

off();
await client.close();
```

`ensureHost` resolves the target in this order: the explicit address from `settings` (mode `remote`), then `run/host.json` in the data root together with `run/token`, then starting a host. Starting means the caller's own entry point when `hostEntry` is given (the desktop app ships the host inside its build), otherwise `npx -y @ai-zen/agents-host@<version range> serve`. It then polls the address until the host listens.

The result says what happened: `client` (already connected and probed), `target` (the structured address — interfaces should build display strings from it), `started` (whether this client started the host), `explicit` (whether an explicit address was used; on that path `started` is always false because nothing is started), and `dataRoot`.

`run/next-version.json` is the upgrade pin: when it names a version, that one is started instead of the newest matching the range. A host that exits with `UPGRADE_EXIT_CODE` (`75`) is restarting itself for an upgrade.

## Connection settings

`settings.ts` reads and writes "which host was used last, and in what language", one file per client: `<data root>/cli/connection.json` and `<data root>/desktop/connection.json`. They are separate because the two clients may sit on different machines, or on one machine connected to different hosts. What they share is `<data root>/run/` — the discovery file and the credential, which are facts about this machine.

Two behaviours worth knowing:

- The file carries a credential, so it is written with mode `0600`, via a `.tmp` file and `rename`, so a killed process never leaves half a JSON
- `readSettings` returns `null` when there is no usable configuration — absent file, broken JSON, invalid fields. It does not fall back to `{ mode: "local" }`: collapsing "never configured" into "configured as local" would make first launch start a host instead of showing the connect screen

## Addresses

`parseAddress` / `normalizeAddress` / `webSocketUrl` / `addressLabel` / `isLoopbackHost` are exported so validation lives in one place. Accepted forms include `ws://`, `wss://`, and bare `host:port`, which is treated as `ws://`.

## Assets

`uploadAsset` / `uploadAssets` send bytes to the host and return ids; `getAsset` fetches bytes back. Assets are the host's property — the SDK never learns about them.

## Status

This package is `private: true` and is not published. The CLI and the desktop app each bundle it into their own build.
