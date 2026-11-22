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
| `apps/browser/assets/app-icon.png` | A 512 px `ictool` render, for onboarding and the check-in banner |

`python3 docs/brand/ardia/build.py` (numpy, Pillow, SciPy) builds every size into `output/brand/ardia/final/`. Where they go:

| Built file | Slot |
|---|---|
| `ntp-mark[-<colour>]-{back,front,sun}*.png` | `apps/browser/assets/`: the New Tab page, hills on the bottom edge rising from behind the bar, as three layers that rise one after another (the light hill behind, painted on under the dark one; the dark hill; the sun); one set per profile colour (green is the brand painting). `ntp-mark[-<colour>]*.png` is the whole painting the layers are cut from (not installed) |
| `new-tab-mark*.png` | `apps/browser/assets/new-tab-mark*.png`: one colour (drawn tinted), hills split and the sun cut free |
| `icon-512.png` | `extras/raycast-ardia/assets/icon.png` |
| `apple-touch-icon.png` | `apps/site/public/apple-touch-icon.png` |
| `engine/chromium/src/chrome/app/theme/chromium/mac/{app.icns,Assets.car}` (written there, from `icon-1024.png` through `actool`, 128 pt at most) | the Chromium Framework's Alerts helpers, whose icon macOS shows on every web notification and in System Settings › Notifications, both far smaller than 256 px |
| `engine/chromium/src/…/product_logo*.png`, `favicon_product.png`, `product_logo{,_animation}.svg` (written there: the flat tile at 92 % of the square, no shadow) | Chromium's `IDR_PRODUCT_LOGO_*`, `IDR_PRODUCT_FAVICON` and the framework's `Resources/product_logo_32.png`: chrome://settings/help, chrome://version, the profile picker, the task manager, the screen-share picker, payment and sign-in dialogs. Chromium's wordmarks (`product_logo_name_22*`, chrome://version's `product_logo*`) become the tile alone: Ardia has no wordmark |

The site's header icon, favicon and share image are cut from the same files (`apps/site`).

The `engine/chromium/src` files replace Chromium's own: `engine/chromium/apply.sh` copies every file there outside
`chrome/browser/ardia` over the tree's, so a change ships only after `scripts/agent/engine-build` (the paks and the
helpers are rebuilt, not the framework's binary; `release.sh` refuses a framework older than them). Commit them with
the rest of a re-run.
