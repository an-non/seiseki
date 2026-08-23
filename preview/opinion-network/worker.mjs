const MOBILE_PATCH = `
<style id="seiseki-mobile-quantum-patch">
  #scene canvas { touch-action:none; }
  @media (max-width:700px) {
    header { top:10px !important; left:12px !important; right:12px !important; }
    h1 { font-size:18px !important; line-height:1.25 !important; }
    .legend { font-size:10px !important; gap:4px 8px !important; max-width:250px !important; }
    .controls {
      top:68px !important;
      left:8px !important;
      right:8px !important;
      max-width:none !important;
      width:calc(100% - 16px) !important;
      overflow-x:auto !important;
      -webkit-overflow-scrolling:touch;
      scrollbar-width:none;
      padding:4px !important;
      gap:2px !important;
    }
    .controls::-webkit-scrollbar { display:none; }
    .controls button { min-width:46px !important; height:36px !important; padding:0 8px !important; }
    .controls .observe { min-width:38px !important; width:38px !important; }
    .provenance {
      top:114px !important;
      left:8px !important;
      right:8px !important;
      max-width:none !important;
      padding:6px 8px !important;
      font-size:9px !important;
      line-height:1.3 !important;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      pointer-events:none;
    }
    .status { display:none !important; }
    .trace { display:none !important; }
    .details {
      left:8px !important;
      right:8px !important;
      bottom:8px !important;
      width:calc(100% - 16px) !important;
      min-height:0 !important;
      max-height:74px !important;
      padding:7px 9px !important;
      overflow:hidden !important;
      border-radius:8px !important;
      pointer-events:none;
    }
    .details h2 { font-size:10px !important; margin-bottom:2px !important; }
    .details p, .details .generated { font-size:8px !important; line-height:1.3 !important; }
    .details dl { display:none !important; }
    .details .result { font-size:8px !important; margin-top:2px !important; }
  }
</style>
<script id="seiseki-mobile-quantum-tap-patch">
(() => {
  const isCoarse = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  if (!isCoarse) return;
  const bind = () => {
    const canvas = document.querySelector('#scene canvas');
    if (!canvas || canvas.dataset.seisekiTapPatch === '1') return false;
    canvas.dataset.seisekiTapPatch = '1';
    let replaying = false;
    canvas.addEventListener('click', (event) => {
      if (replaying) {
        replaying = false;
        return;
      }
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const move = new PointerEvent('pointermove', {
        bubbles:true,
        cancelable:true,
        pointerId:1,
        pointerType:'touch',
        clientX:event.clientX,
        clientY:event.clientY,
        buttons:0,
        isPrimary:true
      });
      canvas.dispatchEvent(move);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        replaying = true;
        canvas.dispatchEvent(new MouseEvent('click', {
          bubbles:true,
          cancelable:true,
          clientX:event.clientX,
          clientY:event.clientY,
          button:0
        }));
      }));
    }, true);
    return true;
  };
  if (bind()) return;
  const observer = new MutationObserver(() => {
    if (bind()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList:true, subtree:true });
})();
</script>
`;

async function previewResponse(request, env, url) {
  const assetUrl = new URL(url);
  assetUrl.pathname = "/chunk-network-entanglement-preview.html";
  const response = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  if (!response.ok) return response;
  return new HTMLRewriter()
    .on("body", {
      element(element) {
        element.append(MOBILE_PATCH, { html:true });
      },
    })
    .transform(response);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/chunk-network-entanglement-preview.html") {
      return previewResponse(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },
};
