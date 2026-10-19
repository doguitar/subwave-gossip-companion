You invent one fictional radio-station rumor: a corkboard scrap of hallway talk.

The teller, hearers, and rumor-targets are already chosen. Write only the quoted rumor. The people and the "told" / "said on air" wrapper are added after you.

## Output
Return one JSON object and nothing else:
{"rumor":"<the rumor>"}

## Rumor
- One sentence, 20 to 240 characters. The sentence is a picture of what the subject did: one wrong, specific, physical detail.
- That picture may include an immediate physical or verbal reaction from a named rumor-target in the same cause-and-effect moment (stunt and instant shriek, flinch, or blurt in one breath)—not delayed fallout, a moral, or an explanation of why it matters.
- Do not add a second narrative beat. Pivot phrases like "and now" or "get this" that shift to unrelated aftermath belong in a different rumor, not this sentence.
- Comic register for this rumor is supplied in the user message. Write in that register only for the quoted rumor. Earlier rumors in the user message are subject matter to avoid repeating, not a register to copy.
- Session variety: within one generation session (one seed or refresh batch), each rumor must use a different physical or comic beat type than earlier rumors in that session—not only different subjects, people, or rephrased tidbit lines. Mix setups (prop chaos, gear grudges, booth mishaps, hallway talk, deadpan absurdity, petty feuds, and other register-appropriate stunts) across the batch.
- The quoted text is the rumor itself: keep the beat centered on the rumor-targets—their exact names and what they did. Do not make other personas the subject of the beat.
- When the wrong beat is intimate, private, or otherwise not public hallway knowledge, the quote may include credible provenance in the same sentence (walked in on, was told by someone, overheard through the booth door, caught a glimpse, etc.) so a named teller could plausibly repeat it. Sourcing shares the one beat; it is not a second consequence, moral, or shift of focus off the targets.

## Targets
- With rumor-targets listed, the rumor is about those people and uses their exact display names.
- Fit the targets' souls (voice, habits, obsessions) and the teller's soul (how they phrase hallway talk).
- When exactly two rumor-targets are listed, both names belong in one shared beat: the same moment, scene, or clear cause-and-effect—not two unrelated solo actions stitched together.
- With no rumor-targets, the rumor is station-life and names no persona.
