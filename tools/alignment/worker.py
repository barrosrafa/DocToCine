#!/usr/bin/env python3
"""
DocToCine v2.0 — Forced Alignment Worker (WhisperX)
Reads JSON payload from stdin: { "audioPath": "...", "transcript": "...", "language": "pt" }
Outputs JSON to stdout: { "words": [{ "text": "...", "startSeconds": 0.0, "endSeconds": 0.5, "confidence": 0.9 }], "warnings": [] }
"""
import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="WhisperX Forced Alignment Worker")
    parser.add_argument("--audio", required=True, help="Path to audio file")
    parser.add_argument("--language", default="pt", help="Language code")
    args = parser.parse_args()

    try:
        raw_stdin = sys.stdin.read()
        payload = json.loads(raw_stdin) if raw_stdin.strip() else {}
    except Exception as exc:
        print(json.dumps({"error": f"Invalid JSON stdin: {exc}"}))
        return 1

    transcript = str(payload.get("transcript", "")).strip()
    audio_path = str(payload.get("audioPath") or args.audio)
    language = str(payload.get("language") or args.language or "pt")

    if not transcript:
        print(json.dumps({"words": [], "warnings": ["Transcript vazio"]}))
        return 0

    try:
        import torch  # type: ignore
        import whisperx  # type: ignore
    except ImportError as exc:
        sys.stderr.write(f"WhisperX dependencies not installed: {exc}\n")
        return 2

    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        audio = whisperx.load_audio(audio_path)
        duration = float(len(audio)) / 16000.0
        model_a, metadata = whisperx.load_align_model(language_code=language, device=device)
        segments = [{"text": transcript, "start": 0.0, "end": max(0.2, duration)}]
        aligned = whisperx.align(
            segments,
            model_a,
            metadata,
            audio,
            device,
            return_char_alignments=False,
        )
        word_segments = aligned.get("word_segments", [])
        words = []
        cursor = 0.0
        for item in word_segments:
            w = str(item.get("word", "")).strip()
            if not w:
                continue
            start = float(item.get("start", cursor))
            end = float(item.get("end", start + 0.1))
            if end <= start:
                end = start + 0.05
            score = item.get("score")
            entry = {
                "text": w,
                "startSeconds": round(max(cursor, start), 4),
                "endSeconds": round(max(cursor + 0.02, end), 4),
            }
            if isinstance(score, (int, float)):
                entry["confidence"] = round(min(1.0, max(0.0, float(score))), 4)
            words.append(entry)
            cursor = entry["endSeconds"]

        print(json.dumps({"words": words, "warnings": []}, ensure_ascii=False))
        return 0
    except Exception as exc:
        sys.stderr.write(f"Forced alignment runtime error: {exc}\n")
        return 3


if __name__ == "__main__":
    sys.exit(main())
