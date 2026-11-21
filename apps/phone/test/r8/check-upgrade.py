#!/usr/bin/env python3
"""Checks that an Expo APK can take over from a Compose APK on upgrade, by name.

  apps/phone/test/r8/check-upgrade.py <compose apk> <expo apk>
  apps/phone/test/r8/check-upgrade.py --self-test

For every component the Compose manifest exports, the Expo manifest has one with the same name and kind, exported,
answering at least the same intent actions (an activity-alias counts for an activity). Each such class, or an
alias's target, is in the Expo dex under that name, so a placed widget, a pinned shortcut, a tile or a pinned share
target still resolves. Both widget receivers keep their appwidget-provider meta-data. Every launcher shortcut's
targetClass resolves. Every WorkManager worker the Compose app can have queued is in the Expo dex under its name,
and WorkManager's WorkDatabase carries the same Room identity hash in both, so jobs queued by Compose survive.
Every database and preferences name the legacy reader opens is a string in the Expo dex. Exits 1 on any miss.
"""
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

if len(sys.argv) > 1 and sys.argv[1] in ('-h', '--help'):
    print(__doc__.strip())
    sys.exit(0)

SDK = Path.home() / 'Library/Android/sdk'
TOOLS = sorted((SDK / 'build-tools').iterdir())[-1] if (SDK / 'build-tools').exists() else None
REPO = Path(__file__).resolve().parents[4]

WORKERS = ['com.ardia.sync.SyncWorker']
LEGACY_SOURCE = 'packages/phone/android/src/main/java/com/ardia/phone/PhoneLegacy.kt'


def manifest_components(text):
    package = re.search(r'package="([^"]+)"', text).group(1)
    lines = text.splitlines()
    found = []
    index = 0
    while index < len(lines):
        tag = re.match(r'(\s*)E: (activity-alias|activity|service|receiver|provider)\b', lines[index])
        if not tag:
            index += 1
            continue
        depth = len(tag.group(1))
        block = [lines[index]]
        index += 1
        while index < len(lines):
            opening = re.match(r'(\s*)E: ', lines[index])
            if opening and len(opening.group(1)) <= depth:
                break
            block.append(lines[index])
            index += 1
        head = []
        for line in block[1:]:
            if re.match(r'\s*E: ', line):
                break
            head.append(line)
        def attribute(name):
            for line in head:
                match = re.search(r'android:' + name + r'\(0x[0-9a-f]+\)=(?:"([^"]*)"|(\S+))', line)
                if match:
                    return match.group(1) if match.group(1) is not None else match.group(2)
            return None
        def qualified(value):
            return package + value if value and value.startswith('.') else value
        actions = sorted({re.search(r'="([^"]+)"', line).group(1) for i, line in enumerate(block) if 'android:name' in line and i > 0 and 'E: action' in block[i - 1]})
        providers = [re.search(r'android:resource\(0x[0-9a-f]+\)=(\S+)', ''.join(block[i:i + 3])) for i, line in enumerate(block) if 'android.appwidget.provider' in line]
        found.append({
            'kind': 'activity' if tag.group(2) == 'activity-alias' else tag.group(2),
            'alias': tag.group(2) == 'activity-alias',
            'name': qualified(attribute('name')),
            'target': qualified(attribute('targetActivity')),
            'exported': (attribute('exported') or '').lower() in ('true', '(type 0x12)0xffffffff'),
            'actions': actions,
            'widget': any(providers),
        })
    return found


def check_components(compose, expo, classes):
    problems = []
    by_name = {item['name']: item for item in expo}
    for item in compose:
        if not item['exported'] or not item['name'] or item['name'].startswith(('androidx.', 'com.google.')):
            continue
        twin = by_name.get(item['name'])
        if twin is None:
            problems.append(f"{item['kind']} {item['name']}: exported by Compose, absent from the Expo manifest")
            continue
        if twin['kind'] != item['kind']:
            problems.append(f"{item['name']}: a {item['kind']} in Compose, a {twin['kind']} in Expo")
        if not twin['exported']:
            problems.append(f"{item['name']}: exported by Compose, not by Expo")
        missing = sorted(set(item['actions']) - set(twin['actions']))
        if missing:
            problems.append(f"{item['name']}: Expo answers none of {', '.join(missing)}")
        resolved = twin['target'] if twin['alias'] else twin['name']
        if classes is not None and resolved not in classes:
            problems.append(f"{item['name']}: {resolved} is not in the Expo dex under that name")
        if item['widget'] and not twin['widget']:
            problems.append(f"{item['name']}: Expo dropped its appwidget-provider meta-data")
    return problems


