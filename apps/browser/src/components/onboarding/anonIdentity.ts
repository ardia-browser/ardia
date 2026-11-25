const ADJECTIVES = [
  "Quiet", "Swift", "Lucky", "Sleepy", "Brave", "Clever", "Cosmic", "Gentle",
  "Mellow", "Nimble", "Plucky", "Sunny", "Witty", "Zesty", "Breezy", "Curious",
  "Dapper", "Fuzzy", "Jolly", "Misty", "Noble", "Rusty", "Silky", "Velvet",
] as const;

const CREATURES = [
  { name: "Otter", art: "🦦" },
  { name: "Fox", art: "🦊" },
  { name: "Owl", art: "🦉" },
  { name: "Panda", art: "🐼" },
  { name: "Koala", art: "🐨" },
  { name: "Penguin", art: "🐧" },
  { name: "Hedgehog", art: "🦔" },
  { name: "Octopus", art: "🐙" },
  { name: "Frog", art: "🐸" },
  { name: "Tiger", art: "🐯" },
  { name: "Whale", art: "🐳" },
  { name: "Sloth", art: "🦥" },
  { name: "Raccoon", art: "🦝" },
  { name: "Flamingo", art: "🦩" },
  { name: "Turtle", art: "🐢" },
  { name: "Bee", art: "🐝" },
] as const;

export type AnonIdentity = { name: string; art: string; serial: string; rarity: number };

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function anonIdentity(installId: string): AnonIdentity {
  const h = hash(installId);
  const creature = CREATURES[h % CREATURES.length]!;
  const adjective = ADJECTIVES[Math.floor(h / CREATURES.length) % ADJECTIVES.length]!;
  const hex = installId.replace(/[^0-9a-f]/gi, "").toUpperCase().padEnd(8, "0");
  return { name: `${adjective} ${creature.name}`, art: creature.art, serial: `${hex.slice(0, 4)}·${hex.slice(4, 8)}`, rarity: 1 + (hash(`${installId}:rarity`) % 3) };
}
