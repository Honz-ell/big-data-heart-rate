"use client";

import React, { useState } from "react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { DEMO_SCENARIOS } from "../lib/mockEngine";
import { ScenarioId, TeamOverviewData, ZoneState } from "../lib/types";
import { InfoTooltip } from "./InfoTooltip";

function zoneBadge(zone: ZoneState, motionActive: boolean) {
  if (motionActive) {
    return {
      icon: "🏃",
      text: "Vận động",
      color: "var(--sky)",
      bg: "var(--sky-soft)",
    };
  }
  if (zone === "STRESS") {
    return {
      icon: "▲",
      text: "Căng thẳng",
      color: "var(--crimson)",
      bg: "var(--crimson-soft)",
    };
  }
  if (zone === "ATTENTION") {
    return {
      icon: "⚠",
      text: "Chú ý",
      color: "var(--amber)",
      bg: "var(--amber-soft)",
    };
  }
  return {
    icon: "✓",
    text: "Ổn định",
    color: "var(--emerald)",
    bg: "var(--emerald-soft)",
  };
}

export function TeamTab({
  data,
  selectedSubjectId,
  scenarioId,
  onInspectMember,
  onRunCohortScenario,
}: {
  data: TeamOverviewData;
  selectedSubjectId: string;
  scenarioId: ScenarioId;
  onInspectMember: (subjectId: string) => void;
  onRunCohortScenario: (scenarioId: ScenarioId) => void;
}) {
  const realCount = data.realMeasuredCount ?? 0;
  // Default to strict real-PostgreSQL mode whenever at least 1 subject has real DB rows
  const [showSimulatedFill, setShowSimulatedFill] = useState<boolean>(false);
  const strictRealOnly = realCount > 0 && !showSimulatedFill;
  const activeScenarioTitle =
    DEMO_SCENARIOS.find((s) => s.id === scenarioId)?.title ?? "Áp lực thuyết trình (TSST)";
  const cohortRunning = data.cohortJob?.status === "running";
  const cohortDone = data.cohortJob?.completedCount ?? 0;
  const cohortTotal = data.cohortJob?.totalCount ?? 15;

  const displayedStressedRatio = strictRealOnly
    ? Math.round(((data.realStressedCount ?? 0) / Math.max(1, realCount)) * 100)
    : data.stressedRatioPercent;
  const displayedDenominator = strictRealOnly ? realCount : data.members.length;
  const displayedStressedCount = strictRealOnly
    ? data.realStressedCount ?? 0
    : Math.round((data.stressedRatioPercent * data.members.length) / 100);

  return (
    <div className="space-y-5">
      {/* Privacy Notice Banner + DB Mode Switcher + 15-Subject Cohort Runner */}
      <div
        className="surface-card space-y-3 px-5 py-4"
        style={{ borderLeft: "4px solid var(--emerald)" }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-sm">
            <span className="text-lg" aria-hidden="true">
              🔒
            </span>
            <div>
              <strong style={{ color: "var(--ink)" }}>Chính sách Quyền riêng tư &amp; Chạy Toàn Nhóm (S2–S17):</strong>{" "}
              <span style={{ color: "var(--muted)" }}>
                Khi đang ở Tab 2, chọn bất kỳ kịch bản nào phía trên sẽ <strong>chạy cuốn chiếu lần lượt cả 15 file <code>.pkl</code> thật</strong> (chỉ tốn ~1 GB RAM) và cập nhật thẳng vào PostgreSQL!
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={cohortRunning}
              onClick={() => onRunCohortScenario(scenarioId)}
              className="rounded-xl px-3.5 py-1.5 text-xs font-extrabold cursor-pointer transition-opacity disabled:opacity-60"
              style={{
                backgroundColor: "var(--sky)",
                color: "#ffffff",
              }}
            >
              {cohortRunning
                ? `⚡ Đang xử lý ${data.cohortJob?.currentSubject ?? ""} (${cohortDone}/${cohortTotal})...`
                : `⚡ Chạy "${activeScenarioTitle}" cho cả 15 người`}
            </button>

            {realCount > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowSimulatedFill(false)}
                  className="rounded-full px-3 py-1 text-xs font-extrabold cursor-pointer transition-all"
                  style={{
                    backgroundColor: !showSimulatedFill ? "var(--emerald)" : "var(--surface-2)",
                    color: !showSimulatedFill ? "#ffffff" : "var(--ink-2)",
                    border: "1px solid var(--border)",
                  }}
                >
                  ● DB thật ({realCount}/15)
                </button>
                <button
                  type="button"
                  onClick={() => setShowSimulatedFill(true)}
                  className="rounded-full px-3 py-1 text-xs font-bold cursor-pointer transition-all"
                  style={{
                    backgroundColor: showSimulatedFill ? "var(--amber)" : "var(--surface-2)",
                    color: showSimulatedFill ? "#ffffff" : "var(--muted)",
                    border: "1px solid var(--border)",
                  }}
                >
                  👁 Kèm mô phỏng
                </button>
              </>
            )}
          </div>
        </div>

        {/* Live Sequential Cohort Progress Bar */}
        {cohortRunning && (
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center justify-between text-xs font-bold" style={{ color: "var(--sky)" }}>
              <span>
                ⚡ Đang trích xuất tín hiệu thật &amp; chấm điểm Random Forest cho thiết bị{" "}
                <strong>{data.cohortJob?.currentSubject}</strong>...
              </span>
              <span className="tabular-nums">
                {cohortDone}/{cohortTotal} thành viên ({Math.round((cohortDone / cohortTotal) * 100)}%)
              </span>
            </div>
            <div className="h-2.5 w-full rounded-full overflow-hidden" style={{ backgroundColor: "var(--surface-3)" }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(5, Math.round((cohortDone / cohortTotal) * 100))}%`,
                  backgroundColor: "var(--sky)",
                  transition: "width 250ms ease",
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* 3 Group KPI Cards */}
      <section aria-label="Chỉ số tổng hợp toàn nhóm" className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="surface-card p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              Tỷ lệ nhóm đang căng thẳng
            </span>
            <InfoTooltip
              title="% người đang căng thẳng"
              content="Tỷ lệ thành viên có chỉ số căng thẳng ≥ 60/100 ở cửa sổ 30 giây gần nhất trong PostgreSQL (đã loại trừ người đang vận động thể chất)."
            />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span
              className="text-4xl font-black tabular-nums"
              style={{
                color: displayedStressedRatio >= 30 ? "var(--crimson)" : "var(--emerald)",
              }}
            >
              {displayedStressedRatio}%
            </span>
            <span className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
              ({displayedStressedCount}/{displayedDenominator} người đang căng thẳng)
            </span>
          </div>
          <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
            Ngưỡng khuyến nghị điều phối ca: dưới 25% toàn nhóm
          </p>
        </div>

        <div className="surface-card p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              Số cảnh báo ghi nhận trong DB
            </span>
            <InfoTooltip
              title="Tổng số cảnh báo"
              content="Tính trực tiếp từ tổng số cửa sổ dự đoán STRESS đã lưu trong bảng stress_predictions của PostgreSQL."
            />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-4xl font-black tabular-nums" style={{ color: "var(--amber)" }}>
              {strictRealOnly ? Math.max(0, Math.ceil((data.realStressWindowsTotal ?? 0) / 2)) : data.alertsToday}
            </span>
            <span className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
              đợt cảnh báo ({data.realStressWindowsTotal ?? 0} cửa sổ Stress trong DB)
            </span>
          </div>
          <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
            Đã tự động lọc bỏ các lượt tăng nhịp tim do đi lại
          </p>
        </div>

        <div className="surface-card p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              Thời gian phục hồi trung bình
            </span>
            <InfoTooltip
              title="Thời gian phục hồi (phút)"
              content="Khoảng thời gian trung bình để chỉ số căng thẳng hạ từ vùng Đỏ (≥ 60) trở lại vùng Xanh (< 40) sau khi nghỉ ngơi hoặc tập thở 4-4-6."
            />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-4xl font-black tabular-nums" style={{ color: "var(--sky)" }}>
              {data.avgRecoveryMinutes.toFixed(1)}
            </span>
            <span className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
              phút / đợt
            </span>
          </div>
          <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
            Nhanh hơn 38% khi thực hiện bài thở điều hòa 4-4-6
          </p>
        </div>
      </section>

      {/* Lưới thẻ nhỏ mỗi người (Ẩn danh NV-02..NV-17) */}
      <section className="surface-card p-5 lg:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base sm:text-lg font-extrabold" style={{ color: "var(--ink)" }}>
              Trạng thái Trực tiếp theo Thành viên Ẩn danh (S2 – S17)
            </h3>
            <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
              Nhấp vào bất kỳ thẻ nào (ví dụ <strong>NV-09 = S9</strong>) để chuyển sang Tab 1 và phát luồng cảm biến thật từ file <code>.pkl</code> của người đó vào PostgreSQL
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs font-semibold">
            <span style={{ color: "var(--emerald)" }}>✓ Ổn định</span>
            <span style={{ color: "var(--amber)" }}>⚠ Chú ý</span>
            <span style={{ color: "var(--crimson)" }}>▲ Căng thẳng</span>
            <span style={{ color: "var(--sky)" }}>🏃 Đang vận động</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          {data.members.map((m) => {
            const isReal = m.sourceType === "live_kafka" || m.sourceType === "postgres_db";
            const isSelected = m.subjectId === selectedSubjectId;

            if (strictRealOnly && !isReal) {
              return (
                <button
                  key={m.subjectId}
                  type="button"
                  onClick={() => onInspectMember(m.subjectId)}
                  className="surface-subtle p-3.5 text-left cursor-pointer transition-all hover:-translate-y-0.5 opacity-75 hover:opacity-100"
                  style={{
                    borderColor: isSelected ? "var(--sky)" : "var(--border)",
                    borderWidth: isSelected ? "2px" : "1px",
                    borderStyle: "dashed",
                  }}
                >
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <span className="text-sm font-extrabold" style={{ color: "var(--ink)" }}>
                      {m.anonymousCode}{" "}
                      <span className="text-[11px] font-normal" style={{ color: "var(--muted)" }}>
                        ({m.subjectId})
                      </span>
                    </span>
                    <span
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                      style={{ backgroundColor: "var(--surface-3)", color: "var(--muted)" }}
                    >
                      ○ Chưa đo
                    </span>
                  </div>
                  <div className="text-[11px] truncate mb-2" style={{ color: "var(--muted)" }}>
                    {m.departmentRole}
                  </div>
                  <div className="py-2 text-xs font-semibold" style={{ color: "var(--sky)" }}>
                    ▶ Nhấp để phát dữ liệu thật {m.subjectId}.pkl
                  </div>
                </button>
              );
            }

            const b = zoneBadge(m.zone, m.motionActive);
            return (
              <button
                key={m.subjectId}
                type="button"
                onClick={() => onInspectMember(m.subjectId)}
                className="surface-subtle p-3.5 text-left cursor-pointer transition-all hover:-translate-y-0.5"
                style={{
                  borderColor: isSelected ? "var(--sky)" : isReal ? "var(--emerald)" : "var(--border)",
                  borderWidth: isSelected ? "2px" : "1px",
                }}
              >
                <div className="flex items-center justify-between gap-1 mb-1">
                  <span className="text-sm font-extrabold" style={{ color: "var(--ink)" }}>
                    {m.anonymousCode}{" "}
                    <span className="text-[11px] font-normal" style={{ color: "var(--muted)" }}>
                      ({m.subjectId})
                    </span>
                  </span>
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold"
                    style={{ backgroundColor: b.bg, color: b.color }}
                  >
                    <span>{b.icon}</span>
                    <span>{b.text}</span>
                  </span>
                </div>

                <div className="text-[11px] truncate mb-1.5" style={{ color: "var(--muted)" }}>
                  {m.departmentRole}
                </div>

                <div className="flex items-baseline justify-between mb-1.5">
                  <div>
                    <span className="text-xl font-black tabular-nums" style={{ color: b.color }}>
                      {m.stressIndex}
                    </span>
                    <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                      /100
                    </span>
                  </div>
                  <div className="text-xs font-semibold tabular-nums" style={{ color: "var(--ink-2)" }}>
                    {m.hrBpm} BPM · {m.edaUs} µS
                  </div>
                </div>

                <div className="h-7 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={m.sparkline.map((v, i) => ({ i, v }))}>
                      <Line
                        type="monotone"
                        dataKey="v"
                        stroke={b.color}
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                <div className="mt-1 flex items-center justify-between text-[10.5px] font-bold">
                  <span
                    style={{
                      color:
                        m.sourceType === "live_kafka"
                          ? "var(--sky)"
                          : isReal
                            ? "var(--emerald)"
                            : "var(--muted)",
                    }}
                  >
                    {m.updatedLabel}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* HEATMAP GIỜ TRONG NGÀY × NGƯỜI + TOP 3 KHUNG GIỜ ÁP LỰC CAO */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
        <section className="surface-card xl:col-span-8 p-5 lg:p-6 space-y-4 overflow-x-auto">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-base sm:text-lg font-extrabold" style={{ color: "var(--ink)" }}>
                Bản đồ nhiệt (Heatmap): Khung giờ trong ngày × Thành viên
              </h3>
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                Giúp quản lý phát hiện ca trực hoặc khung giờ có áp lực tập trung cao để bố trí giải lao hợp lý
              </p>
            </div>
            <InfoTooltip
              title="Cách đọc bản đồ nhiệt"
              content="Mỗi ô thể hiện chỉ số căng thẳng trung bình (0–100) của một thành viên ẩn danh trong khung giờ đó. Có hiển thị kèm con số để người mù màu vẫn đọc chính xác."
            />
          </div>

          <table className="w-full border-collapse text-xs min-w-[560px]">
            <thead>
              <tr>
                <th className="py-2 pr-3 text-left font-bold" style={{ color: "var(--muted)" }}>
                  Mã ẩn danh
                </th>
                {data.heatmap[0]?.hourlyScores.map((h) => (
                  <th key={h.hour} className="p-1.5 text-center font-bold tabular-nums" style={{ color: "var(--muted)" }}>
                    {h.hour}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.heatmap.map((row) => (
                <tr key={row.anonymousCode} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="py-2 pr-3 font-bold whitespace-nowrap" style={{ color: "var(--ink)" }}>
                    {row.anonymousCode}
                    <span className="ml-1.5 font-normal text-[11px] hidden sm:inline" style={{ color: "var(--muted)" }}>
                      ({row.subjectId})
                    </span>
                  </td>
                  {row.hourlyScores.map((cell) => {
                    const bg =
                      cell.zone === "STRESS"
                        ? "var(--crimson-soft)"
                        : cell.zone === "ATTENTION"
                          ? "var(--amber-soft)"
                          : "var(--emerald-soft)";
                    const fg =
                      cell.zone === "STRESS"
                        ? "var(--crimson)"
                        : cell.zone === "ATTENTION"
                          ? "var(--amber)"
                          : "var(--emerald)";
                    return (
                      <td key={cell.hour} className="p-1 text-center">
                        <div
                          title={`${row.anonymousCode} lúc ${cell.hour}: ${cell.score}/100`}
                          className="rounded-lg py-1.5 font-extrabold tabular-nums"
                          style={{
                            backgroundColor: bg,
                            color: fg,
                          }}
                        >
                          {cell.score}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Top 3 khung giờ áp lực cao nhất */}
        <section className="surface-card xl:col-span-4 p-5 lg:p-6 flex flex-col justify-between space-y-4">
          <div className="space-y-3.5">
            <div>
              <h3 className="text-base sm:text-lg font-extrabold" style={{ color: "var(--ink)" }}>
                Top 3 Khung giờ Áp lực Cao nhất
              </h3>
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                Gợi ý điều chỉnh lịch họp &amp; luân phiên ca trực
              </p>
            </div>

            <div className="space-y-3">
              {data.topPeakHours.map((pk, idx) => (
                <div key={pk.hourRange} className="surface-subtle p-3.5 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-extrabold tabular-nums" style={{ color: "var(--ink)" }}>
                      #{idx + 1} · {pk.hourRange}
                    </span>
                    <span
                      className="rounded-full px-2.5 py-0.5 text-xs font-bold tabular-nums"
                      style={{
                        backgroundColor: idx === 0 ? "var(--crimson-soft)" : "var(--amber-soft)",
                        color: idx === 0 ? "var(--crimson)" : "var(--amber)",
                      }}
                    >
                      TB {pk.avgScore}/100 ({pk.affectedPercent}% nhóm)
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
                    {pk.contextNote}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div
            className="rounded-xl p-3.5 text-xs leading-relaxed"
            style={{ backgroundColor: "var(--emerald-soft)", color: "var(--ink-2)" }}
          >
            <strong style={{ color: "var(--emerald)" }}>💡 Giá trị thực tiễn cho tổ chức:</strong> Bố trí 5 phút nghỉ giữa ca lúc 10:30 và 15:15 giúp giảm tần suất cảnh báo căng thẳng kéo dài cho tài xế, điều dưỡng trực cấp cứu và nhân viên tổng đài.
          </div>
        </section>
      </div>
    </div>
  );
}
