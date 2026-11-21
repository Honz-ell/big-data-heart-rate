from __future__ import annotations

import argparse
import json
import os
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from pyspark.sql import SparkSession, functions as F
from pyspark.storagelevel import StorageLevel


class MetricsState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._values: dict[str, float] = {
            "wesad_spark_stream_up": 0,
            "wesad_spark_records_in_batch": 0,
            "wesad_spark_input_records_per_second": 0,
            "wesad_spark_processed_records_per_second": 0,
            "wesad_spark_trigger_execution_ms": 0,
            "wesad_spark_last_batch_timestamp_seconds": 0,
        }

    def update(self, progress: dict[str, Any]) -> None:
        duration_ms = progress.get("durationMs") or {}
        batch_timestamp = progress.get("timestamp")
        try:
            timestamp_seconds = datetime.fromisoformat(
                str(batch_timestamp).replace("Z", "+00:00")
            ).timestamp()
        except (TypeError, ValueError):
            timestamp_seconds = 0
        values = {
            "wesad_spark_stream_up": 1,
            "wesad_spark_records_in_batch": float(progress.get("numInputRows") or 0),
            "wesad_spark_input_records_per_second": float(
                progress.get("inputRowsPerSecond") or 0
            ),
            "wesad_spark_processed_records_per_second": float(
                progress.get("processedRowsPerSecond") or 0
            ),
            "wesad_spark_trigger_execution_ms": float(
                duration_ms.get("triggerExecution") or 0
            ),
            "wesad_spark_last_batch_timestamp_seconds": timestamp_seconds,
        }
        with self._lock:
            self._values = values

    def set_down(self) -> None:
        with self._lock:
            self._values["wesad_spark_stream_up"] = 0

    def render(self) -> str:
        help_text = {
            "wesad_spark_stream_up": "Whether the Spark Structured Streaming query has reported progress.",
            "wesad_spark_records_in_batch": "Kafka records processed by the most recent Spark micro-batch.",
            "wesad_spark_input_records_per_second": "Spark source input rate for the most recent micro-batch.",
            "wesad_spark_processed_records_per_second": "Spark processing rate for the most recent micro-batch.",
            "wesad_spark_trigger_execution_ms": "Wall-clock execution time of the most recent Spark micro-batch in milliseconds.",
            "wesad_spark_last_batch_timestamp_seconds": "Unix timestamp when Spark started the most recent micro-batch.",
        }
        with self._lock:
            values = self._values.copy()
        lines: list[str] = []
        for name, description in help_text.items():
            lines.extend((f"# HELP {name} {description}", f"# TYPE {name} gauge"))
            lines.append(f"{name} {values[name]}")
        return "\n".join(lines) + "\n"


METRICS = MetricsState()


class MetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path != "/metrics":
            self.send_error(404)
            return
        body = METRICS.render().encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Aggregate WESAD wearable events from Kafka with Structured Streaming."
    )
    parser.add_argument("--broker", default="kafka:9092")
    parser.add_argument("--topic", default="wearable.sensor.v1")
    parser.add_argument("--window", default="10 seconds")
    parser.add_argument("--watermark", default="15 seconds")
    parser.add_argument("--starting-offsets", choices=("earliest", "latest"), default="earliest")
    parser.add_argument(
        "--checkpoint-location",
        default="/opt/project/checkpoints/spark-postgres",
    )
    parser.add_argument(
        "--postgres-url", default="jdbc:postgresql://postgres:5432/wesad"
    )
    parser.add_argument("--postgres-user", default="wesad")
    parser.add_argument("--metrics-host", default="0.0.0.0")
    parser.add_argument("--metrics-port", type=int, default=9095)
    return parser.parse_args()


def write_microbatch_to_postgres(batch_df, batch_id: int, args: argparse.Namespace) -> None:
    """Write each completed Spark window batch through Spark's JDBC data source."""
    output = (
        batch_df.where(F.col("sensor") != "__CONTROL__")
        .withColumn("spark_batch_id", F.lit(batch_id).cast("long"))
    )
    if not output.take(1):
        print(f"Spark micro-batch #{batch_id} chỉ chứa bản tin điều khiển watermark.")
        return
    (
        output.write.format("jdbc")
        .option("url", args.postgres_url)
        .option("dbtable", "sensor_window_aggregates")
        .option("user", args.postgres_user)
        .option("password", os.environ.get("WESAD_DB_PASSWORD", "wesad_dev_password"))
        .option("driver", "org.postgresql.Driver")
        .option("batchsize", "1000")
        .mode("append")
        .save()
    )
    print(f"Đã ghi micro-batch Spark #{batch_id} vào sensor_window_aggregates.")


