#!/usr/bin/env python3
import json
import math
import sys
from pathlib import Path


def fail(message):
    print(f"FAIL: {message}")
    raise SystemExit(1)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: validate_scene_contract.py MANIFEST.json")

    path = Path(sys.argv[1])
    data = json.loads(path.read_text(encoding="utf-8"))
    scenes = data.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        fail("manifest must contain a non-empty scenes array")

    for scene_index, scene in enumerate(scenes):
        segments = scene.get("segments")
        if not isinstance(segments, list) or not segments:
            fail(f"scene {scene_index} has no segments")

        expected_start = 0.0
        for segment_index, segment in enumerate(segments):
            start = float(segment.get("start", expected_start))
            duration = float(segment.get("duration", 0))
            if duration <= 0:
                fail(f"scene {scene_index} segment {segment_index} has invalid duration")
            if not math.isclose(start, expected_start, abs_tol=0.05):
                fail(
                    f"scene {scene_index} segment {segment_index} starts at {start:.3f}, "
                    f"expected {expected_start:.3f}"
                )
            expected_start = start + duration

        scene_duration = float(scene.get("duration", 0))
        if scene_duration <= 0:
            fail(f"scene {scene_index} has invalid duration")
        if not math.isclose(scene_duration, expected_start, abs_tol=0.05):
            fail(
                f"scene {scene_index} declares {scene_duration:.3f}s but segments cover "
                f"{expected_start:.3f}s"
            )

    print(json.dumps({"ok": True, "scenes": len(scenes)}))


if __name__ == "__main__":
    main()
