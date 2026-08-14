# Academic Scene Composition

This branch adds a scene-oriented Media Source Extensions playback layer for an Academic Library.

The goal is to keep a single native HTML `<video controls>` element and its browser controls while presenting an ordered Scene compilation as one logical timeline.

## Scene manifest

A compilation manifest contains an ordered `scenes` array. V1 uses one multiplexed fragmented-MP4 SourceBuffer per Compilation: video and audio, when present, live in the same initialization/media fragments.

```json
{
  "type": "scenes",
  "title": "Thermodynamics compilation",
  "scenes": [
    {
      "id": "scene-1",
      "title": "Entropy explanation",
      "sourceId": "media-42",
      "sourceStart": 120.0,
      "sourceEnd": 132.0,
      "duration": 12.0,
      "mimeType": "video/mp4; codecs=\"avc1.640028, mp4a.40.2\"",
      "mediaStart": 0,
      "initSegment": {"url": "scene-1/init.mp4"},
      "segments": [
        {"url": "scene-1/segment-00000.m4s", "start": 0, "duration": 4},
        {"url": "scene-1/segment-00001.m4s", "start": 4, "duration": 4},
        {"url": "scene-1/segment-00002.m4s", "start": 8, "duration": 4}
      ]
    }
  ]
}
```

Scene `duration` must match the duration covered by its media segments. The player assigns each Scene a continuous `timelineStart`/`timelineEnd` range beginning at zero.

## Playback contracts

- The visible media element remains a normal native `<video controls>` element.
- No custom control overlay is required.
- `video.duration` represents the full Compilation duration.
- `video.currentTime` is Compilation time.
- Scene transitions are driven by the logical timeline.
- Seeking on the native browser timeline resolves to the Scene owning that logical time.
- The next Scene is prefetched before the current one ends.
- Adjacent Scenes can share the same source identity; the application may coalesce them before creating a manifest.
- Different compatible MP4 codec configurations may use `SourceBuffer.changeType()` at Scene boundaries when the browser supports it.
- V1 requires compatible track topology across a Compilation; changing from audio+video to video-only within the same SourceBuffer is not a supported contract.
- The player never transcodes media in the browser. Scene fragment creation belongs to the server.

## Native Scene titles

When explicitly enabled, Scene titles may be exposed through a native `TextTrack` using `VTTCue`. This avoids an HTML overlay over the video surface.

For maximum video-surface isolation, leave Scene title cues disabled and consume `scene_change` outside the video instead. NVIDIA VSR behavior with MSE and text tracks must still be validated on the target machine.

## Keyboard navigation

The Scene player can optionally intercept unmodified Left/Right Arrow presses while Compilation mode is active:

- Left Arrow: previous Scene
- Right Arrow: next Scene

Editable controls retain normal arrow-key behavior. Application integration should scope Scene navigation to the active player context.

## Events

The current Scene engine emits:

- `scene_manifest_loaded`
- `scene_ready`
- `scene_change`
- `scene_time_update`
- `scene_segment_buffered`
- `scene_buffer_evicted`
- `scene_error`

`scene_time_update` contains both Compilation time and Scene-local time.

## Server-side fragment preparation

`tools/prepare-academic-scene.py` creates a multiplexed H.264/AAC fragmented-MP4 Scene using FFmpeg stream copy. It writes `init.mp4`, one or more `.m4s` media fragments, and `scene.json`.

Stream-copy boundaries are keyframe constrained. Production integration must distinguish the requested Scene boundary from the actual usable keyframe boundary and enforce the library's allowed boundary tolerance before accepting a prepared Scene.

If a source cannot be remuxed losslessly into a browser-supported configuration, the source must be normalized before Scene fragment generation.

## Automated validation

GitHub Actions validates:

1. the standalone Scene bundle builds;
2. the example manifest is internally consistent;
3. synthetic H.264/AAC media can be prepared into Scene fMP4 assets;
4. headless Firefox can load a two-Scene MSE Compilation, seek across the boundary, seek backward, and reload the player.

These tests do not validate NVIDIA RTX Video Super Resolution because GitHub-hosted runners do not provide the target NVIDIA/Firefox rendering path.

## VSR validation

The target-machine validation is:

1. Use Firefox native video controls.
2. Play a two-Scene Compilation through MediaSource.
3. Confirm one continuous native timeline.
4. Seek across the Scene boundary.
5. Confirm NVIDIA VSR remains active with Scene titles disabled.
6. Enable native Scene title cues separately; keep them disabled if they affect VSR.
