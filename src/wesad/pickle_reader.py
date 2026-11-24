"""Read synchronized WESAD wrist signals from a participant pickle file."""

from __future__ import annotations

import csv
import pickle
from datetime import datetime, timezone
from functools import lru_cache
from heapq import merge
from pathlib import Path
from typing import Iterator
import warnings

import numpy as np

from wesad.e4_reader import UNITS, iter_sensor_samples
from wesad.features import SAMPLE_RATES_HZ


def recording_origin_epoch(subject_dir: Path, sensors: tuple[str, ...]) -> float:
    """Legacy fallback based on CSV headers; not safe for aligning pickle channels."""
    e4_dir = subject_dir / f"{subject_dir.name}_E4_Data"
    starts: list[float] = []
    for sensor in sensors:
        if sensor not in SAMPLE_RATES_HZ:
            continue
        path = e4_dir / f"{sensor}.csv"
        if not path.is_file():
            continue
        with path.open("r", newline="", encoding="utf-8-sig") as handle:
            first = next(csv.reader(handle), None)
        if not first or not first[0].strip():
            raise ValueError(f"Không đọc được mốc thời gian trong {path}")
        starts.append(float(first[0]))
    if not starts:
        # Fallback deterministic epoch if companion CSV headers are absent
        return 1497342820.0
    return min(starts)


def _read_csv_bvp(path: Path) -> tuple[float, float, np.ndarray]:
    with path.open("r", newline="", encoding="utf-8-sig") as handle:
        rows = csv.reader(handle)
        start_row = next(rows, None)
        rate_row = next(rows, None)
        if not start_row or not rate_row:
            raise ValueError(f"Thiếu header BVP trong {path}")
        start_epoch = float(start_row[0])
        rate_hz = float(rate_row[0])
        values = [float(row[0]) for row in rows if row and row[0].strip()]
    if rate_hz <= 0 or not values:
        raise ValueError(f"Không đọc được mẫu BVP hợp lệ trong {path}")
    return start_epoch, rate_hz, np.asarray(values, dtype=np.float64)


def _best_normalized_match_offset(
    reference: np.ndarray, recording: np.ndarray, rate_hz: float
) -> tuple[float, float]:
    """Find where a short pickle BVP excerpt occurs in the E4 BVP CSV."""
    samples = max(8, int(round(20.0 * rate_hz)))
    reference = np.asarray(reference, dtype=np.float64).reshape(-1)
    recording = np.asarray(recording, dtype=np.float64).reshape(-1)
    if reference.size < samples or recording.size < samples:
        raise ValueError("BVP không đủ dài để căn chỉnh")
    reference = np.nan_to_num(reference, copy=False)
    recording = np.nan_to_num(recording, copy=False)

    possible_starts = reference.size - samples
    starts = sorted(
        {
            0,
            min(possible_starts, int(300 * rate_hz)),
            min(possible_starts, int(1800 * rate_hz)),
        }
    )
    offsets: list[float] = []
    confidences: list[float] = []
    prefix_sum = np.concatenate(([0.0], np.cumsum(recording, dtype=np.float64)))
    prefix_square = np.concatenate(([0.0], np.cumsum(np.square(recording), dtype=np.float64)))
    window_sum = prefix_sum[samples:] - prefix_sum[:-samples]
    window_square = prefix_square[samples:] - prefix_square[:-samples]

    fft_size = 1 << int(np.ceil(np.log2(recording.size + samples - 1)))
    recording_fft = np.fft.rfft(recording, fft_size)
    for start in starts:
        excerpt = reference[start : start + samples]
        excerpt = excerpt - float(np.mean(excerpt))
        excerpt_variance = float(np.dot(excerpt, excerpt))
        if excerpt_variance < 1e-12:
            continue
        convolution = np.fft.irfft(
            recording_fft * np.fft.rfft(excerpt[::-1], fft_size), fft_size
        )[: recording.size + samples - 1]
        dot_products = convolution[samples - 1 : recording.size]
        covariance = dot_products - window_sum * float(np.mean(excerpt))
        window_variance = np.maximum(
            window_square - np.square(window_sum) / samples, 0.0
        )
        denominator = np.sqrt(window_variance * excerpt_variance)
        correlations = np.divide(
            covariance,
            denominator,
            out=np.zeros_like(covariance),
            where=denominator > 1e-12,
        )
        lag = int(np.argmax(np.abs(correlations)))
        confidence = float(abs(correlations[lag]))
        offsets.append(lag / rate_hz - start / rate_hz)
        confidences.append(confidence)

    if not offsets or min(confidences) < 0.97:
        raise ValueError("Không tìm được đoạn BVP tương ứng đủ tin cậy")
    if max(offsets) - min(offsets) > max(0.05, 2.0 / rate_hz):
        raise ValueError("Độ lệch BVP thay đổi giữa các đoạn; không thể căn chỉnh an toàn")
    return float(np.median(offsets)), float(min(confidences))


