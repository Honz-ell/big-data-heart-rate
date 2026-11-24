from __future__ import annotations

import os
import pickle
from pathlib import Path
import sys

import numpy as np
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "src"))
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

os.environ["WESAD_DEMO_MODE"] = "1"

from wesad.demo_simulator import synthesize_ppg_bvp  # noqa: E402
from wesad.features import SAMPLE_RATES_HZ, sensor_features  # noqa: E402
from wesad.pickle_reader import calibrate_pickle_origin_epoch, iter_pickle_sensor_samples  # noqa: E402
from wesad.vitals import (  # noqa: E402
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


def test_pickle_reader_calibrates_bvp_offset_and_joins_csv_hr(tmp_path: Path) -> None:
    subj_dir = tmp_path / "S4"
    e4_dir = subj_dir / "S4_E4_Data"
    e4_dir.mkdir(parents=True)
    csv_origin = 1500000000.0
    shift_sec = 12.5  # Simulate E4 powered on 12.5s before synchronized pickle start

    rng = np.random.default_rng(7)
    full_bvp = synthesize_ppg_bvp(rng, 45, target_hr_bpm=80.0, target_rmssd_ms=30.0, amplitude=90.0)
    shift_samples = int(round(shift_sec * 64))
    pickle_bvp = full_bvp[shift_samples : shift_samples + 25 * 64]

    (e4_dir / "BVP.csv").write_text(
        f"{csv_origin}\n64\n" + "\n".join(f"{v:.4f}" for v in full_bvp) + "\n",
        encoding="utf-8",
    )
    for sensor in ("ACC", "EDA", "TEMP"):
        rate = SAMPLE_RATES_HZ[sensor]
        (e4_dir / f"{sensor}.csv").write_text(f"{csv_origin}\n{rate}\n0\n", encoding="utf-8")

    # HR.csv starts at csv_origin with 1 Hz samples (80 BPM during the aligned pickle window)
    hr_lines = [f"{78.0 + (i % 3):.1f}" for i in range(45)]
    (e4_dir / "HR.csv").write_text(
        f"{csv_origin}\n1\n" + "\n".join(hr_lines) + "\n",
        encoding="utf-8",
    )

    calibrated_epoch, aligned = calibrate_pickle_origin_epoch(subj_dir, pickle_bvp)
    assert aligned is True
    assert abs(calibrated_epoch - (csv_origin + shift_sec)) < 0.05

    payload = {
        "signal": {
            "wrist": {
                "ACC": np.tile(np.array([[38.0, 24.0, 45.0]]), (25 * 32, 1)),
                "BVP": pickle_bvp.reshape(-1, 1),
                "EDA": np.full((25 * 4, 1), 1.2),
                "TEMP": np.full((25 * 4, 1), 32.8),
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
    assert len(hr_values) >= 9
    assert all(77.0 <= v <= 81.0 for v in hr_values)


def test_vitals_consecutive_ibi_and_motion_context() -> None:
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

    # Provide consecutive IBIs separated by a 6s dropped-beat gap in the middle
    ibi_samples = [
        {"offset": 1.00, "interval": 0.50},
        {"offset": 1.52, "interval": 0.52},
        {"offset": 2.01, "interval": 0.49},
        {"offset": 2.52, "interval": 0.51},
        # 6-second dropped segment: should NOT be diffed against offset=2.52
        {"offset": 8.60, "interval": 0.90},
    ]

    vitals = summarize_window_vitals(
        window_samples={
            "ACC": [{"x": float(r[0]), "y": float(r[1]), "z": float(r[2])} for r in acc],
            "BVP": bvp.tolist(),
            "EDA": eda.tolist(),
            "TEMP": temp.tolist(),
            "HR": [120.0, 122.0, 123.0],
            "IBI": ibi_samples,
        },
        features=feats,
        model_score_stress=0.62,
        baseline_hr_bpm=72.0,
        baseline_eda_us=0.6,
    )
    assert vitals["activity_state"] == "HIGH_ACTIVITY"
    assert vitals["heart_anomaly"] == "NONE"
    assert vitals["stress_load"] == 62
    assert vitals["hrv_rmssd_ms"] is not None
    assert float(vitals["hrv_rmssd_ms"]) < 40.0  # Gap jump (0.90 - 0.51 = 390ms) excluded!
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
        assert dev_client.get("/pipeline/telemetry").status_code == 200
        team_res = dev_client.get("/team/summary")
        assert team_res.status_code == 200
        assert "S4" in team_res.json()["subjects"]
        scenarios = dev_client.get("/scenarios").json()
        assert len(scenarios) == 4
        tl = dev_client.get("/devices/S4/timeline").json()
        assert tl["subject_id"] == "S4"
        assert len(tl["predictions"]) == 8
        assert len(tl["spark_series"]) == 24

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


def test_resolve_subject_scenario_offsets_for_counterbalanced_subject(tmp_path) -> None:
    import pickle
    from wesad.pickle_reader import resolve_subject_scenario_offsets

    subj_dir = tmp_path / "S9"
    e4_dir = subj_dir / "S9_E4_Data"
    e4_dir.mkdir(parents=True)

    # 12 windows of 30s = 360 seconds total:
    # Windows 0..3 (0..120s): Baseline (label == 1), calm ACC, low EDA
    # Windows 4..5 (120..180s): Walking transition (label == 0), high ACC std, low EDA
    # Windows 6..9 (180..300s): TSST Stress (label == 2), calm ACC, high EDA surge
    # Windows 10..11 (300..360s): Meditation recovery (label == 4), calm ACC, low EDA
    total_sec = 360
    labels = np.zeros(total_sec * 700, dtype=np.int32)
    labels[0 : 120 * 700] = 1
    labels[180 * 700 : 300 * 700] = 2
    labels[300 * 700 : 360 * 700] = 4

    rng = np.random.default_rng(9)
    acc = np.column_stack(
        [
            np.full(total_sec * 32, 62.0) + rng.normal(0.0, 0.4, total_sec * 32),
            rng.normal(0.0, 0.4, total_sec * 32),
            rng.normal(0.0, 0.4, total_sec * 32),
        ]
    )
    # Vigorous motion during windows 4..5 (120..180s)
    t_walk = np.arange(60 * 32) / 32.0
    acc[120 * 32 : 180 * 32, 0] += 14.0 * np.sin(2.0 * np.pi * 2.0 * t_walk)

    t_bvp = np.arange(total_sec * 64) / 64.0
    bvp = (25.0 * np.sin(2.0 * np.pi * 1.2 * t_bvp) + rng.normal(0.0, 0.5, t_bvp.size)).reshape(-1, 1)
    eda = np.full((total_sec * 4, 1), 0.35)
    eda[180 * 4 : 300 * 4, 0] = 4.8  # TSST EDA surge on S9 at 180..300s
    temp = np.full((total_sec * 4, 1), 32.8)

    bvp_csv_lines = ["1500000000.000000", "64.000000", *(f"{float(v[0]):.4f}" for v in bvp)]
    (e4_dir / "BVP.csv").write_text("\n".join(bvp_csv_lines) + "\n", encoding="utf-8")

    payload = {
        "label": labels,
        "signal": {"wrist": {"ACC": acc, "BVP": bvp, "EDA": eda, "TEMP": temp}},
    }
    with (subj_dir / "S9.pkl").open("wb") as handle:
        pickle.dump(payload, handle)

    offsets = resolve_subject_scenario_offsets(subj_dir)
    assert 180 <= offsets["tsst_acute_stress"] <= 270
    assert 120 <= offsets["physical_activity_check"] <= 150
    assert offsets["stress_to_recovery"] == 210

