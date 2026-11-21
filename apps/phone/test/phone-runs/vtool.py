"""vtool.py <video.mp4> <out.csv> [name=x,y,w,h ...]
vtool.py --check <video.mp4>

Per-frame table for a screenrecord MP4: idx, wall (epoch seconds of when the phone composed the frame, from the frame's
own elapsed-realtime stamp in screenrecord's WinScope metadata track plus the recorder's offset), pts, then for each
region the mean absolute grey change against the previous frame (0-255). Regions are full-resolution pixels of a
1080 x 2400 portrait screen. --check exits 1 when the video carries no frame stamps. FFMPEG names ffmpeg (default
~/.local/bin/ffmpeg, else ffmpeg on the PATH)."""
import os
import re
import shutil
import struct
import subprocess
import sys

FF = os.environ.get("FFMPEG") or (os.path.expanduser("~/.local/bin/ffmpeg") if os.path.exists(os.path.expanduser("~/.local/bin/ffmpeg")) else shutil.which("ffmpeg") or "ffmpeg")
MAGIC = b"#VV1NSC0PET1ME2#"
BLOCK = 40
COLUMNS, ROWS = 27, 60


def frame_walls(video):
    staged = video + ".meta.bin"
    for stream in (1, 2, 3):
        subprocess.run([FF, "-v", "error", "-discard", "none", "-i", video, "-map", f"0:{stream}", "-c", "copy", "-f", "data", "-y", staged], capture_output=True)
        if not os.path.exists(staged):
            continue
        data = open(staged, "rb").read()
        os.remove(staged)
        if data.startswith(MAGIC):
            offset, = struct.unpack_from("<q", data, 20)
            count, = struct.unpack_from("<I", data, 28)
            stamps = struct.unpack_from("<%dq" % count, data, 32)
            return [(stamp + offset) / 1e9 for stamp in stamps]
    whole = open(video, "rb").read()
    at = whole.find(MAGIC)
    if at < 0:
        return None
    offset, = struct.unpack_from("<q", whole, at + 20)
    count, = struct.unpack_from("<I", whole, at + 28)
    stamps = struct.unpack_from("<%dq" % count, whole, at + 32)
    return [(stamp + offset) / 1e9 for stamp in stamps]


def presentation_times(video):
    info = subprocess.run([FF, "-v", "info", "-i", video, "-map", "0:0", "-vf", "showinfo", "-fps_mode", "passthrough", "-f", "null", "-"], capture_output=True, text=True).stderr
    return [float(found) for found in re.findall(r"pts_time:([0-9.]+)", info)]


def region_changes(video, regions):
    raw = subprocess.run([FF, "-v", "error", "-i", video, "-map", "0:0", "-vf", f"format=gray,tblend=all_mode=difference,scale={COLUMNS}:{ROWS}:flags=area", "-fps_mode", "passthrough", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    frames = len(raw) // (COLUMNS * ROWS)
    changes = {}
    for name, x, y, w, h in regions:
        cells = [row * COLUMNS + column for row in range(round(y / BLOCK), round((y + h) / BLOCK)) for column in range(round(x / BLOCK), round((x + w) / BLOCK))]
        values = [sum(raw[k * COLUMNS * ROWS + cell] for cell in cells) / len(cells) for k in range(frames)]
        floor = min(values) if values else 0.0
        changes[name] = [0.0] + [value - floor for value in values]
    return changes


def main(arguments):
    if not arguments or arguments[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if arguments else 64
    if arguments[0] == "--check":
        return 0 if frame_walls(arguments[1]) else 1
    video, out = arguments[0], arguments[1]
    regions = []
    for spec in arguments[2:]:
        name, box = spec.split("=")
        x, y, w, h = map(int, box.split(","))
        regions.append((name, x, y, w, h))
    walls = frame_walls(video)
    if not walls:
        print(f"no frame stamps in {video}: screenrecord's metadata track is missing, so no frame has a wall time", file=sys.stderr)
        return 1
    pts = presentation_times(video)
    changes = region_changes(video, regions) if regions else {}
    count = min([len(walls), len(pts)] + [len(values) for values in changes.values()])
    if len(walls) != len(pts):
        print(f"warning: {len(walls)} frame stamps, {len(pts)} video frames", file=sys.stderr)
    with open(out, "w") as table:
        table.write("idx,wall,pts" + "".join("," + region[0] for region in regions) + "\n")
        for i in range(count):
            table.write(f"{i},{walls[i]:.6f},{pts[i]:.6f}" + "".join(f",{changes[region[0]][i]:.3f}" for region in regions) + "\n")
    if count > 2:
        drift = max(abs((walls[i] - walls[0]) - (pts[i] - pts[0])) for i in range(count))
        print(f"{count} frames, {walls[0]:.3f}..{walls[count - 1]:.3f}, largest stamp-pts drift {drift * 1000:.2f} ms", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
