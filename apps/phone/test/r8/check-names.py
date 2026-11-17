#!/usr/bin/env python3
# Usage: check-names.py <apk> [<baseline apk built without R8>]
# Checks that what Android and the JavaScript reach by name survived R8: the manifest's activities, services,
# receivers and providers, App Startup initializers, each module in packages/phone/expo-module.config.json, the
# native names the JavaScript asks for (a name no Kotlin Name(...) in packages/phone/android defines, or absent from
# the baseline too, is reported as not built for Android),
# Room's WorkDatabase_Impl with its no-argument constructor, and Expo's generated package list. Exits 1 on a loss.
# Components switched on or off by the build's ardia_sync_offered value are listed with it; their classes are still checked.
# check-names.py --self-test checks the constructor match on fixed dexdump records.
# The SDK is ANDROID_HOME (else ~/Library/Android/sdk), apkanalyzer ARDIA_APKANALYZER (else the SDK's cmdline-tools),
# and the sources ARDIA_BUILD_ROOT (else this checkout).
import json, os, re, subprocess, sys, zipfile, pathlib

def has_no_argument_constructor(section):
    return re.search(r"name\s*:\s*'<init>'\s*\n\s*type\s*:\s*'\(\)V'", section) is not None


if len(sys.argv) > 1 and sys.argv[1] == '--self-test':
    wrong = "    #0 : (in LX;)\n      name          : '<init>'\n      type          : '(Landroid/content/Context;)V'\n    #1 : (in LX;)\n      name          : 'clear'\n      type          : '()V'\n"
    right = "    #0 : (in LX;)\n      name          : '<init>'\n      type          : '()V'\n"
    assert not has_no_argument_constructor(wrong), 'a constructor with arguments and an unrelated ()V method must not pass'
    assert has_no_argument_constructor(right)
    print('self-test passed')
    sys.exit(0)

if len(sys.argv) < 2 or sys.argv[1] in ('-h', '--help'):
    print('\n'.join(line[2:] for line in open(__file__).read().splitlines()[1:11]))
    sys.exit(0 if len(sys.argv) > 1 else 64)
apk = sys.argv[1]
baseline = sys.argv[2] if len(sys.argv) > 2 else None
repo = pathlib.Path(os.environ.get('ARDIA_BUILD_ROOT') or pathlib.Path(__file__).resolve().parents[4])
sdk = pathlib.Path(os.environ.get('ANDROID_HOME') or pathlib.Path.home() / 'Library/Android/sdk')
analyzer = os.environ.get('ARDIA_APKANALYZER') or str(sdk / 'cmdline-tools/latest/bin/apkanalyzer')
if not os.access(analyzer, os.X_OK):
    sys.exit(f'no apkanalyzer at {analyzer}: install the SDK cmdline-tools or set ARDIA_APKANALYZER')
build_tools = sorted((sdk / 'build-tools').iterdir(), key=lambda path: [int(part) if part.isdigit() else part for part in re.split(r'(\d+)', path.name)])[-1]
aapt2 = build_tools / 'aapt2'

listing = subprocess.run([analyzer, 'dex', 'packages', '--defined-only', apk], capture_output=True, text=True).stdout
classes = {line.split('\t')[3] for line in listing.splitlines() if line.startswith('C') and len(line.split('\t')) >= 4}

manifest = subprocess.run([str(aapt2), 'dump', 'xmltree', '--file', 'AndroidManifest.xml', apk], capture_output=True, text=True).stdout
package = re.search(r'package="([^"]+)"', manifest).group(1)
components = []
current = None
for line in manifest.splitlines():
    tag = re.match(r'\s*E: (activity-alias|activity|service|receiver|provider|application)\b', line)
    if tag:
        current = tag.group(1)
        continue
    name = re.search(r'android:name\(0x01010003\)="([^"]+)"', line)
    if name and current:
        value = name.group(1)
        if value.startswith('.'):
            value = package + value
        if current != 'activity-alias':
            components.append((current, value))
        current = None
    target = re.search(r'android:targetActivity\(0x[0-9a-f]+\)="([^"]+)"', line)
    if target:
        components.append(('targetActivity', target.group(1) if not target.group(1).startswith('.') else package + target.group(1)))

