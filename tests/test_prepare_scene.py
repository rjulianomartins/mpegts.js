#!/usr/bin/env python3
import json
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def run(command):
    return subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def main():
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise SystemExit("ffmpeg and ffprobe are required")

    repo = Path(__file__).resolve().parents[1]
    helper = repo / "tools" / "prepare-academic-scene.py"
    validator = repo / "tests" / "validate_scene_contract.py"

    with tempfile.TemporaryDirectory(prefix="scene-ci-") as tmp:
        tmp = Path(tmp)
        source = tmp / "source.mp4"
        output = tmp / "scene"

        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=8",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-keyint_min", "30",
            "-c:a", "aac", "-shortest", str(source)
        ])

        requested_start = 1.35
        requested_end = 6.0
        run([
            sys.executable, str(helper), str(source), str(output),
            "--start", str(requested_start), "--end", str(requested_end),
            "--id", "ci-scene", "--title", "CI Scene",
            "--source-id", "ci-source", "--segment-seconds", "2.0",
            "--keyframe-tolerance", "1.0"
        ])

        manifest = output / "scene.json"
        if not manifest.exists():
            raise SystemExit("scene.json was not generated")

        scene = json.loads(manifest.read_text(encoding="utf-8"))
        wrapped_manifest = tmp / "compilation.json"
        wrapped_manifest.write_text(
            json.dumps({"type": "scenes", "scenes": [scene]}, indent=2) + "\n",
            encoding="utf-8"
        )
        run([sys.executable, str(validator), str(wrapped_manifest)])

        if not math.isclose(float(scene.get("requestedSourceStart")), requested_start, abs_tol=1e-6):
            raise SystemExit("requestedSourceStart was not preserved")
        if not math.isclose(float(scene.get("requestedSourceEnd")), requested_end, abs_tol=1e-6):
            raise SystemExit("requestedSourceEnd was not preserved")

        actual_start = float(scene.get("actualSourceStart"))
        boundary_delta = float(scene.get("startBoundaryDelta"))
        if abs(actual_start - requested_start) > 1.0 + 1e-6:
            raise SystemExit("actual Scene start exceeded the 1s keyframe tolerance")
        if not math.isclose(boundary_delta, actual_start - requested_start, abs_tol=1e-6):
            raise SystemExit("startBoundaryDelta does not match requested vs actual start")
        if math.isclose(actual_start, requested_start, abs_tol=0.01):
            raise SystemExit("non-keyframe request unexpectedly reported an exact boundary")
        if not math.isclose(float(scene.get("sourceStart")), actual_start, abs_tol=1e-6):
            raise SystemExit("sourceStart must represent the actual prepared boundary")

        actual_end = float(scene.get("actualSourceEnd"))
        if not math.isclose(float(scene.get("sourceEnd")), actual_end, abs_tol=1e-6):
            raise SystemExit("sourceEnd must represent the actual prepared boundary")
        if not math.isclose(actual_end, actual_start + float(scene.get("duration")), abs_tol=0.02):
            raise SystemExit("actualSourceEnd does not match actual start plus prepared duration")

        init_file = output / "init.mp4"
        if not init_file.exists() or init_file.stat().st_size == 0:
            raise SystemExit("init.mp4 missing or empty")

        segments = scene.get("segments") or []
        if not segments:
            raise SystemExit("no media segments generated")

        for segment in segments:
            segment_file = output / Path(segment["url"]).name
            if not segment_file.exists() or segment_file.stat().st_size == 0:
                raise SystemExit(f"missing media segment {segment_file.name}")

        probe = json.loads(run([
            "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name",
            "-of", "json", str(source)
        ]).stdout)
        stream_map = {s.get("codec_type"): s.get("codec_name") for s in probe.get("streams", [])}
        if stream_map.get("video") != "h264":
            raise SystemExit("synthetic source video is not H.264")
        if stream_map.get("audio") != "aac":
            raise SystemExit("synthetic source audio is not AAC")

        playlist_probe = json.loads(run([
            "ffprobe", "-v", "error", "-show_entries", "format=start_time,duration",
            "-of", "json", str(output / "scene.m3u8")
        ]).stdout)
        fmt = playlist_probe.get("format") or {}
        actual_media_start = float(fmt.get("start_time") or 0.0)
        declared_media_start = float(scene.get("mediaStart") or 0.0)
        if not math.isclose(declared_media_start, actual_media_start, abs_tol=0.01):
            raise SystemExit(
                f"scene mediaStart mismatch: manifest={declared_media_start:.6f} "
                f"ffprobe={actual_media_start:.6f}"
            )

        # A stricter tolerance must reject this deliberately non-keyframe request.
        rejected = subprocess.run([
            sys.executable, str(helper), str(source), str(tmp / "rejected"),
            "--start", str(requested_start), "--end", str(requested_end),
            "--id", "rejected", "--title", "Rejected",
            "--keyframe-tolerance", "0.1"
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if rejected.returncode == 0:
            raise SystemExit("helper accepted a Scene with no keyframe inside the configured tolerance")

        print(json.dumps({
            "ok": True,
            "segments": len(segments),
            "duration": scene.get("duration"),
            "requestedStart": requested_start,
            "actualStart": actual_start,
            "boundaryDelta": boundary_delta,
            "mediaStart": declared_media_start,
            "mimeType": scene.get("mimeType")
        }))


if __name__ == "__main__":
    main()
