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
                Khi đang ở Tab 2, chọn kịch bản phía trên sẽ <strong>chạy cuốn chiếu trực tiếp trên các tệp <code>.pkl</code> thật hiện có</strong> (~1 GB RAM) và lưu vào PostgreSQL (từ chối ghi dữ liệu mô phỏng vào DB).
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
        {data.cohortJob?.status === "failed" && data.cohortJob.error && (
          <div
            className="rounded-xl px-3.5 py-2 text-xs font-bold"
            style={{ backgroundColor: "var(--crimson-soft)", color: "var(--crimson)" }}
          >
            ⚠ {data.cohortJob.error}
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
              content="Tỷ lệ thành viên có kết quả phân loại STRESS (điểm Random Forest ≥ 50/100) ở cửa sổ 30 giây mới nhất trong PostgreSQL."
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
            Đồng nhất ngưỡng phân loại <code>prediction = &apos;STRESS&apos;</code> (≥ 0.50) từ DB
          </p>
        </div>

        <div className="surface-card p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              {strictRealOnly ? "Đợt Stress liên tiếp (≥60s) trong DB" : "Đợt cảnh báo trên Dashboard"}
            </span>
            <InfoTooltip
              title="Cách tính đợt Stress liên tiếp"
              content="Đếm trực tiếp từ chuỗi thời gian bảng stress_predictions: mỗi đợt gồm ≥ 2 cửa sổ 30 giây liên tiếp cùng phân loại STRESS (không ước lượng chia đôi, không gửi thông báo SMS/Email ra ngoài)."
            />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-4xl font-black tabular-nums" style={{ color: "var(--amber)" }}>
              {strictRealOnly ? (data.realSustainedAlerts ?? 0) : data.alertsToday}
            </span>
            <span className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
              {strictRealOnly
                ? `đợt ≥60s (${data.realStressWindowsTotal ?? 0} cửa sổ STRESS trong DB)`
                : "đợt cảnh báo hiển thị (minh họa)"}
            </span>
          </div>
          <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
            Cảnh báo trực quan trên Dashboard khi ≥ 2 cửa sổ 30s liên tiếp vượt ngưỡng
          </p>
        </div>

        <div className="surface-card p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              Thời gian phục hồi trung bình
            </span>
            <InfoTooltip
              title="Thời gian phục hồi thực đo"
              content="Ở chế độ DB thật, tính trung bình khoảng cách thời gian từ cuối một đợt STRESS sang cửa sổ NON_STRESS kế tiếp trong cùng phiên đo của từng người."
            />
          </div>
          {strictRealOnly ? (
            data.realAvgRecoveryMinutes !== null && data.realAvgRecoveryMinutes !== undefined ? (
              <>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-4xl font-black tabular-nums" style={{ color: "var(--sky)" }}>
                    {data.realAvgRecoveryMinutes.toFixed(1)}
                  </span>
                  <span className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
                    phút / đợt chuyển tiếp (từ DB thật)
                  </span>
                </div>
                <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
                  Tính trực tiếp từ các điểm chuyển <code>STRESS → NON_STRESS</code> trong PostgreSQL
                </p>
              </>
            ) : (
              <>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl font-black tabular-nums" style={{ color: "var(--muted)" }}>
                    Chưa có chuỗi
                  </span>
                </div>
                <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
                  Chạy <strong>Kịch bản 3 (Căng thẳng → Phục hồi)</strong> để đo thời gian hồi phục thật trong DB
                </p>
              </>
            )
          ) : (
            <>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-4xl font-black tabular-nums" style={{ color: "var(--sky)" }}>
                  {(data.avgRecoveryMinutes ?? 3.5).toFixed(1)}
                </span>
                <span className="text-xs font-semibold" style={{ color: "var(--muted)" }}>
                  phút / đợt (mô phỏng minh họa)
                </span>
              </div>
              <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
                Giá trị tham khảo ở chế độ mô phỏng ca trực
              </p>
            </>
          )}
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

      {/* HEATMAP (100% REAL POSTGRESQL WINDOWS IN LIVE MODE, OR LABELED SHIFT SIMULATION) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
        <section className="surface-card xl:col-span-8 p-5 lg:p-6 space-y-4 overflow-x-auto">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-base sm:text-lg font-extrabold" style={{ color: "var(--ink)" }}>
                {strictRealOnly
                  ? "Bản đồ nhiệt (Heatmap): Chuỗi cửa sổ 30s thực tế trong PostgreSQL × Thành viên"
                  : "Bản đồ nhiệt Minh họa Ca trực (Kèm mô phỏng): Khung giờ × Thành viên"}
              </h3>
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                {strictRealOnly
                  ? "100% con số truy vấn trực tiếp từ bảng stress_predictions (ô '—' nghĩa là thành viên chưa có cửa sổ tại bước đó)"
                  : "Chế độ minh họa ghép dữ liệu DB với khung giờ hành chính 08:00–17:00"}
              </p>
            </div>
            <InfoTooltip
              title="Cách đọc bản đồ nhiệt"
              content={
                strictRealOnly
                  ? "Mỗi cột thể hiện một cửa sổ 30 giây thật trong phiên gần nhất của từng người trong PostgreSQL (từ các cửa sổ trước đến cửa sổ 'Mới nhất'). Ngưỡng Đỏ ≥ 50 khớp chính xác cột prediction = 'STRESS'."
                  : "Mỗi ô thể hiện chỉ số căng thẳng (0–100) minh họa theo khung giờ trong ngày."
              }
            />
          </div>

          {(() => {
            const activeHeatmap =
              strictRealOnly && data.realHeatmap ? data.realHeatmap : data.heatmap;
            return (
              <table className="w-full border-collapse text-xs min-w-[560px]">
                <thead>
                  <tr>
                    <th className="py-2 pr-3 text-left font-bold" style={{ color: "var(--muted)" }}>
                      Mã ẩn danh
                    </th>
                    {activeHeatmap[0]?.hourlyScores.map((h) => (
                      <th key={h.hour} className="p-1.5 text-center font-bold tabular-nums" style={{ color: "var(--muted)" }}>
                        {h.hour}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeHeatmap.map((row) => (
                    <tr key={row.anonymousCode} className="border-t" style={{ borderColor: "var(--border)" }}>
                      <td className="py-2 pr-3 font-bold whitespace-nowrap" style={{ color: "var(--ink)" }}>
                        {row.anonymousCode}
                        <span className="ml-1.5 font-normal text-[11px] hidden sm:inline" style={{ color: "var(--muted)" }}>
                          ({row.subjectId})
                        </span>
                      </td>
                      {row.hourlyScores.map((cell) => {
                        if (cell.score === null || cell.zone === "UNMEASURED") {
                          return (
                            <td key={cell.hour} className="p-1 text-center">
                              <div
                                title={`${row.anonymousCode} (${cell.hour}): chưa có bản ghi trong PostgreSQL`}
                                className="rounded-lg py-1.5 font-semibold tabular-nums"
                                style={{
                                  backgroundColor: "var(--surface-2)",
                                  color: "var(--muted)",
                                }}
                              >
                                —
                              </div>
                            </td>
                          );
                        }
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
                              title={`${row.anonymousCode} (${cell.clockUtc ? `${cell.clockUtc} UTC` : cell.hour}): ${cell.score}/100`}
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
            );
          })()}
        </section>

        {/* Top 3 khung giờ áp lực cao nhất */}
        <section className="surface-card xl:col-span-4 p-5 lg:p-6 flex flex-col justify-between space-y-4">
          <div className="space-y-3.5">
            <div>
              <h3 className="text-base sm:text-lg font-extrabold" style={{ color: "var(--ink)" }}>
                {strictRealOnly
                  ? "Thống kê Khung giờ Ghi hình Thật (PostgreSQL)"
                  : "Top 3 Khung giờ Minh họa Ca trực"}
              </h3>
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                {strictRealOnly
                  ? "Tổng hợp trực tiếp theo giờ UTC của các cửa sổ WESAD đã lưu trong DB"
                  : "Dữ liệu minh họa phân bổ ca trực"}
              </p>
            </div>

            <div className="space-y-3">
              {(strictRealOnly && data.realPeakHours && data.realPeakHours.length > 0
                ? data.realPeakHours
                : data.topPeakHours
              ).map((pk, idx) => (
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
            <strong style={{ color: "var(--emerald)" }}>💡 Ghi chú dữ liệu:</strong>{" "}
            {strictRealOnly
              ? "Tất cả số liệu trên đang đọc trực tiếp từ PostgreSQL (không pha trộn dữ liệu ngẫu nhiên). Bạn có thể bật '👁 Kèm mô phỏng' nếu muốn xem giao diện mẫu ca trực 08:00–17:00."
              : "Đang bật chế độ kèm mô phỏng ca trực 08:00–17:00. Nhấn '● DB thật' để chỉ hiển thị số liệu gốc từ PostgreSQL."}
          </div>
        </section>
      </div>
    </div>
  );
}
