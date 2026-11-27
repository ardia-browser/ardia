#!/usr/bin/env bash
set -euo pipefail

vendor="$(cd "$(dirname "$0")/.." && pwd)/vendor"

UBO_VERSION="1.77.2"
UBO_SHA256="636cfa6c640b29ab7251b765225d6c0f580bd9fe830d1319005ea7093cf4303c"
UBO_KEY="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAv1MPdIgJjIsN4Y0N/20GDNPfN4J//aknk5dsH8Y1LBxSnz3Jp/BT187Gub5cv6lee5CUVDmVBa3Yiqow8GMna5KwX+ZP+yc1pt/ewzyNxm2BzoQPgWz+1DgZaahz56/szi1EEtWVYxd3wNxFN4wPDqwV6aqlnV4R3RnxlF1ocw1kDgJ+8BxR1EY+MB+H8bymdef+xB3TNifBZIVmZt81cC3UMOG6KWRTU1wtIXsW+ZqSv5zaeFHLkjG4MPB7EfcMGrvO80ElJBZZLdrTmYOL4uUPsz2Wy6GiPWzpDmzzI9RfsZm11sLiJo63blcPF0Cz3sM0wQfxJPPcQuqkZDReswIDAQAB"
UBO_PATCH="33"
ubo="$vendor/ubo"
stamp="$UBO_VERSION-$UBO_PATCH"
installed() { [ -f "$ubo/.version" ] && [ "$(cat "$ubo/.version")" = "$stamp" ]; }
if ! installed && [ -z "${UBO_LOCKED:-}" ]; then
  mkdir -p "$ubo"
  UBO_LOCKED=1 exec lockf -k -t 600 "$ubo/.lock" "$0"
fi
if ! installed; then
  zip="$ubo/uBlock0_$UBO_VERSION.chromium.zip"
  if [ ! -f "$zip" ]; then
    url="https://github.com/gorhill/uBlock/releases/download/$UBO_VERSION/uBlock0_$UBO_VERSION.chromium.zip"
    echo "Downloading $url"
    curl -fL --retry 3 -o "$zip.part" "$url"
    mv "$zip.part" "$zip"
  fi
  echo "$UBO_SHA256  $zip" | shasum -a 256 -c -
  rm -rf "$ubo/unzip" "$ubo/ext.new" "$ubo/ext.old"
  unzip -q "$zip" -d "$ubo/unzip"
  mv "$ubo/unzip/uBlock0.chromium" "$ubo/ext.new"
  rm -rf "$ubo/unzip"
  python3 -I - "$ubo/ext.new" "$UBO_KEY" "$UBO_PATCH" <<'PY'
import json, os, sys
ext, key, level = sys.argv[1], sys.argv[2], sys.argv[3]
path = os.path.join(ext, "manifest.json")
manifest = json.load(open(path))
manifest["key"] = key
manifest["version_name"] = manifest["version"]
manifest["version"] = f"{manifest['version']}.{level}"
manifest["incognito"] = "spanning"
web = ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"]
if manifest["permissions"].count("<all_urls>") != 1:
    sys.exit("ubo.sh: manifest.json no longer asks for <all_urls>")
manifest["permissions"] = [p for p in manifest["permissions"] if p != "<all_urls>"] + web
scripts = manifest["content_scripts"]
kept = [entry for entry in scripts if entry["js"] not in (["/js/scriptlets/subscriber.js"], ["/js/scriptlets/updater.js"])]
if len(kept) != len(scripts) - 2:
    sys.exit("ubo.sh: manifest.json no longer has the subscriber and updater content scripts")
manifest["content_scripts"] = kept
storage = manifest.get("storage")
if not isinstance(storage, dict) or "managed_schema" not in storage:
    sys.exit("ubo.sh: manifest.json no longer declares storage.managed_schema")
del storage["managed_schema"]
if not storage:
    del manifest["storage"]
json.dump(manifest, open(path, "w"), indent=2)
def patch(rel, old, new):
    path = os.path.join(ext, rel)
    source = open(path).read()
    if source.count(old) != 1:
        sys.exit(f"ubo.sh: {rel} no longer has exactly one {old.strip().splitlines()[0]!r}")
    open(path, "w").write(source.replace(old, new))
