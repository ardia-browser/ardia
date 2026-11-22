import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const gitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && name !== 'AC_TARGET_OS')),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
const ardia = 'engine/chromium/src/chrome/browser/ardia'
const real = [
  'engine/engine-key.sh',
  'engine/engine-key.py',
  'engine/patches/series.py',
  'engine/patches/build/pathguard.py',
  'engine/patches/build/target_config.py',
  'engine/ardiacore-linux/apply.sh',
]

const series = `# fixture series
chromium chromium-shared.patch
chromium chromium-mac-only.patch mac
chromium chromium-linux-only.patch linux

layer engine/chromium
layer engine/ardiacore mac
layer engine/ardiacore-linux linux
`

const copies = [
  ['engine/ardiacore/src/ardia/core/ac_hooks.h', 'ardia/core/ac_hooks.h'],
  ['packages/ardiacore/ios/page_script.js', 'ardia/core/page_script.js'],
  ['engine/chromium/src/chrome/app/theme/chromium/product_logo_16.png', 'chrome/app/theme/chromium/linux/product_logo_16.png'],
]

const build = `# Copyright fixture. "ac_commented_linux.cc" is a comment.

assert(is_mac || is_linux)

ardia_sources = [
  "shared.cc",
  "pip/ac_pip_mac.h",
]

if (is_mac) {
  ardia_sources += [
    "ac_external_apps.h",
    "ac_external_apps.mm",
    "ac_reauth.cc",
  ]
}

if (!is_win) {
  ardia_sources += [ "ac_local_storage.cc" ]
}

if (is_linux) {
  ardia_sources += [ "ac_external_apps_linux.cc" ]
  action("registry") {
    inputs = filter_include(ardia_sources, [ "*.cc" ])
  }
  if (use_ozone) {
    ardia_sources += [ "ac_nested_linux.cc" ]
  }
} else {
  ardia_sources += [ "ac_not_linux.cc" ]
}

if (is_mac) {
  ardia_sources += [ "both.cc" ]
} else if (is_linux) {
  ardia_sources += [
    "//chrome/browser/ardia/both.cc",
    "//chrome/browser/ardia/rooted_linux.cc",
    "//ardia/core/twice.cc",
  ]
}

source_set("ardia") {
  sources = ardia_sources
}
`

