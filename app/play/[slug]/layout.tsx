// app/play/[slug]/layout.tsx
//
// The hosted runtime's own layout: no chrome, transparent background
// (build spec §3 repository structure: "No chrome, transparent bg").
//
// The root layout (app/layout.tsx) sets `min-h-screen` on <body> for the
// marketing/app routes, which would force this route's document to always
// report a full-viewport scrollHeight — breaking the postMessage
// auto-height handshake with the embed loader (build spec §14/§23: "an
// iframe does not grow to fit content"). The !important overrides below
// undo that for this route only, so the page's height always matches its
// actual (game) content.
export default function PlayLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`
        html, body {
          background: transparent !important;
          margin: 0 !important;
          padding: 0 !important;
          min-height: 0 !important;
          height: auto !important;
        }
      `}</style>
      {children}
    </>
  );
}
