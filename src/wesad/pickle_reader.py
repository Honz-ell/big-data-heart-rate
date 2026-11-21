"""Read synchronized WESAD wrist signals from a participant pickle file."""

from __future__ import annotations

import csv
import pickle
from datetime import datetime, timezone
from heapq import merge
from pathlib import Path
from typing import Iterator

import numpy as np

from wesad.e4_reader import UNITS
from wesad.features import SAMPLE_RATES_HZ
from wesad.vitals import derive_hr_stream_from_bvp


def recording_origin_epoch(subject_dir: Path, sensors: tuple[str, ...]) -> float:
    """Use the earliest E4 header time as the shared epoch for synchronized pickle arrays."""
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
    wants_hr = "HR" in sensors and "BVP" in wrist_by_name
    missing = [
        sensor
        for sensor in sensors
        if sensor not in available and not (sensor == "HR" and wants_hr)
    ]
    if missing:
        print(f"Pickle wrist không có kênh: {', '.join(missing)}; bỏ qua các kênh này.")
    if not available and not wants_hr:
        raise ValueError(f"Không có kênh wrist phù hợp trong {pkl_path}")

    origin_sensors = available if available else ("BVP",)
    origin_epoch = recording_origin_epoch(subject_dir, origin_sensors)
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

    def derived_hr_stream() -> Iterator[dict[str, object]]:
        bvp_all = np.asarray(wrist_by_name["BVP"], dtype=np.float64).reshape(-1)
        bvp_rate = float(SAMPLE_RATES_HZ["BVP"])
        lookback_sec = 8.0
        slice_start_sec = max(0.0, start_sec - lookback_sec)
        s_idx = int(slice_start_sec * bvp_rate)
        e_idx = bvp_all.size if end_sec is None else min(bvp_all.size, int(np.ceil(end_sec * bvp_rate)))
        hr_points = derive_hr_stream_from_bvp(
            bvp_all[s_idx:e_idx],
            sample_rate_hz=bvp_rate,
            window_seconds=lookback_sec,
            step_seconds=1.0,
        )
        for rel_offset_sec, hr_bpm in hr_points:
            abs_offset_sec = slice_start_sec + rel_offset_sec
            if abs_offset_sec < start_sec:
                continue
            if end_sec is not None and abs_offset_sec >= end_sec:
                break
            hr_index = int(round(abs_offset_sec))
            timestamp = datetime.fromtimestamp(
                origin_epoch + abs_offset_sec, timezone.utc
            ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            yield {
                "subject_id": subject_dir.name,
                "timestamp": timestamp,
                "sensor": "HR",
                "unit": UNITS["HR"],
                "sample_index": hr_index,
                "value": float(hr_bpm),
            }

    streams: list[Iterator[dict[str, object]]] = [sensor_stream(sensor) for sensor in available]
    if wants_hr:
        streams.append(derived_hr_stream())
    yield from merge(*streams, key=lambda record: str(record["timestamp"]))