const files = {
  'engine/patches/series': series,
  'engine/patches/chromium-shared.patch': 'shared\n',
  'engine/patches/chromium-mac-only.patch': 'mac\n',
  'engine/patches/chromium-linux-only.patch': 'linux\n',
  'engine/patches/build/env.sh': 'export CHROMIUM_VERSION=1.2.3.4\n',
  'engine/patches/build/tests/test_tooling.py': 'pass\n',
  'engine/chromium/apply.sh': '#!/usr/bin/env bash\n',
  'engine/chromium/src/chrome/app/theme/chromium/product_logo_16.png': 'logo\n',
  [`${ardia}/BUILD.gn`]: build,
  [`${ardia}/shared.cc`]: 'shared\n',
  [`${ardia}/pip/ac_pip_mac.h`]: 'pip header\n',
  [`${ardia}/ac_external_apps.h`]: 'external apps header\n',
  [`${ardia}/ac_external_apps.mm`]: 'mac external apps\n',
  [`${ardia}/ac_reauth.cc`]: 'mac reauth\n',
  [`${ardia}/ac_local_storage.cc`]: 'local storage\n',
  [`${ardia}/ac_external_apps_linux.cc`]: 'linux external apps\n',
  [`${ardia}/ac_nested_linux.cc`]: 'nested linux\n',
  [`${ardia}/ac_not_linux.cc`]: 'not linux\n',
  [`${ardia}/ac_commented_linux.cc`]: 'in a comment only\n',
  [`${ardia}/both.cc`]: 'both\n',
  [`${ardia}/rooted_linux.cc`]: 'rooted linux\n',
  'engine/chromium/src/ardia/core/twice.cc': 'twice in chromium\n',
  'engine/ardiacore/src/ardia/core/twice.cc': 'twice in ardiacore\n',
  'engine/ardiacore/apply.sh': '#!/usr/bin/env bash\n',
  'engine/ardiacore/src/ardia/core/ac_hooks.h': 'hooks\n',
  'engine/ardiacore/src/ardia/core/ardiacore_engine.mm': 'mac engine\n',
  'engine/ardiacore-linux/copies.tsv': copies.map((row) => row.join('\t')).join('\n') + '\n',
  'engine/ardiacore-linux/src/ardia/linux/shell.cc': 'linux shell\n',
  'engine/ardiacore-linux/src/ardia/core/ac_linux_core.cc': 'linux core\n',
  'apps/browser/assets/offline-game/game.js': 'game\n',
  'apps/browser/assets/offline-game-pipeline/inline.py': 'inline\n',
  'packages/ardiacore/ios/page_script.js': 'page\n',
  'README.md': 'fixture\n',
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'engine-key-'))
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  for (const [path, content] of Object.entries(files)) write(path, content)
  for (const path of real) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    copyFileSync(join(repo, path), join(root, path))
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, env: gitEnv, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  const run = (args, env = {}) =>
    spawnSync(join(root, 'engine/engine-key.sh'), args, { cwd: root, env: { ...gitEnv, ...env }, encoding: 'utf8' })
  const key = (platform, ...rest) => {
    const result = run(['--platform', platform, ...rest])
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const keys = () => ({ macos: key('macos'), linux: key('linux') })
  const commit = (message = 'change') => {
    git('add', '-A')
    git('commit', '-q', '-m', message)
    return keys()
  }
  const change = (path, content) => {
    write(path, content)
    return commit(`change ${path}`)
  }
  const pathspecs = (platform) => key(platform, '--paths').split('\n')
  const dirty = (platform) => git('status', '--porcelain', '--untracked-files=all', '--', ...pathspecs(platform))
  return { root, git, run, key, keys, write, commit, change, pathspecs, dirty, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function withFixture(body) {
  return () => {
    const fx = fixture()
    try {
      body(fx)
    } finally {
      fx.cleanup()
    }
  }
}

function assertKeys(before, after, { macos, linux }) {
  assert.equal(before.macos !== after.macos, macos, `macOS key ${macos ? 'should' : 'should not'} change`)
  assert.equal(before.linux !== after.linux, linux, `Linux key ${linux ? 'should' : 'should not'} change`)
}

function moved(expected) {
  return Object.entries(expected).filter(([, value]) => value).map(([name]) => name).join(' and ') || 'neither key'
}

const cases = [
  ['a Linux-only patch', 'engine/patches/chromium-linux-only.patch', { macos: false, linux: true }],
  ['a macOS-only patch', 'engine/patches/chromium-mac-only.patch', { macos: true, linux: false }],
  ['a shared patch', 'engine/patches/chromium-shared.patch', { macos: true, linux: true }],
  ['the Linux layer', 'engine/ardiacore-linux/src/ardia/linux/shell.cc', { macos: false, linux: true }],
  ['the Linux layer apply.sh', 'engine/ardiacore-linux/apply.sh', { macos: false, linux: true }],
  ['the Linux layer copies.tsv', 'engine/ardiacore-linux/copies.tsv', { macos: false, linux: true }],
  ['the macOS layer', 'engine/ardiacore/src/ardia/core/ardiacore_engine.mm', { macos: true, linux: false }],
  ['a macOS layer file the Linux layer copies', 'engine/ardiacore/src/ardia/core/ac_hooks.h', { macos: true, linux: true }],
  ['page_script.js, which only the Linux layer copies', 'packages/ardiacore/ios/page_script.js', { macos: false, linux: true }],
  ['a logo the Linux layer copies from the shared layer', 'engine/chromium/src/chrome/app/theme/chromium/product_logo_16.png', { macos: true, linux: true }],
  ['ac_external_apps_linux.cc, built only inside is_linux', `${ardia}/ac_external_apps_linux.cc`, { macos: false, linux: true }],
  ['a unit in a block nested in is_linux', `${ardia}/ac_nested_linux.cc`, { macos: false, linux: true }],
  ['ac_external_apps.mm, built only inside is_mac', `${ardia}/ac_external_apps.mm`, { macos: true, linux: false }],
  ['a macOS-only unit without mac in its name', `${ardia}/ac_reauth.cc`, { macos: true, linux: false }],
  ['a header listed only inside is_mac, which Linux may include', `${ardia}/ac_external_apps.h`, { macos: true, linux: true }],
  ['a unit in the else of is_linux', `${ardia}/ac_not_linux.cc`, { macos: true, linux: true }],
  ['a unit inside !is_win', `${ardia}/ac_local_storage.cc`, { macos: true, linux: true }],
  ['a unit named only in a BUILD.gn comment', `${ardia}/ac_commented_linux.cc`, { macos: true, linux: true }],
  ['a shared unit', `${ardia}/shared.cc`, { macos: true, linux: true }],
  ['a unit listed relative under is_mac and from the source root under else if (is_linux)', `${ardia}/both.cc`, { macos: true, linux: true }],
  ['a unit listed from the source root only under is_linux', `${ardia}/rooted_linux.cc`, { macos: false, linux: true }],
  ['a unit a source-root path under is_linux names in two layers', 'engine/chromium/src/ardia/core/twice.cc', { macos: true, linux: true }],
  ['the BUILD.gn', `${ardia}/BUILD.gn`, { macos: true, linux: true }],
  ['the build scripts', 'engine/patches/build/env.sh', { macos: true, linux: true }],
  ['series.py, the series parser', 'engine/patches/series.py', { macos: true, linux: true }],
  ['the offline game', 'apps/browser/assets/offline-game/game.js', { macos: true, linux: true }],
  ['the offline game pipeline', 'apps/browser/assets/offline-game-pipeline/inline.py', { macos: true, linux: true }],
  ['the build scripts tests', 'engine/patches/build/tests/test_tooling.py', { macos: false, linux: false }],
  ['engine-key.py', 'engine/engine-key.py', { macos: false, linux: false }],
  ['engine-key.test.mjs', 'engine/engine-key.test.mjs', { macos: false, linux: false }],
  ['a file outside the engine', 'README.md', { macos: false, linux: false }],
]

const appendable = new Set(['engine/patches/series.py', 'engine/engine-key.py', 'engine/ardiacore-linux/apply.sh', 'engine/ardiacore-linux/copies.tsv', `${ardia}/BUILD.gn`])

for (const [name, path, expected] of cases) {
  test(
    `a change to ${name} changes ${moved(expected)}`,
    withFixture(({ root, keys, change }) => {
      const before = keys()
      const content = appendable.has(path) ? `${readFileSync(join(root, path), 'utf8')}\n` : `changed ${path}\n`
      assertKeys(before, change(path, content), expected)
    }),
  )
}

const dirtyCases = [
  ['an uncommitted edit to ac_external_apps_linux.cc', (fx) => appendFileSync(join(fx.root, ardia, 'ac_external_apps_linux.cc'), 'more\n'), { macos: false, linux: true }],
  ['an uncommitted edit to ac_external_apps.mm', (fx) => appendFileSync(join(fx.root, ardia, 'ac_external_apps.mm'), 'more\n'), { macos: true, linux: false }],
  ['an uncommitted edit to a Linux-only patch', (fx) => appendFileSync(join(fx.root, 'engine/patches/chromium-linux-only.patch'), 'more\n'), { macos: false, linux: true }],
  ['an uncommitted edit to a macOS-only patch', (fx) => appendFileSync(join(fx.root, 'engine/patches/chromium-mac-only.patch'), 'more\n'), { macos: true, linux: false }],
  ['a new untracked file in the Linux layer', (fx) => fx.write('engine/ardiacore-linux/src/ardia/linux/new.cc', 'new\n'), { macos: false, linux: true }],
  ['a new untracked file in the macOS layer', (fx) => fx.write('engine/ardiacore/src/ardia/core/new.mm', 'new\n'), { macos: true, linux: false }],
  ['an uncommitted edit to a header the Linux layer copies', (fx) => appendFileSync(join(fx.root, 'engine/ardiacore/src/ardia/core/ac_hooks.h'), 'more\n'), { macos: true, linux: true }],
  ['an uncommitted edit to page_script.js', (fx) => appendFileSync(join(fx.root, 'packages/ardiacore/ios/page_script.js'), 'more\n'), { macos: false, linux: true }],
  ['an uncommitted edit to a shared unit', (fx) => appendFileSync(join(fx.root, ardia, 'shared.cc'), 'more\n'), { macos: true, linux: true }],
  ['an uncommitted edit to engine-key.py', (fx) => appendFileSync(join(fx.root, 'engine/engine-key.py'), '\n'), { macos: false, linux: false }],
]

for (const [name, edit, expected] of dirtyCases) {
  test(
    `${name} dirties the --paths of ${moved(expected)}`,
    withFixture((fx) => {
      assert.equal(fx.dirty('macos'), '')
      assert.equal(fx.dirty('linux'), '')
      edit(fx)
      assert.equal(fx.dirty('macos') !== '', expected.macos, `macOS --paths ${expected.macos ? 'should' : 'should not'} be dirty`)
      assert.equal(fx.dirty('linux') !== '', expected.linux, `Linux --paths ${expected.linux ? 'should' : 'should not'} be dirty`)
    }),
  )
}

test(
  'a series line for one platform leaves the other platform key alone',
  withFixture(({ keys, change, root }) => {
    const before = keys()
    writeFileSync(join(root, 'engine/patches/chromium-linux-new.patch'), 'new\n')
    const linuxLine = change('engine/patches/series', series.replace('chromium chromium-linux-only.patch linux\n', 'chromium chromium-linux-only.patch linux\nchromium chromium-linux-new.patch linux\n'))
    assertKeys(before, linuxLine, { macos: false, linux: true })
    writeFileSync(join(root, 'engine/patches/chromium-mac-new.patch'), 'new\n')
    const macLine = change('engine/patches/series', readFileSync(join(root, 'engine/patches/series'), 'utf8').replace('chromium chromium-mac-only.patch mac\n', 'chromium chromium-mac-only.patch mac\nchromium chromium-mac-new.patch mac\n'))
    assertKeys(linuxLine, macLine, { macos: true, linux: false })
  }),
)

test(
  'comments and blank lines in the series change neither key, the order of shared lines changes both',
  withFixture(({ keys, change }) => {
    const before = keys()
    const commented = change('engine/patches/series', `${series}\n# another comment\n`.replace('chromium chromium-shared.patch', 'chromium chromium-shared.patch  # why'))
    assertKeys(before, commented, { macos: false, linux: false })
    const reordered = change('engine/patches/series', series.replace('layer engine/chromium\n', '').replace('chromium chromium-shared.patch\n', 'layer engine/chromium\nchromium chromium-shared.patch\n'))
    assertKeys(commented, reordered, { macos: true, linux: true })
  }),
)

test(
  'a series with CRLF line ends parses as series.py parses it, so its Linux patch stays in the Linux key',
  withFixture(({ keys, change }) => {
    const lf = keys()
    const crlf = change('engine/patches/series', series.replaceAll('\n', '\r\n'))
    assert.deepEqual(crlf, lf)
    assertKeys(crlf, change('engine/patches/chromium-linux-only.patch', 'linux, changed\n'), { macos: false, linux: true })
  }),
)

test(
  'a series series.py rejects has no key',
  withFixture(({ write, commit, run }) => {
    write('engine/patches/series', series.replace('chromium chromium-linux-only.patch linux', 'chromium chromium-linux-only.patch windows'))
    assert.throws(() => commit())
    const unknown = run(['--platform', 'macos'])
    assert.notEqual(unknown.status, 0)
    assert.match(unknown.stderr, /engine\/patches\/series is invalid: series:4: unknown platform windows/)
    write('engine/patches/series', series)
    write('engine/patches/chromium-unlisted.patch', 'unlisted\n')
    assert.throws(() => commit())
    assert.match(run(['--platform', 'linux']).stderr, /patches missing from series: chromium-unlisted\.patch/)
  }),
)

test(
  'marking a shared patch for Linux drops it from the macOS key only',
  withFixture(({ keys, change }) => {
    const before = keys()
    assertKeys(before, change('engine/patches/series', series.replace('chromium chromium-shared.patch\n', 'chromium chromium-shared.patch linux\n')), { macos: true, linux: false })
  }),
)

test(
  'the Linux layer apply.sh copies exactly what copies.tsv lists, and the Linux key covers each source',
  { skip: spawnSync('rsync', ['--version']).status !== 0 && 'needs rsync' },
  withFixture(({ root, keys, change }) => {
    const src = mkdtempSync(join(tmpdir(), 'engine-key-src-'))
    try {
      for (const [, target] of copies.filter(([source]) => source.startsWith('engine/chromium/'))) {
        mkdirSync(dirname(join(src, target)), { recursive: true })
        writeFileSync(join(src, target), 'helium\n')
      }
      const applied = spawnSync(join(root, 'engine/ardiacore-linux/apply.sh'), [], { env: { ...gitEnv, CHROMIUM_SRC: src }, encoding: 'utf8' })
      assert.equal(applied.status, 0, applied.stderr)
      const written = []
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name)
          if (statSync(path).isDirectory()) walk(path)
          else written.push(relative(src, path))
        }
      }
      walk(src)
      const own = ['ardia/linux/shell.cc', 'ardia/core/ac_linux_core.cc']
      assert.deepEqual(written.sort(), [...copies.map(([, target]) => target), ...own].sort())
      for (const [source, target] of copies) assert.equal(readFileSync(join(src, target), 'utf8'), readFileSync(join(root, source), 'utf8'))
      const listed = spawnSync(join(root, 'engine/ardiacore-linux/apply.sh'), ['--paths'], { encoding: 'utf8' })
      assert.deepEqual(listed.stdout.trim().split('\n'), copies.map(([, target]) => target))
      let before = keys()
      for (const [source] of copies) {
        const after = change(source, `${readFileSync(join(root, source), 'utf8')}more\n`)
        assert.notEqual(after.linux, before.linux, `${source} should move the Linux key`)
        before = after
      }
    } finally {
      rmSync(src, { recursive: true, force: true })
    }
  }),
)

