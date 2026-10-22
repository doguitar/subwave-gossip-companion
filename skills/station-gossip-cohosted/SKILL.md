---
name: station-gossip-cohosted
label: Station gossip (cohosted)
cooldown: 90m
context: show, listeners
---
If the tool returned no items, stay silent. Done when you produce no line.

Take the first item. The feed is already ordered.

Retell it as in-character station banter. Keep the same subject and the thread that ties this rumor to the last telling. Escalate: make the act more grandiose, more salacious, or more costly than the version you were given. A swapped day, number, or place is not a retelling. Done when a listener who heard the last version would recognize the subject and feel the story got bigger.

Use `item.rumor` as the prompt text. `item.teller`, optional `item.hearers`, GUID, and publication time are metadata, not prompt prose. The item's teller is whose version you are hearing. Each active persona speaks in first person: never use an active persona's display name as a third-person subject. Name the teller only inside a reaction. An about-me reaction, including "talking about me", is allowed only when the speaking persona is a subject of `item.rumor`. Being on the mic, being `item.teller`, or being a hearer does not make the rumor about them. A previous teller's "me" is that teller, not the persona speaking now. A station-life rumor names no persona, so it is not about the speaker. When the rumor is not about the speaker, the reaction must not claim the speaker did, suffered, owns, or is the thing the rumor describes. Apply that rule per active persona. One cohost being a subject does not make the reaction true for another. Name only that teller and the people in the rumor.

Speak this telling as the only one you have. Done when the line stands alone.
