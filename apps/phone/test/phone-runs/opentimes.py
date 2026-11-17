"""opentimes.py taps <dir> <name> [labels...]   deck and card opens: every touch-down on the app's window, labelled in turn
opentimes.py flick <dir> <name>                swipes: finger up to settled
opentimes.py launch <dir> <name>               cold or warm starts: the START line to the frames

Times touch-to-frame for one recording made by rec.sh. Every frame's time is its own wall time from screenrecord's frame
stamps (vtool.py), and every touch's is the phone's input log line (MIUIInput's publisher action=0x0 down / 0x1 up on
the app's window; MIUI phones only), so no timing depends on when screenrecord was started or how long its encoder took
to deliver the first frame. Reads <dir>/<name>.mp4, <dir>/<name>.cmd.txt and the lines of LOG (the session log rec.sh
recorded) that the .cmd.txt names. PHONE_UTC_OFFSET is the phone's log time zone (default +05:30). A frame moves when a
region changes by more than 2 grey levels; an open has settled when the whole screen stays within 0.8 for 300 ms."""
import csv
import datetime
import os
import re
import statistics
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REGIONS = ["page=60,300,960,1400", "full=0,90,1080,2170", "bar=0,2080,1080,190", "deck=0,250,1080,1650"]
MOVE = 2.0
QUIET = 0.8
QUIET_MS = 300
PACKAGE = "com.ardia.browser.android"


def zone():
    sign, hours, minutes = re.match(r"([+-])(\d\d):(\d\d)", os.environ.get("PHONE_UTC_OFFSET", "+05:30")).groups()
    delta = datetime.timedelta(hours=int(hours), minutes=int(minutes))
    return datetime.timezone(delta if sign == "+" else -delta)


TZ = zone()


def wall_of(line, year=datetime.date.today().year):
    found = re.match(r"(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d+)", line)
    if not found:
        return None
    month, day, hour, minute, second, fraction = found.groups()
    return datetime.datetime(year, int(month), int(day), int(hour), int(minute), int(second), int(fraction.ljust(6, "0")[:6]), tzinfo=TZ).timestamp()


def load(folder, name):
    table = f"{folder}/{name}.csv"
    if not os.path.exists(table):
        subprocess.run([sys.executable, "-I", f"{HERE}/vtool.py", f"{folder}/{name}.mp4", table] + REGIONS, check=True)
    rows = [{key: float(value) for key, value in row.items()} for row in csv.DictReader(open(table))]
    command = open(f"{folder}/{name}.cmd.txt").read()
    first, last = map(int, re.search(r"loglines (\d+) (\d+)", command).groups())
    with open(os.environ["LOG"], encoding="utf-8", errors="replace") as log:
        lines = [line for index, line in enumerate(log) if first - 5 <= index <= last + 5]
    return rows, command, lines


def touches(lines):
    events = []
    for line in lines:
        if "MIUIInput" in line and "publisher action=" in line and f"{PACKAGE}/" in line:
            kind = {"0": "down", "1": "up"}.get(re.search(r"action=0x(\w+)", line).group(1))
            if kind:
                events.append((wall_of(line), kind))
    return events


def settle(rows, start, until=None):
    last = start
    for index in range(start, len(rows)):
        if rows[index]["full"] > QUIET:
            last = index
        elif rows[index]["wall"] - rows[last]["wall"] >= QUIET_MS / 1000:
            break
        if until and rows[index]["wall"] > until:
            break
    return last


def first_after(rows, moment, column, threshold=MOVE, until=None):
    for index, row in enumerate(rows):
        if row["wall"] > moment and row[column] > threshold:
            return None if until and row["wall"] > until else index
    return None


def longest_gap(rows, start, end):
    gaps = [(rows[i]["wall"] - rows[i - 1]["wall"]) * 1000 for i in range(start + 1, end + 1)]
    return max(gaps) if gaps else 0.0


def summary(label, values):
    values = [value for value in values if value is not None]
    if not values:
        return f"{label}: n 0"
    return f"{label}: n {len(values)} median {statistics.median(values):.0f} worst {max(values):.0f} (min {min(values):.0f})"


