from __future__ import annotations

import argparse
import gc
import pickle
import sys
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
    recall_score,
)
from sklearn.model_selection import LeaveOneGroupOut

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from wesad.features import FEATURE_NAMES, SAMPLE_RATES_HZ, sensor_features  # noqa: E402
from wesad.e4_reader import iter_sensor_samples  # noqa: E402
from wesad.pickle_reader import calibrate_pickle_origin_epoch  # noqa: E402

LABEL_RATE_HZ = 700
NON_STRESS_LABELS = (1, 3, 4)
STRESS_LABEL = 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train a wrist-only WESAD stress baseline with subject-wise evaluation."
    )
    parser.add_argument("--data-root", type=Path, default=Path(r"D:\btldll\archive\WESAD"))
    parser.add_argument("--window-seconds", type=int, default=30)
    parser.add_argument("--min-label-purity", type=float, default=0.8)
    parser.add_argument("--min-sensor-coverage", type=float, default=0.8)
    parser.add_argument(
        "--feature-source",
        choices=("pickle", "csv"),
        default="pickle",
        help="Signal source used for training; choose csv to match the Kafka producer stream.",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--exclude-subject",
        action="append",
        default=[],
        help="Exclude a participant from evaluation and training; repeat for multiple IDs.",
    )
    parser.add_argument("--output", type=Path, default=Path("models/stress_rf.joblib"))
    return parser.parse_args()


def make_model(seed: int) -> RandomForestClassifier:
    return RandomForestClassifier(
        n_estimators=300,
        min_samples_leaf=2,
        class_weight="balanced_subsample",
        random_state=seed,
        n_jobs=-1,
    )


