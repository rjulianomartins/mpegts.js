# Academic Scene Composition

This branch adds a scene-oriented Media Source Extensions playback layer for an Academic Library.

The goal is to keep a single native HTML video element and its browser controls while presenting an ordered scene compilation as one logical timeline.

## Scene manifest

A compilation manifest contains an ordered `scenes` array. Each scene has a stable `id`, a `title`, source timing metadata, and one or more fragmented-MP4 tracks.

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
      "sourceEnd": 315.0,
      "tracks": [
        {
          "kind": "video",
          "mimeType": "video/mp4; codecs=\"avc1.640028\"",
          "initUrl": "/scene/scene-1/video/init.mp4",
          "mediaUrl": "/scene/scene-1/video/media.m4s"
        },
        {
          "kind": "audio",
          "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"",
          "initUrl": "/scene/scene-1/audio/init.mp4",
          "mediaUrl": "/scene/scene-1/audio/media.m4s"
        }
      ]
    }
  ]
}
```

The player derives each scene duration from `sourceEnd - sourceStart` and assigns a continuous logical range beginning at zero.

## Playback contracts

- The visible media element remains a normal native `<video controls>` element.
- No custom control overlay is required.
- `video.duration` represents the full compilation duration.
- `video.currentTime` is compilation time.
- Scene transitions are driven by the logical timeline.
- Seeking on the native browser timeline resolves to the scene owning that logical time.
- The next scene is prefetched before the current one ends.
- Adjacent scenes can share the same source identity; the application may coalesce them before creating a manifest.
- Different compatible MP4 configurations may use `SourceBuffer.changeType()` at scene boundaries when the browser supports it.
- The player never transcodes media in the browser. Scene fragment creation belongs to the server.

## Native scene titles

When enabled, scene titles are exposed through a native `TextTrack` using `VTTCue`. This deliberately avoids placing HTML layers over the video surface.

Applications that need maximum video-surface isolation can disable scene title cues and consume the `SCENE_CHANGE` event instead.

## Keyboard navigation

The Scene player can optionally intercept unmodified Left/Right Arrow presses while compilation mode is active:

- Left Arrow: previous scene
- Right Arrow: next scene

Editable controls retain normal arrow-key behavior.

## Events

The Scene engine emits:

- `scene_manifest_loaded`
- `scene_ready`
- `scene_change`
- `scene_time_update`
- `scene_buffering`
- `scene_buffered`
- `scene_ended`
- `scene_error`

`scene_time_update` contains both compilation time and scene-local time.

## Server-side fragment preparation

The browser expects fragmented MP4 initialization and media fragments. A server may use FFmpeg to create these with stream copy when codecs are already compatible.

Example conceptually:

```sh
ffmpeg -ss START -to END -i INPUT -map 0:v:0 -c copy -movflags frag_keyframe+empty_moov+default_base_moof OUTPUT.mp4
```

Production integration should split the init segment (`ftyp`/`moov`) and media fragments (`moof`/`mdat`) or serve equivalent CMAF/fMP4 assets.

If a source cannot be remuxed losslessly into a browser-supported configuration, that source can be normalized by the Academic Library's existing conversion pipeline before scene fragment generation.

## VSR validation

The intended NVIDIA VSR test is explicit:

1. Use Firefox native video controls.
2. Play a two-scene compilation through MediaSource.
3. Confirm one continuous native timeline.
4. Seek across the scene boundary.
5. Confirm scene title cues do not disable VSR.
6. If cues affect VSR, disable them; the MSE player itself does not require overlays or cues.
