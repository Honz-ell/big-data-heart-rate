from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from wesad.e4_reader import SENSORS, iter_subject_samples  # noqa: E402
from wesad.pickle_reader import iter_pickle_sensor_samples  # noqa: E402
from wesad.replay_clock import allocate_replay_shift  # noqa: E402


def _allocate_stream_shift(source_start_epoch: float, duration_seconds: float) -> int:
    import psycopg

    with psycopg.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        dbname=os.getenv("DB_NAME", "wesad"),
        user=os.getenv("DB_USER", "wesad"),
        password=os.getenv("DB_PASSWORD", "wesad_dev_password"),
        connect_timeout=3,
    ) as connection:
        return allocate_replay_shift(connection, source_start_epoch, duration_seconds)


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
        default=["ACC", "BVP", "EDA", "HR", "IBI", "TEMP"],
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
    parser.add_argument(
        "--stream-shift-seconds",
        type=int,
        default=None,
        help="Internal Spark event-time shift. Omit to reserve a safe range in PostgreSQL.",
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
    playback_origin: float | None = None
    playback_started_at: float | None = None
    stream_shift_seconds = args.stream_shift_seconds
    last_event: dict[str, object] | None = None
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
            linger_ms=10,
        )
        already_sliced = False
        if args.source == "pickle":
            records = iter_pickle_sensor_samples(
                subject_dir,
                tuple(args.sensors),
                start_offset_seconds=args.start_offset_seconds,
                duration_seconds=args.duration_seconds,
            )
            already_sliced = True
        else:
            records = iter_subject_samples(subject_dir, tuple(args.sensors))
        last_future = None
        for record in records:
            event_time = datetime.fromisoformat(
                str(record["timestamp"]).replace("Z", "+00:00")
            ).timestamp()
            if not already_sliced:
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
            if stream_shift_seconds is None:
                try:
                    stream_shift_seconds = _allocate_stream_shift(
                        event_time, args.duration_seconds
                    )
                except Exception as error:
                    raise RuntimeError(
                        "Không cấp được mốc replay qua PostgreSQL. Hãy bật PostgreSQL "
                        "hoặc truyền --stream-shift-seconds nếu chỉ kiểm tra Kafka."
                    ) from error
            if playback_origin is None:
                playback_origin = event_time
                playback_started_at = time.monotonic()
            if playback_origin is not None and playback_started_at is not None:
                deadline = playback_started_at + (event_time - playback_origin) / args.speed
                wait_seconds = deadline - time.monotonic()
                # Anchor pacing to one monotonic clock. Sub-millisecond sleeps
                # on every sample accumulate scheduler overhead on Windows.
                if wait_seconds >= 0.002:
                    time.sleep(wait_seconds)
            record = dict(record)
            shifted_time = event_time + int(stream_shift_seconds or 0)
            record["stream_timestamp"] = datetime.fromtimestamp(
                shifted_time, timezone.utc
            ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            record["replay_shift_seconds"] = int(stream_shift_seconds or 0)

            last_future = producer.send(
                args.topic,
                key=args.subject.encode("utf-8"),
                value=json.dumps(record, separators=(",", ":")).encode("utf-8"),
            )
            sent += 1
            last_event = record
            if sent % 250 == 0:
                last_future.get(timeout=30)
            if sent % 100 == 0:
                print(f"Đã gửi {sent:,} mẫu; mẫu mới nhất: {record['sensor']} @ {record['timestamp']}")
            if args.limit and sent >= args.limit:
                break
        if last_future is not None:
            last_future.get(timeout=30)
        if last_event is not None:
            last_source_time = datetime.fromisoformat(
                str(last_event["timestamp"]).replace("Z", "+00:00")
            ).timestamp()
            flush_epoch = last_source_time + 26.0
            control_record = {
                "subject_id": args.subject,
                "timestamp": datetime.fromtimestamp(
                    flush_epoch, timezone.utc
                ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "stream_timestamp": datetime.fromtimestamp(
                    flush_epoch + int(stream_shift_seconds or 0), timezone.utc
                ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "replay_shift_seconds": int(stream_shift_seconds or 0),
                "sensor": "__CONTROL__",
                "unit": "control",
                "sample_index": -1,
                "value": 0,
                "replay_control": True,
            }
            last_future = producer.send(
                args.topic,
                key=args.subject.encode("utf-8"),
                value=json.dumps(control_record, separators=(",", ":")).encode("utf-8"),
            )
            last_future.get(timeout=30)
            print(
                f"Đã gửi bản tin kết thúc replay để Spark chốt các cửa sổ "
                f"(dịch thời gian nội bộ {int(stream_shift_seconds or 0)}s)."
            )
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
