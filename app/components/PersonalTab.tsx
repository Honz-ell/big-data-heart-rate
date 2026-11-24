"use client";

import React, { useMemo, useState } from "react";
import {
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { PersonalDashboardData, ZoneState } from "../lib/types";
import { InfoTooltip } from "./InfoTooltip";

function StressGauge({
  score,
  zone,
  motionShield,
}: {
  score: number;
  zone: ZoneState;
  motionShield: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, score));
  // Angle from -90deg (left, 0) to +90deg (right, 100)
  const angleDeg = -90 + (clamped / 100) * 180;

  const zoneMeta: Record<
    ZoneState,
    { label: string; icon: string; color: string; bg: string }
  > = {
    RELAXED: {
      label: motionShield ? "Đang vận động (Ổn)" : "Thư giãn",
      icon: "✓",
      color: "var(--emerald)",
      bg: "var(--emerald-soft)",
    },
    ATTENTION: {
      label: "Chú ý nhẹ",
      icon: "⚠",
      color: "var(--amber)",
      bg: "var(--amber-soft)",
    },
    STRESS: {
      label: "Căng thẳng",
      icon: "▲",
      color: "var(--crimson)",
      bg: "var(--crimson-soft)",
    },
  };
  const cfg = zoneMeta[zone];

  // Helper to build SVG arc path on center (110, 108) with radius 82
  const polar = (deg: number, r = 82) => {
    const rad = ((deg - 180) * Math.PI) / 180;
    return {
      x: 110 + r * Math.cos(rad),
      y: 108 + r * Math.sin(rad),
    };
  };

  const arcSegment = (startPct: number, endPct: number) => {
    const s = polar((startPct / 100) * 180);
    const e = polar((endPct / 100) * 180);
    return `M ${s.x.toFixed(1)} ${s.y.toFixed(1)} A 82 82 0 0 1 ${e.x.toFixed(1)} ${e.y.toFixed(1)}`;
  };

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 220 128" className="w-56 h-32 overflow-visible" aria-label={`Chỉ số căng thẳng ${clamped} trên 100`}>
        {/* Zone 1: 0..39 Green */}
        <path
          d={arcSegment(0, 39)}
          fill="none"
          stroke="var(--emerald)"
          strokeWidth="16"
          strokeLinecap="round"
          opacity={0.88}
        />
        {/* Zone 2: 41..59 Amber */}
        <path
          d={arcSegment(41, 59)}
          fill="none"
          stroke="var(--amber)"
          strokeWidth="16"
          opacity={0.88}
        />
        {/* Zone 3: 61..100 Red */}
        <path
          d={arcSegment(61, 100)}
          fill="none"
          stroke="var(--crimson)"
          strokeWidth="16"
          strokeLinecap="round"
          opacity={0.88}
        />

        {/* Scale labels */}
        <text x="20" y="122" fontSize="10" fontWeight="700" fill="var(--muted)">
          0
        </text>
        <text x="72" y="24" fontSize="10" fontWeight="700" fill="var(--muted)">
          40
        </text>
        <text x="138" y="24" fontSize="10" fontWeight="700" fill="var(--muted)">
          60
        </text>
        <text x="188" y="122" fontSize="10" fontWeight="700" fill="var(--muted)">
          100
        </text>

        {/* Needle */}
        <g
          style={{
            transform: `rotate(${angleDeg}deg)`,
            transformOrigin: "110px 108px",
            transition: "transform 300ms ease-out",
          }}
        >
          <line
            x1="110"
            y1="108"
            x2="110"
            y2="38"
            stroke="var(--ink)"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
          <circle cx="110" cy="108" r="7" fill="var(--ink)" />
          <circle cx="110" cy="108" r="3" fill="var(--surface)" />
        </g>
      </svg>

      <div className="-mt-2 text-center">
        <div className="flex items-baseline justify-center gap-1">
          <span className="text-4xl font-black tabular-nums" style={{ color: cfg.color }}>
            {clamped}
          </span>
          <span className="text-sm font-semibold" style={{ color: "var(--muted)" }}>
            / 100
          </span>
        </div>
        <span
          className="mt-1 inline-flex items-center gap-1.5 rounded-full px-3 py-0.5 text-xs font-extrabold"
          style={{ backgroundColor: cfg.bg, color: cfg.color }}
        >
          <span aria-hidden="true">{cfg.icon}</span>
          <span>{cfg.label}</span>
        </span>
      </div>
    </div>
  );
}