def dump(tool, *args):
    return subprocess.run([str(TOOLS / tool), *args], capture_output=True).stdout.decode('utf-8', 'replace')


def dex_files(apk, folder):
    paths = []
    with zipfile.ZipFile(apk) as archive:
        for entry in archive.namelist():
            if re.match(r'classes\d*\.dex$', entry):
                path = os.path.join(folder, os.path.basename(apk) + '-' + entry)
                with open(path, 'wb') as out:
                    out.write(archive.read(entry))
                paths.append(path)
    return paths


def class_names(dexes):
    names = set()
    for path in dexes:
        for match in re.finditer(r"Class descriptor\s*:\s*'L([^;']+);'", dump('dexdump', path)):
            names.add(match.group(1).replace('/', '.'))
    return names


def identity_hashes(dexes, owner):
    prefix = "Class descriptor  : 'L" + owner.replace('.', '/')
    hashes = set()
    for path in dexes:
        text = dump('dexdump', '-d', path)
        start = text.find(prefix)
        while start >= 0:
            end = text.find('Class #', start + 10)
            hashes.update(re.findall(r'"([0-9a-f]{32})"', text[start:end if end > 0 else None]))
            start = text.find(prefix, start + 10)
    return hashes


def dex_strings(apk):
    data = b''
    with zipfile.ZipFile(apk) as archive:
        for entry in archive.namelist():
            if re.match(r'classes\d*\.dex$', entry):
                data += archive.read(entry)
    return data


def legacy_names():
    source = (REPO / LEGACY_SOURCE).read_text()
    names = set(re.findall(r'const val \w+ = "([^"$]+)"', source))
    names.update(re.findall(r'File\(dataDir, "databases/([^"$]+)"\)', source))
    keys = re.search(r'val STORE_KEYS = listOf\((.*?)\)', source, re.S)
    if keys:
        names.update(re.findall(r'"([^"$]+)"', keys.group(1)))
    return sorted(names)


def shortcut_targets(apk):
    with zipfile.ZipFile(apk) as archive:
        entries = [name for name in archive.namelist() if re.search(r'res/.*shortcuts.*\.xml$', name)]
    targets = set()
    for entry in entries:
        text = dump('aapt2', 'dump', 'xmltree', '--file', entry, apk)
        targets.update(re.findall(r'android:targetClass\(0x[0-9a-f]+\)="([^"]+)"', text))
    return targets