values = subprocess.run([str(aapt2), 'dump', 'resources', apk], capture_output=True, text=True).stdout
offered_id = re.search(r'resource (0x[0-9a-f]+) bool/ardia_sync_offered', values)
if offered_id:
    offered = re.search(r'bool/ardia_sync_offered[^\n]*\n\s*\(\)\s*(true|false)', values)
    switched = []
    owner = None
    for line in manifest.splitlines():
        if re.match(r'\s*E: (activity-alias|activity|service|receiver|provider)\b', line):
            owner = None
        name = re.search(r'android:name\(0x01010003\)="([^"]+)"', line)
        if name and owner is None:
            owner = name.group(1)
        if re.search(r'android:enabled\(0x0101000e\)=@' + offered_id.group(1) + r'\b', line):
            switched.append(owner or '?')
    print(f'components switched by ardia_sync_offered ({offered.group(1) if offered else "unknown"} in this build): ' + (', '.join(item.rsplit('.', 1)[-1] for item in switched) or 'none'))
missing = [(kind, name) for kind, name in components if name not in classes]
print(f'manifest: {len(components)} named classes, {len(missing)} missing')
for kind, name in missing:
    print(f'  MISSING {kind} {name}')

config = json.loads((repo / 'packages/phone/expo-module.config.json').read_text())
modules = config['android']['modules']
absent = [m for m in modules if m not in classes]
print(f'expo modules in packages/phone: {len(modules)}, {len(absent)} missing')
for m in absent:
    print(f'  MISSING module {m}')

def dex_bytes(path):
    data = b''
    with zipfile.ZipFile(path) as archive:
        for entry in archive.namelist():
            if re.match(r'classes\d*\.dex$', entry):
                data += archive.read(entry)
    return data

strings = dex_bytes(apk)
base_strings = dex_bytes(baseline) if baseline else None
names = set()
for source in list((repo / 'packages/phone/src').rglob('*.ts')) + list((repo / 'packages/phone/src').rglob('*.tsx')):
    for found in re.findall(r'require(?:Optional)?Native(?:Module|ViewManager)(?:<[^>]*>)?\(\s*"([^"]+)"', source.read_text()):
        names.add(found)
defined = set()
for source in (repo / 'packages/phone/android/src/main').rglob('*.kt'):
    defined.update(re.findall(r'\bName\("([^"]+)"\)', source.read_text()))
built = {n for n in names if n in defined and (base_strings is None or n.encode() in base_strings)}
unnamed = sorted(n for n in built if n.encode() not in strings)
expected = sorted(names - built)
if expected:
    print(f'  not built for Android: {", ".join(expected)}')
print(f'native names the JS asks for: {len(names)}, {len(unnamed)} absent from the dex strings')
for n in unnamed:
    print(f'  ABSENT {n}')

initializers = []
lines = manifest.splitlines()
for index, line in enumerate(lines):
    if re.match(r'\s*E: meta-data\b', line):
        block = '\n'.join(lines[index:index + 4])
        value = re.search(r'android:value\(0x01010024\)="([^"]+)"', block)
        name = re.search(r'android:name\(0x01010003\)="([^"]+)"', block)
        if value and name and value.group(1) == 'androidx.startup':
            initializers.append(name.group(1))
lost = [n for n in initializers if n not in classes]
print(f'startup initializers named in the manifest: {len(initializers)}, {len(lost)} missing')
for n in lost:
    print(f'  MISSING initializer {n}')
dump = build_tools / 'dexdump'
room = 'androidx.work.impl.WorkDatabase_Impl'
constructor = False
if room in classes:
    descriptor = 'L' + room.replace('.', '/') + ';'
    with zipfile.ZipFile(apk) as archive:
        import tempfile, os
        with tempfile.TemporaryDirectory() as folder:
            for entry in archive.namelist():
                if re.match(r'classes\d*\.dex$', entry):
                    target = os.path.join(folder, entry)
                    with open(target, 'wb') as out:
                        out.write(archive.read(entry))
                    text = subprocess.run([str(dump), target], capture_output=True).stdout.decode('utf-8', 'replace')
                    start = text.find(f"Class descriptor  : '{descriptor}'")
                    if start >= 0:
                        section = text[start:text.find('Class #', start + 10)]
                        constructor = has_no_argument_constructor(section)
print(f'{room}: {"present with its no-argument constructor" if constructor else "MISSING or without <init>()"}')
lost = lost + ([] if constructor else [room])
generated = 'expo.modules.ExpoModulesPackageList'
print(f'{generated}: {"present" if generated in classes else "MISSING"}')
sys.exit(1 if missing or absent or unnamed or lost or generated not in classes else 0)
