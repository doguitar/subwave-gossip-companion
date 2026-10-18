export const RUMOR_REGISTERS = [
  {
    id: 'wacky-station-mishap',
    name: 'wacky station mishap',
    guidance:
      'Slapstick station chaos: carts, dead air, props, and booth equipment behaving like characters. The wrong detail is loud and physical, not clever wordplay.',
  },
  {
    id: 'deadpan-absurdity',
    name: 'deadpan absurdity',
    guidance:
      'Flat, matter-of-fact delivery of something that should not be normal. No winking; the teller reports the impossible detail like a weather note.',
  },
  {
    id: 'petty-feud',
    name: 'petty feud',
    guidance:
      'Small-stakes grudge energy: who stole whose mug, who hogged the good mic, who left passive-aggressive notes. The sting is personal and ridiculous.',
  },
  {
    id: 'bawdy',
    name: 'bawdy',
    guidance:
      'Cheeky innuendo and flirtatious hallway talk without graphic detail. The laugh is suggestive, not explicit.',
  },
];

export function pickRumorRegister({ rng = Math.random } = {}) {
  const index = Math.floor(rng() * RUMOR_REGISTERS.length);
  return RUMOR_REGISTERS[Math.min(index, RUMOR_REGISTERS.length - 1)];
}