def taps(folder, name, labels):
    rows, _, lines = load(folder, name)
    events = touches(lines)
    downs = [(moment, index) for index, (moment, kind) in enumerate(events) if kind == "down"]
    results = {label: [] for label in labels}
    for n, (moment, index) in enumerate(downs):
        label = labels[n % len(labels)]
        up = next((when for when, kind in events[index + 1:] if kind == "up"), None)
        following = downs[n + 1][0] if n + 1 < len(downs) else moment + 3
        first = first_after(rows, moment, "page", until=following)
        if first is None:
            print(f"{label} {n}: no moving frame")
            continue
        settled = settle(rows, first, following)
        result = dict(down_first=(rows[first]["wall"] - moment) * 1000, up_first=(rows[first]["wall"] - up) * 1000 if up else None,
                      down_settled=(rows[settled]["wall"] - moment) * 1000, up_settled=(rows[settled]["wall"] - up) * 1000 if up else None,
                      gap=longest_gap(rows, first, settled))
        results[label].append(result)
        print(f"{label} {n}: down->first {result['down_first']:.0f}  down->settled {result['down_settled']:.0f}  longest gap {result['gap']:.1f} (frames {first}-{settled})")
    for label in labels:
        for key in ("down_first", "up_first", "down_settled", "up_settled", "gap"):
            print(summary(f"{name} {label} {key}", [result[key] for result in results[label]]))
    return results


def flick(folder, name):
    rows, _, lines = load(folder, name)
    events = touches(lines)
    results = []
    for index, (moment, kind) in enumerate(events):
        if kind != "up":
            continue
        down = max((when for when, what in events[:index] if what == "down"), default=None)
        following = next((when for when, what in events[index + 1:] if what == "down"), moment + 3)
        first = next((i for i, row in enumerate(rows) if row["wall"] > (down or moment)), None)
        settled = settle(rows, next(i for i, row in enumerate(rows) if row["wall"] > moment), following)
        results.append(dict(up_settled=(rows[settled]["wall"] - moment) * 1000, gap=longest_gap(rows, first, settled)))
        print(f"flick: up->settled {results[-1]['up_settled']:.0f}  longest gap {results[-1]['gap']:.1f}")
    print(summary(f"{name} up_settled", [result["up_settled"] for result in results]))
    print(summary(f"{name} gap", [result["gap"] for result in results]))


def launch(folder, name):
    rows, command, lines = load(folder, name)
    starts = [wall_of(line) for line in lines if "ActivityTaskManager: START u0" in line and f"{PACKAGE}/.MainActivity" in line and "LAUNCHER" in line]
    totals = [int(value) for value in re.findall(r"TotalTime: (\d+)", command)]
    results = []
    for n, moment in enumerate(starts):
        following = starts[n + 1] if n + 1 < len(starts) else moment + 10
        first = first_after(rows, moment, "full", 1.0, following)
        if first is None:
            print(f"{name} {n + 1}: no frame")
            continue
        limit = min(following, moment + 6.0)
        usable = max((i for i, row in enumerate(rows) if moment < row["wall"] <= limit and (row["full"] > QUIET or row["bar"] > QUIET)), default=first)
        settled, last, i = None, first, first
        while i < len(rows) and rows[i]["wall"] < following:
            if rows[i]["full"] > QUIET:
                last = i
            elif rows[i]["wall"] - rows[last]["wall"] >= 0.05:
                settled = last
                break
            i += 1
        result = dict(total=totals[n] if n < len(totals) else None, first_frame=(rows[first]["wall"] - moment) * 1000,
                      window_settled=(rows[settled]["wall"] - moment) * 1000 if settled is not None else None, usable=(rows[usable]["wall"] - moment) * 1000)
        results.append(result)
        print(f"{name} {n + 1}: TotalTime {result['total']}  first changed frame {result['first_frame']:.0f}  window animation settled {result['window_settled'] or -1:.0f}  last change within 6 s {result['usable']:.0f}")
    for key in ("total", "first_frame", "window_settled", "usable"):
        print(summary(f"{name} {key}", [result[key] for result in results]))
    return results


def main(arguments):
    if len(arguments) < 3 or arguments[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if arguments[:1] in (["-h"], ["--help"]) else 64
    kind, folder, name = arguments[:3]
    if kind == "taps":
        taps(folder, name, arguments[3:] or ["tap"])
    elif kind == "flick":
        flick(folder, name)
    elif kind == "launch":
        launch(folder, name)
    else:
        print(__doc__)
        return 64
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
