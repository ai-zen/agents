# @ai-zen/agents-logger

One log file: three levels, a source tag, size-based rotation, and a queued writer.

This package only does "write one line out". It reads no environment variables, holds no global singleton, writes to neither stdout nor stderr, and knows nothing about the concept of a notice — to learn what was just written, subscribe to `onRecord`.

```ts
import { FileLogger } from "@ai-zen/agents-logger";

const log = new FileLogger({ file: "/var/log/ai-zen/host.log" });

log.info("host started", { port: 8790 });
log.warn("config recovered", { path: "/home/me/.ai-zen/config.json" });
log.error("handoff failed", { error });

await log.close(); // flushes the queue, then closes the stream
```

## Three things are fixed here

1. **Rotation by size.** A file is rotated once it reaches `maxBytes` (default 5MB), keeping `maxFiles` files (default 5, including the one being written). Naming is `<file>` (current), `<file>.1` (previous), and so on; the oldest is deleted on rotation. No dependency is involved: `rename` / `rm` from `node:fs` are enough.
2. **Writes are queued serially in arrival order.** The cost of one log line should not be paid by the caller, so callers never wait; `close()` drains the queue before closing the stream (a line not written before the process exits is a line lost).
3. **The stream is opened lazily.** It opens on the first write that actually happens, so a process that logs nothing leaves no empty file on disk.

There is no level threshold: `info`, `warn` and `error` are all written. Deciding which level to keep is not this package's call.

## Line format

```
<ISO timestamp> <level> <source> <message> [detail JSON]
```

Levels are fixed-width (`INFO ` / `WARN ` / `ERROR`), so a single grep column filters them.

## API

| Export | Kind |
|---|---|
| `FileLogger` | The writer |
| `LogSink` | Structural type with `info` / `warn` / `error`, plus `withSource()` products |
| `formatLine` | The line formatter, exported so any second sink produces identical lines |
| `LogLevel`, `LogRecord`, `FileLoggerOptions` | Types |
| `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_FILES` | Defaults |

There are no singletons and nothing is re-exported with new semantics: the process that uses a logger owns the instance.