def calibrate_pickle_origin_epoch(
    subject_dir: Path, pickle_bvp: np.ndarray
) -> tuple[float, bool]:
    e4_dir = subject_dir / f"{subject_dir.name}_E4_Data"
    bvp_csv = e4_dir / "BVP.csv"
    if not bvp_csv.is_file():
        return recording_origin_epoch(subject_dir, ("ACC", "BVP", "EDA", "TEMP")), False
    try:
        csv_start, csv_rate, csv_bvp = _read_csv_bvp(bvp_csv)
        pickle_rate = float(SAMPLE_RATES_HZ["BVP"])
        if abs(csv_rate - pickle_rate) > 1e-6:
            raise ValueError(f"BVP sample rate khác nhau: pickle={pickle_rate:g}, CSV={csv_rate:g}")
        offset_seconds, _confidence = _best_normalized_match_offset(
            pickle_bvp, csv_bvp, pickle_rate
        )
        return csv_start + offset_seconds, True
    except (OSError, ValueError, IndexError) as error:
        warnings.warn(
            f"{subject_dir.name}: không căn được mốc pickle với BVP.csv ({error}); "
            "không dùng mốc ước đoán để tránh phát dữ liệu lệch thời gian.",
            RuntimeWarning,
            stacklevel=2,
        )
        return recording_origin_epoch(subject_dir, ("ACC", "BVP", "EDA", "TEMP")), False


@lru_cache(maxsize=32)
def _cached_pickle_origin(
    subject_path: str, pickle_mtime_ns: int, bvp_mtime_ns: int
) -> float:
    subject_dir = Path(subject_path)
    with (subject_dir / f"{subject_dir.name}.pkl").open("rb") as handle:
        payload = pickle.load(handle, encoding="latin1")
    wrist = payload["signal"]["wrist"]
    bvp = next(
        value
        for key, value in wrist.items()
        if (key.decode("latin1") if isinstance(key, bytes) else str(key)).upper() == "BVP"
    )
    origin_epoch, aligned = calibrate_pickle_origin_epoch(subject_dir, np.asarray(bvp))
    if not aligned:
        raise ValueError(
            f"{subject_dir.name}: không xác minh được mốc thời gian pickle với BVP.csv"
        )
    return origin_epoch


def pickle_wrist_origin_epoch(subject_dir: Path) -> float:
    """Return the actual E4 epoch corresponding to sample zero of the pickle wrist arrays."""
    pkl_path = subject_dir / f"{subject_dir.name}.pkl"
    bvp_path = subject_dir / f"{subject_dir.name}_E4_Data" / "BVP.csv"
    pkl_mtime = pkl_path.stat().st_mtime_ns if pkl_path.is_file() else 0
    bvp_mtime = bvp_path.stat().st_mtime_ns if bvp_path.is_file() else 0
    return _cached_pickle_origin(str(subject_dir.resolve()), pkl_mtime, bvp_mtime)


