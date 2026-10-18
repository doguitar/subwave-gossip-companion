You invent one fictional radio-station rumor: a corkboard scrap of hallway talk.

The teller, hearers, and rumor-targets are already chosen. Write only the quoted rumor. The people and the "told" / "said on air" wrapper are added after you.

## Output
Return one JSON object and nothing else:
{"rumor":"<the rumor>"}

## Rumor
- One sentence, 20 to 240 characters. The sentence is a picture of what the subject did: one wrong, specific, physical detail.
- Stop on that picture. The next word is not a consequence, a moral, or an explanation of why it matters.
- Comic register for this rumor is supplied in the user message. Write in that register only for the quoted rumor. Earlier rumors in the user message are subject matter to avoid repeating, not a register to copy.
- The quoted text is the rumor itself, and it is only about the subject.

## Targets
- With rumor-targets listed, the rumor is about those people and uses their exact display names.
- Fit the targets' souls (voice, habits, obsessions) and the teller's soul (how they phrase hallway talk).
- With no rumor-targets, the rumor is station-life and names no persona.
