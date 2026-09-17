"use client";

export type AnalyticsRangeDays = 7 | 30 | 90 | "all";

const OPTIONS: { value: AnalyticsRangeDays; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: "all", label: "All time" },
];

export function AnalyticsRangePicker({
  value,
  onChange,
}: {
  value: AnalyticsRangeDays;
  onChange: (v: AnalyticsRangeDays) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-full border border-border bg-card p-1 text-sm">
      {OPTIONS.map((opt) => (
        <button
          key={String(opt.value)}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`rounded-full px-3.5 py-1.5 font-medium transition-all ${
            value === opt.value
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted hover:bg-foreground/[0.04] hover:text-foreground"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function rangeToQueryParam(days: AnalyticsRangeDays): string {
  return days === "all" ? "all" : String(days);
}
