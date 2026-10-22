#!/usr/bin/env python3
"""
Builds the demo video from the recorded clips.

  1. reads clips.json (recorded by record.mjs) and s3-events.json (question timings)
  2. generates narration with edge-tts (cached by text hash)
  3. schedules each line so lines never overlap and never drift past the picture
  4. renders each scene at 1920x1080 with its own audio bed, then concatenates

  python3 video/make.py --dir /tmp/attic-video --out attic-demo.mp4
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

VOICE = "en-US-AndrewMultilingualNeural"
RATE = "-3%"
FPS = 30
W, H = 1920, 1080


def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(" ".join(cmd) + "\n" + proc.stderr[-2000:] + "\n")
        raise SystemExit(1)


def duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    return float(out)


def tts(text: str, cache: Path, edge_tts: str) -> Path:
    key = hashlib.sha1(f"{VOICE}|{RATE}|{text}".encode()).hexdigest()[:16]
    target = cache / f"{key}.mp3"
    if target.exists() and target.stat().st_size > 0:
        return target
    cache.mkdir(parents=True, exist_ok=True)
    txt = cache / f"{key}.txt"
    txt.write_text(text)
    run([edge_tts, "--voice", VOICE, f"--rate={RATE}", "-f", str(txt), "--write-media", str(target)])
    return target


def schedule(lines: list[tuple[float, str]], cache: Path, edge_tts: str):
    """lines: (desired_start, text) → [(start, path, dur)] with no overlaps."""
    out = []
    cursor = 0.0
    for desired, text in lines:
        path = tts(text, cache, edge_tts)
        dur = duration(path)
        start = max(desired, cursor + 0.12)
        out.append((start, path, dur))
        cursor = start + dur
    return out


def scene_audio(items, target: float, out_path: Path) -> None:
    if not items:
        run([
            "ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo",
            "-t", f"{target:.3f}", "-c:a", "aac", "-b:a", "192k", str(out_path),
        ])
        return
    args = ["ffmpeg", "-y"]
    for _, path, _ in items:
        args += ["-i", str(path)]
    filters = []
    for i, (start, _, _) in enumerate(items):
        filters.append(f"[{i}:a]adelay={int(start * 1000)}|{int(start * 1000)},volume=1.0[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(items)))
    filters.append(
        f"{mix}amix=inputs={len(items)}:normalize=0:dropout_transition=0,"
        f"loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=0:{target:.3f}[out]"
    )
    args += ["-filter_complex", ";".join(filters), "-map", "[out]",
             "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", str(out_path)]
    run(args)


def scene_video(src: Path, target: float, out_path: Path) -> None:
    run([
        "ffmpeg", "-y", "-i", str(src),
        "-vf", f"scale={W}:{H}:flags=lanczos,fps={FPS},format=yuv420p,setsar=1,tpad=stop_mode=clone:stop_duration=4",
        "-t", f"{target:.3f}", "-an",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", str(out_path),
    ])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="/tmp/attic-video")
    ap.add_argument("--out", default="attic-demo.mp4")
    ap.add_argument("--edge-tts", default="edge-tts")
    args = ap.parse_args()

    root = Path(args.dir)
    clips = json.loads((root / "clips.json").read_text())
    ev = json.loads((root / "s3-events.json").read_text())
    cache = root / "tts"

    s1_lines = [(0.5, "Every house has a memory. The plumber who fixed the water heater. The warranty that quietly expires. The spare key that is definitely not where you think. None of it lives anywhere a voice assistant can reach. Until now.")]

    s2_lines = [(0.6, "Attic is an MCP server. A self-hosted skill that Alexa Plus calls for anything about the home. Service history, vendors, prices, warranties, open problems. It keeps them in one place, and answers in a single spoken sentence, grounded in a real record. MCP is the open standard behind Alexa Plus integrations, and Attic speaks version 2025-11-25 over Streamable HTTP. One endpoint, one bearer token, no vendor lock in. The assistant stays stateless, and the house keeps its own data.")]

    ledger_start = ev["end"] - 4.2
    s3_lines = [
        (0.8, "This is the simulated Alexa Plus experience. On the right, the real MCP traffic."),
        (ev["q1"]["submitted"] - 1.7, "Ask when the water heater was last serviced."),
        (ev["q1"]["answered"] - 0.4, "One tools call, and a grounded answer. March fourteenth, Budi Plumbing, eighty five dollars."),
        (ev["q2"]["submitted"] - 1.7, "The fridge warranty? December fifteenth. Fifty four days left."),
        (ev["q3"]["submitted"] - 2.0, "Now something happened. The leak is fixed, ServicePro, two hundred and ten dollars."),
        (ev["q3"]["answered"] + 0.3, "Two writes. The service record, and the issue closed."),
        (ev["q4"]["submitted"] - 1.9, "What is still broken? Answered from the house brief, not from the chat."),
        (ev["q4"]["answered"] + 0.8, "Every answer is traceable to a record the house owns."),
        (ledger_start, "This is the ledger those answers come from. One SQLite file, nine tools, one endpoint."),
    ]

    s4_lines = [(0.7, "Under the hood, it is one Node process, one SQLite file, and nine tools. Recall and remember. Log service. Home brief. Report a problem, and mark it fixed. Remind and complete. And forget, because memory is only useful if it can be taken back. Sessions, streaming and JSON RPC are the SDK's job. The model only ever sees tool results, so it cannot invent a price or a date. This is running on a five dollar VPS, behind TLS, with a bearer token.")]

    s5_lines = [(0.6, "Attic. The memory of your house. Code, architecture and a friction log are on GitHub, and the live demo is open to try.")]

    plan = [
        ("s1", s1_lines),
        ("s2", s2_lines),
        ("s3", s3_lines),
        ("s4", s4_lines),
        ("s5", s5_lines),
    ]

    rendered = []
    for name, lines in plan:
        src = Path(clips[name])
        video_len = duration(src)
        items = schedule(lines, cache, args.edge_tts)
        audio_end = max([s + d for s, _, d in items], default=0.0)
        target = max(video_len, audio_end + 0.6)
        audio = root / f"{name}.m4a"
        video = root / f"{name}.mp4"
        scene_audio(items, target, audio)
        scene_video(src, target, video)
        # mux
        final = root / f"{name}-final.mp4"
        run(["ffmpeg", "-y", "-i", str(video), "-i", str(audio), "-c:v", "copy", "-c:a", "aac",
             "-b:a", "192k", "-shortest", str(final)])
        rendered.append(final)
        print(f"[{name}] video {video_len:5.1f}s  audio {audio_end:5.1f}s  → {target:5.1f}s")

    listing = root / "concat.txt"
    listing.write_text("".join(f"file '{p}'\n" for p in rendered))
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(listing),
         "-c", "copy", "-movflags", "+faststart", str(root / args.out)])
    total = duration(root / args.out)
    print(f"[done] {root / args.out} — {int(total // 60)}:{total % 60:04.1f}")


if __name__ == "__main__":
    main()
