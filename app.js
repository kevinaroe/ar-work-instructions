/* ============================================================
 * AR Work Instructions
 *
 * A zero-dependency step-by-step work-instruction player.
 *
 * It runs three ways from one codebase:
 *   1. Immersive AR  - WebXR `immersive-ar` with a DOM Overlay, so this
 *                      exact HTML floats over passthrough in the headset.
 *   2. Handheld AR   - same thing on an ARCore phone/tablet in Chrome.
 *   3. Plain 2D      - anywhere else. Same content, normal web page.
 *
 * There is no 3D scene. The WebGL context exists only because a WebXR
 * session requires a base layer; we clear it fully transparent every
 * frame so the passthrough camera shows through untouched. That keeps
 * the whole app dependency-free and readable by a shop instructor.
 * ============================================================ */

'use strict';

const CONTENT_URL = 'content/dogtag-h2d.json';
const STORE_KEY = 'arwi.progress.v1';

/* ---------------- State ---------------- */

const state = {
  data: null,
  index: 0,          // current step index
  startedAt: null,
  ppe: new Set(),    // ticked PPE ids
  checks: {},        // { [stepId]: Set(checkIndex) }
  speak: false,
  listening: false,
  screen: 'home',
  returnScreen: 'step',
};

/* ---------------- Tiny DOM helpers ---------------- */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function show(name) {
  state.screen = name;
  for (const s of ['home', 'ppe', 'step', 'help', 'done']) {
    $(`screen-${s}`).hidden = s !== name;
  }
  const inJob = name === 'step';
  $('hud').hidden = !(inJob || name === 'help');
  // The stop reminder rides along only once the machine can actually fire.
  $('estop-bar').hidden = !(inJob && currentStep() && currentStep().phase === 'Run');
  window.scrollTo(0, 0);
}

function toast(msg, ms = 1900) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------------- Persistence ---------------- */

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      index: state.index,
      startedAt: state.startedAt,
      ppe: [...state.ppe],
      checks: Object.fromEntries(
        Object.entries(state.checks).map(([k, v]) => [k, [...v]])
      ),
      rev: state.data ? state.data.revision : null,
    }));
  } catch (_) { /* private mode, quota - progress just won't persist */ }
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    // A revised instruction sheet invalidates old progress on purpose.
    if (state.data && p.rev && p.rev !== state.data.revision) return null;
    return p;
  } catch (_) { return null; }
}

function clearSaved() {
  try { localStorage.removeItem(STORE_KEY); } catch (_) {}
}

/* ---------------- Speech out (read aloud) ---------------- */

const tts = {
  ok: 'speechSynthesis' in window,
  say(text) {
    if (!state.speak || !this.ok || !text) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.98;
      u.pitch = 1;
      speechSynthesis.speak(u);
    } catch (_) {}
  },
  stop() { if (this.ok) { try { speechSynthesis.cancel(); } catch (_) {} } },
};

/* ---------------- Speech in (voice control) ----------------
 * Hands are busy and often gloved, so voice is the primary AR input.
 * Grammar is deliberately tiny and forgiving. */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const voice = {
  ok: !!SR,
  rec: null,
  wantOn: false,

  start() {
    if (!this.ok) { toast('Voice control not supported here'); return; }
    this.wantOn = true;
    if (this.rec) return;

    const r = new SR();
    r.continuous = true;
    r.interimResults = false;
    r.lang = 'en-US';

    r.onresult = (e) => {
      const said = e.results[e.results.length - 1][0].transcript.toLowerCase().trim();
      this.handle(said);
    };
    // Browsers stop recognition on their own after a pause; restart it.
    r.onend = () => { this.rec = null; if (this.wantOn) setTimeout(() => this.start(), 350); };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.wantOn = false;
        setMic(false);
        toast('Microphone permission denied');
      }
    };

    try { r.start(); this.rec = r; } catch (_) {}
  },

  stop() {
    this.wantOn = false;
    if (this.rec) { try { this.rec.stop(); } catch (_) {} this.rec = null; }
  },

  handle(said) {
    const has = (...words) => words.some((w) => said.includes(w));
    if (has('next', 'forward', 'continue', 'done')) { toast('▶ next'); next(); }
    else if (has('back', 'previous', 'go back')) { toast('◀ back'); prev(); }
    else if (has('repeat', 'again', 'say that')) { toast('↻ repeat'); speakStep(); }
    else if (has('help', 'problem', 'trouble', 'wrong')) { toast('🛠 troubleshooting'); openHelp(); }
    else if (has('stop listening', 'mute mic')) { setMic(false); }
  },
};