for (const [name, line] of [
  ['a CRLF line end', 'packages/ardiacore/ios/page_script.js\tardia/core/page_script.js\r'],
  ['a third field', 'packages/ardiacore/ios/page_script.js\tardia/core/page_script.js\textra'],
  ['a path with ..', 'engine/ardiacore-linux/../../README.md\tardia/core/readme'],
  ['an absolute target', 'packages/ardiacore/ios/page_script.js\t/ardia/core/page_script.js'],
  ['a leading tab', '\tpackages/ardiacore/ios/page_script.js\tardia/core/page_script.js'],
  ['a backslash', 'engine/input\\literal.cc\tardia/core/literal.cc'],
]) {
  test(
    `copies.tsv with ${name} stops both the key and apply.sh`,
    withFixture(({ root, write, commit, run }) => {
      write('engine/ardiacore-linux/copies.tsv', `engine/ardiacore/src/ardia/core/ac_hooks.h\tardia/core/ac_hooks.h\n${line}\n`)
      assert.throws(() => commit())
      const keyed = run(['--platform', 'linux'])
      assert.notEqual(keyed.status, 0)
      assert.match(keyed.stderr, /copies\.tsv:2/)
      const listed = spawnSync(join(root, 'engine/ardiacore-linux/apply.sh'), ['--paths'], { encoding: 'utf8' })
      assert.notEqual(listed.status, 0)
      assert.match(listed.stderr, /copies\.tsv:2/)
    }),
  )
}

