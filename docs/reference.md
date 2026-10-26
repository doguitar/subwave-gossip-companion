# Operator reference

This page lists what the process accepts. The README explains how to run it.

## Commands

Every command accepts `--base-dir <dir>` or `--base <dir>`. That directory wins over `GOSSIP_BASE_DIR` and is where `.env` and `config.yaml` are loaded. `config.yaml.example` is the commented settings example. The default command is `serve`.

| Command | Arguments | Depends on |
|---|---|---|
| `serve` | none | Subwave credential, provider, `GOSSIP_REFRESH_SECRET`. Listens on `GOSSIP_HOST:GOSSIP_PORT`. One process per state file. |
| `seed`, `gossip:seed` | none | Subwave credential and provider. Appends tidbits. No refresh secret. |
| `refresh`, `gossip:refresh` | optional count, integer 1–10 | Subwave credential and provider. Replaces the board. Count overrides `GOSSIP_REFRESH_COUNT`. |
| `generate` | `--reasoning <level>`, `--review-steps <0-5>` | Same as `seed`. Prints each new rumor. Flags apply to that run only. |
| `summarize-souls` | `--reasoning <level>` | Subwave credential and provider. Prints summaries. Does not write gossip. |
| `ingest-spoken`, `gossip:ingest-spoken` | none | Subwave credential. Records spoken lines already stored by the station. No provider call. |

Unknown commands exit with the command list. `--reasoning` and `--review-steps` require a value. A refresh count outside 1–10 is rejected.

## HTTP

The process binds `GOSSIP_HOST` (default `0.0.0.0`) and `GOSSIP_PORT` (default `8080`, integer 1–65535). Anything not listed below is `404` with body `not found`.

| Route | Auth | Success | Errors |
|---|---|---|---|
| `GET /` | none | `200` `text/html`. "Station Gossip" lists every current rumor text. A later "Show rumors" heading names the show on air (the scheduled show, otherwise the session title), its DJs (host, then guests, public names only), and the rumors that show's feed would serve with no actor. When personas resolve but none have a public name, the DJ line is empty and ids are not printed. No resolved personas omits the DJ line. No current show says "No current show is on air." with no DJ names and no rumors. An unmatched title is that title alone, with no DJ line and no rumors | Still `200` when that show cannot be loaded. The section says the current show could not be loaded |
| `GET /health` | none | `200` `text/plain` body `ok` | |
| `GET /ready` | none | `200` JSON `{ "ready": true }` when the state file reads and the station schedule loads | `503` JSON `{ "ready": false, "checks": { "state", "subwave" } }` |
| `POST /refresh`, `POST /gossip/refresh` | `Authorization: Bearer` equal to `GOSSIP_REFRESH_SECRET` | `200` JSON refresh result (`refreshed`, `tidbits`, and the rest of the refresh payload) | `401` `{ "error": "unauthorized" }`; `GET` is `405` with `Allow: POST`; `413` `{ "error": "request body too large" }`; `408` `{ "error": "request body timed out" }`; `400` `{ "error": "invalid JSON body" }` or the count message; `429` `{ "error": "refresh admission limit exceeded" }`; `503` `{ "error": "shutting down" }` |
| `GET /gossip.rss` | none | `200` RSS when `show` is set. Optional `actor` rotates items. Unknown show is an empty feed. | `400` plain text when `show` is missing. Schedule failure is non-2xx JSON, not RSS. |

`count` on refresh is a query parameter or JSON `{ "count": 1 }`. Omit it to use `GOSSIP_REFRESH_COUNT`. Unauthenticated refresh does not read the body.

`GET /` and `GET /gossip.rss` publish station fiction to anyone who can reach the port. Do not put the port on a public interface unless that exposure is intended. Only the refresh routes check a credential.

## Environment

`.env.example`, `config.yaml`, `config.yaml.example`, and `loadConfig` are the source of truth. Relative paths resolve under `GOSSIP_BASE_DIR` (default `.`).

