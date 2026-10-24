(() => {
  const api = window.aipet,
    art = window.PetArt;
  const poses = window.PetPoses.createController({ allowWelcome: false, allowAntics: false });
  const spriteUsage = window.SpriteUsage.create({ api });
  let snapshot,
    lastCharacter = "",
    lastState = "",
    currentView = "companion",
    sizeTimer,
    toastTimer;
  const $ = (selector) => document.querySelector(selector);
  function toast(message) {
    $("#toast").textContent = message;
    $("#toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($("#toast").hidden = true), 3000);
  }
  function view(name) {
    if (!["companion", "activity", "usage", "connections", "privacy"].includes(name))
      return;
    currentView = name;
    document
      .querySelectorAll(".view")
      .forEach((node) => (node.hidden = node.id !== `view-${name}`));
    document.querySelectorAll(".nav-item").forEach((node) => {
      node.classList.toggle("active", node.dataset.view === name);
      node.setAttribute(
        "aria-current",
        node.dataset.view === name ? "page" : "false",
      );
    });
    $("#breadcrumb").textContent = name === "usage" ? "SPRITE USAGE" : name.toUpperCase();
    spriteUsage.setVisible(name === "usage");
    window.scrollTo(0, 0);
  }
  document
    .querySelectorAll("[data-view]")
    .forEach((button) =>
      button.addEventListener("click", () => view(button.dataset.view)),
    );
  document
    .querySelectorAll("[data-goto]")
    .forEach((button) =>
      button.addEventListener("click", () => view(button.dataset.goto)),
    );
  async function update(patch) {
    try {
      render(await api.updateSettings(patch));
    } catch {
      toast("That preference could not be saved.");
    }
  }
  function buildCharacters(characters) {
    const target = $("#character-picker");
    for (const [index, character] of characters.entries()) {
      const button = document.createElement("button");
      button.className = "character-card";
      button.dataset.character = character.id;
      button.innerHTML =
        '<span class="character-number">0' +
        (index + 1) +
        '</span><span class="selected-check">✓</span><img draggable="false"><strong></strong><small></small>';
      const name = character.id === "gpt" ? "ChatGPT" : character.name;
      const img = button.querySelector("img");
      art.setImage(img, character, "idle");
      img.alt = `${name} companion`;
      button.querySelector("strong").textContent = name;
      button.querySelector("small").textContent =
        character.provider === "claude"
          ? "THE THOUGHTFUL ONE"
          : "THE CURIOUS ONE";
      button.setAttribute("aria-label", `Choose ${name}`);
      button.addEventListener("click", () => {
        update({ character: character.id, followActivity: false });
        toast(`${name} is keeping you company. Auto-follow paused.`);
      });
      target.append(button);
    }
  }
  for (const state of [
    "idle",
    "thinking",
    "reading",
    "coding",
    "tool",
    "waiting",
    "success",
    "error",
    "sleeping",
  ]) {
    const button = document.createElement("button");
    button.className = "state-button";
    button.dataset.state = state;
    const mark = document.createElement("span");
    mark.textContent = art.states[state].mark;
    button.append(mark, document.createTextNode(art.states[state].short));
    button.addEventListener("click", async () => {
      try {
        render(await api.preview(state));
      } catch {
        toast("Preview unavailable.");
      }
    });
    $("#state-grid").append(button);
  }
  function render(value) {
    if (!snapshot) buildCharacters(value.characters);
    snapshot = value;
    const character =
      value.characters.find((c) => c.id === value.activity.character) ||
      value.characters[0];
    const name = character.id === "gpt" ? "ChatGPT" : character.name;
    const state = value.activity.state,
      meta = art.states[state] || art.states.idle;
    const selected = poses.update(value.activity.provider || character.provider, character, state, { reducedMotion: value.settings.reducedMotion });
    document.body.classList.toggle(
      "reduced-motion",
      value.settings.reducedMotion,
    );
    for (const stageId of ["hero", "lab"]) {
      const stage = $(`#${stageId}-stage`);
      stage.dataset.state = state;
      art.setImage($(`#${stageId}-art`), character, state, selected.path);
      if (state !== lastState)
        $(`#${stageId}-effects`).innerHTML = art.effectMarkup(state);
    }
    if (character.id !== lastCharacter) {
      $("#character-tagline").innerHTML =
        character.id === "claude"
          ? "A quiet presence.<br>A curious mind."
          : "A spark of wonder.<br>A world of ideas.";
      lastCharacter = character.id;
    }
    lastState = state;
    $("#preview-name").textContent = name.toUpperCase();
    $("#preview-mode").textContent = value.activity.preview
      ? "ANIMATION PREVIEW"
      : "LIVE COMPANION";
    $("#hero-state").textContent = meta.label;
    $("#hero-caption").textContent =
      state === "idle"
        ? "Right here, while you make your next thing."
        : meta.line;
    $("#lab-name").textContent = name;
    $("#lab-state").textContent = meta.label;
    $("#lab-line").textContent = meta.line;
    $("#lab-badge").textContent = value.activity.preview ? "PREVIEW" : "LIVE";
    document.querySelectorAll(".character-card").forEach((button) => {
      const selected = button.dataset.character === character.id;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    document
      .querySelectorAll("[data-setting]")
      .forEach(
        (input) => (input.checked = value.settings[input.dataset.setting]),
      );
    if (document.activeElement !== $("#pet-size")) {
      $("#pet-size").value = value.settings.size;
      $("#size-value").textContent = `${value.settings.size}%`;
    }
    $("#visibility").textContent = value.hidden
      ? "Show desktop pet ↗"
      : value.companions?.length === 2
        ? "Hide both companions ↗"
        : "Hide desktop pet ↗";
    $("#show-both").disabled = !value.settings.followActivity;
    $("#show-both-status").textContent = !value.settings.followActivity
      ? "Enable Follow my AI to show both when both apps are open."
      : value.companions?.length === 2
        ? "Claude and ChatGPT are keeping you company together."
        : "Side by side when Claude Code and Codex are both open.";
    $("#resume-auto").hidden = value.visibility?.mode === "auto";
    $("#startup").checked = value.startup?.registered === true;
    $("#startup").disabled = value.startup?.registered === null;
    $("#startup-status").textContent =
      value.startup?.error ||
      (value.startup?.status === "blocked"
        ? "Disabled in Windows Startup Apps. Re-enable there to start at sign-in."
        : value.startup?.status === "different-launch"
          ? "Registered for another Aipet location. Toggle to use this copy."
          : value.startup?.status === "approval-unknown"
            ? "Registered; check Windows Startup Apps to confirm it is enabled."
            : value.startup?.enabled
              ? "Enabled · launches quietly in the tray at Windows sign-in."
              : "Start quietly in the tray. Quit any time from its menu.");
    $("#dormant-status").textContent =
      value.visibility?.reason === "hidden"
        ? "Manually hidden. Resume automatic wake/sleep from the tray."
        : value.visibility?.reason === "dormant"
          ? "Waiting in tray. No pet window or animation renderer is loaded."
          : "Wake for Claude or Codex; return after a short grace period when they close.";
    $("#data-directory").textContent = value.dataDirectory;
    $("#foreground-status").textContent =
      value.foregroundStatus === "on"
        ? "Process detection is running"
        : value.foregroundStatus === "off"
          ? "Process detection is off · hook signals still work"
          : "Process detection unavailable · hook signals still work";
    document.querySelectorAll(".state-button").forEach((button) => {
      const selected = button.dataset.state === state;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    for (const provider of ["claude", "codex"]) {
      const seen = value.activity.sessions.some(
        (item) => item.provider === provider,
      );
      const node = $(`#${provider}-connected`);
      node.textContent = seen ? "Signal received" : "No recent signal";
      node.classList.toggle("seen", seen);
    }
    $("#session-count").textContent = value.activity.sessions.length
      ? `${value.activity.sessions.length} RECENT SIGNAL${value.activity.sessions.length === 1 ? "" : "S"}`
      : "NO SIGNALS YET";
    const list = $("#session-list");
    list.replaceChildren();
    if (!value.activity.sessions.length)
      list.textContent =
        "Connect Claude Code or Codex to see live activity here.";
    for (const event of value.activity.sessions.slice(0, 6)) {
      const row = document.createElement("div");
      row.className = "session-item";
      const label = document.createElement("span"),
        time = document.createElement("span");
      label.textContent = `${event.provider === "claude" ? "Claude Code" : "Codex"} · ${(art.states[event.state] || art.states.idle).short}`;
      time.textContent = new Date(event.at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      row.append(label, time);
      list.append(row);
    }
  }
  document
    .querySelectorAll("[data-setting]")
    .forEach((input) =>
      input.addEventListener("change", () =>
        update({ [input.dataset.setting]: input.checked }),
      ),
    );
  $("#pet-size").addEventListener("input", (event) => {
    $("#size-value").textContent = `${event.target.value}%`;
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(
      () => update({ size: Number(event.target.value) }),
      80,
    );
  });
  $("#visibility").addEventListener("click", () =>
    snapshot?.hidden ? api.showPet() : api.hidePet(),
  );
  $("#bring-home").addEventListener("click", () => {
    api.bringHome();
    toast("Your companion is back on the desktop.");
  });
  $("#resume-auto").addEventListener("click", () => {
    api.resumeAutomatic();
    toast("Automatic wake and sleep resumed.");
  });
  $("#startup").addEventListener("change", async (event) => {
    event.target.disabled = true;
    try {
      const result = await api.setStartup(event.target.checked);
      render(result);
      if (result.startup?.error) toast(result.startup.error);
    } catch {
      toast("Windows startup could not be changed.");
    } finally {
      event.target.disabled = snapshot?.startup?.registered === null;
    }
  });
  $("#pat").addEventListener("click", () => {
    api.interact("pat");
    toast("A little encouragement, delivered. ♡");
  });
  document.querySelectorAll(".setup-button").forEach((button) =>
    button.addEventListener("click", async () => {
      $("#setup-title").textContent =
        button.dataset.provider === "claude"
          ? "Connect Claude Code"
          : "Connect Codex";
      $("#setup-panel").hidden = false;
      try {
        const setup = await api.getSetup(button.dataset.provider);
        $("#setup-example").textContent = setup.example;
        $("#setup-guide").textContent = setup.guide;
      } catch {
        $("#setup-example").textContent =
          "Open docs/integrations.md and integrations/*.example.json in the application folder.";
      }
      $("#setup-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }),
  );
  $("#close-setup").addEventListener(
    "click",
    () => ($("#setup-panel").hidden = true),
  );
  api.onSnapshot(render);
  api
    .getSnapshot()
    .then(render)
    .catch(() => toast("Unable to connect to the companion. Restart Aipet."));
  setInterval(() => {
    if (
      snapshot?.activity.state === "idle" &&
      !snapshot.settings.reducedMotion
    ) {
      const character = snapshot.characters.find(
        (c) => c.id === snapshot.activity.character,
      );
      if (character)
        art.blink(
          $(currentView === "activity" ? "#lab-art" : "#hero-art"),
          character,
        );
    }
  }, 6700);
})();
