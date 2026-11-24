"""Allocate monotonically increasing Spark event-time ranges for historical replays."""

from __future__ import annotations

import math
import time
from typing import Any


def ensure_replay_clock(connection: Any) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS replay_stream_clock (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
            reserved_until_epoch DOUBLE PRECISION NOT NULL DEFAULT 0
        )
        """
    )
    connection.execute(
        """
        INSERT INTO replay_stream_clock (singleton, reserved_until_epoch)
        VALUES (TRUE, 0)
        ON CONFLICT (singleton) DO NOTHING
        """
    )
    connection.commit()


def allocate_replay_shift(
    connection: Any,
    source_start_epoch: float,
    duration_seconds: float,
    *,
    window_seconds: int = 10,
    watermark_seconds: int = 15,
    now_epoch: float | None = None,
) -> int:
    """Reserve a non-overlapping virtual event-time range and return its shift.

    The shift is a multiple of the Spark window size, so subtracting it after
    aggregation restores the original WESAD window boundaries exactly.
    """
    ensure_replay_clock(connection)
    row = connection.execute(
        "SELECT reserved_until_epoch FROM replay_stream_clock WHERE singleton = TRUE FOR UPDATE"
    ).fetchone()
    if row is None:
        raise RuntimeError("Không đọc được replay stream clock từ PostgreSQL")
    reserved_until = (
        row["reserved_until_epoch"]
        if isinstance(row, dict)
        else row[0]
    )
    current_epoch = time.time() if now_epoch is None else float(now_epoch)
    minimum_start = max(
        current_epoch + 60.0,
        float(reserved_until) + watermark_seconds + window_seconds,
    )
    shift = int(
        math.ceil((minimum_start - float(source_start_epoch)) / window_seconds)
        * window_seconds
    )
    virtual_start = float(source_start_epoch) + shift
    # Unlimited CLI replays may run through the full WESAD recording. Reserve
    # four hours in that case so an immediate follow-up does not fall behind
    # the watermark after the stream has been accelerated.
    reserved_duration = max(float(duration_seconds), 4 * 60 * 60 if duration_seconds <= 0 else 0)
    reserved_end = virtual_start + reserved_duration + watermark_seconds + window_seconds + 1
    connection.execute(
        "UPDATE replay_stream_clock SET reserved_until_epoch = %s WHERE singleton = TRUE",
        (reserved_end,),
    )
    connection.commit()
    return shift
