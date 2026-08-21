const compactPanelCss = `
<style id="seiseki-panel-size-adjustment">
  .details {
    width:min(292px,calc(100% - 40px)) !important;
    min-height:92px !important;
    max-height:min(210px,calc(100vh - 190px)) !important;
    padding:10px 12px !important;
  }
  .details h2 { margin-bottom:5px !important; font-size:12px !important; }
  .details p { font-size:10px !important; line-height:1.55 !important; }
  .details .generated { font-size:11px !important; }
  .details .result { margin-top:6px !important; font-size:9px !important; line-height:1.45 !important; }
  .details dl {
    grid-template-columns:64px 1fr !important;
    gap:3px 7px !important;
    margin-top:8px !important;
    font-size:10px !important;
  }
  .trace {
    width:min(390px,calc(100% - 350px)) !important;
    height:min(40vh,360px) !important;
    max-height:calc(100vh - 260px) !important;
    font-size:9px !important;
    line-height:1.45 !important;
  }
  .trace header {
    justify-content:flex-start !important;
    margin-bottom:5px !important;
  }
  .trace header span:last-child {
    display:none !important;
  }
  @media (max-width:700px) {
    .details {
      width:calc(100% - 22px) !important;
      min-height:92px !important;
      max-height:118px !important;
    }
    .trace {
      width:calc(100% - 22px) !important;
      height:min(32vh,250px) !important;
      max-height:min(32vh,250px) !important;
    }
  }
</style>`;

class PanelSizeInjector {
  element(element) {
    element.append(compactPanelCss, { html: true });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let assetRequest = request;
    if (url.pathname === "/") {
      url.pathname = "/chunk-network-entanglement-preview.html";
      assetRequest = new Request(url.toString(), request);
    }

    const response = await env.ASSETS.fetch(assetRequest);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return response;

    return new HTMLRewriter()
      .on("head", new PanelSizeInjector())
      .transform(response);
  },
};