/* ---------------- WebXR ----------------
 * DOM Overlay puts the live DOM in front of passthrough. We still need a
 * GL base layer for the session to be valid, so we make one and clear it
 * to fully transparent each frame. No geometry, no library. */

const xr = {
  supported: false,
  session: null,
  gl: null,

  async probe() {
    const status = $('xr-status');
    if (!navigator.xr) {
      status.textContent = 'Running in 2D. Open this page in a headset browser (or an AR phone) for hands-free AR.';
      return;
    }
    try {
      this.supported = await navigator.xr.isSessionSupported('immersive-ar');
    } catch (_) {
      this.supported = false;
    }
    if (this.supported) {
      $('btn-ar').hidden = false;
      status.textContent = 'AR is available on this device.';
    } else {
      status.textContent = 'Running in 2D. This browser reports no immersive-AR support.';
    }
  },

  async enter() {
    if (!this.supported) return;
    const canvas = $('xr-canvas');
    const gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true });
    if (!gl) { toast('WebGL unavailable'); return; }
    this.gl = gl;

    let session;
    try {
      session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['dom-overlay'],
        optionalFeatures: ['local-floor'],
        domOverlay: { root: $('overlay-root') },
      });
    } catch (err) {
      toast('Could not start AR: ' + (err && err.message ? err.message : 'unknown'));
      return;
    }

    this.session = session;
    document.body.classList.add('xr-active');

    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
    const refSpace = await session.requestReferenceSpace('local').catch(() => null);

    session.addEventListener('end', () => {
      this.session = null;
      document.body.classList.remove('xr-active');
      $('btn-ar').hidden = !this.supported;
    });

    const onFrame = (_t, frame) => {
      const s = frame.session;
      s.requestAnimationFrame(onFrame);
      const layer = s.renderState.baseLayer;
      if (!layer) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
      // Fully transparent: the real world is the background.
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    };
    session.requestAnimationFrame(onFrame);

    void refSpace; // reserved for future world-locked anchoring
    if (state.screen === 'home') startJob();
  },
};

/* ---------------- Rendering ---------------- */

function currentStep() {
  return state.data ? state.data.steps[state.index] : null;
}

function renderHome() {
  const d = state.data;
  $('home-title').textContent = d.title;
  $('home-machine').textContent = d.machine;
  $('home-summary').textContent = d.summary;
  $('home-steps').textContent = d.steps.length;
  $('home-time').textContent = d.estimatedMinutes + ' min';
  $('home-rev').textContent = d.revision;
  document.title = d.title + ' — AR Work Instructions';

  const saved = load();
  if (saved && saved.index > 0 && saved.index < d.steps.length) {
    $('resume-line').hidden = false;
    $('resume-step').textContent = saved.index + 1;
    $('btn-resume').onclick = () => {
      state.index = saved.index;
      state.startedAt = saved.startedAt || Date.now();
      state.ppe = new Set(saved.ppe || []);
      state.checks = Object.fromEntries(
        Object.entries(saved.checks || {}).map(([k, v]) => [k, new Set(v)])
      );
      show('step');
      renderStep();
    };
  }
}