| Key | Default | Range / values |
|---|---|---|
| `GOSSIP_BASE_DIR` | `.` | directory |
| `GOSSIP_TYPES_PATH` | `gossip-types.json` | file under the base directory |
| `SUBWAVE_API_URL` | empty | station API origin |
| `SUBWAVE_API_TOKEN` | required | HTTP Basic credential: base64 of `user:password`, or the raw `user:password` pair. Sent as `Authorization: Basic` |
| `PROVIDER` | `openai` | `openai`, `google`, `anthropic`. Alias `GOSSIP_LLM_PROVIDER` |
| `PROVIDER_KEY` | empty | Alias `GOSSIP_LLM_API_KEY`, then `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` |
| `PROVIDER_MODEL` | `gpt-4o-mini`, `gemini-2.0-flash`, or `claude-sonnet-4-5` by provider | Alias `GOSSIP_LLM_MODEL` |
| `PROVIDER_THINKING` | off when unset | any non-empty string. Alias `GOSSIP_LLM_THINKING` |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Alias `GOSSIP_LLM_URL` |
| `GOSSIP_REFRESH_COUNT` | `1` | integer 1–10 |
| `GOSSIP_REFRESH_SECRET` | required | bearer for HTTP refresh only |
| `GOSSIP_REFRESH_MAX_CONCURRENCY` | `1` | integer 1–10 |
| `GOSSIP_REFRESH_MIN_INTERVAL_MS` | `60000` | integer 0–3600000 |
| `GOSSIP_REFRESH_BODY_MAX_BYTES` | `16384` | integer 1–1048576 |
| `GOSSIP_HEADERS_TIMEOUT_MS` | `10000` | integer 1000–300000 |
| `GOSSIP_REQUEST_TIMEOUT_MS` | `30000` | integer 1000–300000 |
| `GOSSIP_SHUTDOWN_DEADLINE_MS` | `5000` | integer 0–3600000 |
| `GOSSIP_HOST` | `0.0.0.0` | bind address |
| `GOSSIP_PORT` | `8080` | integer 1–65535 |
| `GOSSIP_STATE_PATH` | `data/gossip-state.json` | file under the base directory |
| `GOSSIP_SEED_CAP` | `5` | integer 1–50 |
| `GOSSIP_HISTORY_GENERATIONS` | `7` | integer 0–50 |
| `GOSSIP_REVIEW_ROUNDS` | `0` | integer 0–5 |
| `GOSSIP_THREAD_MAX_TELLINGS` | `3` | integer 1–100 |
| `GOSSIP_THREAD_MAX_AGE_MS` | `86400000` | positive number |
| `GOSSIP_FEED_BASE_URL` | empty | public RSS link base; empty uses the request URL |
| `GOSSIP_MIN_RUMOR_LENGTH` | `20` | positive number; shorter model text is rejected |
| `GOSSIP_TIMEZONE` | empty | IANA zone for day boundaries; empty uses the station schedule, then UTC |
| `GOSSIP_LLM_FIXTURE` | empty | file of canned model replies; empty calls the provider |
| `GOSSIP_LLM_CALL_LOG` | `logs/llm-calls.jsonl` | empty disables the call log |
| `GOSSIP_LLM_LOG_CONTENT` | `metadata` | `off`, `metadata`, or `full` |
| `GOSSIP_TTS_TIMEOUT_MS` | `300000` | positive number; how long serve polls for a spoken clip |
| `GOSSIP_TTS_POLL_MS` | `3000` | number ≥ 250; poll interval for that wait |
| `GOSSIP_OPERATIONAL_LOG` | `logs/gossip.log` | active operational log |
| `GOSSIP_OPERATIONAL_LOG_MAX_BYTES` | `524288` | integer 1–1073741824 |
| `GOSSIP_OPERATIONAL_LOG_RETENTION_MS` | `604800000` | integer 1–31536000000 |

## Privacy

`GET /` and `GET /gossip.rss` are unauthenticated. The HTML page shows current rumor text, then a Show rumors section. When a show title resolves, that section publishes the same unauthenticated fiction as the no-actor show feed. When no show is on air, the section says so and lists no rumors. When the show cannot be loaded, the section says the current show could not be loaded. RSS shows retellable rumor bodies and, when names resolve, teller and hearer display names. Persona ids are not on the page or in the feed. Refresh is the only route that checks `GOSSIP_REFRESH_SECRET`.

`GOSSIP_LLM_LOG_CONTENT=metadata` stores version, time, ids, kind, provider, model, retry, stage, and when present elapsed time, status, usage, and a redacted detail. It drops prompt, message, soul, house-rule, and response bodies. `full` retains those bodies. `off`, or an empty `GOSSIP_LLM_CALL_LOG`, writes no call log. The operational log records one-line summaries and redacts provider credentials. Keep `logs/` owner-readable and out of shared backups.
