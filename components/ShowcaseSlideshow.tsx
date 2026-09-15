// components/ShowcaseSlideshow.tsx
//
// Replaces the single static "See it in action" window with a Figma-style
// slideshow: a few real GameSpecs (lib/runtime/fixtures/sampleGameSpec),
// each restyled for a different brand/vertical, auto-advancing through the
// same browser-chrome frame. Still mounts the real runtime per slide — not
// screenshots — so it stays honest with the "not a mockup" claim.
"use client";

import { useEffect, useRef, useState } from "react";

const AUTO_ADVANCE_MS = 5000;

interface Slide {
  specKey: string;
  domain: string;
  vertical: string;
}

const SLIDES: Slide[] = [
  { specKey: "demo-catch", domain: "bloomcoffee.co", vertical: "Coffee & retail" },
  { specKey: "demo-chain-pop", domain: "sweetpop.co", vertical: "Confectionery" },
  { specKey: "demo-guess-price", domain: "nordicsock.co", vertical: "Apparel" },
  { specKey: "demo-catch-lumen", domain: "lumenskincare.com", vertical: "Beauty" },
  { specKey: "demo-guess-price-kicks", domain: "kicksandco.com", vertical: "Footwear" },
];

export function ShowcaseSlideshow() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % SLIDES.length);
    }, AUTO_ADVANCE_MS);
    return () => clearInterval(timer);
  }, [paused]);

  useEffect(() => {
    let cancelled = false;
    let handle: { teardown(): void } | undefined;
    setFailed(false);

    (async () => {
      if (!containerRef.current) return;
      try {
        const [{ mount }, { fixtureGameSpecs }] = await Promise.all([
          import("@/lib/runtime/mount"),
          import("@/lib/runtime/fixtures/sampleGameSpec"),
        ]);
        if (cancelled || !containerRef.current) return;
        const spec = fixtureGameSpecs[SLIDES[index]!.specKey];
        if (!spec) throw new Error("missing fixture");
        handle = mount(spec, containerRef.current, "section");
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      handle?.teardown();
    };
  }, [index]);

  const slide = SLIDES[index]!;

  return (
    <div
      className="overflow-hidden rounded-2xl border border-border bg-card shadow-elevated"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="flex items-center gap-1.5 border-b border-border bg-card2 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-destructive/50" />
        <span className="h-2.5 w-2.5 rounded-full bg-warning/50" />
        <span className="h-2.5 w-2.5 rounded-full bg-success/50" />
        <span className="ml-3 truncate text-xs text-muted">{slide.domain}</span>
      </div>

      <div key={index} className="animate-fade-up" style={{ minHeight: 420 }}>
        <div ref={containerRef} style={{ minHeight: 420 }}>
          {failed && (
            <div className="flex h-full min-h-[420px] items-center justify-center text-sm text-muted">
              Preview unavailable.
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        <p className="truncate text-xs font-medium text-muted">
          {slide.vertical} · <span className="text-foreground">demo</span>
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="Previous slide"
            onClick={() => setIndex((i) => (i - 1 + SLIDES.length) % SLIDES.length)}
            className="flex h-6 w-6 items-center justify-center rounded-full text-muted transition hover:bg-secondary hover:text-foreground"
          >
            ‹
          </button>
          <div className="flex items-center gap-1.5">
            {SLIDES.map((s, i) => (
              <button
                key={s.specKey}
                type="button"
                aria-label={`Go to slide ${i + 1}`}
                onClick={() => setIndex(i)}
                className={`h-1.5 rounded-full transition-all ${
                  i === index ? "w-5 bg-primary" : "w-1.5 bg-border hover:bg-muted"
                }`}
              />
            ))}
          </div>
          <button
            type="button"
            aria-label="Next slide"
            onClick={() => setIndex((i) => (i + 1) % SLIDES.length)}
            className="flex h-6 w-6 items-center justify-center rounded-full text-muted transition hover:bg-secondary hover:text-foreground"
          >
            ›
          </button>
        </div>
      </div>
    </div>
  );
}
