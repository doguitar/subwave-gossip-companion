export const DEFAULT_RUMOR_REGISTERS = [
  {
    id: 'wacky-station-mishap',
    name: 'wacky station mishap',
    guidance:
      'Slapstick station chaos: runaway carts, dead air, props in the wrong rack, booth gear acting possessed. Vary the physical gag rumor to rumor; the wrong detail is loud and physical, not clever wordplay.',
  },
  {
    id: 'deadpan-absurdity',
    name: 'deadpan absurdity',
    guidance:
      'Flat, matter-of-fact delivery of impossible station details: wrong inventory counts, clocks that disagree, furniture in the wrong room. No winking; the teller reports the absurd detail like a weather note.',
  },
  {
    id: 'petty-feud',
    name: 'petty feud',
    guidance:
      'Small-stakes grudge energy: stolen mugs, hogged mics, swapped booth props, locker sabotage, parking-spot wars, gear hoarding. Keep the sting personal and ridiculous; pick a fresh petty stunt flavor each rumor.',
  },
  {
    id: 'bawdy',
    name: 'bawdy',
    guidance:
      'Cheeky innuendo and flirtatious hallway talk without graphic detail: closet whispers, booth-door gossip, suggestive prop mix-ups. The laugh is suggestive, not explicit.',
  },
];

/** @deprecated Use loaded config catalog or DEFAULT_RUMOR_REGISTERS in tests. */
export const RUMOR_REGISTERS = DEFAULT_RUMOR_REGISTERS;

export function pickRumorRegister({ catalog = DEFAULT_RUMOR_REGISTERS, rng = Math.random } = {}) {
  const list = catalog?.length ? catalog : DEFAULT_RUMOR_REGISTERS;
  const index = Math.floor(rng() * list.length);
  return list[Math.min(index, list.length - 1)];
}