patch("js/background.js", "prefetchingDisabled: true,", "prefetchingDisabled: false,")
patch("js/background.js", "    noDashboard: false,", "    noDashboard: true,")
patch("js/background.js", "    autoUpdateDelayAfterLaunch: 37,", "    autoUpdateDelayAfterLaunch: 600,")
patch("js/background.js", "    selfieDelayInSeconds: 53,", "    selfieDelayInSeconds: 3,")
patch("js/background.js", "    showIconBadge: true,", "    showIconBadge: false,")
patch("js/background.js", "    contextMenuEnabled: true,", "    contextMenuEnabled: false,")
patch("js/contextmenu.js", "    newBits |= SUBSCRIBE_TO_LIST_BIT;\n", "")
patch("js/contextmenu.js",
      "const VIEW_SOURCE_BIT            = 0b10000;\n",
      "const VIEW_SOURCE_BIT            = 0b10000;\n"
      "const ARDIA_HIDE_ELEMENT_BIT     = 0b100000;\n")
patch("js/contextmenu.js",
      "const onEntryClicked = function(details, tab) {\n",
      "chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId }) => {\n"
      "    if ( frameId === 0 && µb.ardiaHideElementFrameClick?.tabId === tabId ) {\n"
      "        µb.ardiaHideElementFrameClick = null;\n"
      "    }\n"
      "});\n"
      "\n"
      "const onEntryClicked = function(details, tab) {\n"
      "    if ( details.menuItemId === 'ardia-hideElement' ) {\n"
      "        if ( tab === undefined || /^https?:\\/\\//.test(tab.url) === false ) { return; }\n"
      "        µb.ardiaHideElementFrameClick = { tabId: tab.id, pageUrl: tab.url, frameId: details.frameId, at: Date.now() };\n"
      "        return;\n"
      "    }\n")
patch("js/contextmenu.js",
      "const menuEntries = {\n",
      "const menuEntries = {\n"
      "    ardiaHideElement: {\n"
      "        id: 'ardia-hideElement',\n"
      "        title: 'Hide Element\u2026',\n"
      "        contexts: [ 'all' ],\n"
      "        documentUrlPatterns: [ 'http://*/*', 'https://*/*' ],\n"
      "    },\n")
patch("js/contextmenu.js",
      "    if ( newBits === currentBits ) { return; }\n"
      "    currentBits = newBits;\n"
      "    const usedEntries = [];\n",
      "    newBits |= ARDIA_HIDE_ELEMENT_BIT;\n"
      "    if ( newBits === currentBits ) { return; }\n"
      "    currentBits = newBits;\n"
      "    const usedEntries = [ menuEntries.ardiaHideElement ];\n")
patch("js/vapi-background.js",
      "        let version = manifest.version_name || manifest.version;\n",
      "        let version = manifest.version;\n")
patch("js/start.js",
      "    redirectEngine.invalidateResourcesSelfie(io);\n};\n",
      "    redirectEngine.invalidateResourcesSelfie(io);\n"
      "    µb.compiledFormatChanged = true;\n"
      "    µb.selfieManager.destroy();\n"
      "};\n")
patch("js/vapi-background.js",
      "    if ( webext.storage.managed instanceof Object === false ) {\n        return {",
      "    if ( true ) {\n        return {")
patch("js/diff-updater.js",
      "const resolveURL = (path, url) => {\n",
      "const ardiaPatchAllowed = (patchPath, base, patchURL) => {\n"
      "    if ( typeof patchPath !== 'string' || /^(?:[a-z][a-z0-9+.-]*:|[\\\\/])/i.test(patchPath) ) { return false; }\n"
      "    let baseURL;\n"
      "    try { baseURL = new URL(base); } catch { return false; }\n"
      "    if ( patchURL.origin !== baseURL.origin ) { return false; }\n"
      "    const directory = baseURL.pathname.slice(0, baseURL.pathname.lastIndexOf('/') + 1);\n"
      "    const parent = directory.slice(0, directory.slice(0, -1).lastIndexOf('/') + 1) || '/';\n"
      "    return patchURL.pathname.startsWith(parent);\n"
      "};\n"
      "\n"
      "const resolveURL = (path, url) => {\n")
