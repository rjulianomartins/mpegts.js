#!/usr/bin/env python3
import json
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

        run([
            sys.executable, str(helper), str(source), str(output),
            "--start", "1.0", "--end", "6.0",
            "--id", "ci-scene", "--title", "CI Scene",
            "--source-id", "ci-source", "--segment-seconds", "2.0"
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

        print(json.dumps({
            "ok": True,
            "segments": len(segments),
            "duration": scene.get("duration"),
            "mimeType": scene.get("mimeType")
        }))


if __name__ == "__main__":
    main()