def extract_subject(
    subject_dir: Path, window_seconds: int, min_label_purity: float
) -> tuple[list[list[float]], list[int]]:
    pkl_path = subject_dir / f"{subject_dir.name}.pkl"
    if not pkl_path.is_file():
        print(f"  BỎ QUA {subject_dir.name}: không có {pkl_path.name}")
        return [], []

    with pkl_path.open("rb") as handle:
        payload = pickle.load(handle, encoding="latin1")

    labels = np.asarray(payload["label"]).reshape(-1).astype(np.int64, copy=False)
    wrist = payload["signal"]["wrist"]
    wrist_by_name = {
        (key.decode("latin1") if isinstance(key, bytes) else str(key)).upper(): value
        for key, value in wrist.items()
    }
    missing = [name for name in SAMPLE_RATES_HZ if name not in wrist_by_name]
    if missing:
        raise KeyError(f"thiếu kênh cổ tay: {', '.join(missing)}")
    channels = {name: np.asarray(wrist_by_name[name]) for name in SAMPLE_RATES_HZ}

    duration_seconds = min(
        [labels.size / LABEL_RATE_HZ]
        + [channels[name].shape[0] / rate for name, rate in SAMPLE_RATES_HZ.items()]
    )
    full_windows = int(duration_seconds // window_seconds)
    label_window = window_seconds * LABEL_RATE_HZ
    rows: list[list[float]] = []
    targets: list[int] = []

    for window_index in range(full_windows):
        label_start = window_index * label_window
        label_values = labels[label_start : label_start + label_window]
        stress_count = int(np.count_nonzero(label_values == STRESS_LABEL))
        non_stress_count = int(np.isin(label_values, NON_STRESS_LABELS).sum())
        majority_share = max(stress_count, non_stress_count) / label_values.size
        if majority_share < min_label_purity:
            continue

        features: list[float] = []
        valid_window = True
        for sensor, rate in SAMPLE_RATES_HZ.items():
            samples_per_window = window_seconds * rate
            sample_start = window_index * samples_per_window
            sample_values = channels[sensor][sample_start : sample_start + samples_per_window]
            summary = sensor_features(sensor, sample_values)
            if summary is None:
                valid_window = False
                break
            features.extend(summary)

        if valid_window and len(features) == len(FEATURE_NAMES):
            rows.append(features)
            targets.append(int(stress_count > non_stress_count))

    print(
        f"  {subject_dir.name}: {len(rows)} cửa sổ giữ lại / "
        f"{full_windows} cửa sổ; thời lượng đồng bộ tối đa {duration_seconds / 60:.1f} phút"
    )
    del channels, wrist, payload, labels
    gc.collect()
    return rows, targets


def extract_subject_csv(
    subject_dir: Path,
    window_seconds: int,
    min_label_purity: float,
    min_sensor_coverage: float,
) -> tuple[list[list[float]], list[int]]:
    """Train from the same E4 CSV values used by the Kafka producer."""
    pkl_path = subject_dir / f"{subject_dir.name}.pkl"
    e4_dir = subject_dir / f"{subject_dir.name}_E4_Data"
    if not pkl_path.is_file() or not e4_dir.is_dir():
        print(f"  BỎ QUA {subject_dir.name}: thiếu pickle hoặc thư mục E4 CSV")
        return [], []

    with pkl_path.open("rb") as handle:
        payload = pickle.load(handle, encoding="latin1")
    labels = np.asarray(payload["label"]).reshape(-1).astype(np.int64, copy=False)
    wrist = payload["signal"]["wrist"]
    pickle_wrist = {
        (key.decode("latin1") if isinstance(key, bytes) else str(key)).upper(): value
        for key, value in wrist.items()
    }
    origin_epoch, aligned = calibrate_pickle_origin_epoch(
        subject_dir, np.asarray(pickle_wrist["BVP"])
    )
    if not aligned:
        raise ValueError(
            f"{subject_dir.name}: không thể căn CSV với timeline pickle; "
            "dừng để tránh ghép nhãn sai cửa sổ."
        )

    samples_per_label_window = window_seconds * LABEL_RATE_HZ
    full_windows = labels.size // samples_per_label_window
    features_by_window: dict[int, dict[str, list[float]]] = {}
    counts_by_window: dict[int, dict[str, int]] = {}

    for sensor, rate in SAMPLE_RATES_HZ.items():
        current_window: int | None = None
        current_values: list[object] = []

        def save_current_window() -> None:
            if current_window is None:
                return
            if sensor == "ACC":
                values = np.asarray(
                    [[value["x"], value["y"], value["z"]] for value in current_values],
                    dtype=np.float64,
                )
            else:
                values = np.asarray(current_values, dtype=np.float64)
            summary = sensor_features(sensor, values)
            features_by_window.setdefault(current_window, {})[sensor] = summary
            counts_by_window.setdefault(current_window, {})[sensor] = len(current_values)

        for sample in iter_sensor_samples(e4_dir / f"{sensor}.csv", subject_dir.name, sensor):
            event_time = datetime.fromisoformat(
                str(sample["timestamp"]).replace("Z", "+00:00")
            ).timestamp()
            window_index = int((event_time - origin_epoch) // window_seconds)
            if window_index < 0:
                continue
            if window_index >= full_windows:
                save_current_window()
                current_window = None
                current_values = []
                break
            if current_window is None:
                current_window = window_index
            elif window_index != current_window:
                save_current_window()
                current_window = window_index
                current_values = []
            current_values.append(sample["value"])
        else:
            save_current_window()

    rows: list[list[float]] = []
    targets: list[int] = []
    for window_index in range(full_windows):
        label_start = window_index * samples_per_label_window
        label_values = labels[label_start : label_start + samples_per_label_window]
        stress_count = int(np.count_nonzero(label_values == STRESS_LABEL))
        non_stress_count = int(np.isin(label_values, NON_STRESS_LABELS).sum())
        majority_share = max(stress_count, non_stress_count) / label_values.size
        if majority_share < min_label_purity:
            continue

        features: list[float] = []
        valid_window = True
        for sensor, rate in SAMPLE_RATES_HZ.items():
            count = counts_by_window.get(window_index, {}).get(sensor, 0)
            minimum_count = int(rate * window_seconds * min_sensor_coverage)
            summary = features_by_window.get(window_index, {}).get(sensor)
            if count < minimum_count or summary is None:
                valid_window = False
                break
            features.extend(summary)

        if valid_window and len(features) == len(FEATURE_NAMES):
            rows.append(features)
            targets.append(int(stress_count > non_stress_count))

    duration_seconds = labels.size / LABEL_RATE_HZ
    print(
        f"  {subject_dir.name}: {len(rows)} CSV windows giữ lại / {full_windows} cửa sổ; "
        f"thời lượng nhãn {duration_seconds / 60:.1f} phút"
    )
    del payload, labels, features_by_window, counts_by_window
    gc.collect()
    return rows, targets


def main() -> int:
    args = parse_args()
    if args.window_seconds <= 0:
        print("--window-seconds phải lớn hơn 0.")
        return 2
    if not 0.5 <= args.min_label_purity <= 1.0:
        print("--min-label-purity phải nằm trong khoảng 0.5 đến 1.0.")
        return 2
    if not 0.5 <= args.min_sensor_coverage <= 1.0:
        print("--min-sensor-coverage phải nằm trong khoảng 0.5 đến 1.0.")
        return 2
    if not args.data_root.is_dir():
        print(f"Không tìm thấy thư mục WESAD: {args.data_root}")
        return 2

    available_subjects = sorted(
        (path for path in args.data_root.iterdir() if path.is_dir() and path.name.startswith("S") and path.name[1:].isdigit()),
        key=lambda path: int(path.name[1:]),
    )
    excluded_subjects = sorted(set(args.exclude_subject))
    available_names = {path.name for path in available_subjects}
    unknown_subjects = set(excluded_subjects) - available_names
    if unknown_subjects:
        print(f"Không tìm thấy participant cần loại: {', '.join(sorted(unknown_subjects))}.")
        return 2
    subjects = [path for path in available_subjects if path.name not in set(excluded_subjects)]
    if len(subjects) < 2:
        print(f"Cần ít nhất 2 thư mục người tham gia trong {args.data_root}.")
        return 2
    if excluded_subjects:
        print(f"Loại khỏi cả huấn luyện và LOSO: {', '.join(excluded_subjects)}.")

    all_rows: list[list[float]] = []
    all_labels: list[int] = []
    all_groups: list[str] = []
    print(
        f"Đọc {len(subjects)} người tham gia; cửa sổ={args.window_seconds}s; "
        f"nguồn đặc trưng={args.feature_source}."
    )
    print("Nhãn: stress=2; non-stress=1/3/4; nhãn chuyển tiếp/khác bị loại.")

    for subject_dir in subjects:
        try:
            if args.feature_source == "csv":
                rows, labels = extract_subject_csv(
                    subject_dir,
                    args.window_seconds,
                    args.min_label_purity,
                    args.min_sensor_coverage,
                )
            else:
                rows, labels = extract_subject(
                    subject_dir, args.window_seconds, args.min_label_purity
                )
        except (OSError, EOFError, pickle.UnpicklingError, KeyError, ValueError) as error:
            print(f"  BỎ QUA {subject_dir.name}: không đọc được pickle/nhãn/tín hiệu ({error})")
            continue
        all_rows.extend(rows)
        all_labels.extend(labels)
        all_groups.extend([subject_dir.name] * len(labels))

    if not all_rows:
        print("Không tạo được cửa sổ huấn luyện nào; cần kiểm tra cấu trúc file .pkl.")
        return 1
    if len(set(all_labels)) < 2:
        print("Dữ liệu tạo được chỉ có một lớp; cần thêm cửa sổ stress và non-stress.")
        return 1
    if len(set(all_groups)) < 2:
        print("Cần dữ liệu hợp lệ từ ít nhất hai người để tách train/test theo người.")
        return 1

    x = np.asarray(all_rows, dtype=np.float32)
    y = np.asarray(all_labels, dtype=np.int64)
    groups = np.asarray(all_groups)
    logo = LeaveOneGroupOut()
    out_of_fold = np.full(y.shape, -1, dtype=np.int64)
    fold_metrics: list[dict[str, float]] = []
    print(f"\nĐánh giá LOSO trên {len(set(groups))} người; mỗi lượt giữ riêng một người:")
    for fold_index, (train_index, test_index) in enumerate(logo.split(x, y, groups), start=1):
        held_out = sorted(set(groups[test_index]))
        if len(np.unique(y[train_index])) < 2 or len(np.unique(y[test_index])) < 2:
            print(f"  Fold {fold_index} {held_out}: bỏ qua vì train/test thiếu một lớp.")
            continue
        fold_model = make_model(args.seed)
        fold_model.fit(x[train_index], y[train_index])
        predictions = fold_model.predict(x[test_index])
        out_of_fold[test_index] = predictions
        metrics = {
            "accuracy": float(accuracy_score(y[test_index], predictions)),
            "balanced_accuracy": float(balanced_accuracy_score(y[test_index], predictions)),
            "stress_recall": float(
                recall_score(y[test_index], predictions, pos_label=1, zero_division=0)
            ),
            "stress_f1": float(
                f1_score(y[test_index], predictions, pos_label=1, zero_division=0)
            ),
        }
        fold_metrics.append(metrics)
        print(
            f"  {held_out[0]}: n={len(test_index):>3}, "
            f"balanced_acc={metrics['balanced_accuracy']:.3f}, "
            f"stress_recall={metrics['stress_recall']:.3f}, "
            f"stress_f1={metrics['stress_f1']:.3f}"
        )

    if not fold_metrics or np.any(out_of_fold < 0):
        print("LOSO chưa đánh giá đủ người tham gia; không lưu model.")
        return 1

    print(f"\nTổng cửa sổ: {len(y):,}; đã đánh giá ngoài train theo từng người.")
    for metric_name, display_name in (
        ("accuracy", "Accuracy"),
        ("balanced_accuracy", "Balanced accuracy"),
        ("stress_recall", "Stress recall"),
        ("stress_f1", "Stress F1"),
    ):
        values = np.asarray([fold[metric_name] for fold in fold_metrics])
        standard_deviation = float(np.std(values, ddof=1)) if values.size > 1 else 0.0
        print(f"{display_name:19}: {values.mean():.3f} ± {standard_deviation:.3f} (mean ± SD theo người)")
    print("Confusion matrix OOF (rows=true, columns=predicted; 0=non-stress, 1=stress):")
    print(confusion_matrix(y, out_of_fold, labels=[0, 1]))
    print("\nClassification report OOF:")
    print(
        classification_report(
            y,
            out_of_fold,
            labels=[0, 1],
            target_names=["non-stress", "stress"],
            zero_division=0,
        )
    )

    # After out-of-fold evaluation, refit the deployable model on every included subject.
    model = make_model(args.seed)
    model.fit(x, y)
    train_subjects = sorted(set(groups))

    heldout_metrics: dict[str, dict[str, float]] = {}
    for subject_dir in available_subjects:
        if subject_dir.name not in excluded_subjects:
            continue
        try:
            if args.feature_source == "csv":
                heldout_rows, heldout_labels = extract_subject_csv(
                    subject_dir,
                    args.window_seconds,
                    args.min_label_purity,
                    args.min_sensor_coverage,
                )
            else:
                heldout_rows, heldout_labels = extract_subject(
                    subject_dir, args.window_seconds, args.min_label_purity
                )
        except (OSError, EOFError, pickle.UnpicklingError, KeyError, ValueError) as error:
            print(f"  Không thể đánh giá participant giữ riêng {subject_dir.name}: {error}")
            continue
        if not heldout_rows or len(set(heldout_labels)) < 2:
            print(f"  Không đủ cửa sổ hai nhãn để đánh giá {subject_dir.name}.")
            continue

        heldout_x = np.asarray(heldout_rows, dtype=np.float32)
        heldout_y = np.asarray(heldout_labels, dtype=np.int64)
        heldout_predictions = model.predict(heldout_x)
        metrics = {
            "accuracy": float(accuracy_score(heldout_y, heldout_predictions)),
            "balanced_accuracy": float(balanced_accuracy_score(heldout_y, heldout_predictions)),
            "stress_recall": float(
                recall_score(heldout_y, heldout_predictions, pos_label=1, zero_division=0)
            ),
            "stress_f1": float(
                f1_score(heldout_y, heldout_predictions, pos_label=1, zero_division=0)
            ),
        }
        heldout_metrics[subject_dir.name] = metrics
        print(f"\nĐánh giá độc lập trên participant giữ riêng {subject_dir.name}:")
        print(
            f"  n={len(heldout_y)}, accuracy={metrics['accuracy']:.3f}, "
            f"balanced_acc={metrics['balanced_accuracy']:.3f}, "
            f"stress_recall={metrics['stress_recall']:.3f}, "
            f"stress_f1={metrics['stress_f1']:.3f}"
        )
        print("  Confusion matrix (rows=true, columns=predicted; 0=non-stress, 1=stress):")
        print(confusion_matrix(heldout_y, heldout_predictions, labels=[0, 1]))
        print(
            classification_report(
                heldout_y,
                heldout_predictions,
                labels=[0, 1],
                target_names=["non-stress", "stress"],
                zero_division=0,
            )
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(
        {
            "model": model,
            "feature_names": FEATURE_NAMES,
            "window_seconds": args.window_seconds,
            "sample_rates_hz": SAMPLE_RATES_HZ,
            "label_mapping": {"non-stress": 0, "stress": 1},
            "train_subjects": train_subjects,
            "excluded_subjects": excluded_subjects,
            "evaluation": "leave-one-subject-out",
            "feature_source": args.feature_source,
            "heldout_metrics": heldout_metrics,
            "loso_mean_metrics": {
                key: float(np.mean([fold[key] for fold in fold_metrics]))
                for key in fold_metrics[0]
            },
        },
        args.output,
    )
    print(f"\nĐã lưu model: {args.output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