patch("js/diff-updater.js",
      "    const canonicalPatchURL = resolveURL(patchPath, patchURLs?.[0] || cdnURLs[0]);\n"
      "    if ( Boolean(canonicalPatchURL) === false ) { return; }\n"
      "    return canonicalPatchURL.href.replace(/#.*$/, '');\n",
      "    if ( typeof assetDetails.assetKey !== 'string' ) { return; }\n"
      "    const ardiaPatchTargets = [];\n"
      "    for ( const base of patchURLs || cdnURLs ) {\n"
      "        const patchURL = resolveURL(patchPath, base);\n"
      "        if ( patchURL === undefined ) { continue; }\n"
      "        if ( ardiaPatchAllowed(patchPath, base, patchURL) === false ) { continue; }\n"
      "        ardiaPatchTargets.push(patchURL.href.replace(/#.*$/, ''));\n"
      "    }\n"
      "    if ( ardiaPatchTargets.length === 0 ) { return; }\n"
      "    return [ assetDetails.assetKey, ...ardiaPatchTargets ].join('\\n');\n")
patch("js/diff-updater.js",
      "    return canonicalPatchURL && patches.has(canonicalPatchURL);\n",
      "    return Boolean(canonicalPatchURL) && patches.has(canonicalPatchURL);\n")
patch("js/diff-updater.js",
      "        const patchURL = resolveURL(patchPath, cdnURL);\n"
      "        if ( patchURL === undefined ) { continue; }\n",
      "        const patchURL = resolveURL(patchPath, cdnURL);\n"
      "        if ( patchURL === undefined ) { continue; }\n"
      "        if ( ardiaPatchAllowed(patchPath, cdnURL, patchURL) === false ) { continue; }\n")
patch("js/diff-updater.js",
      "        const response = await fetch(patchURL).catch(reason => {\n"
      "            console.error(reason, patchURL);\n"
      "        });\n"
      "        if ( response === undefined ) { continue; }\n"
      "        if ( response.status === 404 ) { break; }\n"
      "        if ( response.ok !== true ) { continue; }\n"
      "        const patchText = await response.text();\n",
      "        const controller = new AbortController();\n"
      "        const deadline = setTimeout(( ) => { controller.abort(); }, 30000);\n"
      "        const stop = ( ) => { clearTimeout(deadline); controller.abort(); };\n"
      "        const response = await fetch(patchURL, { signal: controller.signal, redirect: 'error' }).catch(reason => {\n"
      "            console.error(reason, patchURL);\n"
      "        });\n"
      "        const sameOrigin = response !== undefined && typeof response.url === 'string' &&\n"
      "            response.url.startsWith(patchURL.origin + '/');\n"
      "        if ( response === undefined || sameOrigin === false ) { stop(); continue; }\n"
      "        if ( response.status === 404 ) { stop(); break; }\n"
      "        if ( response.ok !== true ) { stop(); continue; }\n"
      "        const patchText = await response.text().catch(( ) => undefined);\n"
      "        clearTimeout(deadline);\n"
      "        if ( patchText === undefined ) { continue; }\n")
patch("js/storage.js",
      "            const match = /^[a-z]+/.exec(i18n.getUILanguage());\n"
      "            if ( match !== null ) {\n"
      "                re = new RegExp('\\\\b' + match[0] + '\\\\b');",
      "            const langs = new Set([ i18n.getUILanguage(), ...(self.navigator.languages || []) ]\n"
      "                .map(lang => (/^[a-z]+/.exec(lang) || [])[0]).filter(Boolean));\n"
      "            if ( langs.size !== 0 ) {\n"
      "                re = new RegExp('\\\\b(?:' + Array.from(langs).join('|') + ')\\\\b');")
patch("js/background.js", "        compiledMagic: 72,", "        compiledMagic: 173,")
patch("js/background.js", "        selfieMagic: 72,", "        selfieMagic: 173,")
for engine in ("Main", "ExtFilteringEngine", "NetFilteringEngine"):
    for call in ("toCache", "fromCache"):
        patch("js/storage.js", f"io.{call}('selfie/static{engine}'", f"io.{call}('selfie/staticArdia2{engine}'")
patch("js/storage.js",
      "            r = await Promise.all([\n"
      "                loadMain(),\n",
      "            if ( await loadMain() !== true ) { throw new Error('Filtering engine selfie main is not valid'); }\n"
      "            r = await Promise.all([\n"
      "                true,\n")
