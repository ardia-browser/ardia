# @ardia/plugin-cli

Make, check, build, pack and release [Ardia](https://github.com/ardia-browser/ardia) plugins.

```sh
npx -p @ardia/plugin-cli create-ardia-plugin my-plugin --template ui --id @you/my-plugin
cd my-plugin && npm install
npx ardia-plugin dev
```

| Command | What it does |
| --- | --- |
| `ardia-plugin init [dir]` | Makes a plugin from a template: `ui`, `content-script`, `ai-consumer` or `sidecar`, with `plugin.json` (manifest 3) and a GitHub Release workflow |
| `ardia-plugin check [dir]` | Checks `plugin.json`, that every file it names is a regular file inside the folder (no symlinks, no `..`), and the pack's limits |
| `ardia-plugin build [dir]` | Bundles `main` and the content scripts with esbuild (IIFE, ES2022, automatic JSX from `@ardia/plugin-sdk`) |
| `ardia-plugin pack [dir]` | Checks, builds and writes a deterministic `.tar.gz` (sorted, mtime 0, owner 0) under `<name>/`, and its `.sha256` |
| `ardia-plugin dev [dir]` | Rebuilds on every save, links the folder into Ardia (`plugins-dev/<scope>__<name>.json`), asks a running Ardia to reload it and shows the plugin's log |
| `ardia-plugin release [dir]` | Checks, builds, packs each platform and publishes a GitHub Release with `gh` (`--dry-run` prints the commands) |

`dist/<file>.js` in `plugin.json` builds from `src/<file>.tsx`, `.ts`, `.jsx` or `.js`; name another source in
`package.json` under `ardiaPlugin.entries`. A pack leaves out dotfiles, `node_modules`, `src`, tests, lockfiles,
`tsconfig*.json` and source maps unless `plugin.json` names them; add your own patterns in `.ardiaignore`.

Every command takes `--json` (the result on stdout, progress on stderr) and `--quiet`.

Apache-2.0.
