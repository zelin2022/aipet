(() => {
  const api = window.aipet, art = window.PetArt;
  const poses = window.PetPoses.createController();
  const scene = document.querySelector('#pet-scene');
  const slots = [];
  const providerRecords = new Map();
  let snapshot, dragging = false, down = null, lastHit = false;

  function createSlot(index) {
    const element = index === 0 ? document.querySelector('.companion-slot') : slots[0].element.cloneNode(true);
    if (index > 0) {
      for (const node of element.querySelectorAll('[id]')) node.id = `secondary-${node.id}`;
      element.id = 'companion-secondary';
      element.classList.remove('speaking');
      scene.append(element);
    }
    const slot = {
      element, stage: element.querySelector('.art-stage'), img: element.querySelector('.character-art'),
      effects: element.querySelector('.effects'), status: element.querySelector('.status'),
      name: element.querySelector('.companion-name'), state: element.querySelector('.companion-state'),
      speech: element.querySelector('.speech'), provider: null, activity: null, character: null,
      renderedImage: null, renderedState: null, mask: null, speechTimer: null,
      nextBlink: Date.now() + 5800 + Math.random() * 1800
    };
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    slot.img.addEventListener('load', () => {
      canvas.width = slot.img.naturalWidth; canvas.height = slot.img.naturalHeight;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(slot.img, 0, 0);
      slot.mask = context.getImageData(0, 0, canvas.width, canvas.height);
      reportUsage();
    });
    slot.img.addEventListener('error', () => { slot.mask = null; reportUsage(); });
    slot.status.addEventListener('click', () => api.openStudio());
    slots.push(slot);
    return slot;
  }

  function render(value) {
    snapshot = value;
    const companions = Array.isArray(value.companions) && value.companions.length ? value.companions.slice(0, 2) : [value.activity];
    const present = new Set(companions.map(activity => activity.provider || (activity.character === 'gpt' ? 'codex' : 'claude')));
    // A provider may move to another slot when its neighbour leaves. Reconcile
    // presence by provider once, so the retired slot cannot hide the live one.
    for (const [provider, previous] of providerRecords) if (!present.has(provider)) {
      poses.update(provider, previous.character, previous.activity.state, { visible: false });
      providerRecords.delete(provider);
    }
    while (slots.length < companions.length) createSlot(slots.length);
    scene.style.setProperty('--companion-count', companions.length);
    scene.dataset.companions = companions.length;
    scene.setAttribute('aria-label', companions.length > 1 ? 'Claude and ChatGPT companions' : 'Desktop companion');
    let allResting = true;
    slots.forEach((slot, index) => {
      const activity = companions[index];
      slot.element.hidden = !activity;
      if (!activity) return;
      const character = value.characters.find(candidate => candidate.id === activity.character) || value.characters[0];
      const provider = activity.provider || (character.id === 'gpt' ? 'codex' : 'claude');
      if (slot.provider !== provider) {
        slot.element.classList.remove('speaking');
        clearTimeout(slot.speechTimer);
      }
      slot.provider = provider; slot.activity = activity; slot.character = character;
      providerRecords.set(provider, { character, activity });
      const activityAt = (Array.isArray(activity.sessions) ? activity.sessions : []).filter(session => session.provider === provider && typeof session.at === 'string').reduce((latest, session) => session.at > latest ? session.at : latest, '');
      const selected = poses.update(provider, character, activity.state, { visible: !value.hidden, reducedMotion: value.settings.reducedMotion, activityAt });
      const state = selected.state;
      const meta = art.states[state] || art.states.idle;
      const hasProviderSignal = Array.isArray(activity.sessions) && activity.sessions.some(session => session.provider === provider);
      const missingSignal = ['idle', 'sleeping'].includes(state) && !activity.preview && value.visibility?.providers?.includes(provider) && !hasProviderSignal;
      const short = missingSignal ? 'No signal' : meta.short;
      const label = activity.preview ? `${short} · preview` : short;
      const line = missingSignal ? 'I can see the app, but I’m waiting for an activity signal.' : meta.line;
      const key = `${character.id}:${state}:${selected.path}`;
      if (key !== slot.renderedImage) {
        art.setImage(slot.img, character, state, selected.path, () => { slot.mask = null; }); slot.renderedImage = key;
      }
      if (state !== slot.renderedState) { slot.effects.innerHTML = art.effectMarkup(state); slot.renderedState = state; }
      const name = character.name === 'GPT' ? 'ChatGPT' : character.name;
      slot.stage.dataset.state = state;
      slot.element.dataset.state = state;
      slot.element.dataset.provider = provider;
      slot.element.classList.toggle('missing-signal', Boolean(missingSignal));
      slot.element.setAttribute('aria-label', `${name}: ${missingSignal ? short : meta.label}${activity.preview ? ' · preview' : ''}`);
      slot.img.alt = `${name} · ${label}`;
      slot.name.textContent = name;
      slot.state.textContent = label;
      slot.speech.textContent = line;
      slot.status.setAttribute('aria-label', `Open companion studio · ${name} · ${label}`);
      allResting &&= ['idle', 'sleeping'].includes(state);
    });
    // Keep the primary state available for existing single-companion integrations.
    document.body.dataset.state = slots[0].element.dataset.state;
    document.body.classList.toggle('speaking', slots.some(slot => !slot.element.hidden && slot.element.classList.contains('speaking')));
    document.body.classList.toggle('reduced-motion', value.settings.reducedMotion);
    document.body.classList.toggle('docked-left', value.dockSide === 'left' && allResting);
    document.body.classList.toggle('docked-right', value.dockSide === 'right' && allResting);
    reportUsage();
  }

  // Report loaded source images, never requested poses or elapsed renderer time.
  // Only this pet renderer reports; studio thumbnails and previews are excluded.
  let usagePending = false, usageAgain = false, usageSignature = null, usageReportedAt = 0;
  function reportUsage() {
    if (!snapshot || typeof api.reportSpriteUsage !== 'function') return;
    if (usagePending) { usageAgain = true; return; }
    const items = [];
    if (!snapshot.hidden && !document.hidden) for (const slot of slots) {
      if (slot.element.hidden || slot.activity?.preview || !slot.img.complete || !slot.img.naturalWidth) continue;
      const source = slot.img.getAttribute('src');
      if (!source?.startsWith('../assets/')) continue;
      const sprite = source.slice('../assets/'.length);
      if (!new RegExp('^(?:crosspet/characters|custom)/' + slot.character.id + '/[a-zA-Z0-9_-]+\\.(?:png|webp)$').test(sprite)) continue;
      items.push({ provider: slot.provider, sprite });
    }
    const signature = JSON.stringify(items), now = performance.now();
    if (signature === usageSignature && now - usageReportedAt < 950) return;
    usageSignature = signature; usageReportedAt = now;
    usagePending = true;
    api.reportSpriteUsage(items).catch(() => {}).finally(() => {
      usagePending = false;
      if (usageAgain) { usageAgain = false; reportUsage(); }
    });
  }
  setInterval(reportUsage, 1000);
  document.addEventListener('visibilitychange', reportUsage);

  function speak(slot) {
    slot.element.classList.add('speaking');
    document.body.classList.add('speaking');
    clearTimeout(slot.speechTimer);
    slot.speechTimer = setTimeout(() => {
      slot.element.classList.remove('speaking');
      document.body.classList.toggle('speaking', slots.some(candidate => !candidate.element.hidden && candidate.element.classList.contains('speaking')));
    }, 3300);
  }

  function hitSlot(event) {
    for (const slot of slots) {
      if (slot.element.hidden) continue;
      if (event.target.closest('button') === slot.status) return slot;
      if (!slot.mask) continue;
      // Object-fit:contain leaves margins; test each source alpha, not its box.
      const mask = slot.mask;
      const { scale, left, top, crop } = art.sourceGeometry(slot.img);
      if (!(scale > 0)) continue;
      const x = Math.floor((event.clientX - left) / scale), y = Math.floor((event.clientY - top) / scale);
      if (x >= crop.x && y >= crop.y && x < crop.x + crop.width && y < crop.y + crop.height && x < mask.width && y < mask.height && mask.data[(y * mask.width + x) * 4 + 3] > 24) return slot;
    }
    return null;
  }

  window.addEventListener('pointermove', event => {
    if (down && !dragging && Math.hypot(event.screenX - down.x, event.screenY - down.y) > 5) { dragging = true; document.body.classList.add('dragging'); api.drag('start'); }
    const hit = dragging || Boolean(hitSlot(event));
    if (hit !== lastHit) { lastHit = hit; api.setHit(hit); }
  });
  window.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const slot = hitSlot(event);
    if (!slot) return;
    down = { x: event.screenX, y: event.screenY, provider: slot.provider, pointerId: event.pointerId, stage: slot.stage };
    slot.stage.setPointerCapture(event.pointerId);
  });
  function release() {
    if (!down) return;
    const previous = down;
    if (dragging) { api.drag('end'); document.body.classList.remove('dragging'); }
    else api.interact('pat', previous.provider);
    down = null; dragging = false;
    if (previous.stage.hasPointerCapture(previous.pointerId)) previous.stage.releasePointerCapture(previous.pointerId);
  }
  window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release);
  window.addEventListener('blur', () => { if (dragging) release(); });
  window.addEventListener('mouseleave', () => { if (!dragging) { lastHit = false; api.setHit(false); } });
  window.addEventListener('contextmenu', event => { event.preventDefault(); api.menu(hitSlot(event)?.provider); });
  window.addEventListener('keydown', event => { if (event.key === 'Escape') api.hidePet(); });

  createSlot(0);
  api.onInteraction(value => {
    const action = typeof value === 'string' ? value : value?.action;
    if (!['pat', 'poke'].includes(action)) return;
    const provider = typeof value === 'string' ? slots[0].provider : value.provider;
    const slot = slots.find(candidate => !candidate.element.hidden && candidate.provider === provider) || (!provider ? slots[0] : null);
    if (!slot) return;
    poses.interact(slot.provider, action);
    if (snapshot) render(snapshot);
    speak(slot);
  });
  api.onSnapshot(render); api.getSnapshot().then(render);
  setInterval(() => {
    if (!snapshot || dragging) return;
    render(snapshot);
    for (const slot of slots) {
      if (Date.now() >= slot.nextBlink) {
        slot.nextBlink = Date.now() + 5800 + Math.random() * 1800;
        if (!slot.element.hidden && slot.renderedState === 'idle' && !snapshot.hidden && !snapshot.settings.reducedMotion) art.blink(slot.img, slot.character);
      }
    }
  }, 300);
})();
