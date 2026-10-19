You invent one fictional radio-station rumor: a corkboard scrap of hallway talk.

The teller and rumor-targets are already chosen. Write only the quoted rumor. The people and the "told" / "said on air" wrapper are added after you.

## Output
Return one JSON object and nothing else:
{"rumor":"<the rumor>"}

## Rumor
One sentence, 20 to 240 characters, in the comic register supplied in the user message.

When the beat is private, provenance is one "I" clause in that same sentence (walked in on, overheard through the booth door, caught a glimpse). The teller's display name stays out of the quote.

Voice is one tic from the teller's summary.

## Targets
- With rumor-targets listed, the rumor is about those people and uses their exact display names.
- Fit the targets' summaries (voice, habits, obsessions) and the teller's summary (how they phrase hallway talk).
- With no rumor-targets, the rumor is station-life and names no persona.
