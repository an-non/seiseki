const compactPanelCss = `
<style id="seiseki-panel-size-adjustment">
  .details {
    width:min(260px,calc(100% - 40px)) !important;
    min-height:82px !important;
    max-height:min(180px,calc(100vh - 190px)) !important;
    padding:8px 10px !important;
  }
  .details h2 { margin-bottom:4px !important; font-size:10px !important; line-height:1.35 !important; }
  .details p { font-size:8.5px !important; line-height:1.45 !important; }
  .details .generated { font-size:9px !important; line-height:1.45 !important; }
  .details .result { margin-top:5px !important; font-size:8px !important; line-height:1.38 !important; }
  .details dl {
    grid-template-columns:56px 1fr !important;
    gap:2px 6px !important;
    margin-top:6px !important;
    font-size:8.5px !important;
    line-height:1.4 !important;
  }
  .trace {
    width:min(320px,calc(100% - 300px)) !important;
    height:min(31vh,280px) !important;
    max-height:calc(100vh - 300px) !important;
    padding-right:0 !important;
    font-size:8px !important;
    line-height:1.38 !important;
  }
  .trace header {
    justify-content:flex-start !important;
    margin-bottom:4px !important;
    font-size:8px !important;
    line-height:1.35 !important;
  }
  .trace header span:last-child {
    display:none !important;
  }
  .trace pre {
    max-width:320px !important;
    padding-right:0 !important;
  }
  @media (max-width:700px) {
    .details {
      width:calc(100% - 22px) !important;
      min-height:82px !important;
      max-height:106px !important;
      padding:8px 10px !important;
    }
    .trace {
      width:calc(100% - 22px) !important;
      height:min(27vh,220px) !important;
      max-height:min(27vh,220px) !important;
      font-size:8px !important;
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
