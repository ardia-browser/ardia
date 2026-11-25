export type VoiceSource = "x" | "discord" | "youtube";

export interface Voice {
  id: string;
  quote: string;
  name: string;
  handle: string;
  source: VoiceSource;
  sourceLabel: string;
  href: string;
  avatar: string;
  featured?: boolean;
}

export const VOICES: Voice[] = [
  {
    id: "mkbhd",
    quote:
      "It's much faster. It lets you switch engines between WebKit and Chromium, which I think is pretty cool.",
    name: "Marques Brownlee",
    handle: "@MKBHD",
    source: "youtube",
    sourceLabel: "Waveform",
    href: "https://www.youtube.com/watch?v=Fbb5gX2CvoM&t=376s",
    avatar: "mkbhd",
    featured: true,
  },
  {
    id: "charlielamb",
    quote: "how is it already better than Arc",
    name: "Charlie Lamb",
    handle: "@charlielamb",
    source: "x",
    sourceLabel: "X",
    href: "https://x.com/charlielamb/status/2113639195608826321",
    avatar: "charlielamb",
    featured: true,
  },
  {
    id: "jsmasterypro",
    quote: "Just switched over from Arc to Ardia browser and I'm loving it so far!",
    name: "JavaScript Mastery",
    handle: "@jsmasterypro",
    source: "x",
    sourceLabel: "X",
    href: "https://x.com/jsmasterypro/status/2115849106623222026",
    avatar: "jsmasterypro",
  },
  {
    id: "luke_judges",
    quote: "Just found this OS version of Arc browser as its decommissioning soon, its great.",
    name: "LJ",
    handle: "@luke_judges",
    source: "x",
    sourceLabel: "X",
    href: "https://x.com/luke_judges/status/2120712061512794293",
    avatar: "luke_judges",
  },
  {
    id: "itsomsarraf",
    quote:
      "Just switched to Ardia, it's so cool. Onboarding was top notch, really polished product",
    name: "Om Sarraf",
    handle: "@itsOmSarraf_",
    source: "x",
    sourceLabel: "X",
    href: "https://x.com/itsOmSarraf_/status/2121178658199212285",
    avatar: "itsomsarraf",
  },
  {
    id: "sprice",
    quote:
      "Ardia is the most beautiful software experience I’ve had in ages. Such a delightful export/transition from Dia.",
    name: "Shawn Price",
    handle: "@sprice",
    source: "x",
    sourceLabel: "X",
    href: "https://x.com/sprice/status/2120957453827440893",
    avatar: "sprice",
  },
  {
    id: "andywang",
    quote: "I tried everything, they all suck except… ardia.dev. I would pay to see it maintained",
    name: "Andy",
    handle: "@andywang",
    source: "x",
    sourceLabel: "X",
    href: "https://x.com/andywang/status/2114119736099582415",
    avatar: "andywang",
  },
  {
    id: "mielke_jack",
    quote:
      "I basically tried every browser in the game this week and came away with this one as my favorite",
    name: "Jack Mielke",
    handle: "@mielke_jack",
    source: "x",
    sourceLabel: "X",
    href: "https://x.com/mielke_jack/status/2115262317554475497",
    avatar: "mielke_jack",
  },
  {
    id: "pablopunk",
    quote:
      "finally a freaking Arc clone that actually has persistent folders and tabs … I think I'm gonna finall ditch Zen!",
    name: "pablo",
    handle: "@pablopunk",
    source: "x",
    sourceLabel: "X",
    href: "https://x.com/pablopunk/status/2114074885794238665",
    avatar: "pablopunk",
  },
  {
    id: "thaetos",
    quote: "ardia is the most refined clone i've ever tried. its better than Zen too imo",
    name: "Thaetos",
    handle: "thaetos",
    source: "discord",
    sourceLabel: "Discord",
    href: "https://discord.com/channels/1560507457376354414/1560507459448082478/1563327790957203487",
    avatar: "thaetos",
  },
];
