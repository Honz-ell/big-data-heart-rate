"use client";

import React, { useEffect, useState } from "react";

export function BreathingModal({
  open,
  onClose,
  onCompletedCycle,
}: {
  open: boolean;
  onClose: () => void;
  onCompletedCycle?: () => void;
}) {
  // 14-second 4-4-6 cycle: 0..3 Inhale (4s), 4..7 Hold (4s), 8..13 Exhale (6s)
  const [tick, setTick] = useState(0);
  const [cycles, setCycles] = useState(0);

  useEffect(() => {
    if (!open) {
      setTick(0);
      setCycles(0);
      return;
    }
    const id = window.setInterval(() => {
      setTick((prev) => {
        const next = (prev + 1) % 14;
        if (next === 0) {
          setCycles((c) => c + 1);
          onCompletedCycle?.();
        }
        return next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [open, onCompletedCycle]);

  if (!open) return null;

  let phaseTitle = "Hít vào chậm bằng mũi";
  let countdown = 4 - tick;
  let circleScale = 1.28;
  let accent = "var(--emerald)";

  if (tick >= 4 && tick < 8) {
    phaseTitle = "Giữ hơi nhẹ nhàng";
    countdown = 8 - tick;
    circleScale = 1.28;
    accent = "var(--sky)";
  } else if (tick >= 8) {
    phaseTitle = "Thở ra thật chậm bằng miệng";
    countdown = 14 - tick;
    circleScale = 0.78;
    accent = "var(--emerald)";
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(9, 16, 23, 0.72)", backdropFilter: "blur(6px)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Bài tập thở điều hòa nhịp tim 4-4-6"
    >
      <div className="surface-card relative w-full max-w-md p-6 text-center">
        <div className="flex items-center justify-between mb-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold"
            style={{ backgroundColor: "var(--emerald-soft)", color: "var(--emerald)" }}
          >
            ● Can thiệp điều hòa nhịp tim (4 - 4 - 6)
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2.5 py-1 text-sm font-medium cursor-pointer"
            style={{ backgroundColor: "var(--surface-3)", color: "var(--ink)" }}
          >
            ✕ Đóng
          </button>
        </div>

        <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>
          Nhịp thở ra dài (6 giây) kích hoạt dây thần kinh phế vị, giúp hạ nhịp tim và tăng chỉ số HRV trong 1–2 phút.
        </p>

        <div className="relative mx-auto my-6 flex h-52 w-52 items-center justify-center">
          <div
            className="absolute inset-4 rounded-full opacity-25"
            style={{
              backgroundColor: accent,
              transform: `scale(${circleScale * 1.12})`,
              transition: "transform 1000ms ease-in-out, background-color 500ms ease",
            }}
          />
          <div
            className="flex h-36 w-36 flex-col items-center justify-center rounded-full shadow-lg"
            style={{
              backgroundColor: "var(--surface-2)",
              border: `3px solid ${accent}`,
              transform: `scale(${circleScale})`,
              transition: "transform 1000ms ease-in-out, border-color 500ms ease",
            }}
          >
            <span className="text-4xl font-extrabold tabular-nums" style={{ color: accent }}>
              {countdown}s
            </span>
            <span className="mt-1 text-xs font-semibold" style={{ color: "var(--ink-2)" }}>
              Chu kỳ #{cycles + 1}
            </span>
          </div>
        </div>

        <div className="text-lg font-bold mb-1" style={{ color: "var(--ink)" }}>
          {phaseTitle}
        </div>
        <div className="text-xs mb-5" style={{ color: "var(--muted)" }}>
          Nhịp chuẩn: Hít vào 4 giây · Giữ hơi 4 giây · Thở ra 6 giây
        </div>

        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-5 py-2.5 text-sm font-semibold text-white cursor-pointer"
            style={{ backgroundColor: "var(--emerald)" }}
          >
            Hoàn tất &amp; Quay lại theo dõi
          </button>
        </div>
      </div>
    </div>
  );
}
