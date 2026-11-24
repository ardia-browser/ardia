# Android Material symbols

With Settings › General › Material You on, Android's React Native controls draw Google's Material Symbols Rounded. The pinned SVG path data and the mapping from Ardia's symbol names live in `material-symbols.json`, from [google/material-design-icons](https://github.com/google/material-design-icons/tree/10ecc14790612ca8fd164e3f4ffe9c16fc50d5b7/symbols/web). Original view boxes are retained because upstream contains both 24-unit and 960-unit artwork.

The artwork is Copyright Google and licensed under Apache-2.0. See `material-symbols-LICENSE`.

`Symbol` selects these paths only on Android with Material You on. iOS, and Android with the switch off, keep Ardia's own symbols. Ardia's app artwork, favicons, Incognito eyes and Browse for Me glyph stay its own in both designs. The Compose screens keep `ArdiaSymbols` (`com.ardia.design`), which this manifest never writes.

After editing the manifest, run `node apps/phone/scripts/material-symbols.mjs`: it checks that every mapped symbol has its artwork and that no artwork is left unmapped, and writes nothing.
