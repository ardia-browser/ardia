# Ardia logo

Two oil-painted hills (sage `#71955A`, forest `#203F32`) under a sun (`#E6BC62`), on a parchment tile (`#F9F5E3`).
`source/` holds the three paintings, generated with Codex image generation (round 5, "hills"):
`app-icon.png` (the tile), `mark.png` (the hills alone) and `mark-small.png` (flat colours, for 16 pt).

The app icon is no longer built here. Since 2026-11-22 it is the painted icon: the oil painting mapped onto
constructed hills inside Safari's 102-unit inset, with its own light, dark (ink-green tile) and tinted layers. Its
source lives outside the repo; when it changes, the files below are exported from it by hand.

| File | What it is |
|---|---|
| `apps/browser/macos/Ardia-macOS/AppIcon.icon` | The icon, as Icon Composer layers (`<part>-light`, `-dark`, `-tinted`) |
| `apps/browser/macos/Ardia-macOS/Assets.xcassets/AppIcon.appiconset/*` | `ictool` renders of `AppIcon.icon` at each size, for an older Xcode |
| `apps/browser/macos/Ardia-macOS/Assets.xcassets/AppIcon-<id>.imageset` | The Settings › App Icon choices (midnight, daylight, plum, ocean, mono, noir): finished 512 px `ictool` renders that `packages/shell/ios/AppIcons.swift` shows as they are |
| `apps/browser/macos/Ardia-macOS/Assets.xcassets/AppIcon-<id>-flat.imageset` | The flat row of the same choices (default, midnight, daylight, plum, ocean, mono, noir): the `Final/flat/light` hills, sun and plate in each choice's colours, rendered by `ictool` from SVG layers at 1024 px and set on 512 px like the painted ones (412 px tile, a 30% black shadow blurred 7 px and dropped 3 px) |
| `apps/browser/assets/app-icon.png` | A 512 px `ictool` render, for onboarding and the check-in banner |

`python3 docs/brand/ardia/build.py` (numpy, Pillow, SciPy) builds every size into `output/brand/ardia/final/`. Where they go:

| Built file | Slot |
|---|---|
| `ntp-mark[-<colour>]-{back,front,sun}*.png` | `apps/browser/assets/`: the New Tab page, hills on the bottom edge rising from behind the bar, as three layers that rise one after another (the light hill behind, painted on under the dark one; the dark hill; the sun); one set per profile colour (green is the brand painting). `ntp-mark[-<colour>]*.png` is the whole painting the layers are cut from (not installed) |
| `new-tab-mark*.png` | `apps/browser/assets/new-tab-mark*.png`: one colour (drawn tinted), hills split and the sun cut free |
| `icon-512.png` | `extras/raycast-ardia/assets/icon.png` |
| `apple-touch-icon.png` | `apps/site/public/apple-touch-icon.png` |

The site's header icon, favicon and share image are cut from the same files (`apps/site`).

Chromium's own logos are exported by hand from the same source as the app icon: the product logo PNGs and SVGs, the
notification helper's `app.icns` and `Assets.car` in `engine/chromium/src`, and the vector glyphs and mono logo in
`engine/patches/build/ardia-icons`. `engine/chromium/apply.sh` copies the `engine/chromium/src` files over the tree's on
every engine build, so a change ships after `scripts/agent/engine-build` and needs a new engine for each platform.