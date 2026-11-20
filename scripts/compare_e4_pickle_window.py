from __future__ import annotations

import argparse
import csv
import pickle
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from wesad.e4_reader import iter_sensor_samples  # noqa: E402
from wesad.features import FEATURE_NAMES, SAMPLE_RATES_HZ, sensor_features  # noqa: E402

LABEL_RATE_HZ = 700
STRESS_LABEL = 2
NON_STRESS_LABELS = (1, 3, 4)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare E4 CSV and WESAD pickle features for one labeled window."
    )
    parser.add_argument("--subject", required=True)
    parser.add_argument("--offset-seconds", required=True, type=int)
    parser.add_argument("--data-root", type=Path, default=Path(r"D:\btldll\archive\WESAD"))
    parser.add_argument("--window-seconds", type=int, default=30)
    parser.add_argument("--min-label-purity", type=float, default=0.8)
    parser.add_argument("--model", type=Path, default=Path("models/stress_rf.joblib"))
    return parser.parse_args()


def csv_sensor_starts(e4_dir: Path) -> dict[str, float]:
    starts: dict[str, float] = {}
    for sensor in SAMPLE_RATES_HZ:
        path = e4_dir / f"{sensor}.csv"
        with path.open("r", newline="", encoding="utf-8-sig") as handle:
            first = next(csv.reader(handle), None)
        if not first or not first[0].strip():
            raise ValueError(f"Không đọc được mốc thời gian trong {path}")
        starts[sensor] = float(first[0])
    return starts


def csv_window_samples(
    e4_dir: Path, subject: str, sensor: str, start_epoch: float, end_epoch: float
) -> np.ndarray:
    values: list[object] = []
    for sample in iter_sensor_samples(e4_dir / f"{sensor}.csv", subject, sensor):
        sample_time = datetime.fromisoformat(
            str(sample["timestamp"]).replace("Z", "+00:00")
        ).timestamp()
        if sample_time >= end_epoch:
            break
        if sample_time >= start_epoch:
            values.append(sample["value"])

    if sensor == "ACC":
        return np.asarray(
            [[value["x"], value["y"], value["z"]] for value in values],
            dtype=np.float64,
        )
    return np.asarray(values, dtype=np.float64)


def stress_score(model, features: list[float]) -> tuple[str, float]:
    probabilities = model.predict_proba([features])[0]
    class_indices = list(model.classes_)
    score = float(probabilities[class_indices.index(1)])
    return ("STRESS" if score >= 0.5 else "NON_STRESS", score)


