// app/embed.js/route.ts
//
// The loader script (build spec §14 "Embed system"). What a client pastes:
//
//   <div data-playloop="slug"></div>
//   <script src="https://playloop.app/embed.js" async></script>
//
// This route serves that script as `application/javascript`, cacheable at
// the edge. The script itself:
//   - injects a sandboxed iframe pointing at /play/:slug
//   - handles the postMessage auto-height handshake (an iframe never grows
//     to fit its content on its own — build spec §23)
//   - passes the host's accent colour / font through as query params, if
//     the host element declares them via data-accent / data-font
//   - degrades silently on any failure — collapses to nothing, never a
//     broken frame, never a console error on someone else's page. Hosting
//     is a promise: if PlayLoop goes down, nothing should break on a page
//     a client owns.
//
// No browser storage anywhere in this file either (build spec §4/§14/§23).

// Runs at the edge for low-latency, CDN-friendly delivery — this route has
// no sharp/Node dependency, unlike the pipeline's engine routes.
export const runtime = "edge";

function buildLoaderScript(fallbackOrigin: string): string {
  // Kept as one self-invoking function, defensively wrapped so a failure
  // anywhere inside never throws on the host page (build spec §14: "never
  // a broken frame, never a console error on someone else's site").
  return `(function () {
  try {
    if (window.__playloopEmbedLoaded) return;
    window.__playloopEmbedLoaded = true;

    var FALLBACK_ORIGIN = ${JSON.stringify(fallbackOrigin)};
    var MAX_IFRAME_HEIGHT = 4000;

    function resolveOrigin() {
      try {
        var cs = document.currentScript;
        if (cs && cs.src) return new URL(cs.src).origin;
      } catch (e) {}
      return FALLBACK_ORIGIN;
    }
    var BASE = resolveOrigin();

    function mountOne(host) {
      try {
        if (!host || host.nodeType !== 1) return;
        if (host.getAttribute('data-playloop-mounted') === '1') return;
        var slug = host.getAttribute('data-playloop');
        if (!slug) return;
        host.setAttribute('data-playloop-mounted', '1');

        var params = new URLSearchParams();
        var accent = host.getAttribute('data-accent');
        var font = host.getAttribute('data-font');
        var placement = host.getAttribute('data-placement');
        if (accent) params.set('accent', accent);
        if (font) params.set('font', font);
        if (placement) params.set('placement', placement);
        var qs = params.toString();

        var iframe = document.createElement('iframe');
        iframe.src = BASE + '/play/' + encodeURIComponent(slug) + (qs ? '?' + qs : '');
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
        iframe.setAttribute('scrolling', 'no');
        iframe.setAttribute('frameborder', '0');
        iframe.title = 'Playable game';
        iframe.style.display = 'block';
        iframe.style.width = '100%';
        iframe.style.maxWidth = '100%';
        iframe.style.border = '0';
        iframe.style.overflow = 'hidden';
        // Zero height until the play page's first postMessage resize —
        // never a fixed height clipping on mobile or leaving dead space.
        iframe.style.height = '0px';

        function onMessage(event) {
          try {
            if (!event || !event.data || event.data.type !== 'playloop:resize') return;
            if (event.source !== iframe.contentWindow) return;
            var height = Number(event.data.height);
            if (!isFinite(height) || height <= 0) return;
            iframe.style.height = Math.min(Math.ceil(height), MAX_IFRAME_HEIGHT) + 'px';
          } catch (e) {
            // Never throw from a message handler running on the host page.
          }
        }
        window.addEventListener('message', onMessage);

        host.appendChild(iframe);
      } catch (e) {
        // Collapse silently — this one embed just never appears.
      }
    }

    function mountAll() {
      try {
        var hosts = document.querySelectorAll('[data-playloop]');
        for (var i = 0; i < hosts.length; i++) mountOne(hosts[i]);
      } catch (e) {}
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mountAll);
    } else {
      mountAll();
    }
  } catch (e) {
    // Whatever happens, this script must never throw on the host page.
  }
})();
`;
}

export async function GET(request: Request) {
  const envOrigin = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  const fallbackOrigin = envOrigin || new URL(request.url).origin;

  const script = buildLoaderScript(fallbackOrigin);

  return new Response(script, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
