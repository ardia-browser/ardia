# Naming crash and freeze frames

Mac crashes (`$exception` from `native_crash` / `helper_crash`) and `app_freeze` events send their native frames as
offsets: `Chromium Framework + 0x318e860`, `Ardia + 0x327180`. Each event also lists the UUID of every image it names
(`crash_images`, `freeze_images`). The dashboard shows a function name instead of the offset wherever that build's
symbols are published.

## How it works

1. **Symbols ship with each build.** `scripts/publish-engine.sh` uploads `ArdiaCore-<key:12>-symbols.tar.xz` and
   `-uuids.txt` to each `engine-<key:12>` release. Since #2396, `scripts/release.sh` does the same for the app
   (`Ardia-<version>-symbols.tar.xz` and `-uuids.txt` on `v<version>`). See `docs/releasing.md` › Engines.
2. **A job names the frames.** `scripts/symbolicate-frames.mjs` runs every hour (`.github/workflows/symbolicate.yml`):
   - it reads the distinct crash and freeze stacks of the last 14 days (the `reader` ClickHouse user);
   - for each image UUID it hasn't named, it finds the release whose `-uuids.txt` lists it, downloads that release's
     symbols archive and unpacks only that image's DWARF file;
   - it reads the file's Mach-O symbol table and demangles the names (`swift-demangle`, `c++filt`). There is no
     `atos`, so it runs on Linux;
   - it writes one row per frame to `sandbox.ardia_frame_symbols`: UUID, offset, image, function, offset inside the
     function, and source.
   Maps are cached per UUID (`dist/frame-symbols/maps`, gzipped, with the Actions cache keyed by their content), so a
   UUID is downloaded once and later offsets only cost a lookup. A frame named from a dSYM is named once. One with no
   symbols (`none`), outside every named function (`outside`) or named from a match map (`match`) is tried again after a
   day, so a dSYM published later replaces it.
3. **The dashboard reads the names.** Errors and Performance › Freezes look up the frames they show in
   `ardia_frame_symbols` (`apps/dashboard/src/server/frame-symbols.ts`). A named frame reads
   `MenuTarget.undoOrReopenClosedTab(_:) + 400`. An unnamed one keeps its raw offset. Hover a freeze place to see both.
   If the table is missing or ClickHouse is down, everything stays raw.

The engine's dSYMs carry function names only (`symbol_level=0`, no line tables), so names have no file and line.
For file and line in the app's own code, use `scripts/symbolicate-crash.sh` (atos) on a Mac.

## Builds without a dSYM

0.2.47 and 0.2.48 were built and published on a Mac before #2396 landed, and the build artifacts that held their
archives have expired. No dSYM exists for their `Ardia` binary (`6c57f7df…`, `723e5f9d…`).
`scripts/symbols/name-stripped-build.mjs` names such a build from the shipped binary, best evidence first:

- **`objc`**: the binary's own Objective-C class tables (`dyld_info -objc`), which give exact names;
- **`code`**: a function whose code is byte-identical (PC-relative fields masked) to exactly one function in a nearby
  build that has a dSYM, for example a CI release candidate's `build` artifact (kept 3 days);
- **`(by position)`**: changed code, named by its slot between two identical neighbours.

On 0.2.47, code matches agreed with the Objective-C names on 3,426 of the 3,427 methods both covered, ignoring category
labels (`+[ArdiaEarlyWindow pageMoved:]` vs `+[ArdiaEarlyWindow(Pages) pageMoved:]`). The one miss is a method two
classes implement with byte-identical code, and there the Objective-C name wins. The tool writes a symbol map (source
`match`); upload it to that version's release as `Ardia-<version>-symbol-map.tsv.gz` and the job picks it up:

```sh
node scripts/symbols/name-stripped-build.mjs --target <shipped Ardia.app>/Contents/MacOS/Ardia \
  --sibling <nearby Ardia.xcarchive>/Products/Applications/Ardia.app/Contents/MacOS/Ardia \
  --dsym <nearby Ardia.xcarchive>/dSYMs/Ardia.app.dSYM/Contents/Resources/DWARF/Ardia \
  --out Ardia-<version>-symbol-map.tsv.gz
gh release upload v<version> -R ardia-browser/ardia Ardia-<version>-symbol-map.tsv.gz
```

Hermes frames stay raw: no Hermes dSYM is published. Older engines (0.2.44 to 0.2.46 and early 0.2.47 nightlies)
were published without symbols, so their frames stay raw too. `docs/releasing.md` › Engines explains how to backfill one.

## Running it

```sh
set -a; . ~/.config/ardia/telemetry.env; set +a
node scripts/symbolicate-frames.mjs --dry-run              # print what it would store, write nothing
node scripts/symbolicate-frames.mjs --maps <dir of maps>   # with TRIAGE_CLICKHOUSE_PASSWORD set: write the names
node scripts/symbolicate-frames.mjs --help
```

The workflow needs three repository secrets: `TELEMETRY_CLICKHOUSE_URL` (the public ClickHouse HTTPS endpoint, as in
`~/.config/ardia/telemetry.env`), `TELEMETRY_CLICKHOUSE_READER_PASSWORD` (the `reader` user) and
`TELEMETRY_CLICKHOUSE_SANDBOX_PASSWORD` (the `sandbox` user, which can only write `sandbox.*`). Until all three are
set, it logs a notice and does nothing.

The `sandbox` user doesn't have its own password yet. `infra/telemetry/hexclave.deploy.ts` sets
`CLICKHOUSE_SANDBOX_PASSWORD`, and `infra/dashboard/hexclave.deploy.ts` sets `TRIAGE_CLICKHOUSE_PASSWORD`, both from
`TELEMETRY_CLICKHOUSE_ADMIN_PASSWORD`. So putting that value into GitHub would hand Actions the admin password. Before
enabling the workflow:
1. Create a new Hexclave secret, for example `TELEMETRY_CLICKHOUSE_SANDBOX_PASSWORD`.
2. Point both of those deploy entries at it (`SECRETS` in `infra/shared.ts`) and deploy telemetry and the dashboard.
3. Store that same value as the repository secret. The job creates the table itself. Each run's summary lists how many frames it
named by source and image, and which builds had no symbols.

Tests: `node --test scripts/symbols/symbols.test.mjs`. It covers Mach-O parsing and offset math on generated
binaries, an end-to-end run against a generated release served by a fake GitHub, and, on macOS, a real clang +
dsymutil dSYM checked against atos.