function MiniSparkline({
  values,
  color,
}: {
  values: (number | null)[];
  color: string;
}) {
  const pts = values
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .slice(-16)
    .map((v, idx) => ({ idx, v }));

  if (pts.length < 2) {
    return (
      <div className="h-9 flex items-center text-[11px]" style={{ color: "var(--muted)" }}>
        Đang chờ thêm mẫu...
      </div>
    );
  }

  return (
    <div className="h-9 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={pts}>
          <Line
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PersonalTab({
  data,
  onOpenBreathing,
  onSendFeedback,
  onStartQuick,
}: {
  data: PersonalDashboardData;
  onOpenBreathing: () => void;
  onSendFeedback: (verdict: "ACCURATE" | "FALSE_ALARM") => void;
  onStartQuick: () => void;
}) {
  const [rangeMinutes, setRangeMinutes] = useState<"5m" | "15m" | "all">("5m");
  const [chartMode, setChartMode] = useState<"both" | "hr" | "eda">("both");
  const [feedbackBanner, setFeedbackBanner] = useState<string | null>(null);

  const latestWindow = data.edgeWindows.at(-1) ?? null;

  // Filter timeline by selected range (5m = 300s, 15m = 900s, all)
  const filteredChart = useMemo(() => {
    if (data.sparkSeries.length === 0) {
      return { points: [], windows: data.edgeWindows, events: data.events };
    }
    const maxMs = data.sparkSeries[data.sparkSeries.length - 1].timestampMs + 10_000;
    const spanMs =
      rangeMinutes === "5m"
        ? 5 * 60_000
        : rangeMinutes === "15m"
          ? 15 * 60_000
          : Number.POSITIVE_INFINITY;
    const cutoff = spanMs === Number.POSITIVE_INFINITY ? 0 : maxMs - spanMs;

    return {
      points: data.sparkSeries.filter((p) => p.timestampMs >= cutoff),
      windows: data.edgeWindows.filter((w) => w.endMs > cutoff),
      events: data.events.filter((e) => e.timestampMs >= cutoff),
    };
  }, [data.sparkSeries, data.edgeWindows, data.events, rangeMinutes]);

  if (data.edgeWindows.length === 0 && data.sparkSeries.length === 0) {
    const isWarmingUp = data.streamState === "starting" || data.streamState === "running";
    return (
      <section className="surface-card p-10 text-center space-y-4">
        <div
          className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl text-2xl ${isWarmingUp ? "animate-pulse" : ""}`}
          style={{
            backgroundColor: isWarmingUp ? "var(--sky-soft)" : "var(--emerald-soft)",
            color: isWarmingUp ? "var(--sky)" : "var(--emerald)",
          }}
        >
          {isWarmingUp ? "⚡" : "▶"}
        </div>
        <h2 className="text-xl font-extrabold" style={{ color: "var(--ink)" }}>
          {isWarmingUp
            ? `Đang nạp dữ liệu thật ${data.subjectId}.pkl vào Kafka & Spark...`
            : "Chưa có dữ liệu phiên theo dõi"}
        </h2>
        <p className="mx-auto max-w-lg text-sm" style={{ color: "var(--muted)" }}>
          {isWarmingUp ? (
            <>
              Tiến trình Producer &amp; Edge AI đang đọc file gốc WESAD của <strong>{data.subjectId}</strong>, căn chỉnh đúng phân đoạn kịch bản và gom cửa sổ 10s/30s đầu tiên. Biểu đồ sẽ tự động nhảy sau khoảng <strong>5–10 giây</strong>...
            </>
          ) : (
            <>
              Nhấn nút <strong>▶ Start</strong> trên thanh điều khiển hoặc chọn một trong 4 kịch bản mẫu bên trên để phát luồng cảm biến đồng hồ Empatica E4 qua Kafka &amp; Spark.
            </>
          )}
        </p>
        {!isWarmingUp && (
          <button
            type="button"
            onClick={onStartQuick}
            className="rounded-xl px-5 py-2.5 text-sm font-bold text-white cursor-pointer"
            style={{ backgroundColor: "var(--emerald)" }}
          >
            ▶ Bắt đầu kịch bản mẫu ngay
          </button>
        )}
      </section>
    );
  }

  const activityText =
    data.vitals.activityState === "HIGH_ACTIVITY"
      ? "Vận động mạnh"
      : data.vitals.activityState === "LIGHT_ACTIVITY"
        ? "Chuyển động nhẹ"
        : "Ngồi yên";

  const hrDelta = data.vitals.hrDeltaBpm;
  const hrTrend =
    hrDelta === null ? "→" : hrDelta >= 6 ? "↑" : hrDelta <= -5 ? "↓" : "→";

  const edaDelta =
    data.vitals.edaUs !== null && data.vitals.baselineEdaUs !== null
      ? +(data.vitals.edaUs - data.vitals.baselineEdaUs).toFixed(2)
      : null;
  const edaTrend =
    edaDelta === null ? "→" : edaDelta >= 0.4 ? "↑" : edaDelta <= -0.2 ? "↓" : "→";

  const hrvVal = data.vitals.hrvRmssdMs;
  const hrvTrend =
    hrvVal === null ? "—" : hrvVal < 36 ? "↓" : hrvVal > 65 ? "↑" : "→";

  const handleFeedback = (verdict: "ACCURATE" | "FALSE_ALARM") => {
    onSendFeedback(verdict);
    setFeedbackBanner(
      verdict === "ACCURATE"
        ? "Đã ghi nhận: 'Đúng, tôi đang căng thẳng' vào bảng prediction_feedback."
        : "Đã ghi nhận: 'Báo nhầm' vào bảng prediction_feedback để cải thiện phiên bản model kế tiếp."
    );
    window.setTimeout(() => setFeedbackBanner(null), 4500);
  };

  return (
    <div className="space-y-5">
      {/* HÀNG 1: HERO STATUS CARD */}
      <section className="surface-card p-5 lg:p-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
          <div className="lg:col-span-4 flex flex-col items-center justify-center border-b lg:border-b-0 lg:border-r pb-4 lg:pb-0 lg:pr-6" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider mb-1" style={{ color: "var(--muted)" }}>
              <span>Chỉ số căng thẳng (0–100)</span>
              <InfoTooltip
                title="Chỉ số căng thẳng 0–100 là gì?"
                content="Quy đổi từ điểm phân loại của mô hình Random Forest (300 cây quyết định) trên cửa sổ 30 giây kết hợp bộ lọc bối cảnh gia tốc ACC. 0–39: Thư giãn · 40–59: Chú ý · 60–100: Căng thẳng."
              />
            </div>
            <StressGauge
              score={data.currentScore}
              zone={data.currentZone}
              motionShield={data.motionShieldActive}
            />
          </div>

          <div className="lg:col-span-8 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold"
                style={{
                  backgroundColor:
                    data.currentZone === "STRESS"
                      ? "var(--crimson-soft)"
                      : data.currentZone === "ATTENTION"
                        ? "var(--amber-soft)"
                        : "var(--emerald-soft)",
                  color:
                    data.currentZone === "STRESS"
                      ? "var(--crimson)"
                      : data.currentZone === "ATTENTION"
                        ? "var(--amber)"
                        : "var(--emerald)",
                }}
              >
                {data.currentZone === "STRESS"
                  ? "▲ Trạng thái: Căng thẳng"
                  : data.currentZone === "ATTENTION"
                    ? "⚠ Trạng thái: Cần chú ý"
                    : "✓ Trạng thái: Ổn định"}
              </span>

              <span
                className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold"
                style={{ backgroundColor: "var(--surface-2)", color: "var(--ink-2)", border: "1px solid var(--border)" }}
              >
                Độ tin cậy phân loại: <strong className="tabular-nums">{data.confidencePercent}%</strong>
              </span>

              <span
                className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold"
                style={{ backgroundColor: "var(--sky-soft)", color: "var(--sky)" }}
              >
                Model đang dùng: <strong>{data.activeModelVersion}</strong>
              </span>
            </div>

            <h2 className="text-xl sm:text-2xl font-extrabold leading-snug" style={{ color: "var(--ink)" }}>
              {data.heroConclusion}
            </h2>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs" style={{ color: "var(--muted)" }}>
              <span>
                Đối tượng: <strong style={{ color: "var(--ink-2)" }}>{data.subjectId} — {data.roleLabel}</strong>
              </span>
              <span>
                Nguồn: Đồng hồ E4 → Kafka → Spark (10s) &amp; Edge RF (30s) · Mốc giờ: <strong className="tabular-nums">{data.simulatedClockUtc} UTC</strong>
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* HÀNG 2: 5 THẺ CHỈ SỐ SINH TỒN NHỎ + SPARKLINE 5 PHÚT */}
      <section aria-label="5 chỉ số cảm biến cổ tay" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
        {/* 1. Nhịp tim */}
        <div className="surface-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              Nhịp tim
            </span>
            <InfoTooltip
              title="Nhịp tim (BPM)"
              content="Số nhịp tim mỗi phút từ kênh HR của đồng hồ Empatica E4, tổng hợp trung bình mỗi 10 giây qua Spark Structured Streaming."
            />
          </div>
          <div className="my-2 flex items-baseline gap-1.5">
            <span className="text-3xl font-black tabular-nums" style={{ color: "var(--ink)" }}>
              {data.vitals.hrBpm !== null ? Math.round(data.vitals.hrBpm) : "—"}
            </span>
            <span className="text-xs font-bold" style={{ color: "var(--muted)" }}>
              BPM
            </span>
            <span
              className="ml-auto text-xs font-bold tabular-nums"
              style={{
                color:
                  hrDelta !== null && hrDelta >= 10
                    ? "var(--amber)"
                    : "var(--emerald)",
              }}
            >
              {hrTrend}{" "}
              {hrDelta !== null
                ? `${hrDelta >= 0 ? `+${Math.round(hrDelta)}` : Math.round(hrDelta)} so với nền`
                : ""}
            </span>
          </div>
          <MiniSparkline
            values={data.sparkSeries.map((p) => p.hr_bpm)}
            color="var(--emerald)"
          />
          <div className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
            Mức nền cá nhân: {data.vitals.baselineHrBpm ?? "—"} BPM · Spark 10s
          </div>
        </div>

        {/* 2. HRV-RMSSD */}
        <div className="surface-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              Độ biến thiên HRV
            </span>
            <InfoTooltip
              title="HRV-RMSSD (ms) là gì?"
              content="Đo độ chênh lệch tự nhiên giữa các nhịp tim liên tiếp (kênh IBI). Khi thư giãn HRV cao (50–100 ms); khi căng thẳng hoặc vận động mạnh HRV giảm thấp hoặc tạm ẩn do nhiễu cổ tay."
            />
          </div>
          <div className="my-2 flex items-baseline gap-1.5">
            <span className="text-3xl font-black tabular-nums" style={{ color: "var(--ink)" }}>
              {hrvVal !== null ? Math.round(hrvVal) : "—"}
            </span>
            <span className="text-xs font-bold" style={{ color: "var(--muted)" }}>
              ms
            </span>
            <span
              className="ml-auto text-xs font-bold"
              style={{
                color:
                  hrvVal === null
                    ? "var(--muted)"
                    : hrvVal < 36
                      ? "var(--crimson)"
                      : "var(--emerald)",
              }}
            >
              {hrvVal === null ? "Cổ tay dao động" : `${hrvTrend} RMSSD`}
            </span>
          </div>
          <MiniSparkline
            values={data.edgeWindows.map((w) => w.hrv_rmssd_ms)}
            color="var(--sky)"
          />
          <div className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
            Nguồn: Cặp nhịp IBI liên tiếp · Cửa sổ 30s
          </div>
        </div>

        {/* 3. EDA */}
        <div className="surface-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              Dẫn điện da (EDA)
            </span>
            <InfoTooltip
              title="EDA — Độ dẫn điện mồ hôi da (µS)"
              content="Tín hiệu quan trọng số 1 để phát hiện stress tâm lý (trọng số 43.8% trong mô hình). Khi lo âu/thuyết trình, tuyến mồ hôi vi mô ở cổ tay tiết ra làm EDA tăng gấp nhiều lần dù người ngồi yên."
            />
          </div>
          <div className="my-2 flex items-baseline gap-1.5">
            <span className="text-3xl font-black tabular-nums" style={{ color: "var(--ink)" }}>
              {data.vitals.edaUs !== null ? data.vitals.edaUs.toFixed(2) : "—"}
            </span>
            <span className="text-xs font-bold" style={{ color: "var(--muted)" }}>
              µS
            </span>
            <span
              className="ml-auto text-xs font-bold tabular-nums"
              style={{
                color:
                  edaDelta !== null && edaDelta >= 0.6
                    ? "var(--crimson)"
                    : "var(--emerald)",
              }}
            >
              {edaTrend}{" "}
              {edaDelta !== null
                ? `${edaDelta >= 0 ? `+${edaDelta}` : edaDelta} µS`
                : ""}
            </span>
          </div>
          <MiniSparkline
            values={data.sparkSeries.map((p) => p.eda_us)}
            color="var(--amber)"
          />
          <div className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
            Nền nghỉ: {data.vitals.baselineEdaUs?.toFixed(2) ?? "0.45"} µS · Spark 10s (4 Hz)
          </div>
        </div>

        {/* 4. Nhiệt độ cổ tay */}
        <div className="surface-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              Nhiệt độ cổ tay
            </span>
            <InfoTooltip
              title="Nhiệt độ da ngoại vi (°C)"
              content="Cảm biến nhiệt quang học 4 Hz trên đồng hồ E4. Khi căng thẳng cấp tính, mạch máu ngoại vi co nhẹ khiến nhiệt độ bề mặt da cổ tay thường giảm nhẹ 0.2–0.5 °C."
            />
          </div>
          <div className="my-2 flex items-baseline gap-1.5">
            <span className="text-3xl font-black tabular-nums" style={{ color: "var(--ink)" }}>
              {data.vitals.tempC !== null ? data.vitals.tempC.toFixed(1) : "—"}
            </span>
            <span className="text-xs font-bold" style={{ color: "var(--muted)" }}>
              °C
            </span>
            <span className="ml-auto text-xs font-bold" style={{ color: "var(--muted)" }}>
              → Ngoại vi
            </span>
          </div>
          <MiniSparkline
            values={data.sparkSeries.map((p) => p.temp_c)}
            color="#8b5cf6"
          />
          <div className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
            Ngưỡng hợp lệ: 20–45 °C · Spark 10s (4 Hz)
          </div>
        </div>

        {/* 5. Bối cảnh vận động */}
        <div className="surface-card p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              Bối cảnh vận động
            </span>
            <InfoTooltip
              title="Gia tốc cổ tay 3 trục (ACC)"
              content="Đo mức cử động cổ tay ở tần số 32 Hz (đơn vị g). Giúp hệ thống phân biệt nhịp tim tăng do đi bộ/vận động thể chất với nhịp tim tăng khi ngồi yên chịu áp lực tinh thần."
            />
          </div>
          <div className="my-2 flex items-baseline justify-between gap-1">
            <span
              className="text-xl font-black"
              style={{
                color:
                  data.vitals.activityState === "HIGH_ACTIVITY"
                    ? "var(--sky)"
                    : data.vitals.activityState === "LIGHT_ACTIVITY"
                      ? "var(--amber)"
                      : "var(--emerald)",
              }}
            >
              {activityText}
            </span>
            <span className="text-xs font-bold tabular-nums" style={{ color: "var(--muted)" }}>
              {data.vitals.accG !== null ? `${data.vitals.accG.toFixed(2)} g` : "0.02 g"}
            </span>
          </div>
          <MiniSparkline
            values={data.sparkSeries.map((p) => p.acc_g)}
            color="var(--sky)"
          />
          <div className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
            Cảm biến gia tốc 3 trục 32 Hz · Chống báo giả
          </div>
        </div>
      </section>

      {/* HÀNG 3: BIỂU ĐỒ TIMELINE CHÍNH (KẾT HỢP SPARK 10S + DẢI NỀN EDGE 30S + SỰ KIỆN) */}
      <section className="surface-card p-5 lg:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base sm:text-lg font-extrabold" style={{ color: "var(--ink)" }}>
                Diễn biến Sinh lý Thời gian thực (Spark 10s &amp; Phân loại AI Edge 30s)
              </h3>
              <InfoTooltip
                title="Biểu đồ đa tốc độ hoạt động thế nào?"
                content="Đường liền nét cập nhật mỗi 10 giây từ bảng sensor_window_aggregates của Spark. Dải nền màu phía sau là kết luận mỗi 30 giây từ bảng stress_predictions của mô hình Random Forest tại Edge."
              />
            </div>
            <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
              Dải nền xanh = Ổn định · Dải nền đỏ = Căng thẳng · Rê chuột lên từng mốc 10 giây để xem chi tiết
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Metric Toggle */}
            <div
              className="inline-flex rounded-xl p-0.5 text-xs font-bold"
              style={{ backgroundColor: "var(--surface-2)", border: "1px solid var(--border)" }}
            >
              {(
                [
                  { id: "both", label: "BPM + EDA" },
                  { id: "hr", label: "Nhịp tim (BPM)" },
                  { id: "eda", label: "Mồ hôi da (EDA)" },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setChartMode(m.id)}
                  className="rounded-lg px-2.5 py-1 cursor-pointer"
                  style={{
                    backgroundColor: chartMode === m.id ? "var(--surface)" : "transparent",
                    color: chartMode === m.id ? "var(--ink)" : "var(--muted)",
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {/* Range Selector */}
            <div
              className="inline-flex rounded-xl p-0.5 text-xs font-bold"
              style={{ backgroundColor: "var(--surface-2)", border: "1px solid var(--border)" }}
            >
              {(
                [
                  { id: "5m", label: "5 phút" },
                  { id: "15m", label: "15 phút" },
                  { id: "all", label: "Toàn phiên" },
                ] as const
              ).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRangeMinutes(r.id)}
                  className="rounded-lg px-2.5 py-1 cursor-pointer"
                  style={{
                    backgroundColor: rangeMinutes === r.id ? "var(--sky)" : "transparent",
                    color: rangeMinutes === r.id ? "#ffffff" : "var(--muted)",
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Chart Canvas */}
        <div className="h-80 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={filteredChart.points}
              margin={{ top: 14, right: 18, left: 4, bottom: 8 }}
            >
              <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />

              {/* 30-second Edge classification background bands */}
              {filteredChart.windows.map((win) => {
                const fill =
                  win.zone === "STRESS"
                    ? "rgba(220, 38, 38, 0.16)"
                    : win.motionShieldActive
                      ? "rgba(2, 132, 199, 0.13)"
                      : win.zone === "ATTENTION"
                        ? "rgba(217, 119, 6, 0.12)"
                        : "rgba(5, 150, 105, 0.08)";
                return (
                  <ReferenceArea
                    key={win.window_start}
                    yAxisId="hr"
                    x1={win.startMs}
                    x2={win.endMs}
                    fill={fill}
                    ifOverflow="extendDomain"
                  />
                );
              })}

              {/* Event vertical markers */}
              {filteredChart.events.map((ev) => (
                <ReferenceLine
                  key={ev.id}
                  yAxisId="hr"
                  x={ev.timestampMs}
                  stroke={
                    ev.type === "STRESS_ONSET" || ev.type === "ALERT_SENT"
                      ? "var(--crimson)"
                      : ev.type === "MOTION_SHIELD"
                        ? "var(--sky)"
                        : "var(--emerald)"
                  }
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                />
              ))}

              <XAxis
                dataKey="timestampMs"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(ms: number) => new Date(ms).toISOString().slice(11, 19)}
                tick={{ fill: "var(--muted)", fontSize: 12 }}
                minTickGap={48}
              />

              <YAxis
                yAxisId="hr"
                orientation="left"
                domain={["auto", "auto"]}
                tick={{ fill: "var(--muted)", fontSize: 12 }}
                unit=" BPM"
                width={68}
                hide={chartMode === "eda"}
              />

              <YAxis
                yAxisId="eda"
                orientation="right"
                domain={[0, "auto"]}
                tick={{ fill: "var(--muted)", fontSize: 12 }}
                unit=" µS"
                width={60}
                hide={chartMode === "hr"}
              />

              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const pt = payload[0].payload as (typeof filteredChart.points)[number];
                  const matchWin = data.edgeWindows.find(
                    (w) => pt.timestampMs >= w.startMs && pt.timestampMs < w.endMs
                  );
                  return (
                    <div
                      className="rounded-xl p-3 text-xs shadow-xl space-y-1.5"
                      style={{
                        backgroundColor: "var(--surface)",
                        border: "1px solid var(--border-strong)",
                        color: "var(--ink)",
                      }}
                    >
                      <div className="font-bold border-b pb-1" style={{ borderColor: "var(--border)" }}>
                        Cửa sổ Spark 10s: {pt.clockLabel} UTC (Batch #{pt.spark_batch_id})
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                        <span>Nhịp tim:</span>
                        <strong className="tabular-nums">{pt.hr_bpm ?? "—"} BPM</strong>
                        <span>Dẫn điện da (EDA):</span>
                        <strong className="tabular-nums">{pt.eda_us ?? "—"} µS</strong>
                        <span>Nhiệt độ da:</span>
                        <strong className="tabular-nums">{pt.temp_c ?? "—"} °C</strong>
                        <span>Số mẫu cảm biến:</span>
                        <strong className="tabular-nums">{pt.sample_count_total} mẫu/10s</strong>
                      </div>
                      {matchWin && (
                        <div className="pt-1 border-t text-[11px]" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
                          Edge 30s ({matchWin.modelVersion}):{" "}
                          <strong
                            style={{
                              color:
                                matchWin.zone === "STRESS"
                                  ? "var(--crimson)"
                                  : matchWin.motionShieldActive
                                    ? "var(--sky)"
                                    : "var(--emerald)",
                            }}
                          >
                            {matchWin.motionShieldActive
                              ? "Đang vận động (Chặn báo giả)"
                              : matchWin.zone === "STRESS"
                                ? `Căng thẳng (${matchWin.displayStressIndex}/100)`
                                : `Ổn định (${matchWin.displayStressIndex}/100)`}
                          </strong>
                        </div>
                      )}
                    </div>
                  );
                }}
              />

              {chartMode !== "eda" && (
                <Line
                  yAxisId="hr"
                  type="monotone"
                  dataKey="hr_bpm"
                  name="Nhịp tim (BPM)"
                  stroke="var(--emerald)"
                  strokeWidth={3}
                  dot={{ r: 3.5, fill: "var(--emerald)" }}
                  activeDot={{ r: 6 }}
                  isAnimationActive={false}
                />
              )}

              {chartMode !== "hr" && (
                <Line
                  yAxisId="eda"
                  type="monotone"
                  dataKey="eda_us"
                  name="Độ dẫn điện da (µS)"
                  stroke="var(--amber)"
                  strokeWidth={2.5}
                  strokeDasharray={chartMode === "both" ? "5 3" : undefined}
                  dot={{ r: 3, fill: "var(--amber)" }}
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Event Markers Legend Strip */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            {filteredChart.events.length === 0 ? (
              <span style={{ color: "var(--muted)" }}>
                Sự kiện trong phiên: Chưa phát sinh cảnh báo bất thường.
              </span>
            ) : (
              filteredChart.events.map((ev) => (
                <span
                  key={ev.id}
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold"
                  style={{
                    backgroundColor:
                      ev.type === "STRESS_ONSET" || ev.type === "ALERT_SENT"
                        ? "var(--crimson-soft)"
                        : ev.type === "MOTION_SHIELD"
                          ? "var(--sky-soft)"
                          : "var(--emerald-soft)",
                    color:
                      ev.type === "STRESS_ONSET" || ev.type === "ALERT_SENT"
                        ? "var(--crimson)"
                        : ev.type === "MOTION_SHIELD"
                          ? "var(--sky)"
                          : "var(--emerald)",
                  }}
                >
                  <span>
                    {ev.type === "STRESS_ONSET"
                      ? "⚡"
                      : ev.type === "ALERT_SENT"
                        ? "🔔"
                        : ev.type === "MOTION_SHIELD"
                          ? "🛡"
                          : "✓"}
                  </span>
                  <span>
                    {ev.clockLabel}: {ev.label}
                  </span>
                </span>
              ))
            )}
          </div>

          <span style={{ color: "var(--muted)" }}>
            Tổng hợp: <strong className="tabular-nums">{filteredChart.points.length}</strong> điểm Spark 10s ·{" "}
            <strong className="tabular-nums">{filteredChart.windows.length}</strong> cửa sổ Edge 30s
          </span>
        </div>
      </section>

      {/* HÀNG 4 & HÀNG 5: GIẢI THÍCH VÌ SAO + HÀNH ĐỘNG & TÓM TẮT PHIÊN */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* HÀNG 4: VÌ SAO HỆ THỐNG NGHĨ VẬY? (EXPLAINABLE AI) */}
        <section className="surface-card lg:col-span-7 p-5 lg:p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base sm:text-lg font-extrabold" style={{ color: "var(--ink)" }}>
                Vì sao hệ thống kết luận như vậy?
              </h3>
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                Top 3 dấu hiệu sinh lý ảnh hưởng mạnh nhất trong cửa sổ 30 giây gần nhất
              </p>
            </div>
            <InfoTooltip
              title="Giải thích kết quả AI (Explainability)"
              content="Dựa trên mức thay đổi của từng cảm biến so với mức nền cá nhân và trọng số đóng góp đặc trưng của 300 cây quyết định Random Forest (EDA 43.8%, ACC 26.4%, TEMP 18.2%, BVP 11.6%)."
            />
          </div>

          {/* Anti-False-Alarm Shield Banner */}
          {(data.motionShieldActive || data.vitals.activityState === "HIGH_ACTIVITY") && (
            <div
              className="flex items-start gap-3 rounded-xl p-4"
              style={{
                backgroundColor: "var(--sky-soft)",
                border: "1.5px solid var(--sky)",
              }}
            >
              <span className="text-2xl leading-none" aria-hidden="true">
                🛡
              </span>
              <div>
                <div className="text-sm font-extrabold" style={{ color: "var(--sky)" }}>
                  Đã chặn báo động giả: đang vận động mạnh
                </div>
                <p className="text-xs mt-1 leading-relaxed" style={{ color: "var(--ink-2)" }}>
                  Cảm biến gia tốc cổ tay ghi nhận chuyển động liên tục ({data.vitals.accG?.toFixed(2) ?? "0.20"} g) trong khi mồ hôi giao cảm EDA không tăng đột biến. Hệ thống nhận biết nhịp tim tăng là do đi bộ/thể chất nên không phát cảnh báo nhầm.
                </p>
              </div>
            </div>
          )}

          {/* Top 3 Horizontal Bars */}
          <div className="space-y-3.5">
            {data.topReasons.map((reason, idx) => {
              const barColor =
                reason.sensor === "ACC"
                  ? "var(--sky)"
                  : data.currentZone === "STRESS" && reason.direction === "up"
                    ? "var(--crimson)"
                    : reason.direction === "down" && reason.sensor === "HRV"
                      ? "var(--amber)"
                      : "var(--emerald)";
              return (
                <div key={reason.id} className="surface-subtle p-3.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-sm font-bold">
                    <span style={{ color: "var(--ink)" }}>
                      {idx + 1}. {reason.title}
                    </span>
                    <span className="text-xs font-extrabold tabular-nums" style={{ color: barColor }}>
                      Mức tác động {reason.impactPercent}%
                    </span>
                  </div>
                  <div className="h-2.5 w-full rounded-full overflow-hidden" style={{ backgroundColor: "var(--surface-3)" }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(12, Math.min(100, reason.impactPercent))}%`,
                        backgroundColor: barColor,
                        transition: "width 300ms ease",
                      }}
                    />
                  </div>
                  <p className="text-xs" style={{ color: "var(--muted)" }}>
                    {reason.plainSummary}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        {/* HÀNG 5: HÀNH ĐỘNG GỢI Ý, PHẢN HỒI NGƯỜI DÙNG & TÓM TẮT PHIÊN */}
        <section className="surface-card lg:col-span-5 p-5 lg:p-6 flex flex-col justify-between space-y-4">
          <div className="space-y-3.5">
            <h3 className="text-base sm:text-lg font-extrabold" style={{ color: "var(--ink)" }}>
              Hành động gợi ý &amp; Xác nhận thực tế
            </h3>

            {/* Gentle Alert Card when stressed */}
            {data.currentZone === "STRESS" ? (
              <div
                className="rounded-xl p-4 space-y-2"
                style={{
                  backgroundColor: "var(--crimson-soft)",
                  border: "1px solid var(--crimson)",
                }}
              >
                <div className="text-sm font-extrabold" style={{ color: "var(--crimson)" }}>
                  🔔 Khuyến nghị nghỉ ngắn &amp; điều hòa nhịp thở
                </div>
                <p className="text-xs leading-relaxed" style={{ color: "var(--ink-2)" }}>
                  Cơ thể đang có dấu hiệu căng thẳng liên tục. Hãy tạm rời màn hình 90 giây và thực hiện nhịp thở 4-4-6 để hạ nhịp tim.
                </p>
              </div>
            ) : (
              <div className="surface-subtle p-3.5 text-xs leading-relaxed" style={{ color: "var(--ink-2)" }}>
                Bạn có thể mở bài tập thở 4-4-6 bất cứ lúc nào để chủ động thư giãn trước giờ thuyết trình hoặc ca trực căng thẳng.
              </div>
            )}

            <button
              type="button"
              onClick={onOpenBreathing}
              className="w-full rounded-xl px-4 py-3 text-sm font-extrabold text-white shadow-sm cursor-pointer transition-opacity hover:opacity-90"
              style={{ backgroundColor: "var(--emerald)" }}
            >
              🌬 Bắt đầu bài thở 4-4-6 (Có nhịp đếm trực quan)
            </button>

            {/* Human-in-the-loop Feedback */}
            <div className="pt-2 space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold" style={{ color: "var(--muted)" }}>
                <span>Phản hồi của người đeo (lưu vào prediction_feedback):</span>
                {latestWindow?.feedback && (
                  <span style={{ color: "var(--emerald)" }}>
                    ✓ Đã lưu ({latestWindow.feedback.verdict === "ACCURATE" ? "Đúng" : "Báo nhầm"})
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => handleFeedback("ACCURATE")}
                  className="rounded-xl px-3 py-2.5 text-xs font-bold cursor-pointer transition-colors"
                  style={{
                    backgroundColor: "var(--surface-2)",
                    color: "var(--ink)",
                    border: "1px solid var(--border-strong)",
                  }}
                >
                  ✓ Đúng, tôi đang căng thẳng
                </button>
                <button
                  type="button"
                  onClick={() => handleFeedback("FALSE_ALARM")}
                  className="rounded-xl px-3 py-2.5 text-xs font-bold cursor-pointer transition-colors"
                  style={{
                    backgroundColor: "var(--surface-2)",
                    color: "var(--ink)",
                    border: "1px solid var(--border-strong)",
                  }}
                >
                  ✕ Báo nhầm (vận động / cà phê)
                </button>
              </div>
              {feedbackBanner && (
                <div
                  className="rounded-lg px-3 py-2 text-xs font-semibold"
                  style={{ backgroundColor: "var(--emerald-soft)", color: "var(--emerald)" }}
                >
                  {feedbackBanner}
                </div>
              )}
            </div>
          </div>

          {/* Tóm tắt phiên */}
          <div className="pt-3 border-t space-y-2" style={{ borderColor: "var(--border)" }}>
            <div className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              Tóm tắt phiên hiện tại
            </div>
            <div className="grid grid-cols-3 gap-2.5 text-center">
              <div className="surface-subtle p-2.5">
                <div className="text-lg font-black tabular-nums" style={{ color: "var(--ink)" }}>
                  {data.sessionSummary.stressRatioPercent}%
                </div>
                <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                  Thời gian căng thẳng
                </div>
              </div>
              <div className="surface-subtle p-2.5">
                <div className="text-lg font-black tabular-nums" style={{ color: "var(--ink)" }}>
                  {data.sessionSummary.alertCount}
                </div>
                <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                  Số cảnh báo sớm
                </div>
              </div>
              <div className="surface-subtle p-2.5">
                <div className="text-sm font-black tabular-nums pt-1" style={{ color: "var(--ink)" }}>
                  {data.sessionSummary.peakClock ?? "—"}
                </div>
                <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                  Cao điểm ({data.sessionSummary.peakScore}/100)
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
