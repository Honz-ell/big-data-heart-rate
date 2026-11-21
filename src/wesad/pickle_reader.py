"""Read synchronized WESAD wrist signals from a participant pickle file."""

from __future__ import annotations

import csv
import pickle
from datetime import datetime, timezone
from heapq import merge
from pathlib import Path
from typing import Iterator

import numpy as np

from wesad.e4_reader import UNITS, iter_sensor_samples
from wesad.features import SAMPLE_RATES_HZ


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
