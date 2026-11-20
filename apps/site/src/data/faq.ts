export type Question = { id?: string; question: string; answer: string; more?: { path: string; label: string } };

export const FAQ: Question[] = [
  { question: "What does it cost?", answer: "Nothing. It’s free and open source under GPL-3.0." },
  {
    id: "install",
    question: "Is it safe to open?",
    answer: "Signed and notarized by Apple, so macOS opens it without a fuss. The source is on GitHub if you’d rather check yourself.",
  },
  {
    question: "What does it collect?",
    answer:
      "Once a day, Ardia sends an anonymous ping with the app and macOS versions and no lasting ID. Update checks log the version, day and first-install flag. Launch also reads one shared config file so we can turn off a buggy optimization. Crash reports and feature counts stay off unless you opt in, and never include your sites or searches.",
  },
  {
    question: "And this website?",
    answer: "We self-host analytics and 30-day session replays with typed text masked. No third-party trackers.",
  },
  {
    question: "Coming from Arc?",
    answer: "Yes. The importer brings over your spaces, pinned tabs, folders and themes.",
    more: { path: "arc/", label: "See what comes over." },
  },
  { question: "Is this Dia?", answer: "No. It defaults to Dia’s look, with an Arc layout option in Settings." },
  { question: "Why “Ardia”?", answer: "Arc plus Dia." },
];

export const faqJsonLd = () => ({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map((q) => ({ "@type": "Question", name: q.question, acceptedAnswer: { "@type": "Answer", text: q.answer } })),
});
