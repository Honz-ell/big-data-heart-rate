"""Physiological vital-sign extraction and user-facing explainability for Empatica E4 wrist streams."""

from __future__ import annotations

from typing import Any

import numpy as np

# Empatica E4 ACC raw units: 1 g == 64 LSB
E4_ACC_LSB_PER_G = 64.0

# Dynamic acceleration thresholds (std of ||ACC|| in g)
RESTING_ACC_STD_G = 0.028        # ~1.8 raw LSB: sitting / typing / standing still
HIGH_ACTIVITY_ACC_STD_G = 0.085  # ~5.4 raw LSB: brisk walking / stairs / exercise


def _moving_average(values: np.ndarray, window: int) -> np.ndarray:
    if window <= 1 or values.size == 0:
        return values.astype(np.float64, copy=True)
    window = min(window, values.size)
    kernel = np.ones(window, dtype=np.float64) / float(window)
    padded = np.pad(values, (window // 2, window - 1 - window // 2), mode="edge")
    return np.convolve(padded, kernel, mode="valid")


def estimate_pulse_from_bvp(
    bvp_samples: np.ndarray,
    sample_rate_hz: float = 64.0,
) -> dict[str, float | int | None]:
    """Estimate heart rate (BPM) and HRV (RMSSD, SDNN in ms) from a 64 Hz Empatica E4 BVP signal."""
    raw = np.asarray(bvp_samples, dtype=np.float64).reshape(-1)
    raw = raw[np.isfinite(raw)]
    min_samples = int(max(4.0 * sample_rate_hz, 64))
    if raw.size < min_samples or sample_rate_hz <= 0:
        return {
            "hr_bpm": None,
            "hrv_rmssd_ms": None,
            "hrv_sdnn_ms": None,
            "beat_count": 0,
            "signal_quality": 0.0,
        }

    # Band-pass via baseline wander removal (~1.25 s) + high-frequency smoothing (~0.14 s)
    detrended = raw - _moving_average(raw, max(3, int(round(1.25 * sample_rate_hz))))
    smoothed = _moving_average(detrended, max(3, int(round(0.14 * sample_rate_hz))))

    spread = float(np.std(smoothed))
    if spread < 1e-6:
        return {
            "hr_bpm": None,
            "hrv_rmssd_ms": None,
            "hrv_sdnn_ms": None,
            "beat_count": 0,
            "signal_quality": 0.0,
        }

    # Systolic peak candidates above adaptive threshold
    amp_threshold = max(float(np.percentile(smoothed, 62)), 0.35 * spread)
    if smoothed.size < 3:
        return {
            "hr_bpm": None,
            "hrv_rmssd_ms": None,
            "hrv_sdnn_ms": None,
            "beat_count": 0,
            "signal_quality": 0.0,
        }

    interior = (
        (smoothed[1:-1] > smoothed[:-2])
        & (smoothed[1:-1] >= smoothed[2:])
        & (smoothed[1:-1] > amp_threshold)
    )
    candidate_indices = np.flatnonzero(interior) + 1
    if candidate_indices.size < 3:
        return {
            "hr_bpm": None,
            "hrv_rmssd_ms": None,
            "hrv_sdnn_ms": None,
            "beat_count": int(candidate_indices.size),
            "signal_quality": 0.0,
        }

    # Refractory period ~0.36 s (max ~166 BPM) suppresses dicrotic notches
    min_distance = max(2, int(round(0.36 * sample_rate_hz)))
    peaks: list[int] = []
    for idx in candidate_indices.tolist():
        if not peaks or (idx - peaks[-1]) >= min_distance:
            peaks.append(idx)
        elif smoothed[idx] > smoothed[peaks[-1]]:
            peaks[-1] = idx

    if len(peaks) < 3:
        return {
            "hr_bpm": None,
            "hrv_rmssd_ms": None,
            "hrv_sdnn_ms": None,
            "beat_count": len(peaks),
            "signal_quality": 0.0,
        }

    peak_arr = np.asarray(peaks, dtype=np.float64)
    all_ibi = np.diff(peak_arr) / float(sample_rate_hz)
    plausible_mask = (all_ibi >= 0.36) & (all_ibi <= 1.55)
    plausible_ibi = all_ibi[plausible_mask]
    if plausible_ibi.size < 2:
        return {
            "hr_bpm": None,
            "hrv_rmssd_ms": None,
            "hrv_sdnn_ms": None,
            "beat_count": len(peaks),
            "signal_quality": 0.0,
        }

    median_ibi = float(np.median(plausible_ibi))
    clean_mask = np.abs(plausible_ibi - median_ibi) <= (0.28 * median_ibi)
    clean_ibi = plausible_ibi[clean_mask]
    if clean_ibi.size < 2:
        clean_ibi = plausible_ibi

    hr_bpm = round(60.0 / float(np.median(clean_ibi)), 1)
    quality = round(float(clean_ibi.size) / float(max(1, all_ibi.size)), 3)

    # RMSSD from consecutive clean beat-to-beat intervals (avoiding gaps where beats were rejected)
    rmssd_ms: float | None = None
    sdnn_ms: float | None = None
    if clean_ibi.size >= 4:
        sdnn_ms = round(float(np.std(clean_ibi, ddof=1)) * 1000.0, 1)
        consecutive_diffs: list[float] = []
        for idx in range(all_ibi.size - 1):
            a, b = float(all_ibi[idx]), float(all_ibi[idx + 1])
            if (
                0.36 <= a <= 1.55
                and 0.36 <= b <= 1.55
                and abs(a - median_ibi) <= 0.25 * median_ibi
                and abs(b - median_ibi) <= 0.25 * median_ibi
            ):
                consecutive_diffs.append(b - a)
        if len(consecutive_diffs) >= 3:
            diffs_arr = np.asarray(consecutive_diffs, dtype=np.float64)
            rmssd_ms = round(float(np.sqrt(np.mean(np.square(diffs_arr)))) * 1000.0, 1)

    return {
        "hr_bpm": hr_bpm,
        "hrv_rmssd_ms": rmssd_ms,
        "hrv_sdnn_ms": sdnn_ms,
        "beat_count": len(peaks),
        "signal_quality": quality,
    }


def derive_hr_stream_from_bvp(
    bvp_values: np.ndarray,
    sample_rate_hz: float = 64.0,
    window_seconds: float = 8.0,
    step_seconds: float = 1.0,
) -> list[tuple[float, float]]:
    """Generate a 1 Hz (offset_seconds, hr_bpm) stream from synchronized wrist BVP, matching E4 HR.csv."""
    flat = np.asarray(bvp_values, dtype=np.float64).reshape(-1)
    win_samples = int(round(window_seconds * sample_rate_hz))
    step_samples = max(1, int(round(step_seconds * sample_rate_hz)))
    if flat.size < win_samples:
        pulse = estimate_pulse_from_bvp(flat, sample_rate_hz=sample_rate_hz)
        if pulse["hr_bpm"] is not None:
            return [(0.0, float(pulse["hr_bpm"]))]
        return []

    results: list[tuple[float, float]] = []
    last_valid_hr: float | None = None
    total_steps = (flat.size - win_samples) // step_samples + 1
    for step_idx in range(total_steps):
        end_idx = min(flat.size, win_samples + step_idx * step_samples)
        start_idx = max(0, end_idx - win_samples)
        pulse = estimate_pulse_from_bvp(
            flat[start_idx:end_idx], sample_rate_hz=sample_rate_hz
        )
        hr = pulse["hr_bpm"]
        if hr is not None:
            if last_valid_hr is not None:
                # Gentle exponential smoothing just like E4 firmware 1 Hz HR output
                hr = round(0.65 * float(hr) + 0.35 * last_valid_hr, 1)
            last_valid_hr = float(hr)
        if last_valid_hr is not None:
            offset_sec = round((end_idx - 1) / float(sample_rate_hz), 3)
            results.append((offset_sec, last_valid_hr))
    return results


def classify_activity(acc_std_raw: float) -> tuple[str, float]:
    """Map Empatica E4 ACC magnitude std (in 1/64 g LSB) to human activity state."""
    acc_std_g = round(max(0.0, float(acc_std_raw)) / E4_ACC_LSB_PER_G, 4)
    if acc_std_g < RESTING_ACC_STD_G:
        return "RESTING", acc_std_g
    if acc_std_g < HIGH_ACTIVITY_ACC_STD_G:
        return "LIGHT_ACTIVITY", acc_std_g
    return "HIGH_ACTIVITY", acc_std_g


def summarize_window_vitals(
    window_samples: dict[str, list[object]],
    features: list[float],
    model_score_stress: float,
    baseline_hr_bpm: float | None = None,
    baseline_eda_us: float | None = None,
) -> dict[str, Any]:
    """Build user-meaningful physiological vitals, anomaly flags, composite score, and Vietnamese reason codes."""
    # Feature order in wesad.features.FEATURE_NAMES:
    # 0..3: acc_mean, acc_std, acc_min, acc_max
    # 4..7: bvp_mean, bvp_std, bvp_min, bvp_max
    # 8..11: eda_mean, eda_std, eda_min, eda_max
    # 12..15: temp_mean, temp_std, temp_min, temp_max
    acc_std_raw = float(features[1])
    eda_mean_us = round(float(features[8]), 3)
    eda_std_us = round(float(features[9]), 4)
    temp_mean_c = round(float(features[12]), 2)

    activity_state, acc_activity_g = classify_activity(acc_std_raw)

    # Extract HR & HRV from 64 Hz BVP samples (or fallback to explicit HR samples if present)
    bvp_list = window_samples.get("BVP") or []
    pulse = estimate_pulse_from_bvp(np.asarray(bvp_list, dtype=np.float64), sample_rate_hz=64.0)
    hr_bpm = pulse["hr_bpm"]
    if hr_bpm is None and window_samples.get("HR"):
        hr_arr = np.asarray(window_samples["HR"], dtype=np.float64)
        hr_arr = hr_arr[np.isfinite(hr_arr)]
        if hr_arr.size > 0:
            hr_bpm = round(float(np.mean(hr_arr)), 1)

    hrv_rmssd_ms = pulse["hrv_rmssd_ms"]
    signal_quality = float(pulse["signal_quality"] or 0.0)

    ref_hr = float(baseline_hr_bpm) if baseline_hr_bpm is not None else 73.0
    hr_delta_bpm = round(float(hr_bpm) - ref_hr, 1) if hr_bpm is not None else None

    ref_eda = float(baseline_eda_us) if (baseline_eda_us is not None and baseline_eda_us > 0.05) else 0.85
    eda_ratio = round(eda_mean_us / ref_eda, 2) if ref_eda > 0 else 1.0

    # Heart-rate anomaly classification contextualized by physical motion
    heart_anomaly = "NONE"
    if hr_bpm is not None:
        if activity_state == "HIGH_ACTIVITY" and hr_bpm >= 98.0:
            heart_anomaly = "ELEVATED_WITH_MOTION"
        elif activity_state == "RESTING" and (
            hr_bpm >= 100.0 or (hr_delta_bpm is not None and hr_delta_bpm >= 18.0)
        ):
            heart_anomaly = "TACHYCARDIA_AT_REST"
        elif hr_bpm < 48.0:
            heart_anomaly = "BRADYCARDIA"
        elif (
            activity_state != "HIGH_ACTIVITY"
            and hrv_rmssd_ms is not None
            and hrv_rmssd_ms < 22.0
            and model_score_stress >= 0.5
        ):
            heart_anomaly = "LOW_HRV_STRAIN"

    # Composite physiological stress load (0 - 100) for intuitive user comprehension
    raw_load = float(model_score_stress) * 68.0
    if hr_delta_bpm is not None and activity_state != "HIGH_ACTIVITY":
        raw_load += float(np.clip(hr_delta_bpm / 28.0, -0.15, 1.0)) * 18.0
    if hrv_rmssd_ms is not None and activity_state != "HIGH_ACTIVITY":
        raw_load += float(np.clip((42.0 - float(hrv_rmssd_ms)) / 30.0, 0.0, 1.0)) * 8.0
    if eda_std_us >= 0.035:
        raw_load += min(6.0, (eda_std_us / 0.07) * 6.0)
    if activity_state == "HIGH_ACTIVITY":
        # Suppress false psychological stress score during brisk physical motion
        raw_load = min(raw_load * 0.55, 46.0)

    stress_load = int(round(float(np.clip(raw_load, 4.0, 99.0))))

    reason_codes: list[dict[str, str]] = []
    if activity_state == "HIGH_ACTIVITY":
        reason_codes.append(
            {
                "code": "MOTION_CONTEXT",
                "severity": "info",
                "label": "Đang vận động thể chất",
                "detail": (
                    f"Gia tốc cổ tay động ở mức cao ({acc_activity_g:.3f} g). "
                    "Nhịp tim/mồ hôi tăng là đáp ứng sinh lý tự nhiên khi vận động, không kết luận stress tâm lý."
                ),
            }
        )
    else:
        if heart_anomaly == "TACHYCARDIA_AT_REST" and hr_bpm is not None:
            delta_txt = f" ({hr_delta_bpm:+.0f} BPM so với mức nền)" if hr_delta_bpm is not None else ""
            reason_codes.append(
                {
                    "code": "RESTING_HR_SURGE",
                    "severity": "high",
                    "label": "Nhịp tim tăng bất thường khi ngồi tĩnh",
                    "detail": f"Nhịp tim đạt {hr_bpm:.0f} BPM{delta_txt} trong khi cơ thể gần như không vận động ({acc_activity_g:.3f} g).",
                }
            )
        elif hr_bpm is not None and hr_delta_bpm is not None and hr_delta_bpm >= 10.0:
            reason_codes.append(
                {
                    "code": "HR_ELEVATED",
                    "severity": "medium",
                    "label": "Nhịp tim cao hơn mức nghỉ cá nhân",
                    "detail": f"Nhịp tim {hr_bpm:.0f} BPM ({hr_delta_bpm:+.0f} BPM so với nền {ref_hr:.0f} BPM).",
                }
            )

        if hrv_rmssd_ms is not None and hrv_rmssd_ms < 26.0:
            reason_codes.append(
                {
                    "code": "HRV_SUPPRESSED",
                    "severity": "medium" if hrv_rmssd_ms >= 18.0 else "high",
                    "label": "Biến thiên nhịp tim (HRV) giảm thấp",
                    "detail": f"RMSSD còn {hrv_rmssd_ms:.0f} ms — dấu hiệu hệ thần kinh giao cảm đang căng, khả năng thư giãn giảm.",
                }
            )

        if eda_std_us >= 0.038 or eda_mean_us >= 2.8:
            reason_codes.append(
                {
                    "code": "EDA_SYMPATHETIC_SURGE",
                    "severity": "high" if eda_std_us >= 0.065 else "medium",
                    "label": "Tăng dẫn điện da (phản ứng mồ hôi vi thể)",
                    "detail": (
                        f"EDA trung bình {eda_mean_us:.2f} µS (biến thiên {eda_std_us:.3f} µS, gấp {eda_ratio:.1f}× mức nền) "
                        "— tín hiệu đặc trưng nhất của mô hình Random Forest."
                    ),
                }
            )

        if heart_anomaly == "BRADYCARDIA" and hr_bpm is not None:
            reason_codes.append(
                {
                    "code": "LOW_RESTING_HR",
                    "severity": "medium",
                    "label": "Nhịp tim thấp",
                    "detail": f"Nhịp tim ghi nhận {hr_bpm:.0f} BPM (< 48 BPM), cần kiểm tra độ ôm của vòng đeo cổ tay.",
                }
            )

    if not reason_codes:
        if model_score_stress >= 0.5:
            reason_codes.append(
                {
                    "code": "RF_MULTIVARIATE_PATTERN",
                    "severity": "medium",
                    "label": "Tổ hợp tín hiệu sinh lý vượt ngưỡng mô hình",
                    "detail": f"Mô hình Random Forest chấm {model_score_stress:.0%} dựa trên tương quan BVP, EDA và nhiệt độ da ({temp_mean_c:.1f} °C).",
                }
            )
        else:
            hr_txt = f"{hr_bpm:.0f} BPM" if hr_bpm is not None else "ổn định"
            hrv_txt = f", HRV {hrv_rmssd_ms:.0f} ms" if hrv_rmssd_ms is not None else ""
            reason_codes.append(
                {
                    "code": "AUTONOMIC_CALM",
                    "severity": "low",
                    "label": "Chỉ số sinh tồn cân bằng",
                    "detail": f"Nhịp tim {hr_txt}{hrv_txt}, dẫn điện da {eda_mean_us:.2f} µS và nhiệt độ cổ tay {temp_mean_c:.1f} °C ổn định.",
                }
            )

    return {
        "hr_bpm": hr_bpm,
        "baseline_hr_bpm": round(ref_hr, 1),
        "hr_delta_bpm": hr_delta_bpm,
        "hrv_rmssd_ms": hrv_rmssd_ms,
        "eda_mean_us": eda_mean_us,
        "eda_std_us": eda_std_us,
        "temp_mean_c": temp_mean_c,
        "acc_activity_g": acc_activity_g,
        "activity_state": activity_state,
        "heart_anomaly": heart_anomaly,
        "stress_load": stress_load,
        "signal_quality": signal_quality,
        "reason_codes": reason_codes,
    }