function renderPPE() {
  const list = $('ppe-list');
  list.replaceChildren();

  state.data.ppe.forEach((item) => {
    const li = el('li');
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = state.ppe.has(item.id);
    box.addEventListener('change', () => {
      if (box.checked) state.ppe.add(item.id);
      else state.ppe.delete(item.id);
      updatePPEGate();
      save();
    });
    const txt = el('span', 'ck-text', item.label);
    if (item.note) txt.appendChild(el('span', 'ck-note', item.note));
    label.append(box, txt);
    li.appendChild(label);
    list.appendChild(li);
  });

  const forb = $('forbidden-list');
  forb.replaceChildren();
  state.data.forbiddenMaterials.forEach((m) => forb.appendChild(el('li', null, m)));

  updatePPEGate();
}

function updatePPEGate() {
  const total = state.data.ppe.length;
  const n = state.ppe.size;
  const btn = $('btn-ppe-go');
  btn.textContent = `Begin work — ${n} / ${total}`;
  btn.disabled = n < total;
}

function renderStep() {
  const s = currentStep();
  if (!s) return;

  $('hud-phase').textContent = s.phase;
  $('hud-count').textContent = `Step ${state.index + 1} / ${state.data.steps.length}`;
  $('progressfill').style.width = ((state.index + 1) / state.data.steps.length * 100) + '%';

  const pill = $('step-hazard');
  pill.textContent = s.hazard === 'none' ? 'info' : s.hazard + ' risk';
  pill.dataset.h = s.hazard;

  $('step-title').textContent = s.title;
  $('step-why').textContent = s.why;

  const doList = $('step-do');
  doList.replaceChildren();
  s.do.forEach((line) => doList.appendChild(el('li', null, line)));

  const warnWrap = $('step-warn-wrap');
  const warn = $('step-warn');
  warn.replaceChildren();
  if (s.warn && s.warn.length) {
    warnWrap.hidden = false;
    s.warn.forEach((w) => warn.appendChild(el('li', null, w)));
  } else {
    warnWrap.hidden = true;
  }

  const ticked = state.checks[s.id] || new Set();
  const checks = $('step-checks');
  checks.replaceChildren();
  s.checks.forEach((c, i) => {
    const li = el('li');
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = ticked.has(i);
    box.addEventListener('change', () => {
      if (!state.checks[s.id]) state.checks[s.id] = new Set();
      if (box.checked) state.checks[s.id].add(i);
      else state.checks[s.id].delete(i);
      updateNextGate();
      save();
    });
    label.append(box, el('span', 'ck-text', c));
    li.appendChild(label);
    checks.appendChild(li);
  });

  $('btn-prev').disabled = state.index === 0;
  $('estop-bar').hidden = s.phase !== 'Run';
  updateNextGate();
  speakStep();
  save();
}

/* High-hazard steps will not let you tap past them until every
 * verification is ticked. Low-risk steps stay unblocked so the app
 * does not become something students learn to click through. */
function updateNextGate() {
  const s = currentStep();
  const btn = $('btn-next');
  const last = state.index === state.data.steps.length - 1;
  const gated = s.hazard === 'high';
  const ticked = (state.checks[s.id] || new Set()).size;
  const need = s.checks.length;

  if (gated && ticked < need) {
    btn.disabled = true;
    btn.textContent = `Confirm all ${need} checks`;
  } else {
    btn.disabled = false;
    btn.textContent = last ? 'Finish ✓' : 'Next ▶';
  }
}

function speakStep() {
  const s = currentStep();
  if (s) tts.say(s.voice || s.title);
}

function renderHelp() {
  const wrap = $('help-list');
  wrap.replaceChildren();
  state.data.troubleshooting.forEach((t) => {
    const d = el('details', 'tsq');
    const sum = el('summary', null, t.problem);
    const body = el('div', 'tsbody');

    const causes = el('p');
    causes.appendChild(el('strong', null, 'Likely causes: '));
    causes.appendChild(document.createTextNode(t.causes.join('; ') + '.'));

    const fix = el('p', 'fix');
    fix.appendChild(el('strong', null, 'Fix: '));
    fix.appendChild(document.createTextNode(t.fix));

    body.append(causes, fix);
    d.append(sum, body);
    wrap.appendChild(d);
  });
}

