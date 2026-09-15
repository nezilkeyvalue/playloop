// components/HeroDoodle.tsx — a hand-built interactive parallax scene for
// the landing hero. No Lottie/external asset: eight plain shapes in the
// existing design tokens (primary/success/warning/destructive) that drift
// toward the cursor at different strengths depending on size/depth, purely
// via CSS transforms. Confined to the margins either side of the headline
// so it never competes with the text for legibility, and hidden below the
// `sm` breakpoint where there's no room for it anyway.
"use client";

import { useEffect, useRef, useState } from "react";

interface ShapeDef {
  id: number;
  top: string;
  left: string;
  size: number;
  factor: number; // parallax strength — larger/closer shapes move more
  shape: "circle" | "square" | "triangle";
  colorVar: string;
  opacity: number;
}

const SHAPES: ShapeDef[] = [
  { id: 0, top: "6%", left: "6%", size: 64, factor: 16, shape: "circle", colorVar: "--primary", opacity: 0.18 },
  { id: 1, top: "32%", left: "2%", size: 26, factor: 30, shape: "triangle", colorVar: "--warning", opacity: 0.22 },
  { id: 2, top: "58%", left: "11%", size: 40, factor: 20, shape: "square", colorVar: "--success", opacity: 0.2 },
  { id: 3, top: "80%", left: "5%", size: 32, factor: 26, shape: "circle", colorVar: "--destructive", opacity: 0.18 },
  { id: 4, top: "10%", left: "91%", size: 50, factor: 18, shape: "square", colorVar: "--success", opacity: 0.18 },
  { id: 5, top: "36%", left: "95%", size: 24, factor: 32, shape: "triangle", colorVar: "--primary", opacity: 0.22 },
  { id: 6, top: "60%", left: "88%", size: 46, factor: 14, shape: "circle", colorVar: "--warning", opacity: 0.18 },
  { id: 7, top: "82%", left: "93%", size: 30, factor: 24, shape: "square", colorVar: "--destructive", opacity: 0.2 },
];

export function HeroDoodle() {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const raf = useRef<number | null>(null);
  const target = useRef({ x: 0, y: 0 });

  useEffect(() => {
    function handleMove(e: MouseEvent) {
      target.current = {
        x: (e.clientX / window.innerWidth) * 2 - 1,
        y: (e.clientY / window.innerHeight) * 2 - 1,
      };
      if (raf.current !== null) return;
      raf.current = requestAnimationFrame(() => {
        setPos(target.current);
        raf.current = null;
      });
    }
    window.addEventListener("mousemove", handleMove);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 hidden overflow-hidden sm:block" aria-hidden="true">
      {SHAPES.map((s) => {
        const isTriangle = s.shape === "triangle";
        return (
          <span
            key={s.id}
            className="absolute transition-transform duration-300 ease-out"
            style={{
              top: s.top,
              left: s.left,
              width: s.size,
              height: s.size,
              transform: `translate(${pos.x * s.factor}px, ${pos.y * s.factor}px)`,
              background: `rgb(var(${s.colorVar}) / ${s.opacity})`,
              borderRadius: s.shape === "circle" ? "9999px" : s.shape === "square" ? "22%" : 0,
              clipPath: isTriangle ? "polygon(50% 0%, 0% 100%, 100% 100%)" : undefined,
            }}
          />
        );
      })}
    </div>
  );
}
