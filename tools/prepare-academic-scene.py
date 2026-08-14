#!/usr/bin/env python3

import argparse
import json
import subprocess
from pathlib import Path


def run_json(command):
    result = subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return json.loads(result.stdout)


def probe_codecs(source):
    payload = run_json([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,profile,level', '-of', 'json', str(source)
    ])
    streams = payload.get('streams') or []
    if not streams or streams[0].get('codec_name') != 'h264':
        raise SystemExit('V1 scene preparation requires H.264 video.')
    video = streams[0]

    audio_payload = run_json([
        'ffprobe', '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name', '-of', 'json', str(source)
    ])
    audio_streams = audio_payload.get('streams') or []
    audio_codec = audio_streams[0].get('codec_name') if audio_streams else None
    if audio_codec not in (None, 'aac'):
        raise SystemExit('V1 scene preparation requires AAC audio or no audio.')

    profile = str(video.get('profile') or '').lower()
    profile_idc = '64' if 'high' in profile else ('4D' if 'main' in profile else '42')
    constraints = 'E0' if 'constrained baseline' in profile else '00'
    level = int(video.get('level') or 30)
    level_hex = format(max(0, min(level, 255)), '02X')
    codecs = 'avc1.' + profile_idc + constraints + level_hex
    if audio_codec == 'aac':
        codecs += ', mp4a.40.2'
    return 'video/mp4; codecs="' + codecs + '"'


def probe_nearest_keyframe(source, requested_time, tolerance):
    search_start = max(0.0, requested_time - tolerance - 0.5)
    search_duration = max(1.0, (tolerance * 2.0) + 1.0)
    payload = run_json([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-read_intervals', f'{search_start:.6f}%+{search_duration:.6f}',
        '-show_entries', 'packet=pts_time,flags', '-of', 'json', str(source)
    ])

    candidates = []
    for packet in payload.get('packets') or []:
        if 'K' not in str(packet.get('flags') or ''):
            continue
        try:
            timestamp = float(packet.get('pts_time'))
        except (TypeError, ValueError):
            continue
        delta = timestamp - requested_time
        if abs(delta) <= tolerance + 1e-6:
            candidates.append((abs(delta), timestamp))

    if not candidates:
        raise SystemExit(
            f'No video keyframe is within {tolerance:.3f}s of requested Scene start {requested_time:.3f}s.'
        )

    candidates.sort(key=lambda item: (item[0], item[1]))
    return candidates[0][1]


def parse_playlist(path):
    durations = []
    names = []
    pending = None
    for raw in path.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if line.startswith('#EXTINF:'):
            pending = float(line.split(':', 1)[1].split(',', 1)[0])
        elif line and not line.startswith('#') and pending is not None:
            durations.append(pending)
            names.append(line)
            pending = None
    if not durations:
        raise SystemExit('FFmpeg produced no media fragments.')
    return durations, names


def main():
    parser = argparse.ArgumentParser(description='Prepare one lossless H.264/AAC Scene as fragmented MP4.')
    parser.add_argument('source')
    parser.add_argument('output_dir')
    parser.add_argument('--start', type=float, required=True)
    parser.add_argument('--end', type=float, required=True)
    parser.add_argument('--id', required=True)
    parser.add_argument('--title', required=True)
    parser.add_argument('--source-id', default='')
    parser.add_argument('--url-prefix', default='')
    parser.add_argument('--segment-seconds', type=float, default=4.0)
    parser.add_argument('--keyframe-tolerance', type=float, default=1.0)
    args = parser.parse_args()

    if args.end <= args.start:
        raise SystemExit('--end must be greater than --start')
    if args.start < 0:
        raise SystemExit('--start must be zero or greater')
    if args.keyframe_tolerance < 0:
        raise SystemExit('--keyframe-tolerance must be zero or greater')

    source = Path(args.source)
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)

    mime_type = probe_codecs(source)
    actual_start = probe_nearest_keyframe(source, args.start, args.keyframe_tolerance)
    if actual_start >= args.end:
        raise SystemExit('Nearest accepted keyframe is not before requested Scene end.')

    playlist = output / 'scene.m3u8'
    segment_pattern = output / 'segment-%05d.m4s'

    command = [
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-ss', f'{actual_start:.6f}', '-to', f'{args.end:.6f}', '-i', str(source),
        '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-f', 'hls', '-hls_segment_type', 'fmp4',
        '-hls_time', f'{args.segment_seconds:.3f}',
        '-hls_playlist_type', 'vod',
        '-hls_flags', 'independent_segments',
        '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', str(segment_pattern),
        str(playlist)
    ]
    subprocess.run(command, check=True)

    durations, names = parse_playlist(playlist)
    cursor = 0.0
    prefix = args.url_prefix.rstrip('/')

    def url_for(name):
        return (prefix + '/' + name) if prefix else name

    segments = []
    for duration, name in zip(durations, names):
        segments.append({
            'url': url_for(name),
            'start': round(cursor, 6),
            'duration': round(duration, 6)
        })
        cursor += duration

    actual_end = actual_start + cursor
    scene = {
        'id': args.id,
        'title': args.title,
        'sourceId': args.source_id,
        'requestedSourceStart': round(args.start, 6),
        'requestedSourceEnd': round(args.end, 6),
        'actualSourceStart': round(actual_start, 6),
        'actualSourceEnd': round(actual_end, 6),
        'sourceStart': round(actual_start, 6),
        'sourceEnd': round(actual_end, 6),
        'startBoundaryDelta': round(actual_start - args.start, 6),
        'duration': round(cursor, 6),
        'mimeType': mime_type,
        'mediaStart': 0,
        'initSegment': {'url': url_for('init.mp4')},
        'segments': segments
    }
    (output / 'scene.json').write_text(json.dumps(scene, indent=2) + '\n', encoding='utf-8')

    print(json.dumps({
        'ok': True,
        'scene_id': args.id,
        'requested_start': round(args.start, 3),
        'actual_start': round(actual_start, 3),
        'boundary_delta': round(actual_start - args.start, 3),
        'duration': round(cursor, 3),
        'segments': len(segments),
        'mime_type': mime_type
    }))


if __name__ == '__main__':
    main()