def iter_pickle_sensor_samples(
    subject_dir: Path,
    sensors: tuple[str, ...] = ("ACC", "BVP", "EDA", "TEMP"),
    start_offset_seconds: float = 0.0,
    duration_seconds: float = 0.0,
) -> Iterator[dict[str, object]]:
    """Yield synchronized wrist samples (plus BVP-derived 1 Hz HR when requested) from WESAD pickle."""
    pkl_path = subject_dir / f"{subject_dir.name}.pkl"
    with pkl_path.open("rb") as handle:
        payload = pickle.load(handle, encoding="latin1")

    wrist = payload["signal"]["wrist"]
    wrist_by_name = {
        (key.decode("latin1") if isinstance(key, bytes) else str(key)).upper(): value
        for key, value in wrist.items()
    }
    available = tuple(
        sensor for sensor in sensors
        if sensor in SAMPLE_RATES_HZ and sensor in wrist_by_name
    )
    e4_dir = subject_dir / f"{subject_dir.name}_E4_Data"
    csv_channels = tuple(
        sensor for sensor in ("HR", "IBI")
        if sensor in sensors and (e4_dir / f"{sensor}.csv").is_file()
    )
    missing = [
        sensor
        for sensor in sensors
        if sensor not in available and sensor not in csv_channels
    ]
    if missing:
        print(f"Pickle wrist không có kênh: {', '.join(missing)}; bỏ qua các kênh này.")
    if not available and not csv_channels:
        raise ValueError(f"Không có kênh wrist phù hợp trong {pkl_path}")

    pickle_bvp = wrist_by_name.get("BVP")
    if pickle_bvp is None:
        raise ValueError(
            f"{subject_dir.name}: pickle wrist thiếu BVP; không thể xác minh timestamp với E4 CSV"
        )
    origin_epoch, aligned_to_csv = calibrate_pickle_origin_epoch(
        subject_dir, np.asarray(pickle_bvp)
    )
    if not aligned_to_csv:
        raise ValueError(
            f"{subject_dir.name}: từ chối phát pickle vì không căn được timestamp với BVP.csv"
        )
    start_sec = max(0.0, float(start_offset_seconds))
    end_sec = (start_sec + float(duration_seconds)) if duration_seconds > 0 else None

    def sensor_stream(sensor: str) -> Iterator[dict[str, object]]:
        values = wrist_by_name[sensor]
        rate = float(SAMPLE_RATES_HZ[sensor])
        start_idx = int(start_sec * rate)
        stop_idx = len(values) if end_sec is None else min(len(values), int(np.ceil(end_sec * rate)))
        for index in range(start_idx, stop_idx):
            timestamp = datetime.fromtimestamp(
                origin_epoch + index / rate, timezone.utc
            ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            if sensor == "ACC":
                row = values[index]
                value: object = {
                    "x": float(row[0]),
                    "y": float(row[1]),
                    "z": float(row[2]),
                }
            else:
                row = values[index]
                value = float(row[0] if hasattr(row, "__len__") else row)
            yield {
                "subject_id": subject_dir.name,
                "timestamp": timestamp,
                "sensor": sensor,
                "unit": UNITS[sensor],
                "sample_index": index,
                "value": value,
            }

    def csv_channel_stream(sensor: str) -> Iterator[dict[str, object]]:
        path = e4_dir / f"{sensor}.csv"
        for record in iter_sensor_samples(path, subject_dir.name, sensor):
            event_epoch = datetime.fromisoformat(
                str(record["timestamp"]).replace("Z", "+00:00")
            ).timestamp()
            offset = event_epoch - origin_epoch
            if offset < start_sec:
                continue
            if end_sec is not None and offset >= end_sec:
                break
            yield record

    streams: list[Iterator[dict[str, object]]] = [sensor_stream(sensor) for sensor in available]
    streams.extend(csv_channel_stream(sensor) for sensor in csv_channels)
    yield from merge(*streams, key=lambda record: str(record["timestamp"]))
