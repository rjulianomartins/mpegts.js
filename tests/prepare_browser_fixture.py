#!/usr/bin/env python3
import json
import shutil
import subprocess
from pathlib import Path


def run(command):
    subprocess.run(command, check=True)


def make_source(path, size, frequency):
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc=size={size}:rate=30:duration=6",
        "-f", "lavfi", "-i", f"sine=frequency={frequency}:sample_rate=48000:duration=6",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-keyint_min", "30",
        "-c:a", "aac", "-shortest", str(path)
    ])


def main():
    repo = Path(__file__).resolve().parents[1]
    root = repo / "demo" / ".ci-scenes"
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)

    source_a = root / "source-a.mp4"
    source_b = root / "source-b.mp4"
    make_source(source_a, "640x360", 440)
    make_source(source_b, "854x480", 660)

    helper = repo / "tools" / "prepare-academic-scene.py"
    scenes = []
    for index, source in enumerate((source_a, source_b), start=1):
        scene_dir = root / f"scene-{index}"
        run([
            "python3", str(helper), str(source), str(scene_dir),
            "--start", "0", "--end", "5",
            "--id", f"scene-{index}", "--title", f"Scene {index}",
            "--source-id", f"source-{index}",
            "--url-prefix", f".ci-scenes/scene-{index}",
            "--segment-seconds", "2"
        ])
        scenes.append(json.loads((scene_dir / "scene.json").read_text(encoding="utf-8")))

    manifest = {"type": "scenes", "title": "CI Compilation", "scenes": scenes}
    (root / "compilation.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "scenes": len(scenes)}))


if __name__ == "__main__":
    main()
