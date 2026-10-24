/* Independent presentation logic. Original CrossPet artwork is loaded unchanged. */
(() => {
  const poses = window.PetPoses.poses;
  const states = {
    idle: { label: 'Keeping you company', short: 'At ease', line: 'A little company for your next big idea.', mark: '✧' },
    thinking: { label: 'Thinking it through', short: 'Thinking', line: 'Connecting the dots…', mark: '✦' },
    reading: { label: 'Reading files', short: 'Reading', line: 'Getting to know the details.', mark: '▤' },
    coding: { label: 'Writing code', short: 'Coding', line: 'One good line at a time.', mark: '{ }' },
    tool: { label: 'Running a tool', short: 'Using tools', line: 'A little work behind the scenes.', mark: '>_' },
    success: { label: 'All done!', short: 'Complete', line: 'That’s another thing we made happen.', mark: '✓' },
    error: { label: 'A bump in the road', short: 'Needs attention', line: 'We’ll figure this one out.', mark: '!' },
    waiting: { label: 'Waiting for you', short: 'Your turn', line: 'I’ll be right here.', mark: '···' },
    sleeping: { label: 'Taking a little rest', short: 'Resting', line: 'Wake me when inspiration strikes.', mark: 'z' },
    pat: { label: 'That’s the spot', short: 'Happy', line: 'A little encouragement goes a long way.', mark: '♡' },
    poke: { label: 'Oh, hello you!', short: 'Hello', line: 'Ready when you are.', mark: '✧' },
    hum: { label: 'A quiet little tune', short: 'Humming', line: '♪ A good day to make something.', mark: '♪' },
    stretch: { label: 'Time for a stretch', short: 'Stretching', line: 'You can take a little break too.', mark: '✧' },
    yawn: { label: 'Getting a little sleepy', short: 'Sleepy', line: 'Just resting my eyes…', mark: 'z' },
    greet: { label: 'Hello again', short: 'Welcome', line: 'Good to see you. What shall we make today?', mark: '✧' },
    coaxed: { label: 'A little attention?', short: 'Feeling affectionate', line: 'A tiny break for a little company?', mark: '♡' },
    puffed: { label: 'Pouting a little', short: 'Pouting', line: 'A little company when you have a moment?', mark: '···' },
    hairplay: { label: 'Lost in a little daydream', short: 'Daydreaming', line: 'Right here, keeping you company.', mark: '✧' },
    aloof: { label: 'Looking the other way', short: 'Playing aloof', line: 'Just admiring the view over here.', mark: '···' },
    wink: { label: 'A little wink for you', short: 'Winking', line: 'You’ve got this.', mark: '✧' },
    smug: { label: 'Feeling rather pleased', short: 'Feeling smug', line: 'A little confidence goes a long way.', mark: '✦' },
    sip: { label: 'Enjoying a tiny drink', short: 'Taking a sip', line: 'A little refreshment between ideas.', mark: '♧' }
  };
  function imagePath(character, state) { return window.PetPoses.candidates(character, state)[0] || null; }
  const pending = new WeakMap(), decoded = new Map(), frames = new WeakMap();
  function applyFraming(img, character, target) {
    const prefix = '../assets/custom/';
    const frame = target?.startsWith(prefix) ? character.customFraming?.[target.slice(prefix.length)] : null;
    const valid = frame && ['x', 'y', 'width', 'height', 'canvasWidth', 'canvasHeight'].every(key => Number.isFinite(frame[key])) &&
      frame.x >= 0 && frame.y >= 0 && frame.width > 0 && frame.height > 0 && frame.canvasWidth > 0 && frame.canvasHeight > 0 &&
      frame.x + frame.width <= frame.canvasWidth && frame.y + frame.height <= frame.canvasHeight;
    if (valid) {
      // Crop only the presentation viewport. Source PNG bytes and the source
      // alpha mask stay intact, and motion can keep using the transform axis.
      img.style.objectViewBox = `inset(${frame.y / frame.canvasHeight * 100}% ${(frame.canvasWidth - frame.x - frame.width) / frame.canvasWidth * 100}% ${(frame.canvasHeight - frame.y - frame.height) / frame.canvasHeight * 100}% ${frame.x / frame.canvasWidth * 100}%)`;
      frames.set(img, frame);
    } else {
      img.style.removeProperty('object-view-box');
      frames.delete(img);
    }
  }
  function sourceGeometry(img) {
    const rect = img.getBoundingClientRect();
    const frame = frames.get(img);
    const crop = frame && frame.canvasWidth === img.naturalWidth && frame.canvasHeight === img.naturalHeight ? frame :
      { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
    const scale = Math.min(rect.width / crop.width, rect.height / crop.height);
    return { scale, left: rect.left + (rect.width - crop.width * scale) / 2 - crop.x * scale, top: rect.bottom - crop.height * scale - crop.y * scale, crop };
  }
  function preload(target) {
    if (!decoded.has(target)) {
      const image = new Image(); image.src = target;
      decoded.set(target, image.decode().catch(error => { decoded.delete(target); throw error; }));
    }
    return decoded.get(target);
  }
  function setImage(img, character, state, selected, onCommit) {
    const pool = window.PetPoses.candidates(character, state);
    const target = pool.includes(selected) ? selected : imagePath(character, state);
    img.alt = `${character.name} · ${(states[state] || states.idle).short}`;
    if (!target) { pending.delete(img); img.removeAttribute('src'); applyFraming(img, character, null); return Promise.resolve(false); }
    if (pending.get(img)?.target === target) return pending.get(img).promise;
    const request = { target, onCommit };
    pending.set(img, request);
    request.promise = preload(target).then(() => {
      if (pending.get(img) !== request || img.getAttribute('src') === target) return false;
      onCommit?.();
      applyFraming(img, character, target);
      img.src = target;
      return true;
    }).catch(async () => {
      const fallback = imagePath(character, 'idle');
      if (pending.get(img) === request && fallback && target !== fallback) {
        try {
          await preload(fallback);
          if (pending.get(img) !== request) return false;
          onCommit?.();
          applyFraming(img, character, fallback);
          img.src = fallback;
          return true;
        } catch { return false; }
      }
      return false;
    });
    return request.promise;
  }
  function blink(img, character) {
    const resting = imagePath(character, 'idle');
    const custom = character.customMode === 'replace';
    const blinkPath = custom ? character.customBlink : character.poses['idle-blink'];
    if (!resting || img.getAttribute('src') !== resting || pending.get(img)?.target !== resting || !window.PetPoses.safePath(blinkPath)) return;
    const closed = (custom ? '../assets/custom/' : '../assets/crosspet/') + blinkPath;
    preload(closed).then(() => {
      if (img.getAttribute('src') !== resting || pending.get(img)?.target !== resting) return;
      const request = pending.get(img);
      request.onCommit?.();
      applyFraming(img, character, closed);
      img.src = closed;
      setTimeout(() => { if (pending.get(img) === request && img.getAttribute('src') === closed) { request.onCommit?.(); applyFraming(img, character, resting); img.src = resting; } }, 160);
    }).catch(() => {});
  }
  function effectMarkup(state) {
    if (state === 'coding' || state === 'tool') return '<div class="mini-terminal"><div class="terminal-dots"><i></i><i></i><i></i></div><span>' + (state === 'coding' ? 'const idea = ' : '$ run ') + '<b>▌</b></span><div class="code-line"></div><div class="code-line short"></div></div>';
    if (state === 'reading') return '<div class="mini-book"><span></span><span></span><span></span><span></span></div>';
    if (state === 'thinking') return '<div class="thinking-dots"><i></i><i></i><i></i></div>';
    if (state === 'success' || state === 'pat' || state === 'coaxed' || state === 'greet') return '<span class="sparkle s1">✦</span><span class="sparkle s2">' + (['pat', 'coaxed'].includes(state) ? '♡' : '✧') + '</span><span class="sparkle s3">✧</span>';
    if (state === 'sleeping' || state === 'yawn') return '<span class="sleep-z z1">z</span><span class="sleep-z z2">z</span><span class="sleep-z z3">Z</span>';
    if (state === 'waiting') return '<div class="waiting-bubble">···</div>';
    if (state === 'error') return '<div class="error-bubble">!</div>';
    if (state === 'hum') return '<span class="sparkle s1">♪</span><span class="sparkle s2">♫</span>';
    return '';
  }
  window.PetArt = Object.freeze({ poses, states, imagePath, setImage, blink, sourceGeometry, effectMarkup, candidates: window.PetPoses.candidates });
})();