test('the real Linux layer names its copies only in copies.tsv', () => {
  const script = readFileSync(join(repo, 'engine/ardiacore-linux/apply.sh'), 'utf8')
  const parents = script.split('\n').filter((line) => /\$\{?here\}?\/\.\./.test(line))
  assert.deepEqual(parents, ['repo=$(cd "$here/../.." && pwd)'])
  assert.doesNotMatch(script, /packages\/ardiacore|\.\.\/ardiacore|\.\.\/chromium|page_script|ac_hooks|product_logo/)
  const table = readFileSync(join(repo, 'engine/ardiacore-linux/copies.tsv'), 'utf8').trim().split('\n')
  for (const row of table) {
    const [source] = row.split('\t')
    assert.ok(existsSync(join(repo, source)), `${source} is in copies.tsv but not in the checkout`)
  }
})

test(
  'the platforms have different keys, and macos, mac and AC_TARGET_OS name the same one',
  withFixture(({ key, run }) => {
    const macos = key('macos')
    const linux = key('linux')
    assert.match(macos, /^[0-9a-f]{40}$/)
    assert.match(linux, /^[0-9a-f]{40}$/)
    assert.notEqual(macos, linux)
    assert.equal(key('mac'), macos)
    assert.equal(run([], { AC_TARGET_OS: 'linux' }).stdout.trim(), linux)
    assert.equal(run([], { AC_TARGET_OS: 'mac' }).stdout.trim(), macos)
    assert.equal(run(['--platform=linux']).stdout.trim(), linux)
    const native = run([])
    if (process.platform === 'darwin') assert.equal(native.stdout.trim(), macos)
    if (process.platform === 'linux') assert.equal(native.stdout.trim(), linux)
    assert.notEqual(run(['--platform', 'windows']).status, 0)
    assert.notEqual(run(['--bogus']).status, 0)
    assert.equal(run(['--help']).status, 0)
    assert.match(run(['--platform', 'linux', '--help']).stdout, /--platform macos\|linux/)
  }),
)