def main() -> None:
    args = parse_args()
    spark = (
        SparkSession.builder.appName("WESAD-Wrist-Window-Aggregation")
        .config("spark.sql.session.timeZone", "UTC")
        .config("spark.sql.shuffle.partitions", "1")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("WARN")

    kafka_records = (
        spark.readStream.format("kafka")
        .option("kafka.bootstrap.servers", args.broker)
        .option("subscribe", args.topic)
        .option("startingOffsets", args.starting_offsets)
        .option("failOnDataLoss", "false")
        .load()
    )

    decoded = kafka_records.selectExpr("CAST(value AS STRING) AS json")
    events = decoded.select(
        F.get_json_object("json", "$.subject_id").alias("subject_id"),
        F.to_timestamp(F.get_json_object("json", "$.timestamp")).alias("event_time"),
        F.to_timestamp(
            F.coalesce(
                F.get_json_object("json", "$.stream_timestamp"),
                F.get_json_object("json", "$.timestamp"),
            )
        ).alias("stream_time"),
        F.coalesce(
            F.get_json_object("json", "$.replay_shift_seconds").cast("double"),
            F.lit(0.0),
        ).alias("replay_shift_seconds"),
        F.get_json_object("json", "$.sensor").alias("sensor"),
        F.get_json_object("json", "$.unit").alias("unit"),
        F.get_json_object("json", "$.value").alias("value_json"),
    )

    scalar_value = F.col("value_json").cast("double")
    acc_x = F.get_json_object("value_json", "$.x").cast("double")
    acc_y = F.get_json_object("value_json", "$.y").cast("double")
    acc_z = F.get_json_object("value_json", "$.z").cast("double")
    acc_magnitude = F.sqrt(F.pow(acc_x, 2) + F.pow(acc_y, 2) + F.pow(acc_z, 2))
    valid_measurement = (
        F.col("measurement").isNotNull()
        & ((F.col("sensor") != "TEMP") | F.col("measurement").between(20.0, 45.0))
        & ((F.col("sensor") != "HR") | F.col("measurement").between(35.0, 210.0))
        & ((F.col("sensor") != "EDA") | F.col("measurement").between(0.0, 60.0))
    )

    measurable = (
        events.withColumn(
            "measurement",
            F.when(F.col("sensor") == "ACC", acc_magnitude).otherwise(scalar_value),
        )
        .where(
            F.col("subject_id").isNotNull()
            & F.col("event_time").isNotNull()
            & F.col("stream_time").isNotNull()
            & valid_measurement
        )
        .withWatermark("stream_time", args.watermark)
    )

    aggregates = (
        measurable.groupBy(
            F.window("stream_time", args.window),
            "replay_shift_seconds",
            "subject_id",
            "sensor",
            "unit",
        )
        .agg(
            F.count("*").alias("sample_count"),
            F.round(F.avg("measurement"), 3).alias("mean_value"),
            F.round(F.min("measurement"), 3).alias("min_value"),
            F.round(F.max("measurement"), 3).alias("max_value"),
        )
        .select(
            F.timestamp_seconds(
                F.col("window.start").cast("double") - F.col("replay_shift_seconds")
            ).alias("window_start_utc"),
            F.timestamp_seconds(
                F.col("window.end").cast("double") - F.col("replay_shift_seconds")
            ).alias("window_end_utc"),
            "subject_id",
            "sensor",
            "unit",
            "sample_count",
            "mean_value",
            "min_value",
            "max_value",
        )
    )

    query = (
        aggregates.writeStream.outputMode("append")
        .foreachBatch(
            lambda batch_df, batch_id: write_microbatch_to_postgres(
                batch_df, batch_id, args
            )
        )
        .option("checkpointLocation", args.checkpoint_location)
        .trigger(processingTime="5 seconds")
        .start()
    )
    metrics_server = ThreadingHTTPServer(
        (args.metrics_host, args.metrics_port), MetricsHandler
    )
    metrics_thread = threading.Thread(
        target=metrics_server.serve_forever,
        name="spark-prometheus-metrics",
        daemon=True,
    )
    metrics_thread.start()
    print(
        f"Spark is reading topic={args.topic} from {args.broker}; "
        f"window={args.window}, watermark={args.watermark}; writing to PostgreSQL. "
        f"Prometheus metrics at http://{args.metrics_host}:{args.metrics_port}/metrics. "
        "Press Ctrl+C to stop."
    )
    try:
        while query.isActive:
            progress = query.lastProgress
            if progress is not None:
                METRICS.update(json.loads(progress.json))
            time.sleep(1)
        # Surface Spark's underlying failure so the container restarts instead
        # of appearing healthy after the streaming query has stopped.
        query.awaitTermination()
    except KeyboardInterrupt:
        print("\nStopping Spark stream...")
        query.stop()
    finally:
        METRICS.set_down()
        metrics_server.shutdown()
        metrics_server.server_close()


if __name__ == "__main__":
    main()
