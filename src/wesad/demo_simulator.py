"""Scenario catalog and realistic E4 physiological waveform replay for interactive demos."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np

from wesad.features import SAMPLE_RATES_HZ, sensor_features
from wesad.vitals import estimate_pulse_from_bvp, summarize_window_vitals

SCENARIO_CATALOG: list[dict[str, Any]] = [
    {
        "id": "baseline_calm",
        "title": "Làm việc thư giãn (Baseline)",
        "badge": "Ổn định",
        "tone": "calm",
        "subject_id": "S4",
        "start_offset_seconds": 300,
        "duration_seconds": 180,
        "speed": 30,
        "description": (
            "Pha đọc báo / làm việc nhẹ lúc đầu phiên đo WESAD: cơ thể ngồi tĩnh, "
            "nhịp tim ~70–74 BPM, HRV cao và dẫn điện da (EDA) phẳng."
        ),
        "expected_outcome": "Không phát cảnh báo · Chỉ số căng thẳng thấp (< 30/100)",
    },
    {
        "id": "tsst_acute_stress",
        "title": "Áp lực thuyết trình & tính nhẩm (TSST)",
        "badge": "Stress cấp",
        "tone": "stress",
        "subject_id": "S4",
        "start_offset_seconds": 3690,
        "duration_seconds": 180,
        "speed": 30,
        "description": (
            "Bài kiểm tra Trier Social Stress Test (phỏng vấn & trừ nhẩm trước hội đồng): "
            "người đeo ngồi/đứng tĩnh nhưng nhịp tim vọt > 100 BPM, HRV tụt sâu và EDA tăng vọt."
        ),
        "expected_outcome": "Cảnh báo căng thẳng kéo dài sau ≥ 3 cửa sổ (90s) + gợi ý hít thở",
    },
    {
        "id": "stress_to_recovery",
        "title": "Chuyển pha Áp lực → Phục hồi",
        "badge": "Đa pha",
        "tone": "transition",
        "subject_id": "S4",
        "start_offset_seconds": 4140,
        "duration_seconds": 240,
        "speed": 40,
        "description": (
            "Theo dõi 4 phút từ cuối bài áp lực sang giai đoạn nghỉ thư giãn: "
            "quan sát nhịp tim hạ dần, HRV phục hồi và cảnh báo tự động giải tỏa."
        ),
        "expected_outcome": "Đo được thời gian hồi phục (Recovery Time) sau đỉnh stress",
    },
    {
        "id": "physical_activity_check",
        "title": "Đi bộ nhanh / Leo cầu thang (Chống báo giả)",
        "badge": "Vận động",
        "tone": "motion",
        "subject_id": "S4",
        "start_offset_seconds": 2100,
        "duration_seconds": 180,
        "speed": 30,
        "description": (
            "Nhịp tim tăng lên 118–128 BPM kèm gia tốc cổ tay (ACC) dao động lớn: "
            "minh họa cách đa cảm biến phân biệt tập thể dục với căng thẳng tâm lý lúc nghỉ."
        ),
        "expected_outcome": "Gắn nhãn 'Đang vận động' · Không báo động nhầm nhịp tim bất thường",
    },
]


def synthesize_ppg_bvp(
    rng: np.random.Generator,
    duration_seconds: int,
    target_hr_bpm: float,
    target_rmssd_ms: float,
    amplitude: float,
    sample_rate_hz: int = 64,
) -> np.ndarray:
    """Synthesize a realistic 64 Hz wrist PPG waveform with systolic + dicrotic wave and beat-to-beat HRV."""
    total_samples = duration_seconds * sample_rate_hz
    t = np.arange(total_samples, dtype=np.float64) / float(sample_rate_hz)
    mean_ibi = 60.0 / max(42.0, min(165.0, target_hr_bpm))
    # Beat-to-beat respiratory sinus arrhythmia modulation matching target RMSSD
    beat_sd = (target_rmssd_ms / 1000.0) / np.sqrt(2.0)

    beat_times: list[float] = []
    cursor = 0.25
    idx = 0
    while cursor < duration_seconds + mean_ibi:
        resp_mod = beat_sd * np.sin(2.0 * np.pi * 0.23 * cursor)
        jitter = float(rng.normal(0.0, beat_sd * 0.45))
        ibi = float(np.clip(mean_ibi + resp_mod + jitter, 0.37, 1.45))
        beat_times.append(cursor)
        cursor += ibi
        idx += 1

    signal = np.zeros(total_samples, dtype=np.float64)
    for bt in beat_times:
        dt = t - bt
        mask = (dt >= -0.25) & (dt <= 0.75)
        if not np.any(mask):
            continue
        local = dt[mask]
        # Systolic peak + realistic downward foot (reflectance PPG shape) + dicrotic wave
        systolic = np.exp(-0.5 * np.square(local / 0.062))
        foot = -0.78 * np.exp(-0.5 * np.square((local + 0.095) / 0.055))
        dicrotic = 0.24 * np.exp(-0.5 * np.square((local - 0.23) / 0.072))
        signal[mask] += amplitude * (systolic + foot + dicrotic)

    signal -= np.mean(signal)
    signal += rng.normal(0.0, amplitude * 0.045, size=total_samples)
    return signal


def generate_scenario_windows(
    scenario_id: str,
    subject_id: str,
    model: Any,
    model_file: str,
    model_version: str | None,
    duration_seconds: int | None = None,
    base_time: datetime | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Generate realistic 10s Spark aggregate rows and 30s Edge prediction rows using the real RF model."""
    spec = next((item for item in SCENARIO_CATALOG if item["id"] == scenario_id), SCENARIO_CATALOG[1])
    total_sec = int(duration_seconds or spec["duration_seconds"])
    total_sec = max(60, (total_sec // 30) * 30)
    num_30s = total_sec // 30

    if base_time is None:
        now_epoch = int(datetime.now(timezone.utc).timestamp() // 10) * 10
        start_dt = datetime.fromtimestamp(now_epoch - total_sec, tz=timezone.utc)
    else:
        floored = int(base_time.timestamp() // 10) * 10
        start_dt = datetime.fromtimestamp(floored, tz=timezone.utc)

    seed = sum(ord(ch) for ch in f"{subject_id}:{scenario_id}") + 2026
    rng = np.random.default_rng(seed)

    spark_rows: list[dict[str, Any]] = []
    prediction_rows: list[dict[str, Any]] = []

    baseline_hr = 72.0
    baseline_eda = 0.58
    batch_counter = 1

    for w_idx in range(num_30s):
        frac = w_idx / max(1, num_30s - 1)
        if scenario_id == "baseline_calm":
            hr_target = 71.0 + 2.5 * np.sin(w_idx * 0.9)
            rmssd_target = 46.0 - 3.0 * np.cos(w_idx * 0.7)
            eda_base = 0.52 + 0.05 * frac
            eda_burst = 0.008
            temp_c = 32.95 + 0.06 * np.sin(w_idx)
            acc_noise = 0.42
            bvp_amp = 68.0
        elif scenario_id == "tsst_acute_stress":
            # Progressive stress buildup and sustained peak during TSST speech/arithmetic
            ramp = 0.65 if w_idx == 0 else min(1.0, 0.82 + 0.18 * frac)
            hr_target = 96.0 + 14.0 * ramp + float(rng.normal(0.0, 1.4))
            rmssd_target = 23.0 - 6.5 * ramp
            eda_base = 4.9 + 2.3 * ramp
            eda_burst = 0.085 + 0.055 * ramp
            temp_c = 32.85 - 0.18 * ramp
            acc_noise = 1.25  # Subtle speech hand/posture micro-movements while standing still (~0.02 g)
            bvp_amp = 155.0 + 40.0 * ramp
        elif scenario_id == "stress_to_recovery":
            if frac < 0.5:
                # First half: acute TSST stress peak (4 windows = 2 minutes)
                ramp = 0.88 + 0.12 * (frac / 0.5)
                hr_target = 103.0 + 5.0 * (frac / 0.5)
                rmssd_target = 17.5
                eda_base = 6.2 + 0.8 * ramp
                eda_burst = 0.115
                temp_c = 32.78
                acc_noise = 1.20
                bvp_amp = 185.0
            else:
                # Second half: autonomic recovery back toward calm baseline
                rec = (frac - 0.5) / 0.5
                hr_target = 92.0 - 20.0 * rec
                rmssd_target = 24.0 + 20.0 * rec
                eda_base = 2.10 - 1.55 * rec
                eda_burst = 0.022 * (1.0 - 0.75 * rec)
                temp_c = 32.85 + 0.18 * rec
                acc_noise = 0.45
                bvp_amp = 105.0 - 38.0 * rec
        else:  # physical_activity_check
            hr_target = 114.0 + 12.0 * np.sin(frac * np.pi)
            rmssd_target = 26.0
            eda_base = 1.45 + 0.55 * frac
            eda_burst = 0.024
            temp_c = 32.35 - 0.15 * frac
            acc_noise = 8.4  # ~0.13 g vigorous walking / stairs
            bvp_amp = 95.0

        # Synthesize 30 seconds of multi-rate E4 signals
        bvp_30s = synthesize_ppg_bvp(
            rng=rng,
            duration_seconds=30,
            target_hr_bpm=hr_target,
            target_rmssd_ms=rmssd_target,
            amplitude=bvp_amp,
            sample_rate_hz=SAMPLE_RATES_HZ["BVP"],
        )

        n_acc = 30 * SAMPLE_RATES_HZ["ACC"]
        t_acc = np.arange(n_acc, dtype=np.float64) / float(SAMPLE_RATES_HZ["ACC"])
        cadence = acc_noise * np.sin(2.0 * np.pi * 1.85 * t_acc)
        acc_30s = np.column_stack(
            [
                37.2 + cadence + rng.normal(0.0, acc_noise * 0.35, size=n_acc),
                23.5 + 0.5 * cadence + rng.normal(0.0, acc_noise * 0.35, size=n_acc),
                44.6 + 0.4 * cadence + rng.normal(0.0, acc_noise * 0.35, size=n_acc),
            ]
        )

        n_eda = 30 * SAMPLE_RATES_HZ["EDA"]
        t_eda = np.arange(n_eda, dtype=np.float64) / float(SAMPLE_RATES_HZ["EDA"])
        scr_wave = eda_burst * (
            np.sin(2.0 * np.pi * 0.08 * t_eda) + 0.65 * np.sin(2.0 * np.pi * 0.15 * t_eda + 0.7)
        )
        eda_30s = np.clip(eda_base + scr_wave + rng.normal(0.0, eda_burst * 0.25, size=n_eda), 0.08, 25.0)

        n_temp = 30 * SAMPLE_RATES_HZ["TEMP"]
        temp_30s = temp_c + rng.normal(0.0, 0.018, size=n_temp)

        win_start = start_dt + timedelta(seconds=w_idx * 30)
        win_end = win_start + timedelta(seconds=30)

        # Emit 3 Spark 10-second tumbling window aggregates per 30-second Edge window
        for sub_idx in range(3):
            s_start = win_start + timedelta(seconds=sub_idx * 10)
            s_end = s_start + timedelta(seconds=10)
            bvp_10s = bvp_30s[sub_idx * 640 : (sub_idx + 1) * 640]
            acc_10s = acc_30s[sub_idx * 320 : (sub_idx + 1) * 320]
            eda_10s = eda_30s[sub_idx * 40 : (sub_idx + 1) * 40]
            temp_10s = temp_30s[sub_idx * 40 : (sub_idx + 1) * 40]
            acc_mag_10s = np.linalg.norm(acc_10s, axis=1)
            pulse_10s = estimate_pulse_from_bvp(bvp_10s, sample_rate_hz=64.0)
            hr_10s = float(pulse_10s["hr_bpm"] or hr_target)

            sensor_slices: list[tuple[str, str, np.ndarray]] = [
                ("HR", "bpm", np.linspace(hr_10s - 1.1, hr_10s + 1.1, 10)),
                ("EDA", "uS", eda_10s),
                ("TEMP", "C", temp_10s),
                ("ACC", "raw", acc_mag_10s),
                ("BVP", "raw", bvp_10s),
            ]
            for sensor_name, unit_name, arr in sensor_slices:
                spark_rows.append(
                    {
                        "subject_id": subject_id,
                        "window_start_utc": s_start.isoformat(),
                        "window_end_utc": s_end.isoformat(),
                        "sensor": sensor_name,
                        "unit": unit_name,
                        "sample_count": int(arr.size),
                        "mean_value": round(float(np.mean(arr)), 3),
                        "min_value": round(float(np.min(arr)), 3),
                        "max_value": round(float(np.max(arr)), 3),
                        "spark_batch_id": batch_counter,
                    }
                )
            batch_counter += 1

        # Compute exact 16 WESAD features and run the REAL Random Forest classifier
        raw_arrays = {"ACC": acc_30s, "BVP": bvp_30s, "EDA": eda_30s, "TEMP": temp_30s}
        features: list[float] = []
        for sensor_name in SAMPLE_RATES_HZ:
            stats = sensor_features(sensor_name, raw_arrays[sensor_name])
            assert stats is not None
            features.extend(stats)

        probs = model.predict_proba([features])[0]
        classes = list(model.classes_)
        stress_prob = float(probs[classes.index(1)])

        window_samples = {
            "ACC": [{"x": float(r[0]), "y": float(r[1]), "z": float(r[2])} for r in acc_30s],
            "BVP": bvp_30s.tolist(),
            "EDA": eda_30s.tolist(),
            "TEMP": temp_30s.tolist(),
        }
        vitals = summarize_window_vitals(
            window_samples=window_samples,
            features=features,
            model_score_stress=stress_prob,
            baseline_hr_bpm=baseline_hr,
            baseline_eda_us=baseline_eda,
        )
        # Update calm resting baseline ONLY during genuinely calm resting windows
        if (
            vitals["activity_state"] == "RESTING"
            and vitals["heart_anomaly"] == "NONE"
            and stress_prob < 0.35
            and vitals["hr_bpm"] is not None
            and float(vitals["hr_bpm"]) < 88.0
        ):
            baseline_hr = 0.75 * baseline_hr + 0.25 * float(vitals["hr_bpm"])
            baseline_eda = 0.75 * baseline_eda + 0.25 * float(vitals["eda_mean_us"])

        # During vigorous physical activity, prevent false psychological STRESS classification
        effective_prediction = (
            "NON_STRESS"
            if vitals["activity_state"] == "HIGH_ACTIVITY"
            else ("STRESS" if stress_prob >= 0.5 else "NON_STRESS")
        )

        prediction_rows.append(
            {
                "subject_id": subject_id,
                "window_start": win_start.isoformat(),
                "window_end": win_end.isoformat(),
                "prediction": effective_prediction,
                "model_score_stress": round(stress_prob, 4),
                "model_file": model_file,
                "model_version": model_version,
                "sample_counts": {"ACC": n_acc, "BVP": len(bvp_30s), "EDA": n_eda, "TEMP": n_temp},
                "vitals": vitals,
            }
        )

    return spark_rows, prediction_rows
