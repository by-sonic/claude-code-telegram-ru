# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "faster-whisper>=1.1.0",
#   "nvidia-cublas-cu12",
#   "nvidia-cudnn-cu12>=9.0",
# ]
# ///
"""Transcribe an audio file to plain text. Built for Telegram voice notes.

Run via uv, which resolves the deps above into a cached env on first use:

    uv run voice2text.py <audio-file>

stdout carries the transcript and nothing else, so a caller can capture it
directly. Progress, device choice, and timings go to stderr.

Exit codes: 0 ok, 2 bad input, 3 transcription failed.
"""

from __future__ import annotations

import argparse
import os
import site
import sys
import time
from pathlib import Path

DEFAULT_MODEL = "large-v3-turbo"
DEFAULT_LANG = "ru"

# ЗАМЕНИ ПОД СЕБЯ: сюда идут названия твоих проектов и технологий.
#
# Смещает декодирование в сторону этих слов. Без подсказки латинские названия в русской
# речи распознаются на слух и превращаются в мусор — «PostgreSQL» становится
# «постгресс куль», названия продуктов калечатся до неузнаваемости.
#
# Это не жёсткий словарь, а подсказка, и список должен быть коротким: раздутый
# заставляет модель вставлять эти слова там, где их не было.
DOMAIN_HINT = (
    "Обсуждаем разработку: Docker, Kubernetes, PostgreSQL, Redis, Nginx, "
    "React, Next.js, Python, TypeScript, Telegram, Android, Windows, "
    "прод, сервер, деплой, репозиторий, коммит, бэкенд, фронтенд, миграция, эндпоинт."
)

# Telegram caps bot downloads at 20MB, so anything past this is not a voice note
# and is probably a mistake we shouldn't spend GPU minutes on.
MAX_INPUT_BYTES = 25 * 1024 * 1024


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def nvidia_roots() -> list[Path]:
    """Every site-packages/nvidia directory reachable from this interpreter.

    site.getsitepackages() alone is not enough under `uv run`: it reports the
    ephemeral build directory, while the CUDA wheels stay in uv's content cache
    (archive-v0/<hash>/Lib/site-packages) and are wired in through sys.path.
    Scanning only getsitepackages() finds nothing, and cuBLAS then fails to load.
    """
    roots: list[Path] = []

    # The installed package knows its own location — the most reliable source.
    try:
        import nvidia  # noqa: PLC0415 — intentionally late, may be absent on CPU-only installs
        roots.extend(Path(p) for p in getattr(nvidia, "__path__", []))
    except ImportError:
        pass

    candidates = list(sys.path)
    try:
        candidates += site.getsitepackages()
    except AttributeError:
        pass
    for entry in candidates:
        if not entry:
            continue
        nv = Path(entry) / "nvidia"
        if nv.is_dir():
            roots.append(nv)

    # dict.fromkeys keeps first-seen order while removing duplicates.
    return list(dict.fromkeys(roots))


def register_cuda_libs() -> int:
    """Put the pip-installed CUDA DLLs on the loader's search path.

    CTranslate2 links cuBLAS and cuDNN by name. The wheels drop them in
    nvidia/*/bin, which Windows does not search by default. Returns how many
    directories were registered so a failure is diagnosable from the log.
    """
    if not hasattr(os, "add_dll_directory"):
        return 0  # POSIX wheels carry a working rpath

    registered = 0
    for root in nvidia_roots():
        for bin_dir in root.rglob("bin"):
            if not bin_dir.is_dir():
                continue
            try:
                os.add_dll_directory(str(bin_dir))
            except OSError as err:
                log(f"[warn] не смог зарегистрировать {bin_dir}: {err}")
                continue
            # Some CTranslate2 builds resolve through PATH rather than the
            # per-process DLL directory list, so cover both.
            os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"
            registered += 1
    return registered


