// Draws an outline + badge on every element matching a verified finding's selector hint.
(() => {
  if (window.top !== window) return;
  chrome.runtime.sendMessage({ type: "findings", site: location.origin }, (res) => {
    if (!res?.ok || !res.data?.findings?.length) return;
    const { findings, repo } = res.data;
    const root = document.createElement("div");
    root.id = "ariada-deepscan-overlay";
    const shadow = root.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
      .box{position:absolute;pointer-events:none;outline:3px solid #1b2333;box-shadow:0 0 0 6px #ffd23f;border-radius:3px;z-index:2147483646}
      .tag{position:absolute;pointer-events:auto;font:600 12px/1.3 system-ui,sans-serif;background:#1b2333;color:#fff;padding:2px 6px;border-radius:3px;z-index:2147483647;max-width:320px;cursor:help}
      .tag:focus{outline:3px solid #ffd23f}
      .panel{position:fixed;right:12px;bottom:12px;background:#fff;color:#1b2333;border:2px solid #1b2333;border-radius:6px;padding:10px 12px;font:14px/1.4 system-ui,sans-serif;z-index:2147483647;max-width:300px}
      .panel b{display:block}
      .panel button{font:inherit;margin-top:6px}
    </style>`;
    const layer = document.createElement("div");
    shadow.append(layer);
    let shown = 0;
    const draw = () => {
      layer.replaceChildren();
      shown = 0;
      for (const f of findings) {
        let els = [];
        try { els = [...document.querySelectorAll(f.selectorHint)].slice(0, 5); } catch { continue; }
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (!r.width && !r.height) continue;
          shown++;
          const box = document.createElement("div");
          box.className = "box";
          Object.assign(box.style, { left: `${r.left + scrollX}px`, top: `${r.top + scrollY}px`, width: `${r.width}px`, height: `${r.height}px` });
          const tag = document.createElement("a");
          tag.className = "tag";
          tag.href = f.url; tag.target = "_blank"; tag.rel = "noopener";
          tag.textContent = `WCAG ${f.sc} · ${f.severity}`;
          tag.title = `${f.message}\n${f.path}:${f.line}`;
          Object.assign(tag.style, { left: `${r.left + scrollX}px`, top: `${Math.max(0, r.top + scrollY - 22)}px` });
          layer.append(box, tag);
        }
      }
    };
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.setAttribute("role", "status");
    const hide = document.createElement("button");
    hide.textContent = "Hide overlay";
    hide.onclick = () => root.remove();
    draw();
    panel.append(Object.assign(document.createElement("b"), { textContent: "Ariada DeepScan" }), document.createTextNode(`${findings.length} verified issue(s) from ${repo}; ${shown} located on this page.`), document.createElement("br"), hide);
    shadow.append(panel);
    document.documentElement.append(root);
    let t; addEventListener("resize", () => { clearTimeout(t); t = setTimeout(draw, 150); });
  });
})();
