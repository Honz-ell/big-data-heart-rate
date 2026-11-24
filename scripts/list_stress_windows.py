from __future__ import annotations

import argparse
import pickle
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from wesad.features import FEATURE_NAMES, SAMPLE_RATES_HZ, sensor_features  # noqa: E402
from wesad.pickle_reader import calibrate_pickle_origin_epoch  # noqa: E402

LABEL_RATE_HZ = 700
STRESS_LABEL = 2
NON_STRESS_LABELS = (1, 3, 4)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="List WESAD 30-second label windows suitable for a stress replay demo."
    )
    parser.add_argument("--subject", required=True, help="Participant ID such as S4")
    parser.add_argument("--data-root", type=Path, default=Path(r"D:\btldll\archive\WESAD"))
    parser.add_argument("--window-seconds", type=int, default=30)
    parser.add_argument("--min-purity", type=float, default=0.8)
    parser.add_argument(
        "--label-class",
        choices=("stress", "non-stress"),
        default="stress",
        help="List windows for the requested WESAD label class.",
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=None,
        help="Optional trained model; print its prediction and score for each listed window.",
    )
    parser.add_argument("--limit", type=int, default=20)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.window_seconds <= 0 or not 0.5 <= args.min_purity <= 1 or args.limit < 1:
        print("Tham số không hợp lệ: window-seconds > 0, min-purity trong [0.5, 1.0] và limit >= 1.")
        return 2

    subject_dir = args.data_root / args.subject
    pkl_path = subject_dir / f"{args.subject}.pkl"
    e4_dir = subject_dir / f"{args.subject}_E4_Data"
    if not pkl_path.is_file() or not e4_dir.is_dir():
        print(f"Không tìm thấy đủ dữ liệu WESAD cho {args.subject} trong {subject_dir}")
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
        origin_epoch, aligned = calibrate_pickle_origin_epoch(
            subject_dir, np.asarray(wrist_by_name["BVP"])
        )
        if not aligned:
            raise ValueError("Không căn chỉnh được timestamp pickle với BVP.csv")
        origin = datetime.fromtimestamp(origin_epoch, timezone.utc)
    except (OSError, EOFError, pickle.UnpicklingError, KeyError, ValueError) as error:
        print(f"Không đọc được nhãn hoặc thời gian bắt đầu: {error}")
        return 1

    model = None
    if args.model is not None:
        if not args.model.is_file():
            print(f"Không tìm thấy model: {args.model}")
            return 2
        bundle = joblib.load(args.model)
        if tuple(bundle.get("feature_names", ())) != FEATURE_NAMES:
            print("Các đặc trưng trong model không khớp với chương trình.")
            return 2
        if int(bundle.get("window_seconds", 0)) != args.window_seconds:
            print(
                f"Model yêu cầu cửa sổ {bundle.get('window_seconds')}s; "
                f"lệnh đang dùng {args.window_seconds}s."
            )
            return 2
        model = bundle["model"]

    samples_per_window = args.window_seconds * LABEL_RATE_HZ
    full_windows = labels.size // samples_per_window
    found = 0
    label_text = "Stress (nhãn 2)" if args.label_class == "stress" else "Non-Stress (nhãn 1/3/4)"
    print(
        f"{args.subject}: cửa sổ={args.window_seconds}s, lớp cần liệt kê={label_text}, "
        f"độ thuần tối thiểu={args.min_purity:.0%}"
    )
    print(f"Mốc bắt đầu pickle đã căn với BVP.csv: {origin.isoformat()}")
    output_fields = "offset_seconds | thời gian UTC | độ thuần"
    if model is not None:
        output_fields += " | dự đoán model | điểm Stress"
    print(f"Các cửa sổ {label_text}: {output_fields}")
    for index in range(full_windows):
        start = index * samples_per_window
        window_labels = labels[start : start + samples_per_window]
        stress_share = float(np.count_nonzero(window_labels == STRESS_LABEL)) / samples_per_window
        non_stress_share = float(np.isin(window_labels, NON_STRESS_LABELS).sum()) / samples_per_window
        target_share = stress_share if args.label_class == "stress" else non_stress_share
        other_share = non_stress_share if args.label_class == "stress" else stress_share
        if target_share < args.min_purity or target_share <= other_share:
            continue

        offset = index * args.window_seconds
        window_start = origin.timestamp() + offset
        start_utc = datetime.fromtimestamp(window_start, timezone.utc)
        end_utc = datetime.fromtimestamp(window_start + args.window_seconds, timezone.utc)
        model_result = ""
        if model is not None:
            features: list[float] = []
            for sensor, rate in SAMPLE_RATES_HZ.items():
                first_sample = index * args.window_seconds * rate
                last_sample = first_sample + args.window_seconds * rate
                summary = sensor_features(
                    sensor, np.asarray(wrist_by_name[sensor])[first_sample:last_sample]
                )
                if summary is None:
                    features = []
                    break
                features.extend(summary)
            if len(features) == len(FEATURE_NAMES):
                probabilities = model.predict_proba([features])[0]
                class_indices = list(model.classes_)
                stress_score = float(probabilities[class_indices.index(1)])
                prediction = "STRESS" if stress_score >= 0.5 else "NON_STRESS"
                model_result = f" | {prediction} | {stress_score:.3f}"
            else:
                model_result = " | thiếu mẫu model"
        print(
            f"{offset:>6}s | {start_utc.isoformat()} – {end_utc.isoformat()} "
            f"| {target_share:.1%}{model_result}"
        )
        found += 1
        if found >= args.limit:
            break

    if found == 0:
        print(f"Không tìm thấy cửa sổ {label_text} đạt ngưỡng; thử --min-purity 0.7.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
