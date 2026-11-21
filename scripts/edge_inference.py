from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import joblib
import numpy as np
import requests
from kafka import KafkaConsumer

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from wesad.features import FEATURE_NAMES, SAMPLE_RATES_HZ, sensor_features  # noqa: E402
from wesad.vitals import summarize_window_vitals  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run one simulated wearable's windowed stress inference from Kafka."
    )
    parser.add_argument("--subject", required=True, help="Device/participant ID, such as S4")
    parser.add_argument("--broker", default="localhost:9092")
    parser.add_argument("--topic", default="wearable.sensor.v1")
    parser.add_argument(
        "--starting-offsets",
        choices=("earliest", "latest"),
        default="earliest",
        help="Kafka starting position for a consumer group with no committed offsets.",
    )
    parser.add_argument(
        "--consumer-group",
        default=None,
        help="Optional unique Kafka group ID; useful when waiting for a new replay.",
    )
    parser.add_argument("--model", type=Path, default=Path("models/stress_rf.joblib"))
    parser.add_argument(
        "--model-registry-url",
        default=None,
        help="Optional registry URL; the Edge checks for an active model version while streaming.",
    )
    parser.add_argument("--model-poll-seconds", type=float, default=5.0)
    parser.add_argument("--window-seconds", type=int, default=None)
    parser.add_argument("--min-coverage", type=float, default=0.8)
    parser.add_argument(
        "--store-postgres",
        action="store_true",
        help="Save completed window predictions to the local PostgreSQL container.",
    )
    return parser.parse_args()


def to_datetime(timestamp: str) -> datetime:
    return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(timezone.utc)


