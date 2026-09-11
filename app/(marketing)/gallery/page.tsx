// app/(marketing)/gallery/page.tsx
//
// Public gallery of generated games — build spec marks this Phase 3 /
// post-MVP. A simple placeholder is intentional; not over-building here.

export default function GalleryPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-3xl font-semibold">Gallery</h1>
      <p className="max-w-md text-ink/60">
        A public showcase of games built with PlayLoop is coming soon. For now,
        head back and build your own.
      </p>
      <a href="/" className="mt-4 text-sm underline">
        Back to PlayLoop
      </a>
    </main>
  );
}
