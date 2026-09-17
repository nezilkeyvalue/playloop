// app/demo-storefront/page.tsx
//
// A small mock storefront that embeds a real game via the actual embed
// snippet, styled to sit in a "section" placement (build spec §19 MVP
// scope: "Mock storefront page to demo the embed in context"; §21 demo
// script: "paste into the mock storefront"). `npm run dev` → visit this
// page → the whole embed pipeline works end to end with zero setup,
// because /embed.js resolves "demo-catch" straight from the runtime
// fixtures (lib/runtime/fixtures/sampleGameSpec.ts) — no pipeline, no DB.

const PRODUCTS = [
  { name: "House Blend 250g", price: "$14.00", tone: "#8A5A34" },
  { name: "Single Origin Kenya", price: "$19.00", tone: "#C77B45" },
  { name: "Cold Brew Concentrate", price: "$17.00", tone: "#B4713F" },
  { name: "Seasonal Blend", price: "$18.00", tone: "#A96A3B" },
];

const EMBED_SNIPPET = `<div data-playloop="demo-catch" data-placement="section"></div>
<script src="/embed.js" async></script>`;

// A second, separate embed on the same page showing the "modal" placement —
// embed.js renders this one as a trigger BUTTON, not the game itself, and
// only builds the overlay + iframe the first time a visitor clicks it.
const MODAL_EMBED_SNIPPET = `<div data-playloop="demo-guess-price" data-placement="modal"
     data-trigger-label="Guess the price & win"></div>
<script src="/embed.js" async></script>`;

export default function DemoStorefrontPage() {
  return (
    <div className="min-h-screen bg-paper text-ink">
      {/* --- fake storefront header --- */}
      <header className="border-b border-ink/10">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <span className="text-lg font-bold tracking-tight">Bloom Coffee Co.</span>
          <nav className="hidden gap-6 text-sm text-ink/70 sm:flex">
            <span>Shop</span>
            <span>Subscriptions</span>
            <span>About</span>
            <span>Cart (0)</span>
          </nav>
        </div>
      </header>

      {/* --- fake hero --- */}
      <section className="mx-auto max-w-5xl px-6 py-12 text-center">
        <h1 className="text-3xl font-semibold sm:text-4xl">Small-batch roasted, shipped weekly.</h1>
        <p className="mx-auto mt-3 max-w-md text-ink/60">
          This is a mock storefront — every product below is a placeholder. It exists to show one
          thing: an embedded Playloop game sitting in a normal page, not a special demo harness.
        </p>
      </section>

      {/* --- fake product grid --- */}
      <section className="mx-auto max-w-5xl px-6 pb-12">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {PRODUCTS.map((p) => (
            <div key={p.name} className="rounded-xl border border-ink/10 bg-white p-3">
              <div
                className="mb-3 aspect-square rounded-lg"
                style={{ background: `linear-gradient(160deg, ${p.tone}, ${p.tone}cc)` }}
              />
              <p className="text-sm font-medium">{p.name}</p>
              <p className="text-sm text-ink/60">{p.price}</p>
            </div>
          ))}
        </div>
      </section>

      {/* --- the actual embed: this is the whole point of this page --- */}
      <section className="mx-auto max-w-5xl px-6 pb-16">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Play &amp; save</h2>
          <span className="text-xs uppercase tracking-wide text-ink/40">Powered by Playloop</span>
        </div>

        {/* This div + script pair is copy-pasted verbatim from what a
            client would paste into their own site (build spec §14). The
            loader (app/embed.js) reads `data-playloop`, injects a
            sandboxed iframe at /play/demo-catch, and auto-sizes it via
            postMessage — nothing else on this page knows the game exists. */}
        <div className="overflow-hidden rounded-2xl border border-ink/10 bg-white shadow-sm">
          <div data-playloop="demo-catch" data-placement="section" />
          <script src="/embed.js" async />
        </div>

        <details className="mt-3 text-xs text-ink/50">
          <summary className="cursor-pointer select-none">View embed code</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-ink/5 p-3 text-[11px] leading-relaxed text-ink/70">
            {EMBED_SNIPPET}
          </pre>
        </details>
      </section>

      {/* --- second embed: same loader script, "modal" placement --------
          embed.js turns this host div into a trigger button and only
          builds the overlay + game iframe on the first click — nothing
          about this section's markup differs except data-placement. */}
      <section className="mx-auto max-w-5xl px-6 pb-16">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Or trigger it from a button</h2>
          <span className="text-xs uppercase tracking-wide text-ink/40">Modal placement</span>
        </div>
        <div className="rounded-2xl border border-dashed border-ink/15 bg-white/60 p-8 text-center">
          <div data-playloop="demo-guess-price" data-placement="modal" data-trigger-label="Guess the price & win" />
          <script src="/embed.js" async />
        </div>
        <details className="mt-3 text-xs text-ink/50">
          <summary className="cursor-pointer select-none">View embed code</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-ink/5 p-3 text-[11px] leading-relaxed text-ink/70">
            {MODAL_EMBED_SNIPPET}
          </pre>
        </details>
      </section>

      <footer className="border-t border-ink/10 py-8 text-center text-xs text-ink/40">
        Mock storefront for demo purposes only — Playloop build spec §19/§21.
      </footer>
    </div>
  );
}