test(
  'a commit or tree argument gives the key of that commit or tree',
  withFixture(({ key, change, git }) => {
    const first = { macos: key('macos'), linux: key('linux') }
    change('engine/patches/chromium-shared.patch', 'later\n')
    assert.equal(key('macos', 'HEAD~1'), first.macos)
    assert.equal(key('linux', 'HEAD~1'), first.linux)
    assert.equal(key('linux', git('rev-parse', 'HEAD~1^{tree}')), first.linux)
  }),
)

test(
  'a commit that lacks a key path or a copied file has no key',
  withFixture(({ git, run, write, commit }) => {
    git('rm', '-q', 'packages/ardiacore/ios/page_script.js')
    git('commit', '-q', '-m', 'no page script')
    assert.match(run(['--platform', 'linux']).stderr, /copies packages\/ardiacore\/ios\/page_script\.js, which is not there/)
    assert.equal(run(['--platform', 'macos']).status, 0)
    write('packages/ardiacore/ios/page_script.js', 'page\n')
    commit()
    git('rm', '-q', '-r', '--cached', 'apps/browser/assets/offline-game')
    git('commit', '-q', '-m', 'no game')
    const result = run(['--platform', 'macos'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /has no apps\/browser\/assets\/offline-game/)
  }),
)

test('the real checkout scopes --paths to each platform', () => {
  const pathsOf = (platform) => execFileSync(join(repo, 'engine/engine-key.sh'), ['--platform', platform, '--paths'], { encoding: 'utf8' }).trim().split('\n')
  const macos = pathsOf('macos')
  const linux = pathsOf('linux')
  for (const specs of [macos, linux]) {
    assert.deepEqual(specs.slice(0, 3), ['engine', 'apps/browser/assets/offline-game', 'apps/browser/assets/offline-game-pipeline'])
    assert.ok(specs.includes(':(exclude,glob)engine/engine-key.*'))
  }
  assert.ok(macos.includes(':(exclude)engine/ardiacore-linux'))
  assert.ok(macos.includes(`:(exclude)${ardia}/ac_external_apps_linux.cc`))
  assert.ok(macos.includes(':(exclude)engine/patches/chromium-linux-window-state.patch'))
  assert.ok(!macos.includes('packages/ardiacore/ios/page_script.js'))
  assert.ok(linux.includes('packages/ardiacore/ios/page_script.js'))
  assert.ok(linux.includes(`:(exclude)${ardia}/ac_external_apps.mm`))
  assert.ok(linux.includes(':(exclude)engine/patches/chromium-window-hosted-mac.patch'))
  assert.ok(!linux.includes(':(exclude)engine/ardiacore'))
  assert.ok(!linux.some((spec) => spec === ':(exclude)engine/ardiacore/src/ardia/core/ac_hooks.h' || spec === ':(exclude)engine/ardiacore/src/ardia/core' || spec === ':(exclude)engine/ardiacore/src'))
  assert.ok(linux.includes(':(exclude)engine/ardiacore/apply.sh'))
  assert.ok(!linux.includes(`:(exclude)${ardia}/ac_external_apps.h`))
})

test('every workflow names the platform of each engine key it computes', () => {
  const dir = join(repo, '.github/workflows')
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.yml'))) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (line.includes('$(engine/engine-key.sh')) assert.match(line, /engine\/engine-key\.sh --platform (macos|linux)/, `${name}: ${line.trim()}`)
    }
  }
})