def main() -> int:
    args = parse_args()
    if args.offset_seconds < 0 or args.window_seconds <= 0:
        print("Offset không được âm và window phải lớn hơn 0.")
        return 2
    if not 0.5 <= args.min_label_purity <= 1.0:
        print("--min-label-purity phải nằm trong khoảng 0.5 đến 1.0.")
        return 2

    subject_dir = args.data_root / args.subject
    e4_dir = subject_dir / f"{args.subject}_E4_Data"
    pkl_path = subject_dir / f"{args.subject}.pkl"
    if not e4_dir.is_dir() or not pkl_path.is_file() or not args.model.is_file():
        print("Thiếu E4 CSV, pickle hoặc model; kiểm tra --data-root và --model.")
        return 2

    try:
        with pkl_path.open("rb") as handle:
            payload = pickle.load(handle, encoding="latin1")
        labels = np.asarray(payload["label"]).reshape(-1)
        wrist = payload["signal"]["wrist"]
        wrist_by_name = {
            (key.decode("latin1") if isinstance(key, bytes) else str(key)).upper(): value
            for key, value in wrist.items()
        }
        sensor_starts = csv_sensor_starts(e4_dir)
        origin = min(sensor_starts.values())
    except (OSError, EOFError, pickle.UnpicklingError, KeyError, ValueError) as error:
        print(f"Không đọc được dữ liệu/nhãn: {error}")
        return 1

    label_start = args.offset_seconds * LABEL_RATE_HZ
    label_end = label_start + args.window_seconds * LABEL_RATE_HZ
    label_window = labels[label_start:label_end]
    if label_window.size != args.window_seconds * LABEL_RATE_HZ:
        print("Offset nằm ngoài dải nhãn trong file pickle.")
        return 2
    stress_share = float(np.count_nonzero(label_window == STRESS_LABEL)) / label_window.size
    non_stress_share = float(np.isin(label_window, NON_STRESS_LABELS).sum()) / label_window.size
    other_share = max(0.0, 1.0 - stress_share - non_stress_share)
    if stress_share >= args.min_label_purity and stress_share > non_stress_share:
        expected_label = "STRESS"
    elif non_stress_share >= args.min_label_purity and non_stress_share > stress_share:
        expected_label = "NON_STRESS"
    else:
        expected_label = "LOẠI (nhãn khác/chuyển tiếp hoặc chưa đủ thuần)"

    start_epoch = origin + args.offset_seconds
    end_epoch = start_epoch + args.window_seconds
    pkl_features: list[float] = []
    csv_features: list[float] = []
    print(
        f"{args.subject}, offset={args.offset_seconds}s, window={args.window_seconds}s"
    )
    print(
        f"Phân bố nhãn: Stress={stress_share:.1%}, Non-Stress={non_stress_share:.1%}, "
        f"khác/chuyển tiếp={other_share:.1%}; nhãn đánh giá={expected_label} "
        f"(ngưỡng thuần {args.min_label_purity:.0%})"
    )
    print(
        "CSV window UTC: "
        f"{datetime.fromtimestamp(start_epoch, timezone.utc).isoformat()} – "
        f"{datetime.fromtimestamp(end_epoch, timezone.utc).isoformat()}"
    )
    print("CSV sensor header offsets from earliest sensor:")
    for sensor, timestamp in sensor_starts.items():
        print(f"  {sensor}: {timestamp - origin:.3f}s")

    for sensor, rate in SAMPLE_RATES_HZ.items():
        start_index = args.offset_seconds * rate
        end_index = start_index + args.window_seconds * rate
        pickle_values = np.asarray(wrist_by_name[sensor])[start_index:end_index]
        csv_values = csv_window_samples(e4_dir, args.subject, sensor, start_epoch, end_epoch)
        pickle_stats = sensor_features(sensor, pickle_values)
        csv_stats = sensor_features(sensor, csv_values)
        if pickle_stats is None or csv_stats is None:
            print(f"{sensor}: không đủ dữ liệu để trích đặc trưng")
            return 1
        pkl_features.extend(pickle_stats)
        csv_features.extend(csv_stats)
        differences = np.abs(np.asarray(pickle_stats) - np.asarray(csv_stats))
        print(
            f"{sensor}: pickle_n={len(pickle_values)}, csv_n={len(csv_values)}, "
            f"pickle_features={[round(value, 4) for value in pickle_stats]}, "
            f"csv_features={[round(value, 4) for value in csv_stats]}, "
            f"max_feature_diff={differences.max():.6g}"
        )

    bundle = joblib.load(args.model)
    if tuple(bundle["feature_names"]) != FEATURE_NAMES:
        print("Tên đặc trưng trong model không khớp với code hiện tại.")
        return 1
    model = bundle["model"]
    pkl_prediction, pkl_score = stress_score(model, pkl_features)
    csv_prediction, csv_score = stress_score(model, csv_features)
    print(f"Từ pickle (cách train): {pkl_prediction}, model_score_stress={pkl_score:.3f}")
    print(f"Từ E4 CSV (stream):    {csv_prediction}, model_score_stress={csv_score:.3f}")
    print("So sánh này kiểm tra căn chỉnh/đặc trưng; điểm mô hình không phải xác suất sức khỏe.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
