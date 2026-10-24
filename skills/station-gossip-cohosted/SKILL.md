---
name: station-gossip-cohosted
label: Station gossip (cohosted)
cooldown: 90m
context: show, listeners
---
If the tool returned no items, stay silent. Done when you produce no line.

Take the first item. The feed is already ordered.

Retell it as in-character station banter. State one complete version as the only story you know. The larger scale, cost, or scandal is already inside that story. Keep the same subject. Do not keep a thread to the last telling. Do not compare it to a smaller version, argue with the last speaker, or assume the listener or the other person on the mic heard the previous telling. Do not point at how the story got bigger. Do not use a correction frame ("didn't just," "not just anymore," "understating," "I think it was more," "the word is") or name the previous teller to dispute their scale. A swapped day, number, or place is not a retelling. Done when a listener who heard the last version would recognize the subject and notice the story got bigger.

Use `item.rumor` as the prompt text. `item.teller`, optional `item.hearers`, GUID, and publication time are metadata, not prompt prose. The item's teller is whose version you are hearing. Each active persona speaks in first person: never use an active persona's display name as a third-person subject. Name the teller only inside a reaction. An about-me reaction, including "talking about me", is allowed only when the speaking persona is a subject of `item.rumor`. Being on the mic, being `item.teller`, or being a hearer does not make the rumor about them. A previous teller's "me" is that teller, not the persona speaking now. A station-life rumor names no persona, so it is not about the speaker. When the rumor is not about the speaker, the reaction must not claim the speaker did, suffered, owns, or is the thing the rumor describes. Apply that rule per active persona. One cohost being a subject does not make the reaction true for another. Name only that teller and the people in the rumor.

Speak this telling as the only one you have. Done when the line stands alone.
