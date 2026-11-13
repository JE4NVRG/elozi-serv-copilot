// Audit page: reads the JSONL decision log and renders one card per decision.
// No inline script, no external requests; text is inserted with textContent only.
(function () {
  var all = [];
  var rows = document.getElementById("rows");
  var stats = document.getElementById("stats");
  var filter = document.getElementById("filter");

  function parse(text) {
    return text.split(/\r?\n/).filter(Boolean).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function renderStats(list) {
    stats.textContent = "";
    var c = { draft: 0, handoff: 0, none: 0, error: 0 }, tok = 0, cost = 0;
    list.forEach(function (r) {
      c[r.action] = (c[r.action] || 0) + 1;
      if (r.usage) tok += r.usage.total_tokens || 0;
      if (r.cost_usd) cost += r.cost_usd;
    });
    var models = Array.from(new Set(list.map(function (r) { return r.model; }))).join(", ");
    [["decisions", list.length], ["drafts", c.draft], ["handoffs", c.handoff], ["no action", c.none], ["errors", c.error],
     ["tokens", tok], ["est. cost (USD)", cost.toFixed(4)], ["model", models || "-"]].forEach(function (s) {
      var d = el("div", "stat"); d.appendChild(el("b", null, s[1])); d.appendChild(document.createTextNode(s[0])); stats.appendChild(d);
    });
  }

  function render() {
    var f = filter.value;
    var list = all.filter(function (r) { return !f || r.action === f; });
    rows.textContent = "";
    renderStats(all);
    list.forEach(function (r) {
      var card = el("article", "card " + r.action);
      var top = el("div", "top");
      top.appendChild(el("span", "badge " + r.action, r.action));
      top.appendChild(el("strong", null, r.conversation_id));
      top.appendChild(el("span", "meta", r.category + " · conf " + r.confidence + " · " + r.channel));
      top.appendChild(el("span", "meta", r.provider + " / " + r.model + (r.endpoint ? " · " + r.endpoint : "") + " · " + r.executed + (r.usage ? " · " + r.usage.total_tokens + " tok" : "") + (r.cost_usd != null ? " · $" + r.cost_usd : "")));
      card.appendChild(top);
      if (r.error) card.appendChild(el("div", "why", "Error: " + r.error));
      else card.appendChild(el("div", "why", r.rationale));
      if (r.reasoning_summary) card.appendChild(el("div", "reasoning", (r.provider === "serv-reasoning" ? "SERV Reasoning summary: " : "Offline rules (not SERV): ") + r.reasoning_summary));
      if (r.guard_override) card.appendChild(el("div", "guard", "Safety guard override: " + r.guard_override));
      if (r.tool && r.tool_args_preview) {
        var a = r.tool_args_preview;
        card.appendChild(el("div", "payload", r.tool + "\n" + (a.text || a.reason || "")));
      }
      if (r.tool_response) {
        var t = r.tool_response;
        card.appendChild(el("div", "guard", "Elozi: " + t.capability + " → " + t.result_kind + " " + t.result_state + " (receipt " + t.receipt_state + ")"));
      }
      if (r.post_check && r.post_check.conversation) {
        var pc = r.post_check.conversation;
        card.appendChild(el("div", "meta", "Read-back: conversation " + pc.status + " / " + pc.owner + " · v" + pc.version + " · agent messages sent: " + pc.agent_messages));
      }
      card.appendChild(el("div", "meta", r.ts + (r.response_id ? " · " + r.response_id : "") + (r.elozi_receipt ? " · receipt " + r.elozi_receipt : "")));
      rows.appendChild(card);
    });
  }

  filter.addEventListener("change", render);
  document.getElementById("file").addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    file.text().then(function (t) { all = parse(t); render(); });
  });
  fetch("decisions.jsonl").then(function (r) { return r.ok ? r.text() : ""; }).then(function (t) {
    if (t) { all = parse(t); render(); }
  }).catch(function () { /* file:// — use the file picker */ });
})();
