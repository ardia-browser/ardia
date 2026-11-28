#!/usr/bin/env python3
"""Packs a builder's series base into the archive series-zero-fuzz.py checks the series against, and publishes it.

  series-base-pack.py pack --platform linux|mac [--cpu CPU] [--base DIR] [--src DIR] [--dest DIR] [--no-verify]
  series-base-pack.py extend --platform linux|mac [--cpu CPU] [--archive ARCHIVE | --cache DIR] [--src DIR] [--dest DIR]
  series-base-pack.py publish ARCHIVE [--repo OWNER/NAME]

pack runs on the builder, read-only on its tree. It takes from the series base (AC_SERIES_BASE, default
~/chromium-build/series-base for mac/arm64 and ~/chromium-build/series-base-<os>-<cpu> otherwise) only the files the
platform's series needs and writes series-base-<chromium>-<helium12>-<platform>-<helium-platform12>-<cpu>-<inputs12>-
<rev12>.tar.xz into --dest (default: a new temporary directory), with its .sha256 and its manifest. inputs12 is the
digest of what step 3 reads from this checkout (its scripts, helium-pins.ini, env.sh and every source
ardia_resources.txt names), so a change to any of them needs a new base. rev12 is the digest of the files the archive
holds, so a re-pack after capture-base gets a new name, and the old archive stays for the checkouts that pin it.

Before packing it checks, and records in the manifest, that:
- chrome/VERSION is the pinned Chromium;
- both Helium checkouts beside the tree exist, are clean and sit at the pinned commits;
- the tree's step-3 marker shows every mutating stage for this platform;
- every resource ardia_resources.txt names is byte for byte in the base, or in the tree when the series doesn't
  touch it;
- ardia_namesub.py --check-only finds no Helium left in the tree's strings;
- `series.py check` reproduces the tree from the base.
Changes to 03-helium.py's logic or domsub-keep-store.txt can't be read back from a tree. The input digest still
forces a re-pack for them, after the builders' trees run step 3 again. --no-verify skips the checks, and publish
refuses its archive. A file the series needs that the base lacks stops it: run `series.py capture-base` first, or, for
a file a patch renames, copies or only changes the mode of (capture-base doesn't record those), copy it into the
base from a tree step 3 just left.

extend runs on the builder, read-only on its tree, when a series change starts reading files the pinned archive
lacks (a patch for a file no earlier step touched). It packs a new archive: the pinned one (its sha256 checked against
series-bases.tsv on a private copy, from --archive or the one series-zero-fuzz.py cached in --cache, default
$XDG_CACHE_HOME/ardia/series-base) plus each
missing file as step 3 leaves it, which for these files is Chromium's own at the pinned tag. It takes a file only when
step 3 can't have changed it:
- no stage selects it: its name doesn't end in grd, grdp or xtb, in any case (the name substitution, translation and
  branding passes rewrite every such file), it isn't chrome/VERSION (the version stage) or a file 03-helium.py's
  FIXUPS edits, and no Helium patch, domain_substitution.list, pruning.list or resource list at the pinned Helium
  commits (read from git, so a sparse or edited checkout can't hide one), nor ardia_resources.txt, names it;
- Chromium's repository tracks it as a regular file at the pinned tag's commit (resolved on chromium.googlesource.com),
  which must be the tree's HEAD, and the bytes and mode come from that commit (git replacement refs ignored);
- the archive doesn't already hold it or record it as absent;
- the tree holds the same bytes and mode (a difference means something touched it: re-pack).
Any other file stops it with the reason: re-pack that one from a fresh step-3 run. The new archive keeps the pinned
archive's provenance and records each added file under "extensions", with the tag commit; publish it as usual.

publish runs where gh is signed in. It creates the prerelease series-base-<chromium>-<helium12> if needed, uploads
the archive, its .sha256 and manifest (each one already there must match; an archive of the same files packed
again keeps the one published), and writes the archive's row into scripts/engine/series-bases.tsv in place of the
row for the same pins, for you to commit.
"""

import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import series_base  # noqa: E402