function rows(table) {
  return readFileSync(join(repo, table), 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('\t'))
}

for (const table of ['packages/ardiacore/prebuilt-engines.tsv', 'packages/ardiacore/prebuilt-engines-linux.tsv']) {
  test(`${table} rows are key, tag, SHA-256 and an optional built key, each key once`, () => {
    const seen = new Set()
    for (const fields of rows(table)) {
      assert.ok(fields.length === 3 || fields.length === 4, fields.join('\t'))
      const [key, tag, sha, built] = fields
      assert.match(key, /^[0-9a-f]{40}$/)
      assert.match(tag, /^(engine-[0-9a-f]{12}|\d+\.\d+\.\d+(-nightly\.\d+)?)$/)
      assert.match(sha, /^[0-9a-f]{64}$/)
      if (built !== undefined) {
        assert.match(built, /^[0-9a-f]{40}$/)
        assert.notEqual(built, key)
        if (tag.startsWith('engine-')) assert.equal(tag, `engine-${built.slice(0, 12)}`)
      } else if (tag.startsWith('engine-')) {
        assert.equal(tag, `engine-${key.slice(0, 12)}`)
      }
      assert.ok(!seen.has(key), `${key} is listed twice`)
      seen.add(key)
    }
  })
}

const shasum = spawnSync('shasum', ['--version']).status === 0
const xz = spawnSync('xz', ['--version']).status === 0

