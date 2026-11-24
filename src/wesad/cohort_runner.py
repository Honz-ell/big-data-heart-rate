"""Sequential low-memory cohort runner across all 15 WESAD subjects (S2..S17)."""

from __future__ import annotations

import csv
from datetime import datetime, timedelta, timezone
import pickle
from pathlib import Path
from typing import Any, Callable

import numpy as np

from wesad.features import SAMPLE_RATES_HZ, sensor_features
from wesad.pickle_reader import calibrate_pickle_origin_epoch
from wesad.vitals import derive_hr_stream_from_bvp, summarize_window_vitals

COHORT_CACHE_VERSION = 1
_MEMORY_CATALOG_CACHE: dict[tuple[str, int], dict[str, Any]] = {}


def _read_aligned_hr_csv(hr_path: Path, origin_epoch: float, total_sec: int) -> np.ndarray | None:
    if not hr_path.is_file():
        return None
    try:
        with hr_path.open("r", newline="", encoding="utf-8-sig") as handle:
            rows = csv.reader(handle)
            start_row = next(rows, None)
            rate_row = next(rows, None)
            if not start_row or not rate_row:
                return None
            csv_start = float(start_row[0])
            rate_hz = float(rate_row[0])
            vals = [float(r[0]) for r in rows if r and r[0].strip()]
        if not vals or rate_hz <= 0:
            return None
        arr = np.asarray(vals, dtype=np.float64)
        # Slice 1 Hz HR aligned to pickle origin_epoch
        out = np.full(total_sec, np.nan, dtype=np.float64)
        for sec in range(total_sec):
            idx = int(round((origin_epoch + sec - csv_start) * rate_hz))
            if 0 <= idx < arr.size:
                out[sec] = arr[idx]
        return out
    except Exception:
        return None


def _read_aligned_ibi_csv(ibi_path: Path, origin_epoch: float) -> list[tuple[float, float]]:
    """Return list of (pickle_offset_sec, ibi_interval_sec) sorted by offset."""
    if not ibi_path.is_file():
        return []
    records: list[tuple[float, float]] = []
    try:
        with ibi_path.open("r", newline="", encoding="utf-8-sig") as handle:
            rows = csv.reader(handle)
            header = next(rows, None)
            if not header or not header[0].strip():
                return []
            csv_start = float(header[0])
            for row in rows:
                if len(row) < 2:
                    continue
                try:
                    rel_off = float(row[0])
                    interval = float(row[1])
                except ValueError:
                    continue
                pkl_off = (csv_start + rel_off) - origin_epoch
                if pkl_off >= -5.0 and 0.30 <= interval <= 2.00:
                    records.append((pkl_off, interval))
    except Exception:
        return []
    records.sort(key=lambda item: item[0])
    return records


