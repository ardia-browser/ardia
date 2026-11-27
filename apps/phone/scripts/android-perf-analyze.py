#!/usr/bin/env python3
import csv
import json
import re
import subprocess
import sys
from pathlib import Path


def run_query(trace_processor: str, path: Path, sql: str):
    out = subprocess.check_output([trace_processor, "-Q", sql, str(path)], stderr=subprocess.DEVNULL, text=True)
    lines = [line for line in out.strip().splitlines() if line.strip()]
    return list(csv.DictReader(lines)) if len(lines) >= 2 else []


def summarize_trace(tp: str, path: Path, pkg: str):
    frame = run_query(
        tp,
        path,
        f"""
        SELECT count(*) AS frames,
               sum(CASE WHEN jank_type != 'None' AND jank_type IS NOT NULL THEN 1 ELSE 0 END) AS jank,
               sum(CASE WHEN jank_type LIKE '%App Deadline Missed%' THEN 1 ELSE 0 END) AS app_miss,
               round(percentile(dur, 50) / 1e6, 2) AS p50_ms,
               round(percentile(dur, 90) / 1e6, 2) AS p90_ms,
               round(percentile(dur, 99) / 1e6, 2) AS p99_ms,
               round(max(dur) / 1e6, 2) AS max_ms,
               sum(CASE WHEN dur > 16666667 THEN 1 ELSE 0 END) AS over_16_7ms
        FROM actual_frame_timeline_slice a
        JOIN process p USING(upid)
        WHERE p.name = '{pkg}';
        """,
    )[0]
    cpu = {
        r["t"]: float(r["ms"])
        for r in run_query(
            tp,
            path,
            f"""
            SELECT t.name AS t, round(sum(s.dur) / 1e6, 1) AS ms
            FROM sched_slice s
            JOIN thread t USING(utid)
            JOIN process p USING(upid)
            WHERE p.name = '{pkg}'
            GROUP BY t.name;
            """,
        )
    }
    return {
        "frames": int(frame["frames"]),
        "jank": int(frame["jank"]),
        "app_deadline_missed": int(frame["app_miss"]),
        "p50_ms": float(frame["p50_ms"]),
        "p90_ms": float(frame["p90_ms"]),
        "p99_ms": float(frame["p99_ms"]),
        "max_ms": float(frame["max_ms"]),
        "over_16_7ms": int(frame["over_16_7ms"]),
        "total_cpu_ms": round(sum(cpu.values()), 1),
        "ui_cpu_ms": cpu.get("ser.android.dev", 0.0),
        "render_thread_cpu_ms": cpu.get("RenderThread", 0.0),
        "js_cpu_ms": cpu.get("mqt_v_js", 0.0),
        "gc_cpu_ms": cpu.get("HeapTaskDaemon", 0.0),
    }


def summarize_heap(tp: str, path: Path):
    summary = run_query(
        tp,
        path,
        """
        SELECT count(*) AS objects,
               round(sum(self_size) / 1048576.0, 2) AS java_heap_mb,
               round(sum(native_size) / 1048576.0, 2) AS native_mb
        FROM heap_graph_object
        WHERE reachable != 0;
        """,
    )[0]
    bitmap = run_query(
        tp,
        path,
        """
        SELECT count(*) AS count, round(sum(o.native_size) / 1048576.0, 2) AS native_mb
        FROM heap_graph_object o
        JOIN heap_graph_class c ON o.type_id = c.id
        WHERE o.reachable != 0 AND c.name = 'android.graphics.Bitmap';
        """,
    )[0]
    return {
        "reachable_objects": int(summary["objects"]),
        "java_heap_mb": float(summary["java_heap_mb"]),
        "native_mb": float(summary["native_mb"]),
        "bitmaps": int(bitmap["count"]),
        "bitmap_mb": float(bitmap["native_mb"]),
    }


def summarize_meminfo(path: Path):
    text = path.read_text()
    result = {}
    for key, pattern in [
        ("total_pss_mb", r"TOTAL PSS:\s+(\d+)"),
        ("native_pss_mb", r"Native Heap:\s+(\d+)"),
        ("dalvik_pss_mb", r"Dalvik Heap\s+(\d+)"),
        ("graphics_pss_mb", r"Graphics:\s+(\d+)"),
    ]:
        match = re.search(pattern, text)
        result[key] = round(int(match.group(1)) / 1024.0, 1) if match else None
    return result


def main():
    if len(sys.argv) < 3 or sys.argv[1] in ("-h", "--help"):
        print("usage: android-perf-analyze.py <trace_processor> <out_dir> <label> [package]")
        sys.exit(0 if len(sys.argv) > 1 else 64)
    tp, out_dir, label = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
    pkg = sys.argv[4] if len(sys.argv) > 4 else "com.ardia.browser.android.dev"
    report = {"label": label}
    cold = out_dir / f"{label}_cold.perfetto-trace"
    ui = out_dir / f"{label}_ui.perfetto-trace"
    heap = out_dir / f"{label}.perfetto-java-heap-dump"
    mem = out_dir / f"{label}_meminfo.txt"
    if cold.is_file():
        report["cold_launch"] = summarize_trace(tp, cold, pkg)
    if ui.is_file():
        report["interactive_ui"] = summarize_trace(tp, ui, pkg)
    if heap.is_file():
        report["heap"] = summarize_heap(tp, heap)
    if mem.is_file():
        report["meminfo"] = summarize_meminfo(mem)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
