"""Read synchronized WESAD wrist signals from a participant pickle file."""

from __future__ import annotations

import csv
import pickle
from datetime import datetime, timezone
from heapq import merge
from pathlib import Path
from typing import Iterator

from wesad.e4_reader import UNITS
from wesad.features import SAMPLE_RATES_HZ


def recording_origin_epoch(subject_dir: Path, sensors: tuple[str, ...]) -> float:
    """Use the earliest E4 header time as the shared epoch for synchronized pickle arrays."""
    e4_dir = subject_dir / f"{subject_dir.name}_E4_Data"
    starts: list[float] = []
    for sensor in sensors:
        if sensor not in SAMPLE_RATES_HZ:
            continue
        path = e4_dir / f"{sensor}.csv"
        with path.open("r", newline="", encoding="utf-8-sig") as handle:
            first = next(csv.reader(handle), None)
        if not first or not first[0].strip():
            raise ValueError(f"Không đọc được mốc thời gian trong {path}")
        starts.append(float(first[0]))
    if not starts:
        raise ValueError(f"Không tìm thấy header E4 cho cảm biến {sensors}")
    return min(starts)


def iter_pickle_sensor_samples(
    subject_dir: Path, sensors: tuple[str, ...] = ("ACC", "BVP", "EDA", "TEMP")
) -> Iterator[dict[str, object]]:
    """Yield synchronized wrist samples from one subject's WESAD pickle."""
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
    missing = [sensor for sensor in sensors if sensor not in available]
    if missing:
        print(f"Pickle wrist không có kênh: {', '.join(missing)}; bỏ qua các kênh này.")
    if not available:
        raise ValueError(f"Không có kênh wrist phù hợp trong {pkl_path}")

    origin_epoch = recording_origin_epoch(subject_dir, available)

    def sensor_stream(sensor: str) -> Iterator[dict[str, object]]:
        values = wrist_by_name[sensor]
        rate = SAMPLE_RATES_HZ[sensor]
        for index in range(len(values)):
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

    streams = (sensor_stream(sensor) for sensor in available)
    yield from merge(*streams, key=lambda record: record["timestamp"])
