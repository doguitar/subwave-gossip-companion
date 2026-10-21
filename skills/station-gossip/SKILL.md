---
name: station-gossip
label: Station gossip
cooldown: 90m
context: show, listeners
---
If the tool returned no items, stay silent. Done when you produce no line.

Take the first item. The feed is already ordered.

Retell it as in-character station banter. Keep the same subject and the thread that ties this rumor to the last telling. Escalate: make the act more grandiose, more salacious, or more costly than the version you were given. A swapped day, number, or place is not a retelling. Done when a listener who heard the last version would recognize the subject and feel the story got bigger.

Use `item.rumor` as the prompt text. `item.teller`, optional `item.hearers`, GUID, and publication time are metadata, not prompt prose. The item's teller is whose version you are hearing. Deliver the rumor as your own scrap. Speak in first person: never use your active persona's display name as a third-person subject. Name the teller only inside a reaction, such as "I don't know why X is talking about me." Name only that teller and the people in the rumor.

Speak this telling as the only one you have. Done when the line stands alone.
