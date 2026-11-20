"""Feature definitions shared by WESAD training and edge replay."""

from __future__ import annotations

import numpy as np


SAMPLE_RATES_HZ = {"ACC": 32, "BVP": 64, "EDA": 4, "TEMP": 4}
FEATURE_STATS = ("mean", "std", "min", "max")
FEATURE_NAMES = tuple(
    f"{sensor.lower()}_{stat}"
    for sensor in SAMPLE_RATES_HZ
    for stat in FEATURE_STATS
)


def sensor_features(sensor: str, samples: np.ndarray) -> list[float] | None:
    values = np.asarray(samples, dtype=np.float64)
    if sensor == "ACC":
        if values.ndim != 2 or values.shape[1] < 3:
            return None
        valid_rows = np.isfinite(values[:, :3]).all(axis=1)
        values = np.linalg.norm(values[valid_rows, :3], axis=1)
    else:
        values = values.reshape(-1)
        values = values[np.isfinite(values)]
        if sensor == "EDA":
            values = values[values >= 0]
        elif sensor == "TEMP":
            values = values[(values >= 20.0) & (values <= 45.0)]

    if values.size == 0:
        return None
    return [
        float(np.mean(values)),
        float(np.std(values)),
        float(np.min(values)),
        float(np.max(values)),
    ]