default_base = series_base.default_base
default_src = series_base.default_src


def version_of(text):
    parts = dict(line.split("=", 1) for line in text.split() if "=" in line)
    return ".".join(parts.get(key, "") for key in ("MAJOR", "MINOR", "BUILD", "PATCH"))


def tree_version(src):
    return version_of(pathlib.Path(src, "chrome/VERSION").read_text())


def git_head(path):
    result = subprocess.run(["git", "-C", path, "rev-parse", "HEAD"], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


VERIFIED = series_base.VERIFIED


def run_checked(command, what, env=None):
    result = subprocess.run(command, env=env, capture_output=True, text=True)
    if result.returncode:
        print((result.stdout + result.stderr).strip()[-4000:], file=sys.stderr)
        series_base.die(what)
    return (result.stdout + result.stderr).strip().splitlines()[-1:] or [""]


def verify_helium(checkout, pinned, key):
    if not os.path.isdir(os.path.join(checkout, ".git")) and not os.path.isfile(os.path.join(checkout, ".git")):
        series_base.die(f"no git checkout at {checkout}: the base can't be tied to the {key} pin")
    head = git_head(checkout)
    if head != pinned:
        series_base.die(f"{checkout} is at {head}, but helium-pins.ini pins {pinned}")
    dirty = subprocess.run(["git", "-C", checkout, "status", "--porcelain", "--ignored=no"], capture_output=True,
                           text=True).stdout.strip()
    if dirty:
        series_base.die(f"{checkout} has changes git doesn't record at {pinned[:12]}:\n{dirty[:2000]}")


def verify_stages(src, platform):
    marker = pathlib.Path(os.path.dirname(src), f".helium-stages-{os.path.basename(src)}")
    if not marker.is_file():
        series_base.die(f"no {marker}: step 3 never ran on {src}")
    tokens = marker.read_text().split()
    if tokens[:1] != [f"tree-inode={os.stat(src).st_ino}"]:
        series_base.die(f"{marker} belongs to another tree ({(tokens or ['nothing'])[0]}, {src} is "
                        f"inode {os.stat(src).st_ino}): run step 3 on this tree")
    recorded = set(tokens[1:])
    missing = [stage for stage in series_base.STEP3_STAGES if stage not in recorded]
    if missing or f"platform={platform}" not in recorded:
        series_base.die(f"{marker} doesn't show a whole step 3 for {platform} (missing {missing or ['platform=' + platform]})")


def verify_step3_stamp(src, platform, inputs):
    stamp_file = series_base.step3_stamp(src)
    if not stamp_file.is_file():
        series_base.die(f"no {stamp_file}: step 3 didn't run on {src} through scripts/engine/run-step3.py, so what it "
                        "read is unknown; run it on a fresh tree")
    try:
        stamp = json.loads(stamp_file.read_text())
    except ValueError as error:
        series_base.die(f"{stamp_file} is unreadable: {error}")
    marker = series_base.stage_marker(src)
    expected = {"state": "complete", "tree_inode": os.stat(src).st_ino, "platform": platform,
                "marker_sha256": series_base.sha256_file(marker) if marker.is_file() else None}
    wrong = [f"{key} is {stamp.get(key)!r}, not {value!r}" for key, value in expected.items() if stamp.get(key) != value]
    if wrong:
        series_base.die(f"{stamp_file} doesn't describe this tree's finished step 3: " + "; ".join(wrong))
    if stamp.get("inputs") != inputs:
        series_base.die(f"step 3 ran on {src} with inputs {str(stamp.get('inputs'))[:12]}, but this checkout's are "
                        f"{inputs[:12]}: run step 3 again on a fresh tree with these inputs, then step 4")
    if not stamp.get("run"):
        series_base.die(f"{stamp_file} has no run id: run step 3 again through run-step3.py on a fresh tree")
    return stamp, series_base.sha256_file(stamp_file)


def verify_capture(base, stamp_sha, snapshot):
    record_file = pathlib.Path(base, series_base.CAPTURE_RECORD)
    if not record_file.is_file():
        series_base.die(f"no {record_file}: capture the base with scripts/engine/run-capture.py after run-step3.py")
    try:
        record = json.loads(record_file.read_text())
    except ValueError as error:
        series_base.die(f"{record_file} is unreadable: {error}")
    if record.get("step3_stamp_sha256") != stamp_sha:
        series_base.die(f"{record_file} was recorded for another step 3 run than this tree's stamp: set the base aside "
                        "and run run-capture.py again")
    recorded = record.get("files", {})
    present = series_base.snapshot_hashes(snapshot)
    changed = sorted(path for path in set(recorded) | set(present) if recorded.get(path) != present.get(path))
    if changed:
        series_base.die(f"{len(changed)} files in {base} aren't what run-capture.py captured, in content or mode (e.g. "
                        f"{changed[0]}): set the base aside and run run-capture.py again")
    return series_base.sha256_file(record_file)


def verify_resources(src, snapshot):
    wrong = []
    for source, dest in series_base.resource_pairs():
        expected = (series_base.REPO / source).read_bytes()
        if dest in snapshot:
            actual, where = snapshot[dest][0], "base"
        else:
            in_tree = pathlib.Path(src, dest)
            actual, where = (in_tree.read_bytes() if in_tree.is_file() else None), "tree"
        if actual != expected:
            wrong.append(f"{dest} ({where}) isn't {source}")
    if wrong:
        series_base.die("step 3 ran with other resources than this checkout's ardia_resources.txt names:\n  " +
                        "\n  ".join(wrong))


def verify_tree(ident, src, base, platform, cpu, snapshot):
    version = tree_version(src)
    if version != ident["chromium"]:
        series_base.die(f"{src} is Chromium {version}, but the pins say {ident['chromium']}")
    helium_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(src))))
    helium = os.path.join(helium_root, "helium")
    for name, key in (("helium", "helium_chromium"), (series_base.PLATFORM_HELIUM[platform], "helium_platform")):
        verify_helium(os.path.join(helium_root, name), ident[key], key)
    verify_stages(src, platform)
    stamp, stamp_sha = verify_step3_stamp(src, platform, ident["inputs"])
    capture_sha = verify_capture(base, stamp_sha, snapshot)
    verify_resources(src, snapshot)
    marker = pathlib.Path(base, ".ardia-series-target")
    if marker.exists() and json.loads(marker.read_text()) != {"platform": platform, "cpu": cpu}:
        series_base.die(f"{base} is the base for {marker.read_text().strip()}, not {platform}/{cpu}")
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    last = run_checked([sys.executable, str(series_base.BUILD / "ardia_namesub.py"), "--tree", src, "--helium", helium,
                        "--check-only"], "ardia_namesub.py --check-only finds Helium left in the tree's strings", env)
    print(f"brand-namesub: {last[0]}")
    verify_helium(helium, ident["helium_chromium"], "helium_chromium")
    env = dict(os.environ, CHROMIUM_SRC=src, AC_SERIES_BASE=base)
    last = run_checked([sys.executable, str(series_base.REPO / "engine/patches/series.py"), "check", "--platform",
                        platform, "--cpu", cpu], "series.py check doesn't reproduce the tree from this base", env)
    print(f"series.py check: {last[0]}")
    return list(VERIFIED), {"step3_run": stamp["run"], "step3_stamp_sha256": stamp_sha, "capture_sha256": capture_sha}


