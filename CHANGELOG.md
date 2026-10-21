# Changelog

This file is the only operator-facing release note. GitHub Releases for `vX.Y.Z` copy the matching section. The container workflow publishes `ghcr.io/doguitar/subwave-gossip-companion:vX.Y.Z` from that git tag, and also moves `latest` on `main`. Upgrade by changing the pinned tag, not by tracking `latest`.

Before a tag:

1. Set `package.json` `version` to `X.Y.Z` without the `v`.
2. Add a `## vX.Y.Z` section here. Include config, HTTP, and workspace migration notes, or say that none are required.
3. Point the Unraid repository field at the same tag.
4. Push the `vX.Y.Z` tag. The release body is this section.

## v1.0.0

First tagged image. Pull `ghcr.io/doguitar/subwave-gossip-companion:v1.0.0`.

### Config

`GOSSIP_REFRESH_SECRET` is required. Send it as `Authorization: Bearer` on `POST /refresh` and `POST /gossip/refresh`. `GOSSIP_FEED_BASE_URL` must be a URL the station can fetch, not the container loopback. Shutdown drain defaults to `GOSSIP_SHUTDOWN_DEADLINE_MS=5000`; the orchestrator stop grace must be at least 15 seconds. Review rounds default to `0`. LLM call log content defaults to `metadata`.

### HTTP

`GET /health` is liveness. `GET /ready` is readiness. `GET /` is unauthenticated HTML. `GET /gossip.rss` requires `show` and does not emit persona ids.

### Workspace

Keep `data/gossip-state.json`, live `prompt.md`, and a non-empty `gossip-types.json`. The image rewrites `prompt.md.default` on start and seeds `prompt.md` or the catalog only when the live file is missing or empty. A state file that is not valid JSON is not rewritten. A new state file gains `spokenEventCursor` as an empty string. `logs/` are optional diagnostics, not required for rollback.

No migration tool runs. The previous workspace copy is the rollback.