def self_test():
    compose = '''N: android=http://schemas.android.com/apk/res/android (line=2)
  E: manifest (line=2)
    A: package="com.ardia.browser.android" (Raw: "com.ardia.browser.android")
      E: application (line=10)
        E: activity (line=20)
          A: http://schemas.android.com/apk/res/android:name(0x01010003)=".share.ShareActivity" (Raw: ".share.ShareActivity")
          A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true
          E: intent-filter (line=21)
            E: action (line=22)
              A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.intent.action.SEND" (Raw: "android.intent.action.SEND")
        E: receiver (line=30)
          A: http://schemas.android.com/apk/res/android:name(0x01010003)=".system.SearchWidgetReceiver" (Raw: ".system.SearchWidgetReceiver")
          A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true
          E: meta-data (line=31)
            A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.appwidget.provider" (Raw: "android.appwidget.provider")
            A: http://schemas.android.com/apk/res/android:resource(0x01010025)=@0x7f150001
'''
    expo_without = compose.replace('.share.ShareActivity', '.share.PhoneShareActivity')
    expo_alias = expo_without.replace('''        E: receiver (line=30)''', '''        E: activity-alias (line=25)
          A: http://schemas.android.com/apk/res/android:name(0x01010003)=".share.ShareActivity" (Raw: ".share.ShareActivity")
          A: http://schemas.android.com/apk/res/android:targetActivity(0x01010202)=".share.PhoneShareActivity" (Raw: ".share.PhoneShareActivity")
          A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true
          E: intent-filter (line=26)
            E: action (line=27)
              A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.intent.action.SEND" (Raw: "android.intent.action.SEND")
        E: receiver (line=30)''')
    classes = {'com.ardia.browser.android.share.PhoneShareActivity', 'com.ardia.browser.android.system.SearchWidgetReceiver'}
    parsed = manifest_components(compose)
    gone = check_components(parsed, manifest_components(expo_without), classes)
    assert any('ShareActivity: exported by Compose, absent' in line for line in gone), gone
    kept = check_components(parsed, manifest_components(expo_alias), classes)
    assert kept == [], kept
    no_widget = check_components(parsed, manifest_components(expo_alias.replace('android.appwidget.provider', 'something.else')), classes)
    assert any('appwidget-provider' in line for line in no_widget), no_widget
    renamed = check_components(parsed, manifest_components(expo_alias), {'com.ardia.browser.android.share.PhoneShareActivity'})
    assert any('SearchWidgetReceiver is not in the Expo dex' in line for line in renamed), renamed
    print('self-test passed')


if len(sys.argv) > 1 and sys.argv[1] == '--self-test':
    self_test()
    sys.exit(0)

if len(sys.argv) != 3:
    print(__doc__.strip().splitlines()[2], file=sys.stderr)
    sys.exit(64)

compose_apk, expo_apk = sys.argv[1], sys.argv[2]
problems = []
compose = manifest_components(dump('aapt2', 'dump', 'xmltree', '--file', 'AndroidManifest.xml', compose_apk))
expo = manifest_components(dump('aapt2', 'dump', 'xmltree', '--file', 'AndroidManifest.xml', expo_apk))
with tempfile.TemporaryDirectory() as folder:
    expo_dex = dex_files(expo_apk, folder)
    compose_dex = dex_files(compose_apk, folder)
    classes = class_names(expo_dex)
    exported = [item for item in compose if item['exported'] and not item['name'].startswith(('androidx.', 'com.google.'))]
    print(f'exported by Compose (its own): {len(exported)}: ' + ', '.join(item['name'].rsplit('.', 1)[-1] for item in exported))
    problems += check_components(compose, expo, classes)
    expo_names = {item['name'] for item in expo}
    for target in sorted(shortcut_targets(expo_apk) | shortcut_targets(compose_apk)):
        if target not in expo_names or target not in classes:
            problems.append(f'launcher shortcut target {target} does not resolve in Expo')
    for worker in WORKERS:
        if worker not in classes:
            problems.append(f'worker {worker}, which Compose can have queued, is not in the Expo dex under its name')
    room = 'androidx.work.impl.WorkDatabase_Impl'
    old = identity_hashes(compose_dex, room)
    strings = dex_strings(expo_apk)
    lost = sorted(value for value in old if value.encode() not in strings)
    if not old or lost:
        problems.append(f'WorkDatabase identity hash unreadable in Compose or missing from Expo: {sorted(old) or "none found"}')
    else:
        print(f'WorkDatabase identity hashes the same in both: {", ".join(sorted(old))}')
compose_strings = dex_strings(compose_apk)
names = legacy_names()
for name in names:
    if name.encode() not in strings:
        problems.append(f'legacy name "{name}" is not a string in the Expo dex')
unwritten = [name for name in names if name.encode() not in compose_strings]
print(f'legacy reader names, all strings in the Expo dex unless listed below: {len(names)}')
if unwritten:
    print(f'  not strings in the Compose dex (read only if another name leads there, or written by a library): {", ".join(unwritten)}')
print(f'{len(problems)} problem(s)')
for line in problems:
    print('  ' + line)
sys.exit(1 if problems else 0)
