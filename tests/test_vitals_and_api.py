from __future__ import annotations

import os
import pickle
from pathlib import Path
import sys
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "src"))
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

os.environ["WESAD_DEMO_MODE"] = "1"

from wesad.demo_simulator import synthesize_ppg_bvp  # noqa: E402
from wesad.features import SAMPLE_RATES_HZ, sensor_features  # noqa: E402
from wesad.pickle_reader import iter_pickle_sensor_samples  # noqa: E402
from wesad.vitals import (  # noqa: E402
    derive_hr_stream_from_bvp,
    estimate_pulse_from_bvp,
    summarize_window_vitals,
)


def test_estimate_pulse_from_bvp_resting_and_tachycardia() -> None:
    rng = np.random.default_rng(123)
    bvp_calm = synthesize_ppg_bvp(
        rng=rng,
        duration_seconds=30,
        target_hr_bpm=72.0,
        target_rmssd_ms=42.0,
        amplitude=80.0,
        sample_rate_hz=64,
    )
    res_calm = estimate_pulse_from_bvp(bvp_calm, sample_rate_hz=64.0)
    assert res_calm["hr_bpm"] is not None
    assert 68.0 <= float(res_calm["hr_bpm"]) <= 76.0
    assert res_calm["hrv_rmssd_ms"] is not None
    assert float(res_calm["hrv_rmssd_ms"]) >= 22.0

    bvp_stress = synthesize_ppg_bvp(
        rng=rng,
        duration_seconds=30,
        target_hr_bpm=108.0,
        target_rmssd_ms=15.0,
        amplitude=160.0,
        sample_rate_hz=64,
    )
    res_stress = estimate_pulse_from_bvp(bvp_stress, sample_rate_hz=64.0)
    assert res_stress["hr_bpm"] is not None
    assert 102.0 <= float(res_stress["hr_bpm"]) <= 114.0
    assert res_stress["hrv_rmssd_ms"] is not None
    assert float(res_stress["hrv_rmssd_ms"]) < float(res_calm["hrv_rmssd_ms"])


def test_pickle_reader_synthesizes_hr_stream_and_slices_offset(tmp_path: Path) -> None:
    subj_dir = tmp_path / "S4"
    e4_dir = subj_dir / "S4_E4_Data"
    e4_dir.mkdir(parents=True)
    origin = 1500000000.0
    for sensor, rate in SAMPLE_RATES_HZ.items():
        (e4_dir / f"{sensor}.csv").write_text(f"{origin}\n{rate}\n0\n", encoding="utf-8")

    rng = np.random.default_rng(7)
    dur = 25
    bvp = synthesize_ppg_bvp(rng, dur, target_hr_bpm=80.0, target_rmssd_ms=30.0, amplitude=90.0)
    payload = {
        "signal": {
            "wrist": {
                "ACC": np.tile(np.array([[38.0, 24.0, 45.0]]), (dur * 32, 1)),
                "BVP": bvp.reshape(-1, 1),
                "EDA": np.full((dur * 4, 1), 1.2),
                "TEMP": np.full((dur * 4, 1), 32.8),
            }
        }
    }
    with (subj_dir / "S4.pkl").open("wb") as handle:
        pickle.dump(payload, handle)

    records = list(
        iter_pickle_sensor_samples(
            subj_dir,
            sensors=("ACC", "BVP", "EDA", "HR", "TEMP"),
            start_offset_seconds=10.0,
            duration_seconds=10.0,
        )
    )
    sensors_seen = {str(r["sensor"]) for r in records}
    assert sensors_seen == {"ACC", "BVP", "EDA", "HR", "TEMP"}
    hr_values = [float(r["value"]) for r in records if r["sensor"] == "HR"]
    assert len(hr_values) >= 8
    assert all(72.0 <= v <= 88.0 for v in hr_values)


def test_motion_confounder_suppresses_false_stress() -> None:
    rng = np.random.default_rng(99)
    bvp = synthesize_ppg_bvp(rng, 30, target_hr_bpm=122.0, target_rmssd_ms=20.0, amplitude=100.0)
    t_acc = np.arange(30 * 32) / 32.0
    acc = np.column_stack(
        [
            38.0 + 9.5 * np.sin(2 * np.pi * 1.9 * t_acc),
            24.0 + 5.0 * np.cos(2 * np.pi * 1.9 * t_acc),
            45.0 + 4.0 * np.sin(2 * np.pi * 1.9 * t_acc),
        ]
    )
    eda = np.full(30 * 4, 1.8)
    temp = np.full(30 * 4, 32.4)
    raw = {"ACC": acc, "BVP": bvp, "EDA": eda, "TEMP": temp}
    feats: list[float] = []
    for s in SAMPLE_RATES_HZ:
        stats = sensor_features(s, raw[s])
        assert stats is not None
        feats.extend(stats)

    vitals = summarize_window_vitals(
        window_samples={
            "ACC": [{"x": float(r[0]), "y": float(r[1]), "z": float(r[2])} for r in acc],
            "BVP": bvp.tolist(),
            "EDA": eda.tolist(),
            "TEMP": temp.tolist(),
        },
        features=feats,
        model_score_stress=0.62,
        baseline_hr_bpm=72.0,
        baseline_eda_us=0.6,
    )
    assert vitals["activity_state"] == "HIGH_ACTIVITY"
    assert vitals["heart_anomaly"] == "ELEVATED_WITH_MOTION"
    assert vitals["stress_load"] < 48
    assert any(rc["code"] == "MOTION_CONTEXT" for rc in vitals["reason_codes"])


def test_device_manager_and_registry_demo_endpoints() -> None:
    from scripts.device_manager_api import app as device_app
    from wesad.model_registry import app as registry_app

    with TestClient(registry_app) as reg_client:
        r_health = reg_client.get("/health")
        assert r_health.status_code == 200
        models = reg_client.get("/models").json()
        assert len(models) >= 2
        act = reg_client.put("/models/v1.0.0/activate")
        assert act.status_code == 200
        assert reg_client.get("/models/active").json()["version"] == "v1.0.0"

    with TestClient(device_app) as dev_client:
        assert dev_client.get("/health").status_code == 200
        scenarios = dev_client.get("/scenarios").json()
        assert len(scenarios) == 4
        tl = dev_client.get("/devices/S4/timeline").json()
        assert tl["subject_id"] == "S4"
        assert len(tl["predictions"]) == 8
        assert len(tl["spark_series"]) == 24
        assert tl["summary"]["recovery_seconds"] is not None

        first_ws = tl["predictions"][0]["window_start"]
        fb = dev_client.post(
            "/feedback",
            json={
                "subject_id": "S4",
                "window_start": first_ws,
                "verdict": "ACCURATE",
                "note": "Đúng lúc đang thuyết trình",
            },
        )
        assert fb.status_code == 200
        tl2 = dev_client.get("/devices/S4/timeline").json()
        assert tl2["predictions"][0]["feedback"]["verdict"] == "ACCURATE"
