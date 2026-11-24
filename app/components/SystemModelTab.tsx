"use client";

import React, { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SystemTelemetryData } from "../lib/types";
import { InfoTooltip } from "./InfoTooltip";

function FlowArrow({ active }: { active: boolean }) {
  return (
    <div className="hidden xl:flex items-center justify-center px-1">
      <svg width="42" height="24" viewBox="0 0 42 24" aria-hidden="true">
        <line
          x1="2"
          y1="12"
          x2="34"
          y2="12"
          stroke={active ? "var(--emerald)" : "var(--border-strong)"}
          strokeWidth="2.5"
          className={active ? "animate-flow-line" : undefined}
        />
        <polygon
          points="32,6 41,12 32,18"
          fill={active ? "var(--emerald)" : "var(--border-strong)"}
        />
      </svg>
    </div>
  );
}

function ConfusionMiniTable({
  title,
  badge,
  matrix,
  highlight,
}: {
  title: string;
  badge: string;
  matrix: { tn: number; fp: number; fn: number; tp: number; recall: number; f1: number };
  highlight: boolean;
}) {
  return (
    <div
      className="surface-subtle p-4 space-y-3"
      style={{
        borderColor: highlight ? "var(--emerald)" : "var(--border)",
        borderWidth: highlight ? "2px" : "1px",
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-extrabold" style={{ color: "var(--ink)" }}>
          {title}
        </span>
        <span
          className="rounded-full px-2.5 py-0.5 text-[11px] font-bold"
          style={{
            backgroundColor: highlight ? "var(--emerald-soft)" : "var(--surface-3)",
            color: highlight ? "var(--emerald)" : "var(--muted)",
          }}
        >
          {badge}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs text-center">
        <div className="rounded-lg p-2" style={{ backgroundColor: "var(--emerald-soft)" }}>
          <div className="text-[11px]" style={{ color: "var(--muted)" }}>
            Đúng Ổn định (TN)
          </div>
          <div className="text-lg font-black tabular-nums" style={{ color: "var(--emerald)" }}>
            {matrix.tn}
          </div>
        </div>
        <div className="rounded-lg p-2" style={{ backgroundColor: "var(--amber-soft)" }}>
          <div className="text-[11px]" style={{ color: "var(--muted)" }}>
            Báo nhầm (FP)
          </div>
          <div className="text-lg font-black tabular-nums" style={{ color: "var(--amber)" }}>
            {matrix.fp}
          </div>
        </div>
        <div className="rounded-lg p-2" style={{ backgroundColor: "var(--crimson-soft)" }}>
          <div className="text-[11px]" style={{ color: "var(--muted)" }}>
            Bỏ sót Stress (FN)
          </div>
          <div className="text-lg font-black tabular-nums" style={{ color: "var(--crimson)" }}>
            {matrix.fn}
          </div>
        </div>
        <div className="rounded-lg p-2" style={{ backgroundColor: "var(--sky-soft)" }}>
          <div className="text-[11px]" style={{ color: "var(--muted)" }}>
            Bắt đúng Stress (TP)
          </div>
          <div className="text-lg font-black tabular-nums" style={{ color: "var(--sky)" }}>
            {matrix.tp}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between pt-1 text-xs font-bold border-t" style={{ borderColor: "var(--border)" }}>
        <span style={{ color: "var(--ink-2)" }}>
          Độ nhạy Recall: <strong className="tabular-nums">{matrix.recall.toFixed(1)}%</strong>
        </span>
        <span style={{ color: "var(--ink-2)" }}>
          F1-Score: <strong className="tabular-nums">{matrix.f1.toFixed(1)}%</strong>
        </span>
      </div>
    </div>
  );
}

export function SystemModelTab({
  data,
  isFlowing,
  onActivateModel,
}: {
  data: SystemTelemetryData;
  isFlowing: boolean;
  onActivateModel: (version: string) => Promise<void>;
}) {
  const [activatingVer, setActivatingVer] = useState<string | null>(null);
  const [swapToast, setSwapToast] = useState<string | null>(null);
  const [logsExpanded, setLogsExpanded] = useState<boolean>(false);

  const activeVer = data.models.find((m) => m.isActive)?.version ?? "v1.0.0";

  const handleHotSwap = async (version: string) => {
    setActivatingVer(version);
    try {
      await onActivateModel(version);
      setSwapToast(
        `✓ Đã kích hoạt ${version} — Edge sẽ nhận model mới ở lần poll kế tiếp (≤ 5 giây) không dừng luồng!`
      );
      window.setTimeout(() => setSwapToast(null), 6000);
    } finally {
      setActivatingVer(null);
    }
  };

  const pipelineNodes = [
    {
      title: "1. Đồng hồ E4",
      subtitle: "6 kênh cảm biến",
      metric: `${data.liveNodes.sensorRatePerSec.toLocaleString()} mẫu/s`,
      subMetric: "BVP 64Hz · ACC 32Hz · EDA/TEMP",
      accent: "var(--emerald)",
    },
    {
      title: "2. Apache Kafka",
      subtitle: "wearable.sensor.v1",
      metric: `${data.liveNodes.kafkaRecordsPerSec.toLocaleString()} rec/s`,
      subMetric: "KRaft · Phân vùng theo subject_id",
      accent: "var(--sky)",
    },
    {
      title: "3. Spark Streaming",
      subtitle: "Cửa sổ 10s · Watermark 15s",
      metric: `${Math.round(data.liveNodes.sparkBatchMs)} ms/batch`,
      subMetric: `${data.liveNodes.sparkWindowsTotal.toLocaleString()} cửa sổ 10s`,
      accent: "var(--amber)",
    },
    {
      title: "4. PostgreSQL 17",
      subtitle: "Lưu trữ & Replay Clock",
      metric: `${data.liveNodes.postgresRowsTotal.toLocaleString()} bản ghi`,
      subMetric: "aggregates + predictions + feedback",
      accent: "#8b5cf6",
    },
    {
      title: "5. Edge RF Model",
      subtitle: `Cửa sổ ${data.liveNodes.edgeWindowSec}s · Hot-Swap`,
      metric: `Active: ${activeVer}`,
      subMetric: `${data.liveNodes.edgePredictionsTotal} dự đoán đã phát`,
      accent: "var(--emerald)",
    },
    {
      title: "6. Web Dashboard",
      subtitle: "Làm mới mỗi 3 giây",
      metric: isFlowing ? "Trực tuyến" : "Sẵn sàng",
      subMetric: "3 góc nhìn · Chống báo giả",
      accent: "var(--sky)",
    },
  ];

  return (
    <div className="space-y-5">
      {/* Toast Notification on Model Hot-Swap */}
      {swapToast && (
        <div
          role="status"
          className="rounded-2xl px-5 py-3.5 text-sm font-extrabold shadow-lg flex items-center justify-between gap-3"
          style={{
            backgroundColor: "var(--emerald)",
            color: "#ffffff",
          }}
        >
          <span>⚡ {swapToast}</span>
          <button
            type="button"
            onClick={() => setSwapToast(null)}
            className="rounded-lg bg-white/20 px-2.5 py-0.5 text-xs cursor-pointer"
          >
            Đóng
          </button>
        </div>
      )}

      {/* SƠ ĐỒ PIPELINE ĐỘNG */}
      <section className="surface-card p-5 lg:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base sm:text-lg font-extrabold" style={{ color: "var(--ink)" }}>
                Sơ đồ Luồng Kiến trúc Big Data &amp; Edge AI Thời gian thực
              </h3>
              <InfoTooltip
                title="Kiến trúc Dual-Speed (Hai tốc độ)"
                content="Dữ liệu cảm biến từ Kafka chia làm 2 nhánh song song: Spark Structured Streaming gom nhanh mỗi 10 giây để vẽ đường sinh hiệu mượt, trong khi Edge AI gom đủ 30 giây để trích xuất 16 đặc trưng phân loại Stress chính xác."
              />
            </div>
            <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
              {isFlowing
                ? "● Luồng dữ liệu đang chảy trực tiếp qua các tầng xử lý"
                : "◐ Đang ở trạng thái chờ — bấm ▶ Start hoặc chọn kịch bản để quan sát thông lượng tăng vọt"}
            </p>
          </div>
        </div>

        <div className="flex flex-col xl:flex-row items-stretch xl:items-center justify-between gap-2">
          {pipelineNodes.map((node, index) => (
            <React.Fragment key={node.title}>
              <div
                className="surface-subtle flex-1 p-3.5 space-y-1"
                style={{ borderTop: `3px solid ${node.accent}` }}
              >
                <div className="text-xs font-extrabold" style={{ color: "var(--ink)" }}>
                  {node.title}
                </div>
                <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                  {node.subtitle}
                </div>
                <div className="pt-1 text-base font-black tabular-nums" style={{ color: node.accent }}>
                  {node.metric}
                </div>
                <div className="text-[10px]" style={{ color: "var(--muted)" }}>
                  {node.subMetric}
                </div>
              </div>
              {index < pipelineNodes.length - 1 && <FlowArrow active={isFlowing} />}
            </React.Fragment>
          ))}
        </div>
      </section>

      {/* BIỂU ĐỒ KỸ THUẬT: THROUGHPUT KAFKA/SPARK, MICRO-BATCH LATENCY, CPU/RAM CONTAINER */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Chart 1: Throughput Kafka & Spark */}
        <div className="surface-card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-extrabold" style={{ color: "var(--ink)" }}>
                Thông lượng Kafka &amp; Spark (records/s)
              </h4>
              <p className="text-[11px]" style={{ color: "var(--muted)" }}>
                Tốc độ nhận và xử lý mẫu cảm biến
              </p>
            </div>
            <InfoTooltip
              title="Throughput (Bản ghi / giây)"
              content="1 thiết bị E4 ở tốc độ thực sinh ~106 mẫu/giây; khi phát tăng tốc 30× đạt ~3.180 mẫu/giây. Spark xử lý theo kịp ngay trong từng chu kỳ 2 giây."
            />
          </div>
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.history}>
                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="timeLabel" tick={{ fill: "var(--muted)", fontSize: 11 }} />
                <YAxis tick={{ fill: "var(--muted)", fontSize: 11 }} width={46} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--surface)",
                    borderColor: "var(--border-strong)",
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="kafkaRecordsPerSec"
                  name="Kafka In (rec/s)"
                  stroke="var(--sky)"
                  fill="var(--sky-soft)"
                  strokeWidth={2}
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="sparkProcessedPerSec"
                  name="Spark Out (rec/s)"
                  stroke="var(--emerald)"
                  fill="var(--emerald-soft)"
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 2: Micro-batch execution time */}
        <div className="surface-card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-extrabold" style={{ color: "var(--ink)" }}>
                Độ trễ Micro-batch Spark (ms)
              </h4>
              <p className="text-[11px]" style={{ color: "var(--muted)" }}>
                Thời gian gom cửa sổ 10s &amp; ghi JDBC
              </p>
            </div>
            <InfoTooltip
              title="Thời gian thực thi Micro-batch (ms)"
              content="Đo bằng chỉ số wesad_spark_trigger_execution_ms từ Prometheus. Độ trễ ~150–250 ms nhỏ hơn rất nhiều so với chu kỳ cửa sổ 10.000 ms."
            />
          </div>
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.history}>
                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="timeLabel" tick={{ fill: "var(--muted)", fontSize: 11 }} />
                <YAxis tick={{ fill: "var(--muted)", fontSize: 11 }} unit="ms" width={48} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--surface)",
                    borderColor: "var(--border-strong)",
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="sparkBatchMs"
                  name="Micro-batch (ms)"
                  stroke="var(--amber)"
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 3: Container CPU / RAM */}
        <div className="surface-card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-extrabold" style={{ color: "var(--ink)" }}>
                Tài nguyên Container (CPU &amp; RAM)
              </h4>
              <p className="text-[11px]" style={{ color: "var(--muted)" }}>
                Giám sát qua cAdvisor &amp; Prometheus
              </p>
            </div>
            <InfoTooltip
              title="Mức tiêu thụ CPU / RAM"
              content="Giúp đánh giá khả năng mở rộng (scalability) của từng thành phần Docker khi tăng số lượng đồng hồ đeo đồng thời."
            />
          </div>
          <div className="space-y-2.5 pt-1">
            {data.containers.map((c) => (
              <div key={c.name} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold" style={{ color: "var(--ink)" }}>
                    {c.name}
                  </span>
                  <span className="tabular-nums font-semibold" style={{ color: "var(--muted)" }}>
                    CPU {c.cpuPercent}% · RAM {c.ramMb} MB
                  </span>
                </div>
                <div className="h-2 w-full rounded-full overflow-hidden" style={{ backgroundColor: "var(--surface-3)" }}>
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(6, Math.min(100, c.cpuPercent * 1.6))}%`,
                      backgroundColor: c.cpuPercent > 35 ? "var(--amber)" : "var(--emerald)",
                      transition: "width 300ms ease",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* MODEL REGISTRY (HOT-SWAP) + SO SÁNH v1.0.0 vs v1.1.0 */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
        {/* Bảng Model Registry */}
        <section className="surface-card xl:col-span-7 p-5 lg:p-6 space-y-4 overflow-x-auto">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-base sm:text-lg font-extrabold" style={{ color: "var(--ink)" }}>
                Model Registry &amp; Cập nhật Nóng (Hot-Swap Không Dừng Luồng)
              </h3>
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                Edge kiểm tra SHA-256 mỗi 5 giây và tự động nạp phiên bản Active mới giữa hai cửa sổ
              </p>
            </div>
          </div>

          <table className="w-full border-collapse text-xs min-w-[540px]">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
                <th className="py-2 pr-3">Phiên bản</th>
                <th className="py-2 pr-3">SHA-256 rút gọn</th>
                <th className="py-2 pr-3">Recall Stress</th>
                <th className="py-2 pr-3">F1-Score</th>
                <th className="py-2 pr-3">Phát hành</th>
                <th className="py-2 pr-3">Trạng thái</th>
                <th className="py-2 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map((m) => (
                <tr key={m.version} className="border-b" style={{ borderColor: "var(--border)" }}>
                  <td className="py-3 pr-3 font-extrabold text-sm" style={{ color: "var(--ink)" }}>
                    {m.version}
                    <div className="font-normal text-[11px]" style={{ color: "var(--muted)" }}>
                      {m.notes}
                    </div>
                  </td>
                  <td className="py-3 pr-3 font-mono text-[11px]" style={{ color: "var(--ink-2)" }}>
                    {m.sha256Short}…
                  </td>
                  <td className="py-3 pr-3 font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                    {m.stressRecall.toFixed(1)}%
                  </td>
                  <td className="py-3 pr-3 font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                    {m.stressF1.toFixed(1)}%
                  </td>
                  <td className="py-3 pr-3 tabular-nums" style={{ color: "var(--muted)" }}>
                    {m.releasedAt}
                  </td>
                  <td className="py-3 pr-3">
                    {m.isActive ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-extrabold"
                        style={{ backgroundColor: "var(--emerald-soft)", color: "var(--emerald)" }}
                      >
                        ● Active
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
                        style={{ backgroundColor: "var(--surface-3)", color: "var(--muted)" }}
                      >
                        Dự phòng
                      </span>
                    )}
                  </td>
                  <td className="py-3 text-right">
                    <button
                      type="button"
                      disabled={m.isActive || activatingVer === m.version}
                      onClick={() => void handleHotSwap(m.version)}
                      className="rounded-xl px-3.5 py-1.5 text-xs font-extrabold cursor-pointer transition-opacity disabled:opacity-45 disabled:cursor-not-allowed"
                      style={{
                        backgroundColor: m.isActive ? "var(--surface-3)" : "var(--sky)",
                        color: m.isActive ? "var(--muted)" : "#ffffff",
                      }}
                    >
                      {m.isActive
                        ? "Đang chạy"
                        : activatingVer === m.version
                          ? "Đang nạp..."
                          : "⚡ Kích hoạt"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* So sánh v1.0.0 vs v1.1.0 */}
        <section className="surface-card xl:col-span-5 p-5 lg:p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base sm:text-lg font-extrabold" style={{ color: "var(--ink)" }}>
                Đối chiếu v1.0.0 vs v1.1.0
              </h3>
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                Ma trận nhầm lẫn trên tập kiểm thử độc lập S4 ({data.comparison.scenarioTitle})
              </p>
            </div>
            <InfoTooltip
              title="Đánh đổi Precision vs Recall"
              content="v1.0.0 ít báo nhầm hơn (FP=4, F1=75%), phù hợp đeo hàng ngày. v1.1.0 hạ ngưỡng nhạy để bắt nhiều ca Stress hơn (Recall 73.3%), phù hợp tầm soát ca trực đặc thù."
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ConfusionMiniTable
              title="Model v1.0.0"
              badge={activeVer === "v1.0.0" ? "Đang Active" : "Cân bằng"}
              matrix={data.comparison.v100}
              highlight={activeVer === "v1.0.0"}
            />
            <ConfusionMiniTable
              title="Model v1.1.0"
              badge={activeVer === "v1.1.0" ? "Đang Active" : "Độ nhạy cao"}
              matrix={data.comparison.v110}
              highlight={activeVer === "v1.1.0"}
            />
          </div>
        </section>
      </div>

      {/* PANEL ĐÁNH GIÁ LOSO THEO TỪNG NGƯỜI ĐEO (S2..S17) */}
      <section className="surface-card p-5 lg:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base sm:text-lg font-extrabold" style={{ color: "var(--ink)" }}>
                Đánh giá Chéo Độc lập Người đeo (LOSO — Leave-One-Subject-Out)
              </h3>
              <InfoTooltip
                title="Vì sao phải đánh giá LOSO?"
                content="Mỗi người có cơ địa mồ hôi và nhịp tim nền khác nhau. Huấn luyện trên 14 người và kiểm thử trên 1 người hoàn toàn mới (LOSO) giúp đánh giá trung thực khả năng tổng quát hóa, tránh rò rỉ dữ liệu (data leakage)."
              />
            </div>
            <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
              Độ nhạy phát hiện Stress (Recall %) trên từng cá nhân trong WESAD — minh bạch mức dao động sinh lý tự nhiên giữa các người tham gia (cột xanh dương S4 là thiết bị Held-out đang demo)
            </p>
          </div>
          <span
            className="rounded-full px-3 py-1 text-xs font-bold tabular-nums"
            style={{ backgroundColor: "var(--surface-2)", color: "var(--ink-2)", border: "1px solid var(--border)" }}
          >
            Trung bình LOSO Recall: 59.6% · S4 Held-out F1: 75.0%
          </span>
        </div>

        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.losoBenchmarks} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
              <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="subjectId" tick={{ fill: "var(--muted)", fontSize: 12, fontWeight: 700 }} />
              <YAxis domain={[0, 100]} unit="%" tick={{ fill: "var(--muted)", fontSize: 12 }} width={46} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--surface)",
                  borderColor: "var(--border-strong)",
                  borderRadius: 12,
                  fontSize: 12,
                }}
                formatter={(val) => [`${val}%`, "Stress Recall"]}
              />
              <Bar dataKey="stressRecallPercent" radius={[6, 6, 0, 0]} isAnimationActive={false}>
                {data.losoBenchmarks.map((entry) => (
                  <Cell
                    key={entry.subjectId}
                    fill={entry.isHeldOut ? "var(--sky)" : "var(--emerald)"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* LOG TERMINAL THU GỌN (ACCORDION) */}
      <section className="surface-card overflow-hidden">
        <button
          type="button"
          onClick={() => setLogsExpanded((v) => !v)}
          className="w-full flex items-center justify-between px-5 py-4 text-left cursor-pointer"
          style={{ backgroundColor: "var(--surface-2)" }}
        >
          <div>
            <div className="text-sm font-extrabold" style={{ color: "var(--ink)" }}>
              Nhật ký Tiến trình Trực tiếp (Kafka Producer &amp; Edge Consumer)
            </div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>
              Nhấn để {logsExpanded ? "thu gọn" : "mở xem chi tiết"} log kỹ thuật từ produce_e4.py và edge_inference.py
            </div>
          </div>
          <span className="text-xs font-bold px-3 py-1 rounded-lg" style={{ backgroundColor: "var(--surface-3)", color: "var(--ink)" }}>
            {logsExpanded ? "Thu gọn ▲" : "Xem Terminal ▼"}
          </span>
        </button>

        {logsExpanded && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-5">
            <div>
              <div className="text-xs font-bold mb-1.5" style={{ color: "var(--muted)" }}>
                Kafka Producer (scripts/produce_e4.py)
              </div>
              <pre
                className="rounded-xl p-3.5 text-[11.5px] leading-relaxed overflow-x-auto max-h-48 font-mono"
                style={{ backgroundColor: "#0b1219", color: "#a7f3d0" }}
              >
                {data.logs.producer.join("\n")}
              </pre>
            </div>
            <div>
              <div className="text-xs font-bold mb-1.5" style={{ color: "var(--muted)" }}>
                Edge Inference &amp; Hot-Swap (scripts/edge_inference.py)
              </div>
              <pre
                className="rounded-xl p-3.5 text-[11.5px] leading-relaxed overflow-x-auto max-h-48 font-mono"
                style={{ backgroundColor: "#0b1219", color: "#bae6fd" }}
              >
                {data.logs.edge.join("\n")}
              </pre>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
