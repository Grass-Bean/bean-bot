# bean-bot

Successor of goon-bot

honestly only good for media playing

## Logging

Logs go to the existing console output and are available through `docker compose logs -f bean-bot`. No log files or external collector are required.

Set these optional values in `.env`, then recreate the container to apply them:

```dotenv
LOG_LEVEL=info
LOG_FORMAT=pretty
```

`LOG_LEVEL` accepts `debug`, `info`, `warn`, or `error`; `LOG_FORMAT` accepts `pretty` or `json`. Defaults are `info` and `pretty`. Invalid values produce a warning and fall back to the default for that setting. Debug/info records go to stdout; warn/error records go to stderr. Every record occupies one physical line and uses a UTC timestamp. Stacks use escaped newlines, and `npm start` enables TypeScript source maps.

Readable output:

```text
2026-10-01T05:00:00.000Z INFO command.completed Command finished. {"component":"commands","interactionId":"123","command":"play","guildId":"456","userId":"789","outcome":"completed","elapsedMs":850}
```

JSON output has the same fields and can be filtered by `event`, `guildId`, `interactionId`, or `trackId`:

```json
{"component":"audio","guildId":"456","trackId":"track-a","title":"Example song","timestamp":"2026-10-01T05:00:01.000Z","level":"error","event":"audio.source_failed","message":"Audio resource failed.","error":{"name":"Error","message":"yt-dlp closed with code 1","cause":{"name":"YtDlpProcessError","code":"PROCESS_FAILURE","exitCode":1,"httpStatus":403,"diagnostic":"HTTP Error 403: Forbidden"}}}
```

Useful events:

| Event | Meaning |
| --- | --- |
| `bot.starting`, `commands.loaded`, `commands.deploy_completed`, `bot.ready` | Startup and Discord readiness |
| `command.completed` | One terminal command record with `completed`, `rejected`, `rate-limited`, or `failed` outcome and elapsed time |
| `audio.track_queued`, `audio.track_submitted` | Track accepted and handed to the player; audio may still be buffering |
| `audio.track_started`, `audio.track_ended` | Playback began, or the track ended with a reason and playback duration |
| `audio.source_failed`, `audio.player_failed` | Primary resource failure; a wrapped source failure is reported once per resource, including preloads |
| `audio.watchdog_stopped` | Startup timeout, stalled playback, or excessive playback duration |
| `voice.recovery_*`, `voice.websocket_closed`, `voice.cooldown_started` | Recovery progress/results, close codes, and temporary voice cooldowns |
| `audio.session_closed` | Session cleared, with the closure reason |
| `command.error_response_failed`, `pagination.*`, `audio.notification_failed` | Failure delivering or cleaning up Discord messages |
| `process.unhandled_rejection`, `process.uncaught_exception` | Global failure; the process remains running under the existing policy |

Use `LOG_LEVEL=debug` for command starts, buffering/state changes, autoplay cache/selection details, preloads, and cooldown housekeeping. Info includes normal commands, queue/playback activity, and lifecycle. Warnings describe recoverable disruptions; errors describe failed operations. An accepted `/play` command can finish successfully before playback later fails; correlate those records using the queued track ID.

Errors include selected codes/status, bounded causes, and sanitized subprocess diagnostics, without dumping Discord audio resources or HTTP request/response objects. Credential environment values, URL credentials/query strings, prompts, search queries, and generated responses are excluded or redacted. Track titles and IDs remain available for diagnosis. Playback, retry, and recovery policies are unchanged; this logging change does not resolve upstream HTTP 403 errors.
