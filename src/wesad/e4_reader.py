"""Streaming reader for the Empatica E4 CSV files distributed with WESAD."""

from __future__ import annotations

import csv
from heapq import merge
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator


SENSORS = ("ACC", "BVP", "EDA", "HR", "IBI", "TEMP")
UNITS = {
    "ACC": "raw",
    "BVP": "raw",
    "EDA": "uS",
    "HR": "bpm",
    "IBI": "seconds",
    "TEMP": "C",
}


def _number(value: str) -> float:
    return float(value.strip())


def _timestamp(epoch_seconds: float) -> str:
    return datetime.fromtimestamp(epoch_seconds, timezone.utc).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")


def iter_sensor_samples(
    csv_path: Path, subject_id: str, sensor: str
) -> Iterator[dict[str, object]]:
    """Yield normalized records one row at a time from one E4 CSV file."""
    sensor = sensor.upper()
    with csv_path.open("r", newline="", encoding="utf-8-sig") as handle:
        rows = csv.reader(handle)
        first = next(rows, None)
        second = next(rows, None)
        if not first or not second:
            return

        start_epoch = _number(first[0])
        if sensor == "IBI":
            for index, row in enumerate(rows):
                if len(row) < 2 or not row[0].strip() or not row[1].strip():
                    continue
                offset = _number(row[0])
                yield {
                    "subject_id": subject_id,
                    "timestamp": _timestamp(start_epoch + offset),
                    "sensor": sensor,
                    "unit": UNITS[sensor],
                    "sample_index": index,
                    "value": {"interval": _number(row[1]), "offset": offset},
                }
            return

        sample_rate = _number(second[0])
        if sample_rate <= 0:
            raise ValueError(f"Invalid sample rate in {csv_path}: {second!r}")

        sample_index = 0
        for row in rows:
            values = [cell.strip() for cell in row if cell.strip()]
            if not values:
                continue
            if sensor == "ACC":
                if len(values) < 3:
                    continue
                value: object = {
                    "x": _number(values[0]),
                    "y": _number(values[1]),
                    "z": _number(values[2]),
                }
            else:
                value = _number(values[0])

            yield {
                "subject_id": subject_id,
                "timestamp": _timestamp(start_epoch + sample_index / sample_rate),
                "sensor": sensor,
                "unit": UNITS[sensor],
                "sample_index": sample_index,
                "value": value,
            }
            sample_index += 1


def iter_subject_samples(
    subject_dir: Path, sensors: tuple[str, ...] = SENSORS
) -> Iterator[dict[str, object]]:
    """Merge the requested E4 streams in event-time order for one subject."""
    subject_id = subject_dir.name
    e4_dir = subject_dir / f"{subject_id}_E4_Data"
    streams = [
        iter_sensor_samples(e4_dir / f"{sensor}.csv", subject_id, sensor)
        for sensor in sensors
        if (e4_dir / f"{sensor}.csv").is_file()
    ]
    yield from merge(*streams, key=lambda record: record["timestamp"])