def transcribe(audio: Path, requested_device: str, model_name: str, lang: str, hint: str):
    """Return (text, info, device_label), preferring GPU but never dying on its account.

    The whole transcription lives inside the retry, not just the constructor:
    model.transcribe() hands back a lazy generator, so the CUDA libraries are
    only touched once the segments are consumed. Wrapping construction alone
    lets a "cublas64_12.dll cannot be loaded" escape past the CPU fallback.
    """
    from faster_whisper import WhisperModel

    attempts: list[tuple[str, str]] = []
    if requested_device in ("auto", "cuda"):
        attempts.append(("cuda", "float16"))
    if requested_device in ("auto", "cpu"):
        attempts.append(("cpu", "int8"))

    last_err: Exception | None = None
    for device, compute_type in attempts:
        try:
            log(f"[info] загружаю {model_name} на {device} ({compute_type})")
            model = WhisperModel(model_name, device=device, compute_type=compute_type)
            segments, info = model.transcribe(
                str(audio),
                language=None if lang == "auto" else lang,
                # Trims silence so a note with long pauses doesn't invite hallucinated
                # filler, which whisper is prone to on empty audio.
                vad_filter=True,
                beam_size=5,
                initial_prompt=hint or None,
            )
            text = " ".join(seg.text.strip() for seg in segments).strip()
            return text, info, f"{device}/{compute_type}"
        except Exception as err:  # noqa: BLE001 — any CUDA/driver fault means try CPU
            last_err = err
            log(f"[warn] {device} не сработал: {type(err).__name__}: {err}")

    raise RuntimeError(f"не осталось рабочих устройств: {last_err}")


def force_utf8_output() -> None:
    """Pin stdout/stderr to UTF-8.

    Windows Python encodes piped output with the locale codepage, not UTF-8. When
    that codepage can't represent Cyrillic, every letter becomes '?' — the
    transcript arrives structurally intact but unreadable, and the caller has no
    way to tell it apart from a genuinely bad transcription.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


def main() -> int:
    force_utf8_output()
    parser = argparse.ArgumentParser(description="Transcribe audio to plain text.")
    parser.add_argument("audio", help="Path to the audio file (ogg/opus, mp3, wav, m4a...)")
    parser.add_argument("--lang", default=DEFAULT_LANG,
                        help=f"Spoken language, or 'auto' to detect. Default: {DEFAULT_LANG}")
    parser.add_argument("--model", default=DEFAULT_MODEL,
                        help=f"faster-whisper model name. Default: {DEFAULT_MODEL}")
    parser.add_argument("--device", default="auto", choices=("auto", "cuda", "cpu"),
                        help="Where to run. 'auto' tries CUDA then falls back to CPU.")
    parser.add_argument("--hint", default=DOMAIN_HINT,
                        help="Vocabulary hint biasing decoding. Pass '' to disable.")
    args = parser.parse_args()

    audio = Path(args.audio).expanduser()
    if not audio.is_file():
        log(f"[error] не файл: {audio}")
        return 2
    size = audio.stat().st_size
    if size == 0:
        log(f"[error] пустой файл: {audio}")
        return 2
    if size > MAX_INPUT_BYTES:
        log(f"[error] {size / 1e6:.1f}МБ больше лимита {MAX_INPUT_BYTES / 1e6:.0f}МБ: {audio}")
        return 2

    registered = register_cuda_libs()
    log(f"[info] каталогов CUDA-библиотек зарегистрировано: {registered}")

    started = time.monotonic()
    try:
        text, info, device_label = transcribe(audio, args.device, args.model, args.lang, args.hint)
    except Exception as err:  # noqa: BLE001 — surface the reason, don't traceback at the caller
        log(f"[error] расшифровка не удалась: {type(err).__name__}: {err}")
        return 3

    elapsed = time.monotonic() - started
    log(f"[info] {device_label} · аудио {info.duration:.1f}с · язык {info.language} "
        f"({info.language_probability:.2f}) · заняло {elapsed:.1f}с")

    if not text:
        log("[warn] речь не распознана")
        return 0

    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