def floor_to_10s(dt: datetime) -> datetime:
    """Align window origin to 10-second UTC boundaries so 30s Edge windows match 3x10s Spark windows."""
    floored_epoch = (int(dt.timestamp()) // 10) * 10
    return datetime.fromtimestamp(floored_epoch, tz=timezone.utc)


def has_min_coverage(
    samples: dict[str, list[object]], min_coverage: float, window_seconds: int
) -> bool:
    return all(
        len(samples[sensor]) >= int(rate * window_seconds * min_coverage)
        for sensor, rate in SAMPLE_RATES_HZ.items()
    )


def summarize_window(
    samples: dict[str, list[object]], min_coverage: float, window_seconds: int
) -> tuple[list[float] | None, dict[str, int]]:
    features: list[float] = []
    counts = {sensor: len(samples[sensor]) for sensor in SAMPLE_RATES_HZ}
    for sensor, rate in SAMPLE_RATES_HZ.items():
        minimum_count = int(rate * window_seconds * min_coverage)
        if counts[sensor] < minimum_count:
            return None, counts
        if sensor == "ACC":
            values = np.asarray(
                [[sample["x"], sample["y"], sample["z"]] for sample in samples[sensor]],
                dtype=np.float64,
            )
        else:
            values = np.asarray(samples[sensor], dtype=np.float64)
        stats = sensor_features(sensor, values)
        if stats is None:
            return None, counts
        features.extend(stats)
    return features, counts


def main() -> int:
    args = parse_args()
    if not args.subject.startswith("S") or not args.subject[1:].isdigit():
        print("--subject phải có định dạng S2, S3, S4, ...")
        return 2
    if not 0.5 <= args.min_coverage <= 1.0:
        print("--min-coverage phải nằm trong khoảng từ 0.5 đến 1.0.")
        return 2
    if args.model_poll_seconds <= 0:
        print("--model-poll-seconds phải lớn hơn 0.")
        return 2
    if not args.model.is_file():
        print(f"Không tìm thấy tệp mô hình: {args.model.resolve()}")
        return 2

    bundle = joblib.load(args.model)
    model = bundle["model"]
    model_file = args.model.name
    model_version: str | None = bundle.get("model_version")
    feature_names = tuple(bundle["feature_names"])
    if feature_names != FEATURE_NAMES:
        print("Danh sách đặc trưng của mô hình không khớp với bộ trích xuất tại Edge.")
        return 2
    window_seconds = args.window_seconds or int(bundle["window_seconds"])
    if window_seconds != int(bundle["window_seconds"]):
        print(
            f"Model yêu cầu cửa sổ {bundle['window_seconds']}s; "
            f"không thể dùng cửa sổ {window_seconds}s."
        )
        return 2

    stop_requested = False

    def handle_stop(_signum: int, _frame: object) -> None:
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGTERM, handle_stop)

    def refresh_active_model() -> bool:
        nonlocal model, model_file, model_version
        if not args.model_registry_url:
            return False
        base_url = args.model_registry_url.rstrip("/")
        try:
            metadata_response = requests.get(f"{base_url}/models/active", timeout=5)
            if metadata_response.status_code == 404:
                return False
            metadata_response.raise_for_status()
            metadata = metadata_response.json()
            version = str(metadata["version"])
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", version):
                raise ValueError("Registry returned an invalid model version")
            if version == model_version:
                return False

            download_url = str(metadata["download_url"])
            if download_url.startswith("/"):
                download_url = f"{base_url}{download_url}"
            download_response = requests.get(download_url, timeout=60)
            download_response.raise_for_status()
            content = download_response.content
            digest = hashlib.sha256(content).hexdigest()
            if digest != metadata["sha256"]:
                raise ValueError("Downloaded model checksum does not match registry")

            cache_dir = args.model.parent / "edge_cache"
            cache_dir.mkdir(parents=True, exist_ok=True)
            model_path = cache_dir / f"{version}.joblib"
            temporary_path = cache_dir / f".{version}.joblib.tmp"
            temporary_path.write_bytes(content)
            candidate_bundle = joblib.load(temporary_path)
            if tuple(candidate_bundle.get("feature_names", ())) != FEATURE_NAMES:
                raise ValueError("Registry model feature schema does not match Edge")
            if int(candidate_bundle.get("window_seconds", 0)) != window_seconds:
                raise ValueError("Registry model window size does not match Edge")
            temporary_path.replace(model_path)
            model = candidate_bundle["model"]
            model_file = str(metadata["model_file"])
            model_version = version
            print(f"Model Edge đã cập nhật: version={model_version}, file={model_file}")
            return True
        except (requests.RequestException, KeyError, OSError, ValueError, TypeError) as error:
            print(f"Chưa cập nhật được model từ registry; tiếp tục dùng model hiện tại: {error}")
            return False

    if args.model_registry_url:
        refresh_active_model()

    db_connection = None
    if args.store_postgres:
        try:
            import psycopg
            from psycopg.types.json import Jsonb

            db_connection = psycopg.connect(
                host=os.getenv("DB_HOST", "localhost"),
                port=int(os.getenv("DB_PORT", "5432")),
                dbname=os.getenv("DB_NAME", "wesad"),
                user=os.getenv("DB_USER", "wesad"),
                password=os.getenv("DB_PASSWORD", "wesad_dev_password"),
                connect_timeout=5,
            )
            db_connection.execute("SELECT 1 FROM stress_predictions LIMIT 1")
            db_connection.execute(
                "ALTER TABLE stress_predictions ADD COLUMN IF NOT EXISTS model_version TEXT"
            )
            db_connection.execute(
                "ALTER TABLE stress_predictions "
                "ADD COLUMN IF NOT EXISTS vitals JSONB NOT NULL DEFAULT '{}'::jsonb"
            )
            db_connection.commit()
        except Exception as error:
            if db_connection is not None:
                db_connection.close()
            print(
                "Không kết nối/lưu được PostgreSQL. Hãy chạy `docker compose up -d postgres` "
                f"và cài requirements.txt. Chi tiết: {error}"
            )
            return 1
    else:
        Jsonb = None

    try:
        consumer = KafkaConsumer(
            args.topic,
            bootstrap_servers=args.broker,
            auto_offset_reset=args.starting_offsets,
            group_id=args.consumer_group or f"edge-sim-{args.subject.lower()}",
            enable_auto_commit=False,
        )
    except Exception as error:
        print(f"Không kết nối được Kafka tại {args.broker}: {error}")
        if db_connection is not None:
            db_connection.close()
        return 1

    consumer.poll(timeout_ms=1000)

    origin: datetime | None = None
    active_window: int | None = None
    samples: dict[str, list[object]] = defaultdict(list)
    baseline_hr_bpm: float | None = None
    baseline_eda_us: float | None = None
    emitted = 0
    idle_polls = 0
    print(
        f"Edge simulator {args.subject} đang đọc {args.topic} từ {args.broker}; "
        f"cửa sổ={window_seconds}s. Nhấn Ctrl+C để dừng."
    )

    def commit_offsets_safely() -> None:
        try:
            consumer.commit()
        except Exception:
            pass

    def finish_window(window_index: int, window_samples: dict[str, list[object]]) -> None:
        nonlocal emitted, baseline_hr_bpm, baseline_eda_us
        features, counts = summarize_window(
            window_samples, args.min_coverage, window_seconds
        )
        if features is None:
            if any(counts.values()):
                print(
                    f"Bỏ cửa sổ {window_index}: chưa đủ mẫu "
                    + ", ".join(f"{sensor}={counts[sensor]}" for sensor in SAMPLE_RATES_HZ)
                )
            return
        probabilities = model.predict_proba([features])[0]
        class_indices = list(model.classes_)
        stress_probability = float(probabilities[class_indices.index(1)])

        vitals = summarize_window_vitals(
            window_samples=window_samples,
            features=features,
            model_score_stress=stress_probability,
            baseline_hr_bpm=baseline_hr_bpm,
            baseline_eda_us=baseline_eda_us,
        )
        if (
            vitals["activity_state"] == "RESTING"
            and vitals["heart_anomaly"] == "NONE"
            and stress_probability < 0.35
            and vitals["hr_bpm"] is not None
            and float(vitals["hr_bpm"]) < 88.0
        ):
            cur_hr = float(vitals["hr_bpm"])
            cur_eda = float(vitals["eda_mean_us"])
            baseline_hr_bpm = cur_hr if baseline_hr_bpm is None else (0.75 * baseline_hr_bpm + 0.25 * cur_hr)
            baseline_eda_us = cur_eda if baseline_eda_us is None else (0.75 * baseline_eda_us + 0.25 * cur_eda)

        # Keep the classifier's output intact. ACC is shown as context, not used
        # as an unvalidated post-processing rule that can reverse the prediction.
        prediction = "STRESS" if stress_probability >= 0.5 else "NON_STRESS"
        assert origin is not None
        window_start = origin + timedelta(seconds=window_index * window_seconds)
        window_end = window_start + timedelta(seconds=window_seconds)
        emitted += 1
        hr_str = f"{vitals['hr_bpm']:.1f}bpm" if vitals["hr_bpm"] is not None else "n/a"
        hrv_str = f"{vitals['hrv_rmssd_ms']:.1f}ms" if vitals["hrv_rmssd_ms"] is not None else "n/a"
        print(
            f"{args.subject} | {window_start.isoformat()} – {window_end.isoformat()} | "
            f"prediction={prediction} | rf={stress_probability:.3f} | load={vitals['stress_load']}/100 | "
            f"HR={hr_str} | HRV={hrv_str} | EDA={vitals['eda_mean_us']:.2f}uS | "
            f"motion={vitals['activity_state']} | samples="
            + ",".join(f"{sensor}:{counts[sensor]}" for sensor in SAMPLE_RATES_HZ)
        )
        if db_connection is not None:
            db_connection.execute(
                """
                INSERT INTO stress_predictions (
                    subject_id, window_start, window_end, prediction,
                    model_score_stress, model_file, model_version, sample_counts, vitals
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (subject_id, window_start) DO UPDATE SET
                    window_end = EXCLUDED.window_end,
                    prediction = EXCLUDED.prediction,
                    model_score_stress = EXCLUDED.model_score_stress,
                    model_file = EXCLUDED.model_file,
                    model_version = EXCLUDED.model_version,
                    sample_counts = EXCLUDED.sample_counts,
                    vitals = EXCLUDED.vitals,
                    created_at = NOW()
                """,
                (
                    args.subject,
                    window_start,
                    window_end,
                    prediction,
                    stress_probability,
                    model_file,
                    model_version,
                    Jsonb(counts),
                    Jsonb(vitals),
                ),
            )
            db_connection.commit()
            print("  ↳ Đã lưu cửa sổ dự đoán và chỉ số sinh tồn vào PostgreSQL.")
        commit_offsets_safely()

    last_model_check = time.monotonic()
    try:
        while not stop_requested:
            now = time.monotonic()
            if args.model_registry_url and now - last_model_check >= args.model_poll_seconds:
                refresh_active_model()
                last_model_check = now

            records = consumer.poll(timeout_ms=1000, max_records=500)
            if not records:
                idle_polls += 1
                if (
                    idle_polls >= 2
                    and origin is not None
                    and active_window is not None
                    and has_min_coverage(samples, args.min_coverage, window_seconds)
                ):
                    finish_window(active_window, samples)
                    samples = defaultdict(list)
                    active_window += 1
                continue

            idle_polls = 0
            for partition_records in records.values():
                for message in partition_records:
                    event = json.loads(message.value.decode("utf-8"))
                    if event.get("subject_id") != args.subject:
                        continue
                    sensor = event.get("sensor")
                    if sensor not in SAMPLE_RATES_HZ and sensor not in {"HR", "IBI"}:
                        continue
                    event_time = to_datetime(event["timestamp"])
                    if origin is None or active_window is None:
                        origin = floor_to_10s(event_time)
                        active_window = 0

                    window_index = int((event_time - origin).total_seconds() // window_seconds)
                    # Handle non-contiguous replay jumps (backward offset or large forward jump)
                    if window_index < active_window or window_index > active_window + 2:
                        if has_min_coverage(samples, args.min_coverage, window_seconds):
                            finish_window(active_window, samples)
                        samples = defaultdict(list)
                        origin = floor_to_10s(event_time)
                        active_window = 0
                        window_index = 0
                        print(f"Đặt lại mốc cửa sổ theo luồng phát mới: {origin.isoformat()}")

                    while window_index > active_window:
                        finish_window(active_window, samples)
                        samples = defaultdict(list)
                        active_window += 1

                    samples[str(sensor)].append(event["value"])
    except KeyboardInterrupt:
        print("\nĐã dừng Edge simulator.")
    except Exception as error:
        print(f"Lỗi khi đọc hoặc dự đoán dữ liệu: {error}")
        return 1
    finally:
        if (
            origin is not None
            and active_window is not None
            and has_min_coverage(samples, args.min_coverage, window_seconds)
        ):
            try:
                finish_window(active_window, samples)
            except Exception:
                pass
        consumer.close()
        if db_connection is not None:
            db_connection.close()

    print(f"Tổng số cửa sổ đã dự đoán: {emitted}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