hiding_cleanup = r'''
const ardiaOldHidingRule = /^[a-z0-9.-]+##[^+^\s][^\n{}]*$/;
const ardiaOldHidingRuleLength = 1024;
const ardiaCosmeticRule = /^[^\s#]*#@?#[^+^\s]/;
const ardiaCodeFilter = /#@?#[+^]|#@?[$%]\??#/;
const ardiaCloserLine = /^(?:\*\/|[)\]"'])/;
const ardiaCodeOption = /\$(?:[^#]*,)?~?(?:redirect|redirect-rule|rewrite|replace|csp|removeparam|urlskip|uritransform|header|permissions|responseheader)(?:[=,]|$)/;

const ardiaRunsCode = part => {
    const line = part.trim();
    if ( line === '' || line.startsWith('!') ) { return false; }
    return ardiaCodeFilter.test(line) || ( line.includes('#') === false && ardiaCodeOption.test(line) );
};

const ardiaSelectorParses = selector => {
    try {
        document.createDocumentFragment().querySelector(selector);
        return true;
    } catch {
        return false;
    }
};

const ardiaSelectorOf = filter => filter.slice(filter.indexOf('##') + 2);

const ardiaStorableHidingRule = filter =>
    filter.length <= ardiaOldHidingRuleLength &&
    ardiaOldHidingRule.test(filter) &&
    ardiaSelectorParses(ardiaSelectorOf(filter));

const ardiaSelectorLeftOpen = filter => ardiaSelectorParses(ardiaSelectorOf(filter) + '##');

const ardiaPlainHidingRule = filter => ardiaStorableHidingRule(filter) && ardiaSelectorLeftOpen(filter) === false;

const ardiaOpensAcrossBreak = filter => {
    for ( let at = filter.indexOf('\r'); at !== -1; at = filter.indexOf('\r', at + 1) ) {
        if ( ardiaSelectorLeftOpen(filter.slice(0, at)) ) { return true; }
    }
    return false;
};

µb.ardiaCleanHidingRules = function(text, { countNeighbours = false } = {}) {
    const lines = text.split('\n');
    const bodyOf = line => line.endsWith('\r') ? line.slice(0, -1) : line;
    const inert = body => body.trim() === '' || body.trim().startsWith('!');
    const keepsWorking = body => inert(body) || ardiaPlainHidingRule(body.trim());
    const continues = i => i > 0 && i < lines.length && bodyOf(lines[i - 1]).endsWith(' \\') && lines[i].startsWith('    ');
    const headOf = i => {
        while ( continues(i) ) { i -= 1; }
        return i;
    };
    const logicalLine = i => {
        let at = headOf(i);
        let line = bodyOf(lines[at]);
        while ( continues(at + 1) ) {
            at += 1;
            line = line.slice(0, -2).trim() + bodyOf(lines[at]).trim();
        }
        return line;
    };
    let spans = 0;
    let disabled = 0;
    const toDisable = new Set();
    for ( let i = 0; i < lines.length; i++ ) {
        const body = bodyOf(lines[i]);
        const filter = body.trim();
        if ( filter.includes('\r') ) {
            const parts = body.split('\r');
            const opened = ardiaStorableHidingRule(filter) && ardiaOpensAcrossBreak(filter);
            const carriesCode = ardiaOldHidingRule.test(parts[0].trim()) && parts.slice(1).some(ardiaRunsCode);
            if ( opened === false && carriesCode === false ) { continue; }
            spans += 1;
            const edited = parts.map(part => {
                const off = opened ? keepsWorking(part) === false : ardiaRunsCode(part);
                if ( off === false ) { return part; }
                disabled += 1;
                return '! ' + part;
            });
            lines[i] = edited.join('\r') + lines[i].slice(body.length);
            continue;
        }
        if ( ardiaStorableHidingRule(filter) === false || ardiaSelectorLeftOpen(filter) === false ) { continue; }
        let joined = filter;
        let end = i;
        let endOpen = true;
        for ( let j = i + 1; j < lines.length; j++ ) {
            const next = bodyOf(lines[j]);
            if ( next.includes('\r') ) { break; }
            joined += '\r' + next;
            if ( joined.length > ardiaOldHidingRuleLength ) { break; }
            if ( ardiaStorableHidingRule(joined) === false ) { continue; }
            end = j;
            endOpen = ardiaSelectorLeftOpen(joined);
        }
        spans += 1;
        toDisable.add(i);
        if ( endOpen === false ) {
            for ( let j = i + 1; j <= end; j++ ) {
                const line = bodyOf(lines[j]).trim();
                if ( ardiaCloserLine.test(line) || ardiaRunsCode(logicalLine(j)) ) { toDisable.add(j); }
            }
        }
        i = end;
    }
    const heads = new Set([...toDisable].map(headOf));
    for ( const i of heads ) {
        if ( inert(bodyOf(lines[i])) ) { continue; }
        lines[i] = '! ' + lines[i];
        disabled += 1;
    }
    let neighbours = 0;
    if ( countNeighbours ) {
        const plain = new Map();
        const plainAt = i => {
            if ( i < 0 || i >= lines.length ) { return false; }
            if ( plain.has(i) === false ) { plain.set(i, ardiaPlainHidingRule(bodyOf(lines[i]).trim())); }
            return plain.get(i);
        };
        for ( let i = 0; i < lines.length; i++ ) {
            const body = bodyOf(lines[i]);
            if ( inert(body) || ardiaCosmeticRule.test(body.trim()) ) { continue; }
            if ( plainAt(i - 1) || plainAt(i + 1) ) { neighbours += 1; }
        }
    }
    return { text: lines.join('\n'), spans, disabled, neighbours };
};
'''
patch("js/storage.js",
      "µb.saveUserFilters = function(content) {\n",
      hiding_cleanup.lstrip("\n") +
      "\n"
      "let ardiaCleanupGate = Promise.resolve();\n"
      "\n"
      "const ardiaBackUpFilters = async text => {\n"
      "    const key = 'ardiaSplitHidingRulesBackups';\n"
      "    const bin = await vAPI.storage.get(key);\n"
      "    const backups = Array.isArray(bin?.[key]) ? bin[key] : [];\n"
      "    if ( backups.includes(text) ) { return true; }\n"
      "    await vAPI.storage.set({ [key]: [...backups, text] });\n"
      "    const stored = (await vAPI.storage.get(key))?.[key];\n"
      "    return Array.isArray(stored) && stored.includes(text) && backups.every(previous => stored.includes(previous));\n"
      "};\n"
      "\n"
      "const ardiaAddToCount = async (key, n) => {\n"
      "    const bin = await vAPI.storage.get(key);\n"
      "    const before = bin instanceof Object && Number.isInteger(bin[key]) ? bin[key] : 0;\n"
      "    await vAPI.storage.set({ [key]: before + n });\n"
      "};\n"
      "\n"
      "const ardiaCleanupDeadlineMs = 15000;\n"
      "\n"
      "const ardiaNoteCleanup = (neighbours, spans, disabled) => {\n"
      "    (async ( ) => {\n"
      "        const seen = await vAPI.storage.get('ardiaHidingRulesNextToScriptRules');\n"
      "        if ( seen?.ardiaHidingRulesNextToScriptRules !== neighbours ) {\n"
      "            await vAPI.storage.set({ ardiaHidingRulesNextToScriptRules: neighbours });\n"
      "        }\n"
      "        if ( spans === 0 && disabled === 0 ) { return; }\n"
      "        await ardiaAddToCount('ardiaSplitHidingRulesRemoved', spans);\n"
      "        await ardiaAddToCount('ardiaHidingRulesQuarantined', disabled);\n"
      "    })().catch(reason => ubolog(reason));\n"
      "};\n"
      "\n"
      "const ardiaCleanUserFilters = async function(cutoff) {\n"
      "    try {\n"
      "        const details = await io.get(µb.userFiltersPath);\n"
      "        if ( details instanceof Object === false || typeof details.content !== 'string' ) { return; }\n"
      "        const { text, spans, disabled, neighbours } = µb.ardiaCleanHidingRules(details.content, { countNeighbours: true });\n"
      "        if ( text === details.content ) {\n"
      "            ardiaNoteCleanup(neighbours, 0, 0);\n"
      "            return;\n"
      "        }\n"
      "        µb.selfieManager.destroy();\n"
      "        µb.removeCompiledFilterList(µb.userFiltersPath);\n"
      "        if ( await ardiaBackUpFilters(details.content) === false ) {\n"
      "            ubolog('Saved Hide Element rules could not be backed up before cleanup');\n"
      "            return;\n"
      "        }\n"
      "        if ( cutoff.passed ) {\n"
      "            ubolog('Saved Hide Element rules were left as they were: the cleanup ran out of time');\n"
      "            return;\n"
      "        }\n"
      "        await io.put(µb.userFiltersPath, text);\n"
      "        const after = await io.get(µb.userFiltersPath);\n"
      "        if ( after instanceof Object === false || after.content !== text ) {\n"
      "            ubolog('Saved Hide Element rules that need cleanup are still stored');\n"
      "            return;\n"
      "        }\n"
      "        ardiaNoteCleanup(neighbours, spans, disabled);\n"
      "        ubolog(`Commented out ${disabled} lines of ${spans} saved filters Hide Element could not have written`);\n"
      "    } catch (reason) {\n"
      "        ubolog(reason);\n"
      "    }\n"
      "};\n"
      "\n"
      "µb.ardiaRemoveSplitHidingRules = function() {\n"
      "    const cutoff = { passed: false };\n"
      "    const cleanup = ardiaCleanupGate.then(( ) => ardiaCleanUserFilters(cutoff));\n"
      "    const deadline = new Promise(resolve => {\n"
      "        setTimeout(( ) => {\n"
      "            cutoff.passed = true;\n"
      "            resolve();\n"
      "        }, ardiaCleanupDeadlineMs);\n"
      "    });\n"
      "    ardiaCleanupGate = Promise.race([ cleanup, deadline ]);\n"
      "    return ardiaCleanupGate;\n"
      "};\n"
      "\n"
      "µb.saveUserFilters = async function(content) {\n"
      "    await ardiaCleanupGate;\n")
