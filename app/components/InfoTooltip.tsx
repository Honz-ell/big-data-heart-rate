"use client";

import React, { useState } from "react";

export function InfoTooltip({
  title,
  content,
}: {
  title: string;
  content: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={`Giải thích: ${title}`}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold transition-colors cursor-pointer"
        style={{
          backgroundColor: "var(--surface-3)",
          color: "var(--muted)",
          border: "1px solid var(--border)",
        }}
      >
        ?
      </button>
      {open && (
        <div
          role="tooltip"
          className="absolute bottom-full left-1/2 z-50 mb-2 w-64 -translate-x-1/2 rounded-xl p-3 text-left text-xs leading-relaxed shadow-xl pointer-events-none"
          style={{
            backgroundColor: "var(--ink)",
            color: "var(--bg)",
          }}
        >
          <div className="font-semibold mb-1">{title}</div>
          <div className="opacity-90">{content}</div>
        </div>
      )}
    </span>
  );
}