def source_commit():
    head = git_head(str(series_base.REPO)) if (series_base.REPO / ".git").exists() else None
    beside = pathlib.Path(str(series_base.REPO) + ".commit")
    return head or (beside.read_text().strip() if beside.exists() else "")


def cmd_pack(args):
    cpu = args.cpu or series_base.DEFAULT_CPU[args.platform]
    ident = series_base.identity(args.platform, cpu)
    base = os.path.abspath(args.base or default_base(args.platform, cpu))
    src = os.path.abspath(args.src or default_src())
    if not os.path.isdir(base):
        series_base.die(f"no series base at {base}: run `series.py capture-base --platform {args.platform}` on a tree "
                        "Helium and the branding just left (docs/engine-build.md)")
    series = series_base.load_series()
    steps = series.read_series(args.platform)
    required, optional = series_base.base_paths(steps)
    paths = set(required) | set(optional)
    snapshot = series_base.snapshot_base(base)
    verified, provenance = ([], None) if args.no_verify else verify_tree(ident, src, base, args.platform, cpu, snapshot)
    missing = sorted(path for path in required if path not in snapshot)
    if missing:
        for path in missing:
            print(f"error: {path} (changed by {required[path]}) isn't in {base}", file=sys.stderr)
        series_base.die(f"the base lacks {len(missing)} files the series changes: run `series.py capture-base "
                        f"--platform {args.platform}` first")
    commit = source_commit()
    dest = os.path.abspath(args.dest or tempfile.mkdtemp(prefix="ac-series-base-"))
    os.makedirs(dest, exist_ok=True)
    fields = dict(ident, verified=verified, provenance=provenance, series_commit=commit,
                  packed_at=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                  steps=len(steps))
    manifest, out = series_base.write_tarball(snapshot, paths, fields, dest)
    if series_base.snapshot_base(base) != snapshot:
        os.unlink(out)
        series_base.die(f"{base} changed while it was being packed: pack it again")
    digest = series_base.sha256_file(out)
    pathlib.Path(out + ".sha256").write_text(f"{digest}  {os.path.basename(out)}\n")
    pathlib.Path(out + ".manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    print(f"packed {len(manifest['files'])} files ({len(manifest['absent'])} layer paths absent from the base)")
    print(out)
    print("\t".join([ident[key] for key in series_base.IDENTITY] + [series_base.tag_name(ident), os.path.basename(out),
                                                                   digest]))


def pinned_git(checkout, *args, text=True):
    return subprocess.run(["git", "--no-replace-objects", "-C", checkout, *args], capture_output=True, text=text)


def head_blob(src, path, commit="HEAD"):
    listed = pinned_git(src, "ls-tree", commit, "--", path)
    fields = listed.stdout.split()
    if listed.returncode or len(fields) < 4 or fields[1] != "blob" or fields[3] != path or \
            fields[0] not in ("100644", "100755"):
        return None
    blob = pinned_git(src, "cat-file", "blob", fields[2], text=False)
    if blob.returncode:
        return None
    return blob.stdout, 0o755 if fields[0] == "100755" else 0o644


HELIUM_LISTINGS = ("domain_substitution.list", "pruning.list", "resources/helium_resources.txt",
                   "resources/generate_resources.txt")
STEP3_REWRITES_EVERY = ("grd", "grdp", "xtb")
CHROMIUM_REMOTE = "https://chromium.googlesource.com/chromium/src"


def step3_named_files():
    spec = importlib.util.spec_from_file_location("helium_step3", series_base.BUILD / "03-helium.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return {"chrome/VERSION"} | {rel for rel, _, _ in module.FIXUPS}


def tag_commit(version, remote=CHROMIUM_REMOTE):
    listed = subprocess.run(["git", "ls-remote", remote, f"refs/tags/{version}", f"refs/tags/{version}^{{}}"],
                            capture_output=True, text=True, timeout=120)
    refs = dict(reversed(line.split("\t", 1)) for line in listed.stdout.splitlines() if "\t" in line)
    commit = refs.get(f"refs/tags/{version}^{{}}") or refs.get(f"refs/tags/{version}")
    if listed.returncode or not commit:
        raise series_base.Problem(f"couldn't resolve Chromium's tag {version} on {remote}")
    return commit


def helium_mentions(helium_checkouts, path):
    mentions = []
    for checkout, commit in helium_checkouts:
        listed = pinned_git(checkout, "ls-tree", "-r", "--name-only", commit)
        if listed.returncode:
            raise series_base.Problem(f"can't list {checkout} at {commit}: {listed.stderr.strip()}")
        names = listed.stdout.splitlines()
        selectors = [name for name in names if name in HELIUM_LISTINGS or name.startswith("patches/")]
        for name in selectors:
            shown = pinned_git(checkout, "show", f"{commit}:{name}", text=False)
            if shown.returncode:
                raise series_base.Problem(f"can't read {name} at {commit} in {checkout}")
            text = shown.stdout.decode(errors="replace")
            if path in text:
                mentions.append(f"{os.path.basename(checkout)}/{name}")
    resources = series_base.BUILD / "ardia_resources.txt"
    if resources.is_file() and path in resources.read_text(errors="replace"):
        mentions.append("ardia_resources.txt")
    return mentions


def pristine_extensions(src, helium_checkouts, paths, commit, absent=(), named=None):
    named = step3_named_files() if named is None else named
    extensions, problems = {}, []
    for path in paths:
        if not series_base.safe_relative(path):
            problems.append(f"{path!r} isn't a safe relative path")
            continue
        if path in absent:
            problems.append(f"{path}: the pinned archive records it as absent from the base")
            continue
        if path.lower().endswith(STEP3_REWRITES_EVERY) or path in named:
            problems.append(f"{path}: a step-3 stage rewrites it")
            continue
        mentions = helium_mentions(helium_checkouts, path)
        if mentions:
            problems.append(f"{path}: step 3 may change it ({', '.join(mentions)} names it)")
            continue
        blob = head_blob(src, path, commit)
        if blob is None:
            problems.append(f"{path}: Chromium's own repository doesn't track it as a regular file at {commit} "
                            "(a file of a DEPS checkout, or a new one)")
            continue
        target = os.path.join(src, path)
        if os.path.islink(target) or not os.path.isfile(target):
            problems.append(f"{path}: the tree holds no regular file there")
            continue
        if (pathlib.Path(target).read_bytes(), series_base.normal_mode(os.stat(target).st_mode)) != blob:
            problems.append(f"{path}: the tree's file isn't Chromium's at the tag (something changed it, or it holds "
                            "an edit)")
            continue
        extensions[path] = blob
    if problems:
        raise series_base.Problem("these files can't be added from Chromium's tag, so re-pack the base from a fresh "
                                  "step-3 run (docs/engine-build.md, \"The series base archive\"):\n  " +
                                  "\n  ".join(problems))
    return extensions


def extend_archive(archive, extensions, dest, origin, series_commit):
    with tempfile.TemporaryDirectory(prefix="ac-series-extend-") as scratch:
        manifest = series_base.extract(archive, scratch)
        snapshot = series_base.snapshot_base(scratch)
    overlap = sorted(set(extensions) & (set(snapshot) | set(manifest["absent"])))
    if overlap:
        raise series_base.Problem(f"{archive} already holds {overlap[0]}, or records it as absent")
    snapshot.update(extensions)
    fields = {key: value for key, value in manifest.items() if key not in ("format", "files", "absent")}
    added = [{"path": path, "sha256": hashlib.sha256(data).hexdigest(), "origin": origin}
             for path, (data, _) in sorted(extensions.items())]
    fields["extensions"] = sorted(manifest.get("extensions", []) + added, key=lambda entry: entry["path"])
    fields["extended_from"] = {"asset": os.path.basename(archive), "sha256": series_base.sha256_file(archive)}
    fields["series_commit"] = series_commit
    fields["extended_at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    paths = set(manifest["files"]) | set(manifest["absent"]) | set(extensions)
    extended, out = series_base.write_tarball(snapshot, paths, fields, dest)
    try:
        with tempfile.TemporaryDirectory(prefix="ac-series-extended-") as check:
            series_base.extract(out, check)
    except series_base.Problem:
        os.unlink(out)
        raise
    return extended, out


def pinned_archive(ident, given, private, cache=None):
    row = series_base.find_row(ident)
    if row is None:
        series_base.die(f"no series-bases.tsv row for {ident['platform']}/{ident['cpu']} at these pins: re-pack instead")
    source = pathlib.Path(given) if given else pathlib.Path(cache or series_base.default_cache()) / row["asset"]
    if not source.is_file():
        series_base.die(f"{row['asset']} isn't cached: run scripts/engine/series-zero-fuzz.py once, or pass --archive")
    copy = pathlib.Path(private, row["asset"])
    shutil.copyfile(source, copy)
    if series_base.sha256_file(copy) != row["sha256"]:
        series_base.die(f"{source} isn't the archive series-bases.tsv pins ({row['asset']}, sha256 {row['sha256']})")
    return str(copy)


def cmd_extend(args):
    cpu = args.cpu or series_base.DEFAULT_CPU[args.platform]
    ident = series_base.identity(args.platform, cpu)
    src = os.path.abspath(args.src or default_src())
    private = tempfile.mkdtemp(prefix="ac-series-pinned-")
    try:
        archive = pinned_archive(ident, args.archive, private, args.cache)
        manifest = series_base.read_manifest(archive)
        series_base.require_provenance(manifest, archive)
        for key in series_base.IDENTITY:
            if manifest.get(key) != ident[key]:
                series_base.die(f"{archive} is for {key} {manifest.get(key)}, not {ident[key]}")
        if tree_version(src) != ident["chromium"]:
            series_base.die(f"{src} is Chromium {tree_version(src)}, but the pins say {ident['chromium']}")
        commit = tag_commit(ident["chromium"])
        head = pinned_git(src, "rev-parse", "HEAD").stdout.strip()
        if head != commit:
            series_base.die(f"{src}'s HEAD is {head}, not Chromium {ident['chromium']}'s tag commit {commit}")
        helium_root = os.path.dirname(os.path.dirname(os.path.dirname(src)))
        checkouts = [(os.path.join(helium_root, "helium"), ident["helium_chromium"]),
                     (os.path.join(helium_root, series_base.PLATFORM_HELIUM[args.platform]), ident["helium_platform"])]
        for (checkout, pinned), key in zip(checkouts, ("helium_chromium", "helium_platform")):
            verify_helium(checkout, pinned, key)
        steps = series_base.load_series().read_series(args.platform)
        required, _ = series_base.base_paths(steps)
        missing = sorted(path for path in required if path not in manifest["files"])
        if not missing:
            series_base.die(f"{os.path.basename(archive)} already holds every file the series changes: nothing to add")
        for path in missing:
            print(f"adding {path} (changed by {required[path]})")
        extensions = pristine_extensions(src, checkouts, missing, commit, manifest["absent"])
        dest = os.path.abspath(args.dest or tempfile.mkdtemp(prefix="ac-series-base-"))
        os.makedirs(dest, exist_ok=True)
        extended, out = extend_archive(archive, extensions, dest, f"chromium {commit}", source_commit())
        digest = series_base.sha256_file(out)
        pathlib.Path(out + ".sha256").write_text(f"{digest}  {os.path.basename(out)}\n")
        pathlib.Path(out + ".manifest.json").write_text(json.dumps(extended, indent=1, sort_keys=True) + "\n")
        print(f"extended {os.path.basename(archive)} with {len(extensions)} pristine files")
        print(out)
        print("\t".join([ident[key] for key in series_base.IDENTITY] + [series_base.tag_name(ident), os.path.basename(out),
                                                                       digest]))

    finally:
        shutil.rmtree(private, ignore_errors=True)

def gh(*args, check=True):
    result = subprocess.run(["gh", *args], capture_output=True, text=True)
    if check and result.returncode:
        series_base.die(f"gh {' '.join(args)}: {result.stderr.strip() or result.stdout.strip()}")
    return result


def sidecars(name, digest, manifest, scratch):
    sha_file = os.path.join(scratch, name + ".sha256")
    pathlib.Path(sha_file).write_text(f"{digest}  {name}\n")
    manifest_file = os.path.join(scratch, name + ".manifest.json")
    pathlib.Path(manifest_file).write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    return [sha_file, manifest_file]


def download(tag, repo, name, directory):
    gh("release", "download", tag, "-R", repo, "-p", name, "-D", directory)
    return os.path.join(directory, name)


def cmd_publish(args):
    archive = os.path.abspath(args.archive)
    manifest = series_base.read_manifest(archive)
    series_base.require_provenance(manifest, archive)
    ident = {key: manifest[key] for key in series_base.IDENTITY}
    current = series_base.identity(ident["platform"], ident["cpu"])
    if current != ident:
        series_base.die(f"{archive} is for {ident}, but this checkout's pins and step-3 inputs give {current}")
    name = series_base.asset_name(ident, series_base.content_revision(manifest))
    if os.path.basename(archive) != name:
        series_base.die(f"{archive} should be named {name} for its manifest")
    digest = series_base.sha256_file(archive)
    tag = series_base.tag_name(ident)
    with tempfile.TemporaryDirectory(prefix="ac-series-publish-") as scratch:
        os.mkdir(os.path.join(scratch, "files"))
        series_base.extract(archive, os.path.join(scratch, "files"))
        if gh("release", "view", tag, "-R", args.repo, "--json", "tagName", check=False).returncode:
            gh("release", "create", tag, "-R", args.repo, "--prerelease", "--latest=false", "--title", tag, "--notes",
               f"The series base for Chromium {ident['chromium']} on Helium {ident['helium_chromium'][:12]}: the files "
               "engine/patches/series touches, as step 3 leaves them, for scripts/engine/series-zero-fuzz.py. "
               "Not an app release.")
        assets = json.loads(gh("release", "view", tag, "-R", args.repo, "--json", "assets").stdout)["assets"]
        names = {asset["name"] for asset in assets}
        existing = os.path.join(scratch, "existing")
        os.mkdir(existing)
        uploads = []
        if name in names:
            published = download(tag, args.repo, name, existing)
            manifest = series_base.read_manifest(published)
            if series_base.content_revision(manifest) != series_base.content_revision(series_base.read_manifest(archive)):
                series_base.die(f"{tag} holds a {name} with other files under the same name")
            digest = series_base.sha256_file(published)
            print(f"{name} is already on {tag} with the same files; keeping it")
        else:
            uploads.append(archive)
        for sidecar in sidecars(name, digest, manifest, scratch):
            sidecar_name = os.path.basename(sidecar)
            if sidecar_name not in names:
                uploads.append(sidecar)
            elif pathlib.Path(download(tag, args.repo, sidecar_name, existing)).read_bytes() != \
                    pathlib.Path(sidecar).read_bytes():
                series_base.die(f"{tag}'s {sidecar_name} doesn't describe {name}: delete that sidecar and publish again")
        if uploads:
            gh("release", "upload", tag, "-R", args.repo, *uploads)
    row = dict(ident, tag=tag, asset=name, sha256=digest)
    series_base.write_row(row)
    print(f"https://github.com/{args.repo}/releases/download/{tag}/{name}")
    print(f"wrote its row into {series_base.TABLE.relative_to(series_base.REPO)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    pack = sub.add_parser("pack")
    pack.add_argument("--platform", choices=("linux", "mac"), required=True)
    pack.add_argument("--cpu", choices=("arm64", "x64"))
    pack.add_argument("--base")
    pack.add_argument("--src")
    pack.add_argument("--dest")
    pack.add_argument("--no-verify", action="store_true")
    extend = sub.add_parser("extend")
    extend.add_argument("--platform", choices=("linux", "mac"), required=True)
    extend.add_argument("--cpu", choices=("arm64", "x64"))
    extend.add_argument("--archive")
    extend.add_argument("--cache")
    extend.add_argument("--src")
    extend.add_argument("--dest")
    publish = sub.add_parser("publish")
    publish.add_argument("archive")
    publish.add_argument("--repo", default=os.environ.get("ARDIA_SERIES_BASE_REPO", "ardia-browser/ardia"))
    args = parser.parse_args()
    try:
        {"pack": cmd_pack, "extend": cmd_extend, "publish": cmd_publish}[args.command](args)
    except series_base.Problem as error:
        series_base.die(str(error), 2)


if __name__ == "__main__":
    main()