patch("js/storage.js",
      "µb.loadUserFilters = function() {\n"
      "    return io.get(this.userFiltersPath);\n",
      "µb.loadUserFilters = async function() {\n"
      "    await ardiaCleanupGate;\n"
      "    return io.get(this.userFiltersPath);\n")
patch("js/storage.js",
      "µb.compileFilters = function(rawText, details = {}) {\n",
      "µb.compileFilters = function(rawText, details = {}) {\n"
      "    if ( details.assetKey === µb.userFiltersPath && typeof rawText === 'string' ) {\n"
      "        rawText = µb.ardiaCleanHidingRules(rawText).text;\n"
      "    }\n")
patch("js/start.js",
      "    // Prime the filtering engines before first use.\n",
      "    await µb.ardiaRemoveSplitHidingRules();\n"
      "\n"
      "    // Prime the filtering engines before first use.\n")
patch("js/make-scriptlets.js",
      "    const entry = { name: funcName, code, world: details.world ?? 'MAIN',\n"
      "        requiresTrust: details.requiresTrust === true,\n"
      "    };\n",
      "    const entry = { name: funcName, code, world: details.world ?? 'MAIN',\n"
      "        requiresTrust: details.requiresTrust === true,\n"
      "        priority: details.priority ?? 0,\n"
      "    };\n")
