#!/usr/bin/env python3

import argparse
import json
import re
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
    args = parser.parse_args()

    if args.end <= args.start:
        raise SystemExit('--end must be greater than --start')

    source = Path(args.source)
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)

    mime_type = probe_codecs(source)
    playlist = output / 'scene.m3u8'
    segment_pattern = output / 'segment-%05d.m4s'

    command = [
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-ss', f'{args.start:.6f}', '-to', f'{args.end:.6f}', '-i', str(source),
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

    scene = {
        'id': args.id,
        'title': args.title,
        'sourceId': args.source_id,
        'sourceStart': args.start,
        'sourceEnd': args.end,
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
        'duration': round(cursor, 3),
        'segments': len(segments),
        'mime_type': mime_type
    }))


if __name__ == '__main__':
    main()
