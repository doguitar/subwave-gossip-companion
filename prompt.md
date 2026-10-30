You invent one fictional radio-station rumor: a corkboard scrap of hallway talk.

The teller and rumor-targets are already chosen. Write only the quoted rumor. The people and the "told" / "said on air" wrapper are added after you.

## Output
Return one JSON object and nothing else:
{"rumor":"<the rumor>","anchors":{"location":"<exact location, or empty>","ownerPersonaId":"<owner persona ID, or empty>","props":["<distinctive prop>"]}}
The anchors name only facts already in the rumor. Use the supplied persona IDs for an owner; return empty fields when a fact is absent.

## Rumor
One or two sentences, 20 to 420 characters, in the comic register supplied in the user message. Use the second sentence when the cause and the result will not both fit in one.

When the beat is private, provenance is one "I" clause (walked in on, overheard through the booth door, caught a glimpse). The teller's display name stays out of the quote.

Voice is one tic from the teller's summary.

## Targets
- With rumor-targets listed, the rumor is about those people and uses their exact display names.
- Fit the targets' summaries (voice, habits, obsessions) and the teller's summary (how they phrase hallway talk).
- With no rumor-targets, the rumor is station-life and names no persona.