patch("js/make-scriptlets.js",
      "            dependencies: scriptlet.dependencies,\n"
      "            requiresTrust: scriptlet.requiresTrust === true,\n"
      "        };\n",
      "            dependencies: scriptlet.dependencies,\n"
      "            requiresTrust: scriptlet.requiresTrust === true,\n"
      "            priority: scriptlet.priority ?? 0,\n"
      "        };\n")
patch("js/make-scriptlets.js",
      "    arglists: new Map([['',0]]),\n",
      "    arglists: new Map([['',0]]),\n"
      "    priorities: new Map(),\n")
patch("js/make-scriptlets.js",
      "    const arglistIndex = worldDetails.arglists.get(arglistKey);\n",
      "    const arglistIndex = worldDetails.arglists.get(arglistKey);\n"
      "    if ( resourceEntry.priority ) {\n"
      "        worldDetails.priorities.set(arglistIndex, resourceEntry.priority);\n"
      "    }\n")
patch("js/make-scriptlets.js",
      "        content = safeReplace(content, 'self.$hasRegexes$', JSON.stringify(scriptletFromRegexes.length !== 0));\n",
      "        content = safeReplace(content, 'self.$hasRegexes$', JSON.stringify(scriptletFromRegexes.length !== 0));\n"
      "        content = safeReplace(content,\n"
      "            'self.$scriptletArglistPriorities$',\n"
      "            JSON.stringify(Object.fromEntries(worldDetails.priorities))\n"
      "        );\n")
