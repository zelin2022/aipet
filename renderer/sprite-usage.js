(() => {
  function create({ api }) {
    const $ = (selector) => document.querySelector(selector);
    const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
    const characterNames = { claude: "Claude", gpt: "ChatGPT" };
    const stateNames = {
      idle: "Resting", thinking: "Thinking", reading: "Reading", coding: "Coding",
      tool: "Running tools", success: "Celebrating", error: "Error", waiting: "Waiting",
      sleeping: "Sleeping", pat: "Petting", poke: "Surprised", hum: "Humming",
      stretch: "Stretching", yawn: "Yawning", greet: "Greeting", coaxed: "Coaxing",
      puffed: "Pouting", hairplay: "Playing with hair", aloof: "Looking away",
      wink: "Winking", smug: "Smug", sip: "Having a drink", "idle-blink": "Blink",
    };
    let visible = false;
    let timer;
    let data;
    let busy = false;
    let resetBusy = false;

    function duration(value) {
      const seconds = Math.max(0, Math.floor((Number(value) || 0) / 1000));
      if (!seconds) return Number(value) > 0 ? "<1s" : "0s";
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ${minutes % 60}m`;
      return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    }

    function percentage(value) {
      const fraction = Math.min(1, Math.max(0, Number(value) || 0));
      if (!fraction) return "0%";
      if (fraction < 0.001) return "<0.1%";
      return `${(fraction * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    }

    function dateLabel(value) {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return "—";
      return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    }

    function showError(message) {
      $("#usage-error").textContent = message;
      $("#usage-error").hidden = !message;
    }

    function selectedCharacters() {
      const value = $("#usage-character").value;
      return value === "all" ? ["claude", "gpt"] : [value];
    }

    function safeSource(value) {
      return typeof value === "string" && /^\.\.\/assets\/(?:crosspet|custom)\/[a-zA-Z0-9_./-]+\.(?:png|webp)$/.test(value) && !value.slice(3).includes("..") ? value : "";
    }

    function badge(text, className = "") {
      const node = document.createElement("span");
      node.className = `usage-tag ${className}`.trim();
      node.textContent = text;
      return node;
    }

    function buildRow(row) {
      const tr = document.createElement("tr");
      tr.dataset.spriteId = row.id;
      if (row.eligible && row.count === 0) tr.className = "usage-zero";
      const spriteCell = document.createElement("td");
      const sprite = document.createElement("div");
      sprite.className = "usage-sprite";
      const img = document.createElement("img");
      img.className = "usage-thumbnail";
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      const src = safeSource(row.url);
      if (src) img.src = src;
      const copy = document.createElement("div");
      copy.className = "usage-sprite-copy";
      const name = document.createElement("strong");
      name.className = "usage-sprite-name";
      name.textContent = row.name;
      name.title = row.id;
      const states = document.createElement("span");
      states.className = "usage-sprite-states";
      states.textContent = row.states.length ? row.states.map((state) => stateNames[state] || state.replaceAll("-", " ")).join(" · ") : "Outside current state pools";
      const tags = document.createElement("div");
      tags.className = "usage-tags";
      if (!row.eligible) tags.append(badge("Outside rotation"));
      if (row.blink) tags.append(badge("Blink"));
      if (row.eligible && row.count === 0) tags.append(badge("Never displayed", "usage-tag-zero"));
      copy.append(name, states);
      if (tags.childElementCount) copy.append(tags);
      sprite.append(img, copy);
      spriteCell.append(sprite);
      const character = document.createElement("td");
      const dot = document.createElement("span");
      dot.className = `usage-character-dot ${row.character}`;
      dot.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "usage-character-name";
      label.textContent = characterNames[row.character];
      character.append(dot, label);
      const count = document.createElement("td");
      count.className = "usage-number usage-count";
      count.textContent = number.format(row.count);
      const time = document.createElement("td");
      time.className = "usage-number";
      time.textContent = duration(row.visibleMs);
      time.title = `${Number((row.visibleMs / 1000).toFixed(3)).toLocaleString()} seconds`;
      const share = document.createElement("td");
      share.className = "usage-number";
      const shareContent = document.createElement("div");
      shareContent.className = "usage-share";
      const track = document.createElement("span");
      track.className = "usage-share-track";
      track.setAttribute("aria-hidden", "true");
      const fill = document.createElement("span");
      fill.className = "usage-share-fill";
      fill.style.display = "block";
      fill.style.width = `${Math.min(100, Math.max(0, row.timeShare * 100))}%`;
      track.append(fill);
      const shareText = document.createElement("span");
      shareText.textContent = percentage(row.timeShare);
      shareContent.append(track, shareText);
      share.append(shareContent);
      share.title = `Share of ${characterNames[row.character]}'s recorded visible time`;
      tr.append(spriteCell, character, count, time, share);
      return tr;
    }

    function render() {
      if (!data) return;
      const characters = selectedCharacters();
      const relevant = data.rows.filter((row) => characters.includes(row.character));
      const totals = characters.reduce((sum, character) => ({
        count: sum.count + (data.characters[character]?.count || 0),
        visibleMs: sum.visibleMs + (data.characters[character]?.visibleMs || 0),
      }), { count: 0, visibleMs: 0 });
      $("#usage-total-count").textContent = number.format(totals.count);
      $("#usage-total-time").textContent = duration(totals.visibleMs);
      $("#usage-zero-count").textContent = number.format(relevant.filter((row) => row.eligible && row.count === 0).length);
      const rows = relevant.filter((row) => $("#usage-scope").value === "all" || row.eligible);
      const order = $("#usage-sort").value;
      const field = order === "count" || order === "most-count" ? "count" : order === "share" ? "timeShare" : "visibleMs";
      const direction = order.startsWith("most-") ? -1 : 1;
      rows.sort((a, b) => direction * (a[field] - b[field]) || a.count - b.count || a.visibleMs - b.visibleMs || a.character.localeCompare(b.character) || a.name.localeCompare(b.name));
      const fragment = document.createDocumentFragment();
      for (const row of rows) fragment.append(buildRow(row));
      if (!rows.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 5;
        td.className = "usage-empty";
        td.textContent = "No sprites match this view.";
        tr.append(td);
        fragment.append(tr);
      }
      $("#usage-rows").replaceChildren(fragment);
      $("#usage-result-count").textContent = `${number.format(rows.length)} sprite${rows.length === 1 ? "" : "s"}`;
      $("#usage-since").textContent = `Collecting since ${dateLabel(data.startedAt)}`;
      $("#usage-updated").textContent = `Updated ${dateLabel(data.updatedAt)} · refreshes every 5s`;
      if (data.storage === "unavailable") showError("Counters are available for this run, but could not be saved to disk. They may be lost when Aipet closes.");
      else showError("");
    }

    async function refresh() {
      if (busy || resetBusy) return;
      if (typeof api?.getSpriteUsage !== "function") {
        showError("Sprite counters are unavailable in this copy. Restart Aipet after updating the application.");
        $("#usage-result-count").textContent = "Unavailable";
        return;
      }
      busy = true;
      $("#usage-refresh").disabled = true;
      $("#usage-reset-confirm-button").disabled = true;
      $("#usage-table-region").setAttribute("aria-busy", "true");
      try {
        const value = await api.getSpriteUsage();
        if (!value || !Array.isArray(value.rows) || !value.characters) throw new Error("Invalid counter response");
        data = value;
        if (visible && !document.hidden) render();
      } catch {
        showError("Sprite counters could not be loaded. Your existing counters have not been reset. Try Refresh.");
        if (!data) $("#usage-result-count").textContent = "Could not load";
      } finally {
        busy = false;
        $("#usage-refresh").disabled = false;
        $("#usage-reset-confirm-button").disabled = false;
        $("#usage-table-region").setAttribute("aria-busy", "false");
      }
    }

    function schedule() {
      clearInterval(timer);
      timer = undefined;
      if (visible && !document.hidden) {
        refresh();
        timer = setInterval(refresh, 5000);
      }
    }

    function setVisible(value) {
      visible = Boolean(value);
      if (!visible) $("#usage-reset-confirm").hidden = true;
      schedule();
    }

    for (const id of ["#usage-character", "#usage-scope", "#usage-sort"]) $(id).addEventListener("change", render);
    $("#usage-refresh").addEventListener("click", refresh);
    $("#usage-reset-open").addEventListener("click", () => {
      $("#usage-reset-confirm").hidden = false;
      $("#usage-reset-cancel").focus();
      $("#usage-reset-confirm").scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    $("#usage-reset-cancel").addEventListener("click", () => {
      $("#usage-reset-confirm").hidden = true;
      $("#usage-reset-open").focus();
    });
    $("#usage-reset-confirm-button").addEventListener("click", async () => {
      if (busy || resetBusy) return;
      resetBusy = true;
      const buttons = [$("#usage-reset-confirm-button"), $("#usage-reset-cancel"), $("#usage-refresh")];
      buttons.forEach((button) => { button.disabled = true; });
      try {
        if (typeof api?.resetSpriteUsage !== "function") throw new Error("Unavailable");
        const value = await api.resetSpriteUsage();
        if (!value || !Array.isArray(value.rows) || !value.characters) throw new Error("Invalid counter response");
        data = value;
        render();
        $("#usage-reset-confirm").hidden = true;
        $("#usage-reset-open").focus();
      } catch {
        showError("The sprite counters could not be reset. Try again when Aipet is available.");
      } finally {
        resetBusy = false;
        buttons.forEach((button) => { button.disabled = false; });
      }
    });
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("pagehide", () => clearInterval(timer));
    return Object.freeze({ setVisible });
  }

  window.SpriteUsage = Object.freeze({ create });
})();