function renderDone() {
  $('done-steps').textContent = `${state.data.steps.length} / ${state.data.steps.length}`;
  const mins = state.startedAt ? Math.max(1, Math.round((Date.now() - state.startedAt) / 60000)) : 0;
  $('done-time').textContent = mins + ' min';
}

/* ---------------- Navigation ---------------- */

function startJob() {
  state.startedAt = Date.now();
  state.index = 0;
  show('ppe');
  renderPPE();
}

function next() {
  if (state.screen === 'help') { show('step'); return; }
  if (state.screen !== 'step') return;
  if ($('btn-next').disabled) {
    toast('Confirm the checks first');
    tts.say('Confirm the safety checks before continuing.');
    return;
  }
  if (state.index >= state.data.steps.length - 1) {
    tts.stop();
    clearSaved();
    show('done');
    renderDone();
    return;
  }
  state.index++;
  renderStep();
}

function prev() {
  if (state.screen === 'help') { show('step'); return; }
  if (state.screen !== 'step' || state.index === 0) return;
  state.index--;
  renderStep();
}

function openHelp() {
  state.returnScreen = state.screen;
  show('help');
}

function setMic(on) {
  state.listening = on;
  $('btn-mic').setAttribute('aria-pressed', String(on));
  if (on) { voice.start(); toast('Voice on — say "next", "back", "repeat", "help"', 3200); }
  else { voice.stop(); toast('Voice off'); }
}

function setTTS(on) {
  state.speak = on;
  $('btn-tts').setAttribute('aria-pressed', String(on));
  if (on) { toast('Read aloud on'); speakStep(); }
  else { tts.stop(); toast('Read aloud off'); }
}

/* ---------------- Wiring ---------------- */

function wire() {
  $('btn-start').onclick = startJob;
  $('btn-ar').onclick = () => xr.enter();

  $('btn-ppe-back').onclick = () => show('home');
  $('btn-ppe-go').onclick = () => { show('step'); renderStep(); };

  $('btn-next').onclick = next;
  $('btn-prev').onclick = prev;
  $('btn-repeat').onclick = () => {
    if (!state.speak) setTTS(true);
    else speakStep();
  };

  $('btn-help').onclick = openHelp;
  $('btn-help-back').onclick = () => show('step');

  $('btn-mic').onclick = () => setMic(!state.listening);
  $('btn-tts').onclick = () => setTTS(!state.speak);

  $('btn-exit').onclick = () => {
    if (!confirm('Leave this job and return to the menu? Your progress is saved.')) return;
    tts.stop();
    show('home');
    renderHome();
  };

  $('btn-again').onclick = () => { clearSaved(); state.ppe.clear(); state.checks = {}; show('home'); renderHome(); };

  // Physical keyboards, clickers and headset controller "page" buttons all
  // land here, which is what most shop stations actually have wired up.
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prev(); }
    else if (e.key.toLowerCase() === 'r') speakStep();
    else if (e.key === '?' || e.key.toLowerCase() === 'h') openHelp();
  });

  if (!tts.ok) $('btn-tts').style.display = 'none';
  if (!voice.ok) $('btn-mic').style.display = 'none';
}

/* ---------------- Boot ---------------- */

async function boot() {
  wire();
  try {
    const res = await fetch(CONTENT_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.data = await res.json();
  } catch (err) {
    $('home-summary').textContent =
      'Could not load the instruction sheet (' + err.message + '). ' +
      'This page must be served over http, not opened as a file:// URL. ' +
      'Run:  python3 -m http.server 8000';
    $('btn-start').disabled = true;
    return;
  }

  renderHome();
  renderHelp();
  show('home');
  xr.probe();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