test(
  'the macOS fetch-engine.sh downloads the archive a row names by its built key',
  { skip: !(shasum && xz) && 'needs shasum and xz' },
  withFixture(({ root, key, git }) => {
    const script = 'packages/ardiacore/scripts/fetch-engine.sh'
    mkdirSync(join(root, 'packages/ardiacore/scripts'), { recursive: true })
    copyFileSync(join(repo, script), join(root, script))
    writeFileSync(join(root, '.gitignore'), 'apps/browser/build-ardiacore/\n')
    const built = 'f'.repeat(40)
    const tag = `engine-${built.slice(0, 12)}`
    const assets = `${root}-assets`
    const framework = join(assets, 'pack', 'Chromium Framework.framework', 'Versions', 'Current')
    mkdirSync(framework, { recursive: true })
    writeFileSync(join(framework, 'Chromium Framework'), 'engine')
    mkdirSync(join(assets, tag), { recursive: true })
    const archive = join(assets, tag, `ArdiaCore-${built.slice(0, 12)}.tar.xz`)
    execFileSync('tar', ['-cJf', archive, '-C', join(assets, 'pack'), 'Chromium Framework.framework'])
    const sha = createHash('sha256').update(readFileSync(archive)).digest('hex')
    const macos = key('macos')
    writeFileSync(join(root, 'packages/ardiacore/prebuilt-engines.tsv'), `# fixture\n${macos}\t${tag}\t${sha}\t${built}\n`)
    git('add', '-A')
    git('commit', '-q', '-m', 'table')
    const fetch = (env = {}) => spawnSync(join(root, script), [], { cwd: root, env: { ...gitEnv, ARDIACORE_PREBUILT_REPO: 'invalid/invalid', ...env }, encoding: 'utf8' })
    try {
      const fetched = fetch({ ARDIACORE_PREBUILT_ASSETS: `file://${assets}` })
      assert.equal(fetched.status, 0, fetched.stderr)
      assert.equal(fetched.stdout.trim(), join(root, 'apps/browser/build-ardiacore/prebuilt', macos.slice(0, 12), 'Chromium Framework.framework'))
      appendFileSync(join(root, ardia, 'ac_external_apps_linux.cc'), 'uncommitted\n')
      const dirtyLinux = fetch()
      assert.equal(dirtyLinux.status, 0, dirtyLinux.stderr)
      appendFileSync(join(root, ardia, 'ac_external_apps.mm'), 'uncommitted\n')
      const dirtyMac = fetch()
      assert.notEqual(dirtyMac.status, 0)
      assert.match(dirtyMac.stderr, /ac_external_apps\.mm \(in the macOS engine key\) have uncommitted changes/)
    } finally {
      rmSync(assets, { recursive: true, force: true })
    }
  }),
)

test(
  'a layer copy of a foreign GN unit stays in --paths for that platform',
  withFixture(({ root, key, pathspecs, dirty, git }) => {
    const borrowed = `${ardia}/ac_external_apps.mm`
    appendFileSync(join(root, 'engine/ardiacore-linux/copies.tsv'), `${borrowed}\tborrowed/ac_external_apps.mm\n`)
    git('add', '-A')
    git('commit', '-q', '-m', 'copy foreign unit')
    const before = key('linux')
    const linuxPaths = pathspecs('linux')
    assert.ok(!linuxPaths.includes(`:(exclude)${borrowed}`), linuxPaths.join('\n'))
    appendFileSync(join(root, borrowed), 'edit\n')
    assert.match(dirty('linux'), /ac_external_apps\.mm/)
    git('add', '-A')
    git('commit', '-q', '-m', 'edit borrowed unit')
    assert.notEqual(key('linux'), before)
  }),
)
