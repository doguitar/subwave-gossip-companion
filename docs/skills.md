# Station gossip skills

Two skills ship in this repository. They call the same tool. `skills/station-gossip` is the solo telling. `skills/station-gossip-cohosted` uses the same feed and the same return value, and its instructions let every active persona speak in first person.

## Install

Copy the skill directory into the station skill folder, then set the one config field.

| Skill | Directory | When to use |
|---|---|---|
| Solo | `skills/station-gossip` | One persona is on the mic. |
| Cohosted | `skills/station-gossip-cohosted` | More than one persona can speak in the same segment. |

`feedUrl` is the companion origin Subwave can fetch, with no `/gossip.rss` suffix. Use the same value as `GOSSIP_FEED_BASE_URL`, for example `http://192.168.1.20:8080` or `http://subwave-gossip-companion:8080`. The field label is **Gossip feed URL**. An empty value returns `{ "available": false }` and the persona stays silent.

## Context

The tool reads `show` from the skill context (`show`, `showTitle`, `currentShow`, `activeShow`, or `session.show`). A missing show returns `{ "available": false }`.

An actor id (`personaId`, `characterId`, or `actorPersonaId`) is optional. When it is present, the request is `/gossip.rss?show=<show>&actor=<id>` and the feed rotates away from the rumor that persona just told. Without it, the request is `/gossip.rss?show=<show>` and the log says the feed will not rotate per character.

## Tool result

Success:

```json
{
  "available": true,
  "items": [
    {
      "rumor": "Cart rumor",
      "text": "Cart rumor",
      "guid": "abc",
      "teller": "Alpha",
      "hearers": "Beta, Gamma",
      "pubDate": "Sat, 19 Sep 2026 12:00:00 GMT"
    }
  ]
}
```

`rumor` and `text` are the retellable body. `teller` and `hearers` are display names and are omitted when the feed has none. `guid` and `pubDate` are omitted when the item has none. The skill speaks `item.rumor` only.

No `feedUrl`, no `show`, an empty feed, or a failed fetch returns `{ "available": false }` and no `items`. Both skill files say to stay silent in that case.

## Troubleshooting

| Log line | What to fix |
|---|---|
| `feedUrl is not configured` | Set Gossip feed URL to the companion origin. |
| `no show in context` | The station context has no show title. |
| `no actor persona id` | Optional. Add a persona id only if the feed should rotate per character. |
| `feed empty` | The show has no eligible rumor, or the actor was excluded from the only one. Silence is correct. |
| `fetch failed` | The station cannot reach `feedUrl`. Use a LAN or shared-network host, not the companion container's loopback. |