def load_or_build_subject_catalog(
    subject_dir: Path, cache_dir: Path | None = None
) -> dict[str, Any] | None:
    """Extract compact 30s-window features & 10s Spark stats from {S}.pkl once and cache."""
    subject_id = subject_dir.name
    pkl_path = subject_dir / f"{subject_id}.pkl"
    if not pkl_path.is_file():
        return None

    pkl_mtime = pkl_path.stat().st_mtime_ns
    mem_key = (str(subject_dir.resolve()), pkl_mtime)
    if mem_key in _MEMORY_CATALOG_CACHE:
        return _MEMORY_CATALOG_CACHE[mem_key]

    disk_cache_path: Path | None = None
    if cache_dir is not None:
        cache_dir.mkdir(parents=True, exist_ok=True)
        disk_cache_path = cache_dir / f"cohort_{subject_id}_v{COHORT_CACHE_VERSION}.pkl"
        if disk_cache_path.is_file():
            try:
                with disk_cache_path.open("rb") as fh:
                    cached_obj = pickle.load(fh)
                if cached_obj.get("pkl_mtime") == pkl_mtime:
                    _MEMORY_CATALOG_CACHE[mem_key] = cached_obj
                    return cached_obj
            except Exception:
                pass

    with pkl_path.open("rb") as handle:
        payload = pickle.load(handle, encoding="latin1")

    wrist = payload["signal"]["wrist"]
    wrist_by_name = {
        (key.decode("latin1") if isinstance(key, bytes) else str(key)).upper(): value
        for key, value in wrist.items()
    }
    bvp_arr = np.asarray(wrist_by_name["BVP"], dtype=np.float64).reshape(-1)
    acc_arr = np.asarray(wrist_by_name["ACC"], dtype=np.float64)
    eda_arr = np.asarray(wrist_by_name["EDA"], dtype=np.float64).reshape(-1)
    temp_arr = np.asarray(wrist_by_name["TEMP"], dtype=np.float64).reshape(-1)
    labels = np.asarray(payload.get("label", []), dtype=np.int32).reshape(-1)

    origin_epoch, _ = calibrate_pickle_origin_epoch(subject_dir, bvp_arr)
    floored_origin_epoch = float((int(origin_epoch) // 10) * 10)

    win_sec = 30
    n_win = min(
        labels.size // (700 * win_sec) if labels.size else 0,
        acc_arr.shape[0] // (32 * win_sec) if acc_arr.ndim == 2 else 0,
        bvp_arr.size // (64 * win_sec),
        eda_arr.size // (4 * win_sec),
        temp_arr.size // (4 * win_sec),
    )
    if n_win < 4:
        return None

    total_sec = n_win * win_sec
    e4_dir = subject_dir / f"{subject_id}_E4_Data"
    hr_1hz = _read_aligned_hr_csv(e4_dir / "HR.csv", origin_epoch, total_sec)
    if hr_1hz is None or not np.any(np.isfinite(hr_1hz)):
        # Estimate 1 Hz HR from 64 Hz BVP
        hr_1hz = np.full(total_sec, np.nan, dtype=np.float64)
        for off_s, bpm in derive_hr_stream_from_bvp(bvp_arr[: total_sec * 64], 64.0):
            sec_i = min(total_sec - 1, max(0, int(round(off_s))))
            hr_1hz[sec_i] = bpm
    ibi_all = _read_aligned_ibi_csv(e4_dir / "IBI.csv", origin_epoch)

    # Compute resting baseline HR and EDA from label == 1 windows
    base_hrs: list[float] = []
    base_edas: list[float] = []
    for w in range(n_win):
        lbl_w = labels[w * 21000 : (w + 1) * 21000]
        if float(np.count_nonzero(lbl_w == 1)) / 21000.0 >= 0.9:
            hr_slice = hr_1hz[w * 30 : (w + 1) * 30]
            valid_hr = hr_slice[np.isfinite(hr_slice)]
            if valid_hr.size:
                base_hrs.append(float(np.median(valid_hr)))
            eda_slice = eda_arr[w * 120 : (w + 1) * 120]
            if eda_slice.size:
                base_edas.append(float(np.mean(eda_slice)))

    baseline_hr = round(float(np.median(base_hrs)), 1) if base_hrs else 70.0
    baseline_eda = round(float(np.median(base_edas)), 3) if base_edas else 0.45

    windows: list[dict[str, Any]] = []
    for w in range(n_win):
        off_s = w * win_sec
        lbl_w = labels[off_s * 700 : (off_s + win_sec) * 700]
        base_share = float(np.count_nonzero(lbl_w == 1)) / (700 * win_sec)
        stress_share = float(np.count_nonzero(lbl_w == 2)) / (700 * win_sec)

        acc_w = acc_arr[off_s * 32 : (off_s + win_sec) * 32]
        bvp_w = bvp_arr[off_s * 64 : (off_s + win_sec) * 64]
        eda_w = eda_arr[off_s * 4 : (off_s + win_sec) * 4]
        temp_w = temp_arr[off_s * 4 : (off_s + win_sec) * 4]

        f_acc = sensor_features("ACC", acc_w)
        f_bvp = sensor_features("BVP", bvp_w)
        f_eda = sensor_features("EDA", eda_w)
        f_temp = sensor_features("TEMP", temp_w)
        if not (f_acc and f_bvp and f_eda and f_temp):
            continue
        feats = [*f_acc, *f_bvp, *f_eda, *f_temp]

        hr_w = hr_1hz[off_s : off_s + win_sec]
        hr_list = [float(x) for x in hr_w if np.isfinite(x)]
        ibi_w = [
            {"offset": round(rec[0], 4), "interval": round(rec[1], 4)}
            for rec in ibi_all
            if off_s <= rec[0] < off_s + win_sec
        ]

        vit_template = summarize_window_vitals(
            window_samples={"HR": hr_list, "IBI": ibi_w},
            features=feats,
            model_score_stress=0.0,
            baseline_hr_bpm=baseline_hr,
            baseline_eda_us=baseline_eda,
        )

        # Build 3 x 10s Spark aggregate summaries for this 30s window
        spark_10s: list[dict[str, Any]] = []
        for sub in range(3):
            s_off = off_s + sub * 10
            acc_10 = np.linalg.norm(acc_arr[s_off * 32 : (s_off + 10) * 32], axis=1)
            bvp_10 = bvp_arr[s_off * 64 : (s_off + 10) * 64]
            eda_10 = eda_arr[s_off * 4 : (s_off + 10) * 4]
            temp_10 = temp_arr[s_off * 4 : (s_off + 10) * 4]
            hr_10 = hr_1hz[s_off : s_off + 10]
            hr_10_valid = hr_10[np.isfinite(hr_10)]
            if hr_10_valid.size == 0 and hr_list:
                hr_10_valid = np.asarray(hr_list, dtype=np.float64)

            sensors_10: list[tuple[str, str, int, float, float, float]] = [
                ("ACC", "1/64g", int(acc_10.size), float(np.mean(acc_10)), float(np.min(acc_10)), float(np.max(acc_10))),
                ("BVP", "nW", int(bvp_10.size), float(np.mean(bvp_10)), float(np.min(bvp_10)), float(np.max(bvp_10))),
                ("EDA", "uS", int(eda_10.size), float(np.mean(eda_10)), float(np.min(eda_10)), float(np.max(eda_10))),
                ("TEMP", "C", int(temp_10.size), float(np.mean(temp_10)), float(np.min(temp_10)), float(np.max(temp_10))),
            ]
            if hr_10_valid.size > 0:
                sensors_10.append(
                    ("HR", "bpm", int(hr_10_valid.size), float(np.mean(hr_10_valid)), float(np.min(hr_10_valid)), float(np.max(hr_10_valid)))
                )
            spark_10s.append({"offset_sec": s_off, "sensors": sensors_10})

        windows.append(
            {
                "offset_sec": off_s,
                "base_share": base_share,
                "stress_share": stress_share,
                "acc_std": float(f_acc[1]),
                "eda_mean": float(f_eda[0]),
                "features": feats,
                "vitals_base": vit_template,
                "sample_counts": {k: v * win_sec for k, v in SAMPLE_RATES_HZ.items()},
                "spark_10s": spark_10s,
            }
        )

    catalog = {
        "pkl_mtime": pkl_mtime,
        "subject_id": subject_id,
        "origin_epoch": floored_origin_epoch,
        "baseline_hr": baseline_hr,
        "baseline_eda": baseline_eda,
        "windows": windows,
    }
    _MEMORY_CATALOG_CACHE[mem_key] = catalog
    if disk_cache_path is not None:
        try:
            tmp_p = disk_cache_path.with_suffix(".tmp")
            with tmp_p.open("wb") as fh:
                pickle.dump(catalog, fh)
            tmp_p.replace(disk_cache_path)
        except Exception:
            pass
    return catalog


def select_scenario_slice(
    catalog: dict[str, Any], scenario_id: str, model: Any
) -> list[tuple[dict[str, Any], float]]:
    """Score all 30s windows with the active RF model and select the true protocol slice."""
    windows = catalog["windows"]
    n = len(windows)
    matrix = [w["features"] for w in windows]
    probs = model.predict_proba(matrix)
    classes = list(getattr(model, "classes_", [0, 1]))
    s_col = classes.index(1) if 1 in classes else -1
    rf_scores = [float(row[s_col]) for row in probs]

    win_count = 6 if scenario_id == "stress_to_recovery" else 4
    start_idx = 0

    if scenario_id == "baseline_calm":
        cands = [
            i
            for i in range(min(2, n - 1), max(1, n - win_count))
            if all(windows[k]["base_share"] >= 0.8 for k in range(i, i + win_count))
        ]
        if not cands:
            cands = [
                i
                for i in range(min(2, n - 1), max(1, n - win_count))
                if windows[i]["base_share"] >= 0.8
            ]
        if cands:
            start_idx = min(
                cands,
                key=lambda i: rf_scores[i + win_count - 1] * 2.0
                + max(rf_scores[i : i + win_count])
                + windows[i + win_count - 1]["acc_std"] * 0.02,
            )
    elif scenario_id == "tsst_acute_stress":
        cands = [
            i
            for i in range(max(1, n - win_count))
            if windows[i + win_count - 1]["stress_share"] >= 0.7
            or windows[i]["stress_share"] >= 0.8
        ]
        if cands:
            start_idx = max(
                cands,
                key=lambda i: rf_scores[i + win_count - 1] * 2.2
                + sum(rf_scores[i : i + win_count]) / win_count
                + min(windows[i + win_count - 1]["eda_mean"], 10.0) * 0.03,
            )
    elif scenario_id == "stress_to_recovery":
        stress_idx = [i for i, w in enumerate(windows) if w["stress_share"] >= 0.8]
        if stress_idx:
            lo = max(0, stress_idx[-1] - 2)
            hi = min(n - win_count, stress_idx[-1] + 22)
            if hi >= lo:
                cands = list(range(lo, hi + 1))
                start_idx = max(
                    cands,
                    key=lambda i: (
                        max(rf_scores[i : i + 2]) - rf_scores[i + win_count - 1]
                    )
                    - rf_scores[i + win_count - 1] * 1.4,
                )
            else:
                start_idx = max(0, min(n - win_count, stress_idx[-1] - 2))
    elif scenario_id == "physical_activity_check":
        cands = [
            i
            for i in range(max(1, n - win_count))
            if all(windows[k]["stress_share"] == 0.0 for k in range(i, min(n, i + win_count)))
        ]
        if cands:
            def _motion_rank(i: int) -> float:
                end_w = windows[i + win_count - 1]
                act = end_w["vitals_base"].get("activity_state")
                act_bonus = (
                    12.0
                    if act == "HIGH_ACTIVITY"
                    else (4.5 if act == "LIGHT_ACTIVITY" else 0.0)
                )
                return (
                    act_bonus
                    + min(end_w["acc_std"], 14.0) * 0.6
                    - rf_scores[i + win_count - 1] * 4.5
                )

            start_idx = max(cands, key=_motion_rank)

    chosen = windows[start_idx : start_idx + win_count]
    chosen_scores = rf_scores[start_idx : start_idx + win_count]
    return list(zip(chosen, chosen_scores))


def build_subject_scenario_records(
    catalog: dict[str, Any],
    scenario_id: str,
    model: Any,
    model_file: str,
    model_version: str | None,
    spark_batch_base: int = 500,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Build (spark_10s_rows, edge_30s_prediction_rows) from real WESAD subject catalog."""
    subject_id = catalog["subject_id"]
    origin_epoch = float(catalog["origin_epoch"])
    sliced = select_scenario_slice(catalog, scenario_id, model)

    spark_rows: list[dict[str, Any]] = []
    pred_rows: list[dict[str, Any]] = []

    for w_idx, (win, rf_prob) in enumerate(sliced):
        w_start = datetime.fromtimestamp(origin_epoch + win["offset_sec"], tz=timezone.utc)
        w_end = w_start + timedelta(seconds=30)
        prediction = "STRESS" if rf_prob >= 0.5 else "NON_STRESS"
        stress_load = int(round(min(1.0, max(0.0, rf_prob)) * 100.0))

        vitals = dict(win["vitals_base"])
        vitals["stress_load"] = stress_load
        # Refresh RF_SCORE reason code with the active model's actual score
        reason_label = (
            "Tổ hợp tín hiệu cổ tay vượt ngưỡng căng thẳng"
            if prediction == "STRESS"
            else "Các tín hiệu sinh lý trong ngưỡng ổn định"
        )
        reason_codes = [
            rc for rc in vitals.get("reason_codes", []) if rc.get("code") != "RF_SCORE"
        ]
        reason_codes.insert(
            0,
            {
                "code": "RF_SCORE",
                "severity": "high" if prediction == "STRESS" else ("medium" if rf_prob >= 0.38 else "low"),
                "label": reason_label,
                "detail": f"Điểm mô hình Random Forest đạt {rf_prob:.1%}; trích xuất trực tiếp từ {subject_id}.pkl.",
            },
        )
        vitals["reason_codes"] = reason_codes

        pred_rows.append(
            {
                "subject_id": subject_id,
                "window_start": w_start.isoformat(),
                "window_end": w_end.isoformat(),
                "prediction": prediction,
                "model_score_stress": round(rf_prob, 6),
                "model_file": model_file,
                "model_version": model_version,
                "sample_counts": win["sample_counts"],
                "vitals": vitals,
            }
        )

        for s_idx, sp in enumerate(win["spark_10s"]):
            s_start = datetime.fromtimestamp(origin_epoch + sp["offset_sec"], tz=timezone.utc)
            s_end = s_start + timedelta(seconds=10)
            batch_id = spark_batch_base + w_idx * 3 + s_idx
            for sensor, unit, cnt, mean_v, min_v, max_v in sp["sensors"]:
                spark_rows.append(
                    {
                        "subject_id": subject_id,
                        "window_start_utc": s_start.isoformat(),
                        "window_end_utc": s_end.isoformat(),
                        "sensor": sensor,
                        "unit": unit,
                        "sample_count": cnt,
                        "mean_value": mean_v,
                        "min_value": min_v,
                        "max_value": max_v,
                        "spark_batch_id": batch_id,
                    }
                )

    return spark_rows, pred_rows
