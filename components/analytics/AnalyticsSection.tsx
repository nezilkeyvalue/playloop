"use client";

import type { ReactNode } from "react";

export function AnalyticsSection({
  sectionId,
  title,
  description,
  children,
  className = "",
}: {
  sectionId?: string;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={sectionId}
      className={`scroll-mt-24 rounded-2xl border border-border bg-card p-6 shadow-card transition-shadow duration-300 data-[highlight=true]:shadow-elevated data-[highlight=true]:ring-2 data-[highlight=true]:ring-primary/40 ${className}`}
    >
      <div className="mb-5">
        <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function AnalyticsPageHero({
  title,
  subtitle,
  rangeControl,
}: {
  title: string;
  subtitle?: string;
  rangeControl: ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/[0.12] via-card to-card2 p-6 shadow-card sm:p-8">
      <div
        className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/[0.08] blur-3xl"
        aria-hidden
      />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">Insights</p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-2 max-w-xl text-sm text-muted">{subtitle}</p> : null}
        </div>
        <div className="shrink-0">{rangeControl}</div>
      </div>
    </div>
  );
}

export function AnalyticsLoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-8">
      <div className="h-36 rounded-2xl bg-foreground/[0.06]" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-24 rounded-2xl bg-foreground/[0.06]" />
        ))}
      </div>
      <div className="h-80 rounded-2xl bg-foreground/[0.06]" />
    </div>
  );
}