patch("js/scriptlet.template.js",
      "    const { functionRefs } = scriptletGlobals;\n"
      "    for ( const ref of todo ) {\n",
      "    const { functionRefs } = scriptletGlobals;\n"
      "    const priorities = self.$scriptletArglistPriorities$;\n"
      "    const byPriority = (a, b) => (priorities[b] ?? 0) - (priorities[a] ?? 0);\n"
      "    for ( const ref of Array.from(todo).sort(byPriority) ) {\n")
patch("js/resources/proxy-apply.js",
      "        proxyToStringFn.nativeToString = Function.prototype.toString;\n",
      "        proxyToStringFn.nativeToString = Function.prototype.toString;\n"
      "        const reflectApply = Reflect.apply;\n"
      "        const getProto = Reflect.getPrototypeOf;\n"
      "        const setProto = Reflect.setPrototypeOf;\n"
      "        const NativeTypeError = TypeError;\n")
patch("js/resources/proxy-apply.js",
      "                return proxyToStringFn.nativeToString.call(proxied);\n"
      "            }\n"
      "        });\n",
      "                return reflectApply(proxyToStringFn.nativeToString, proxied, []);\n"
      "            },\n"
      "            setPrototypeOf(target, next) {\n"
      "                let link = next;\n"
      "                for ( let hops = 0; link !== null; hops++ ) {\n"
      "                    if ( hops === 4096 || link === proxiedToString || link === target ) {\n"
      "                        throw new NativeTypeError('Cyclic __proto__ value');\n"
      "                    }\n"
      "                    try { link = getProto(link); } catch { break; }\n"
      "                }\n"
      "                return setProto(target, next);\n"
      "            }\n"
      "        });\n")
patch("js/resources/proxy-apply.js",
      "        proxyApplyFn.isCtor = new Map();\n"
      "        proxyApplyFn.proxies = new WeakMap();\n",
      "        proxyApplyFn.isCtor = new Map();\n"
      "        proxyApplyFn.proxies = new WeakMap();\n"
      "        proxyApplyFn.reflectApply = Reflect.apply;\n"
      "        proxyApplyFn.getProto = Reflect.getPrototypeOf;\n"
      "        proxyApplyFn.setProto = Reflect.setPrototypeOf;\n"
      "        proxyApplyFn.TypeError = TypeError;\n"
      "        proxyApplyFn.cyclesBack = (next, wrapper, wrapped) => {\n"
      "            let link = next;\n"
      "            for ( let hops = 0; link !== null; hops++ ) {\n"
      "                if ( hops === 4096 || link === wrapper || link === wrapped ) { return true; }\n"
      "                try { link = proxyApplyFn.getProto(link); } catch { return false; }\n"
      "            }\n"
      "            return false;\n"
      "        };\n")
patch("js/resources/proxy-apply.js",
      "                    return proxyApplyFn.nativeToString.call(proxied);\n"
      "                }\n"
      "            });\n",
      "                    return proxyApplyFn.reflectApply(proxyApplyFn.nativeToString, proxied, []);\n"
      "                },\n"
      "                setPrototypeOf(target, next) {\n"
      "                    if ( proxyApplyFn.cyclesBack(next, proxiedToString, target) ) {\n"
      "                        throw new proxyApplyFn.TypeError('Cyclic __proto__ value');\n"
      "                    }\n"
      "                    return proxyApplyFn.setProto(target, next);\n"
      "                }\n"
      "            });\n")
patch("js/resources/proxy-apply.js",
      "    const proxyDetails = {\n"
      "        apply(target, thisArg, args) {\n"
      "            return handler(proxyApplyFn.ApplyContext.factory(target, thisArg, args));\n"
      "        }\n"
      "    };\n",
      "    const proxyDetails = {\n"
      "        apply(target, thisArg, args) {\n"
      "            return handler(proxyApplyFn.ApplyContext.factory(target, thisArg, args));\n"
      "        },\n"
      "        setPrototypeOf(target, next) {\n"
      "            if ( proxyApplyFn.cyclesBack(next, proxiedTarget, target) ) {\n"
      "                throw new proxyApplyFn.TypeError('Cyclic __proto__ value');\n"
      "            }\n"
      "            return proxyApplyFn.setProto(target, next);\n"
      "        }\n"
      "    };\n")
PY
  [ -d "$ubo/ext" ] && mv "$ubo/ext" "$ubo/ext.old"
  mv "$ubo/ext.new" "$ubo/ext"
  rm -rf "$ubo/ext.old"
  echo "$stamp" > "$ubo/.version"
fi
