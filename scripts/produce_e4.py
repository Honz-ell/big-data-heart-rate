from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from wesad.e4_reader import SENSORS, iter_subject_samples  # noqa: E402
from wesad.pickle_reader import iter_pickle_sensor_samples  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replay WESAD wrist E4 samples to an Apache Kafka topic."
    )
    parser.add_argument("--data", type=Path, default=Path(r"D:\btldll\archive\WESAD"))
    parser.add_argument("--subject", default="S2", help="WESAD subject, for example S2")
    parser.add_argument(
        "--sensors",
        nargs="+",
        choices=SENSORS,
        default=["ACC", "BVP", "EDA", "HR", "TEMP"],
    )
    parser.add_argument("--broker", default="localhost:9092")
    parser.add_argument("--topic", default="wearable.sensor.v1")
    parser.add_argument(
        "--source",
        choices=("csv", "pickle"),
        default="csv",
        help="Read live-like E4 CSV rows or synchronized wrist arrays from the subject pickle.",
    )
    parser.add_argument("--speed", type=float, default=60.0, help="Replay acceleration factor")
    parser.add_argument("--limit", type=int, default=1000, help="Maximum messages; 0 means no limit")
    parser.add_argument(
        "--start-offset-seconds",
        type=float,
        default=0.0,
        help="Skip this many seconds from the beginning of the recording.",
    )
    parser.add_argument(
        "--duration-seconds",
        type=float,
        default=0.0,
        help="Replay this many seconds after the offset; 0 means continue to limit/end.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    subject_dir = args.data / args.subject
    e4_dir = subject_dir / f"{args.subject}_E4_Data"
    if args.source == "csv":
        if not e4_dir.is_dir():
            print(f"Không tìm thấy thư mục cảm biến: {e4_dir}")
            return 2
        missing = [sensor for sensor in args.sensors if not (e4_dir / f"{sensor}.csv").is_file()]
        if missing:
            print(f"Thiếu file cảm biến: {', '.join(missing)} trong {e4_dir}")
            return 2
    if (
        args.speed <= 0
        or args.limit < 0
        or args.start_offset_seconds < 0
        or args.duration_seconds < 0
    ):
        print("--speed phải lớn hơn 0; các giới hạn và offset không được âm.")
        return 2

    try:
        from kafka import KafkaProducer
    except ImportError:
        print("Chưa có kafka-python. Chạy: python -m pip install -r requirements.txt")
        return 2

    producer = None
    sent = 0
    recording_origin: float | None = None
    segment_start: float | None = None
    segment_end: float | None = None
    previous_timestamp: float | None = None
    print(
        f"Đang phát {args.subject} ({', '.join(args.sensors)}) tới "
        f"{args.broker}, topic={args.topic}, source={args.source}, speed={args.speed}x, "
        f"offset={args.start_offset_seconds:g}s, "
        f"duration={args.duration_seconds:g}s"
    )
    try:
        producer = KafkaProducer(
            bootstrap_servers=args.broker,
            acks="all",
            retries=5,
        )
        if args.source == "pickle":
            records = iter_pickle_sensor_samples(subject_dir, tuple(args.sensors))
        else:
            records = iter_subject_samples(subject_dir, tuple(args.sensors))
        for record in records:
            event_time = datetime.fromisoformat(
                str(record["timestamp"]).replace("Z", "+00:00")
            ).timestamp()
            if recording_origin is None:
                recording_origin = event_time
                segment_start = recording_origin + args.start_offset_seconds
                if args.duration_seconds:
                    segment_end = segment_start + args.duration_seconds
            assert segment_start is not None
            if event_time < segment_start:
                continue
            if segment_end is not None and event_time >= segment_end:
                break
            if previous_timestamp is not None:
                wait_seconds = max(0.0, (event_time - previous_timestamp) / args.speed)
                if wait_seconds:
                    time.sleep(wait_seconds)
            previous_timestamp = event_time

            producer.send(
                args.topic,
                key=args.subject.encode("utf-8"),
                value=json.dumps(record, separators=(",", ":")).encode("utf-8"),
            ).get(timeout=30)
            sent += 1
            if sent % 100 == 0:
                print(f"Đã gửi {sent:,} mẫu; mẫu mới nhất: {record['sensor']} @ {record['timestamp']}")
            if args.limit and sent >= args.limit:
                break
    except KeyboardInterrupt:
        print("Đã nhận Ctrl+C, đang hoàn tất các bản ghi còn trong hàng đợi.")
    except Exception as error:
        print(f"Không gửi được dữ liệu vào Kafka: {error}")
        return 1
    finally:
        if producer is not None:
            producer.flush()
            producer.close()

    print(f"Hoàn tất: đã gửi {sent:,} mẫu vào topic {args.topic}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
