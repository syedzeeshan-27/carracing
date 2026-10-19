(() => {
  'use strict';

  // ---- tuning ----
  const W = 1600, H = 900;
  const MAX_KMH = 300;       // holding the gas takes you all the way here (about 6 s from a standstill)
  const RAMP_KM = 5;         // traffic gets busier until this distance, then stays at its busiest
  const ACCEL = 80;          // km/h gained per second on full gas (eases off near top speed)
  const COAST = 25;          // km/h lost per second off the gas
  const BRAKE = 230;         // km/h lost per second on the brake
  const PX_PER_KMH = 12;     // road scroll, px per second per km/h: about real scale (car sprite is ~44 px per metre)
  const TRAFFIC_PX_PER_KMH = 6;  // traffic closes in slower than the road scrolls, so dodging stays humanly possible
  const MIN_ZOOM = 0.72;     // camera pulls back to this at top speed so you see further ahead
  const DIST_SCALE = 2;      // game km tick twice as fast as real ones
  const LAT_SPEED = 640;     // sideways px per second at full lock
  const STEER_LOCK = 110 * Math.PI / 180;  // on-screen wheel rotation at full lock
  const DEMO_KMH = 80;       // road speed behind the title screen
  const ROAD_SCREEN_W = 600; // zoom the road picture until the asphalt is about this wide
  const TRAFFIC_COLORS = ['#2f7cf6', '#f6c22f', '#e9ecef', '#2fc46b', '#9b5cf6'];

  const info = window.ASSET_INFO || {};
  const road = Object.assign({ left: 0.31, right: 0.69, lanes: 3 }, info.road);
  // The road picture is drawn wider than the canvas so the lanes are roomy; grass gets cropped.
  const roadZoom = Math.max(1, ROAD_SCREEN_W / ((road.right - road.left) * W));
  const roadDW = W * roadZoom, roadDX = (W - roadDW) / 2;
  const roadL = roadDX + road.left * roadDW, roadR = roadDX + road.right * roadDW;
  const laneW = (roadR - roadL) / road.lanes;
  const laneX = i => roadL + laneW * (i + 0.5);
  const minZoom = Math.max(MIN_ZOOM, W / roadDW + 0.01);   // never pull back past the edge of the road picture

  const $ = id => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const stage = $('stage');
  const screenEl = $('screen'), titleEl = $('screen-title'), textEl = $('screen-text');
  const btnEl = $('screen-btn'), muteEl = $('mute');
  const clips = { title: $('clip-intro'), over: $('clip-crash'), best: $('clip-best') };
  const clipBroken = {};

  // ---- state ----
  let state = 'loading';     // loading | title | playing | crashing | over
  let speed = 0, dist = 0, scroll = 0;
  let steer = 0, shake = 0, flash = 0, crashT = 0, spawnT = 0;
  let zoom = 1, spawnTop = 0, vignette = null;
  let traffic = [];
  const streaks = Array.from({ length: 36 }, () => ({ x: Math.random() * W, y: Math.random() * H * 2 - H, len: 90 + Math.random() * 150 }));
  const player = { x: 0, y: 0, w: 0, h: 0, tilt: 0, angle: 0, spin: 0 };
  const A = {};              // images, real or placeholder
  const ui = {};             // control positions
  let best = 0, newBest = false;
  try { best = parseFloat(localStorage.getItem('roadrush-best')) || 0; } catch (e) { /* storage blocked */ }

  // ---- helpers ----
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const approach = (v, target, step) => v < target ? Math.min(target, v + step) : Math.max(target, v - step);

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return [c, c.getContext('2d')];
  }

  function loadImage(src) {
    return new Promise(res => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = src;
    });
  }

  // ---- placeholder art, used when a picture is missing ----
  function makeRoad() {
    const S = 1600;
    const [c, g] = makeCanvas(S, S);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    g.fillStyle = '#3f7d32';
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 2500; i++) {
      g.fillStyle = rnd() < 0.5 ? '#38722c' : '#4a8a3a';
      g.fillRect(rnd() * S, rnd() * S, 4 + rnd() * 10, 4 + rnd() * 10);
    }
    const L = road.left * S, R = road.right * S;
    for (let i = 0; i < 70; i++) {
      const x = rnd() * S, y = rnd() * S, r = 24 + rnd() * 30;
      if (x + r > L - 30 && x - r < R + 30) continue;
      g.fillStyle = '#245c1f'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#2f7128'; g.beginPath(); g.arc(x - r * 0.2, y - r * 0.2, r * 0.6, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#8a8170';
    g.fillRect(L - 18, 0, R - L + 36, S);
    g.fillStyle = '#45484d';
    g.fillRect(L, 0, R - L, S);
    g.fillStyle = '#fff';
    g.fillRect(L + 10, 0, 8, S);
    g.fillRect(R - 18, 0, 8, S);
    const lw = (R - L) / road.lanes;
    for (let i = 1; i < road.lanes; i++) {
      // dash centres at 80 + k*160 so the mirrored tile lines up seamlessly
      for (let y = 80; y < S; y += 160) g.fillRect(L + lw * i - 4, y - 35, 8, 70);
    }
    return c;
  }

  function makeCar(color) {
    const [c, g] = makeCanvas(120, 236);
    const body = g.createLinearGradient(8, 0, 112, 0);
    body.addColorStop(0, 'rgba(0,0,0,0.35)');
    body.addColorStop(0.25, 'rgba(255,255,255,0.15)');
    body.addColorStop(0.75, 'rgba(255,255,255,0.15)');
    body.addColorStop(1, 'rgba(0,0,0,0.35)');
    g.fillStyle = color;
    g.beginPath(); g.ellipse(6, 80, 8, 6, 0, 0, Math.PI * 2); g.ellipse(114, 80, 8, 6, 0, 0, Math.PI * 2); g.fill();
    roundRect(g, 8, 6, 104, 224, 30); g.fill();
    g.fillStyle = body; g.fill();
    g.fillStyle = '#18202b';
    g.beginPath(); g.moveTo(20, 66); g.lineTo(100, 66); g.lineTo(94, 104); g.lineTo(26, 104); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(28, 156); g.lineTo(92, 156); g.lineTo(98, 182); g.lineTo(22, 182); g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(30, 70, 30, 6);
    g.fillStyle = '#fff6c8';
    roundRect(g, 18, 10, 22, 9, 4); g.fill();
    roundRect(g, 80, 10, 22, 9, 4); g.fill();
    g.fillStyle = '#ff2a2a';
    roundRect(g, 16, 220, 24, 7, 3); g.fill();
    roundRect(g, 80, 220, 24, 7, 3); g.fill();
    return c;
  }

  function makeWheel() {
    const S = 320, r = S / 2;
    const [c, g] = makeCanvas(S, S);
    g.translate(r, r);
    g.lineCap = 'round';
    g.strokeStyle = '#202226'; g.lineWidth = r * 0.2;
    for (const a of [0, Math.PI, Math.PI / 2]) {
      g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8); g.stroke();
    }
    g.strokeStyle = '#16171a'; g.lineWidth = r * 0.2;
    g.beginPath(); g.arc(0, 0, r * 0.86, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#e0202c';
    g.beginPath(); g.arc(0, 0, r * 0.86, -Math.PI / 2 - 0.12, -Math.PI / 2 + 0.12); g.stroke();
    g.fillStyle = '#2a2c31'; g.beginPath(); g.arc(0, 0, r * 0.3, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e0202c'; g.beginPath(); g.arc(0, 0, r * 0.11, 0, Math.PI * 2); g.fill();
    return c;
  }

  function makePedal(w, h) {
    const [c, g] = makeCanvas(w, h);
    g.fillStyle = '#2a2c31';
    g.fillRect(w * 0.4, 0, w * 0.2, h * 0.35);
    const metal = g.createLinearGradient(0, 0, w, h);
    metal.addColorStop(0, '#d6d9de'); metal.addColorStop(1, '#868a92');
    g.fillStyle = metal;
    roundRect(g, 4, h * 0.25, w - 8, h * 0.75 - 4, 16); g.fill();
    g.fillStyle = '#1d1f23';
    for (let y = h * 0.25 + 16; y < h - 24; y += 22) { roundRect(g, 16, y, w - 32, 10, 5); g.fill(); }
    return c;
  }

  async function loadAssets() {
    const names = ['road.jpg', 'car.png', 'wheel.png', 'gas.png', 'brake.png',
      'traffic1.png', 'traffic2.png', 'traffic3.png', 'traffic4.png', 'traffic5.png'];
    const [roadImg, car, wheel, gas, brake, ...tr] = await Promise.all(names.map(n => loadImage('assets/cut/' + n)));
    A.road = roadImg || makeRoad();
    A.car = car || makeCar('#e0202c');
    A.traffic = tr.filter(Boolean);
    if (!A.traffic.length) A.traffic = TRAFFIC_COLORS.map(makeCar);
    A.wheel = wheel || makeWheel();
    A.gas = gas || makePedal(130, 240);
    A.brake = brake || makePedal(170, 190);
  }

  // ---- layout ----
  function carSize(img) {
    let w = laneW * 0.52, h = w * img.height / img.width;
    if (h > 250) { h = 250; w = h * img.width / img.height; }
    return { w, h };
  }

  function fitBox(img, cx, maxW, maxH) {
    const s = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * s, h = img.height * s;
    return { x: cx - w / 2, y: H - 70 - h, w, h };
  }

  function layout() {
    const grassL = roadL, grassR = W - roadR;
    const r = Math.min(160, grassL * 0.4);
    ui.wheel = { x: grassL / 2, y: H - r - 60, r };
    const k = Math.min(1, grassR / 480);
    const cx = roadR + grassR / 2;
    ui.brake = fitBox(A.brake, cx - 90 * k, 170 * k, 190 * k);
    ui.gas = fitBox(A.gas, cx + 90 * k, 130 * k, 250 * k);
    Object.assign(player, carSize(A.car));
    player.y = H - player.h / 2 - 90;
    // traffic appears just above the top of the view when the camera is pulled all the way back
    spawnTop = player.y - player.y / minZoom - 30;
    vignette = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.62);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,1)');
  }

  function fitStage() {
    const s = Math.min(innerWidth / W, innerHeight / H);
    stage.style.transform = `translate(${-W * s / 2}px, ${-H * s / 2}px) scale(${s})`;
  }

  // ---- input ----
  const keys = { left: false, right: false, gas: false, brake: false };
  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'gas', KeyW: 'gas', ArrowDown: 'brake', KeyS: 'brake', Space: 'brake',
  };
  const touch = { wheelId: null, startAngle: 0, startSteer: 0, wheelSteer: 0, gas: new Set(), brake: new Set() };

  addEventListener('keydown', e => {
    const k = KEYMAP[e.code];
    if (k) { keys[k] = true; e.preventDefault(); }
    if (e.code === 'Enter') startRun();
    if (e.code === 'KeyM') toggleMute();
  });
  addEventListener('keyup', e => {
    const k = KEYMAP[e.code];
    if (k) keys[k] = false;
  });
  addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    touch.wheelId = null; touch.gas.clear(); touch.brake.clear();
  });

  function toStage(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
  }
  const inBox = (p, b) => p.x > b.x - 12 && p.x < b.x + b.w + 12 && p.y > b.y - 12 && p.y < b.y + b.h + 12;
  const wheelAngle = p => Math.atan2(p.y - ui.wheel.y, p.x - ui.wheel.x);

  canvas.addEventListener('pointerdown', e => {
    const p = toStage(e);
    if (Math.hypot(p.x - ui.wheel.x, p.y - ui.wheel.y) < ui.wheel.r * 1.2) {
      touch.wheelId = e.pointerId;
      touch.startAngle = wheelAngle(p);
      touch.startSteer = steer;
      touch.wheelSteer = steer;
    } else if (inBox(p, ui.gas)) {
      touch.gas.add(e.pointerId);
    } else if (inBox(p, ui.brake)) {
      touch.brake.add(e.pointerId);
    } else {
      return;
    }
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    e.preventDefault();
    initAudio();
  });
  canvas.addEventListener('pointermove', e => {
    if (e.pointerId !== touch.wheelId) return;
    let d = wheelAngle(toStage(e)) - touch.startAngle;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    touch.wheelSteer = clamp(touch.startSteer + d / STEER_LOCK, -1, 1);
  });
  const release = e => {
    if (e.pointerId === touch.wheelId) touch.wheelId = null;
    touch.gas.delete(e.pointerId);
    touch.brake.delete(e.pointerId);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  const gasDown = () => keys.gas || touch.gas.size > 0;
  const brakeDown = () => keys.brake || touch.brake.size > 0;

  screenEl.addEventListener('click', e => {
    if (state === 'title' || e.target === btnEl) startRun();
  });
  muteEl.addEventListener('click', e => { e.stopPropagation(); toggleMute(); muteEl.blur(); });

  // ---- sound: a synth engine whose pitch follows speed, plus a noise burst for crashes ----
  const sound = { ctx: null, muted: false };
  try { sound.muted = localStorage.getItem('roadrush-muted') === '1'; } catch (e) { /* storage blocked */ }

  function initAudio() {
    if (sound.ctx) { if (sound.ctx.state === 'suspended') sound.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ac = new AC();
    const master = ac.createGain();
    master.gain.value = sound.muted ? 0 : 1;
    master.connect(ac.destination);
    const engine = ac.createGain();
    engine.gain.value = 0;
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 600;
    const o1 = ac.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 50;
    const o2 = ac.createOscillator(); o2.type = 'square'; o2.frequency.value = 25;
    const g2 = ac.createGain(); g2.gain.value = 0.5;
    o1.connect(filter); o2.connect(g2); g2.connect(filter);
    filter.connect(engine); engine.connect(master);
    o1.start(); o2.start();
    Object.assign(sound, { ctx: ac, master, engine, filter, o1, o2 });
  }

  function updateAudio() {
    if (!sound.ctx) return;
    const t = sound.ctx.currentTime, k = speed / MAX_KMH;
    const f = 48 + k * 150 + (gasDown() && state === 'playing' ? 8 : 0);
    sound.o1.frequency.setTargetAtTime(f, t, 0.08);
    sound.o2.frequency.setTargetAtTime(f / 2, t, 0.08);
    sound.filter.frequency.setTargetAtTime(500 + k * 1500, t, 0.1);
    sound.engine.gain.setTargetAtTime(state === 'playing' ? 0.05 + k * 0.05 : 0, t, 0.15);
  }

  function crashSound() {
    if (!sound.ctx) return;
    const ac = sound.ctx, len = Math.floor(ac.sampleRate * 0.8);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    const src = ac.createBufferSource(); src.buffer = buf;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const g = ac.createGain(); g.gain.value = 0.6;
    src.connect(lp); lp.connect(g); g.connect(sound.master);
    src.start();
  }

  function toggleMute() {
    sound.muted = !sound.muted;
    if (sound.master) sound.master.gain.value = sound.muted ? 0 : 1;
    clips.over.muted = clips.best.muted = sound.muted;
    muteEl.textContent = sound.muted ? 'SOUND OFF' : 'SOUND ON';
    try { localStorage.setItem('roadrush-muted', sound.muted ? '1' : '0'); } catch (e) { /* storage blocked */ }
  }

  // ---- screens and clips ----
  for (const [kind, v] of Object.entries(clips)) {
    v.addEventListener('error', () => {
      clipBroken[kind] = true;
      if (v.classList.contains('active')) {
        v.classList.remove('active');
        screenEl.classList.remove('has-clip', 'clip-titled');
      }
    });
  }

  function showScreen(kind) {
    // a crash that beats your record gets the confetti clip instead of the wreck
    const clipKey = kind === 'over' && newBest && !clipBroken.best ? 'best' : kind;
    if (kind === 'title') {
      titleEl.textContent = 'ROAD RUSH';
      textEl.textContent = 'Dodge the traffic. How far can you go?' + (best ? `  Best: ${best.toFixed(2)} km` : '');
      btnEl.textContent = 'RACE';
    } else {
      titleEl.textContent = newBest ? 'NEW BEST!' : 'CRASHED';
      textEl.textContent = `You drove ${dist.toFixed(2)} km.  Best: ${best.toFixed(2)} km`;
      btnEl.textContent = 'TRY AGAIN';
    }
    screenEl.classList.remove('hidden', 'has-clip', 'clip-titled');
    screenEl.classList.toggle('is-title', kind === 'title');
    for (const v of Object.values(clips)) { v.pause(); v.classList.remove('active'); }
    if (kind !== 'title') {
      btnEl.disabled = true;   // stops a held pedal tap from restarting instantly
      setTimeout(() => { btnEl.disabled = false; }, 700);
    }

    const clip = clips[clipKey];
    if (clipBroken[clipKey]) return;
    clip.currentTime = 0;
    clip.muted = kind === 'title' || sound.muted;
    const shown = () => {
      if (state !== kind) { clip.pause(); return; }
      clip.classList.add('active');
      screenEl.classList.add('has-clip');
      // the crash clip ends on its own GAME OVER, so drop ours
      if (clipKey === 'over') screenEl.classList.add('clip-titled');
    };
    clip.play().then(shown).catch(() => {
      if (clip.muted || clipBroken[clipKey]) return;
      clip.muted = true;   // browser blocked sound, play silently instead
      clip.play().then(shown).catch(() => {});
    });
  }

  function hideScreen() {
    screenEl.classList.add('hidden');
    for (const v of Object.values(clips)) { v.pause(); v.classList.remove('active'); }
  }

  // ---- game flow ----
  function resetRun() {
    speed = 0; dist = 0; steer = 0;
    shake = 0; flash = 0; crashT = 0; spawnT = 1.5;
    traffic = [];
    touch.wheelId = null;
    player.x = laneX(Math.floor(road.lanes / 2));
    player.tilt = 0; player.angle = 0; player.spin = 0;
  }

  function startRun() {
    if (!['title', 'over'].includes(state) || btnEl.disabled) return;
    initAudio();
    resetRun();
    state = 'playing';
    hideScreen();
  }

  function endRun() {
    newBest = dist > best && best > 0;
    if (dist > best) {
      best = dist;
      try { localStorage.setItem('roadrush-best', String(best)); } catch (e) { /* storage blocked */ }
    }
    state = 'over';
    showScreen('over');
  }

  function crash() {
    state = 'crashing';
    crashT = 0; shake = 1; flash = 0.7;
    player.spin = (Math.random() < 0.5 ? -1 : 1) * rand(6, 10) * (0.4 + speed / MAX_KMH);
    speed = 0;
    crashSound();
  }

  function spawnTraffic() {
    if (speed < 90) return;   // too slow to catch anyone, nothing would come into view
    const top = traffic.filter(c => c.y - c.h / 2 < spawnTop + 600);
    const busy = new Set(top.map(c => c.lane));
    if (busy.size >= road.lanes - 1) return;   // always leave a lane open near the top
    const free = [];
    for (let i = 0; i < road.lanes; i++) if (!busy.has(i)) free.push(i);
    const lane = free[Math.floor(Math.random() * free.length)];
    let s = rand(60, Math.min(170, speed - 30));
    // a car spawned ahead must not be slower than the one already in its lane, or it'd rear-end it
    const ahead = traffic.filter(c => c.lane === lane).sort((a, b) => a.y - b.y)[0];
    if (ahead) s = Math.max(s, ahead.speed);
    if (s > speed - 20) return;
    const img = A.traffic[Math.floor(Math.random() * A.traffic.length)];
    const { w, h } = carSize(img);
    traffic.push({ lane, x: laneX(lane), y: spawnTop - h / 2, w, h, speed: s, img });
  }

  const hits = (a, b) =>
    Math.abs(a.x - b.x) < (a.w + b.w) / 2 * 0.78 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 * 0.86;

  function update(dt) {
    flash = Math.max(0, flash - dt * 1.5);
    // camera pulls back as speed builds, and settles in again when you slow or crash
    const zoomTarget = 1 - (1 - minZoom) * clamp((speed - 40) / (MAX_KMH - 40), 0, 1);
    zoom = approach(zoom, zoomTarget, dt * 0.6);
    for (const s of streaks) {
      s.y += speed * PX_PER_KMH * 1.4 * zoom * dt;
      if (s.y - s.len > H) { s.x = Math.random() * W; s.y = -Math.random() * H; }
    }
    if (state === 'title') { scroll += DEMO_KMH * PX_PER_KMH * dt; return; }
    if (state === 'crashing') {
      crashT += dt;
      player.angle += player.spin * dt;
      player.spin *= Math.pow(0.03, dt);
      shake = Math.max(0, shake - dt * 1.4);
      if (crashT > 1.1) endRun();
      return;
    }
    if (state !== 'playing') return;

    const gas = gasDown(), brake = brakeDown();
    if (brake) speed -= BRAKE * dt;
    else if (gas) speed += ACCEL * (1 - 0.6 * speed / MAX_KMH) * dt;
    else speed -= COAST * dt;
    speed = clamp(speed, 0, MAX_KMH);

    if (touch.wheelId !== null) {
      steer = touch.wheelSteer;
    } else {
      const target = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      steer = approach(steer, target, (target === 0 ? 7 : 5) * dt);
    }
    const grip = Math.min(1, speed / 50);
    player.x = clamp(player.x + steer * LAT_SPEED * grip * dt, roadL + player.w / 2 + 6, roadR - player.w / 2 - 6);
    player.tilt = approach(player.tilt, steer * 0.2 * grip, dt * 2);

    scroll += speed * PX_PER_KMH * dt;
    dist += speed / 3600 * dt * DIST_SCALE;

    const p = Math.min(1, dist / RAMP_KM);
    spawnT -= dt;
    if (spawnT <= 0) {
      spawnTraffic();
      spawnT = (1.3 - 0.75 * p) * rand(0.75, 1.25);
    }
    for (const c of traffic) c.y += (speed - c.speed) * TRAFFIC_PX_PER_KMH * dt;
    traffic = traffic.filter(c => c.y < H + 400 && c.y > spawnTop - 1000);

    for (const c of traffic) {
      if (hits(player, c)) { crash(); return; }
    }
  }

  // ---- drawing ----
  function drawRoadPass(top, bottom, lag) {
    const th = roadDW * A.road.height / A.road.width;
    const off = (scroll - lag) % (2 * th);
    // every other tile is flipped upside down, so tile edges always meet their own mirror image
    for (let i = Math.floor((top - off) / th); i * th + off < bottom; i++) {
      const y = i * th + off;
      if ((i % 2 + 2) % 2 === 1) {
        ctx.save();
        ctx.translate(0, y + th);
        ctx.scale(1, -1);
        ctx.drawImage(A.road, roadDX, 0, roadDW, th);
        ctx.restore();
      } else {
        ctx.drawImage(A.road, roadDX, y, roadDW, th);
      }
    }
  }

  function drawRoad(top, bottom, k) {
    drawRoadPass(top, bottom, 0);
    if (k < 0.3) return;
    // cheap motion blur: faint copies of the road where it was a moment ago
    const perFrame = speed * PX_PER_KMH / 60, a = 0.4 * (k - 0.3) / 0.7;
    ctx.globalAlpha = a;
    drawRoadPass(top, bottom, perFrame * 0.5);
    ctx.globalAlpha = a * 0.6;
    drawRoadPass(top, bottom, perFrame);
    ctx.globalAlpha = 1;
  }

  function drawSpeedFx(k) {
    const a = clamp((k - 0.45) / 0.55, 0, 1);
    if (a <= 0) return;
    ctx.strokeStyle = `rgba(255,255,255,${0.3 * a})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const s of streaks) {
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x, s.y - s.len * k);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.55 * a;
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  function drawCar(img, x, y, w, h, angle, extra) {
    ctx.save();
    ctx.translate(x, y);
    if (angle) ctx.rotate(angle);
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetX = 6;
    ctx.shadowOffsetY = 10;
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.shadowColor = 'transparent';
    if (extra) extra(w, h);
    ctx.restore();
  }

  function brakeLights(w, h) {
    ctx.globalCompositeOperation = 'lighter';
    for (const sx of [-0.3, 0.3]) {
      const x = sx * w, y = h * 0.46;
      const g = ctx.createRadialGradient(x, y, 0, x, y, w * 0.32);
      g.addColorStop(0, 'rgba(255,40,40,0.9)');
      g.addColorStop(1, 'rgba(255,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - w * 0.32, y - w * 0.32, w * 0.64, w * 0.64);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawPedal(img, b, pressed, label) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = pressed ? 3 : 10;
    // pressed pedals squash toward their base
    const sy = pressed ? 0.9 : 1;
    ctx.drawImage(img, b.x, b.y + b.h * (1 - sy), b.w, b.h * sy);
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '22px "Russo One", Impact, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, b.x + b.w / 2, H - 34);
  }

  function drawControls() {
    const wh = ui.wheel, playing = state === 'playing';
    ctx.save();
    ctx.translate(wh.x, wh.y);
    ctx.rotate(steer * STEER_LOCK);
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetY = 10;
    const s = (wh.r * 2) / Math.max(A.wheel.width, A.wheel.height);
    ctx.drawImage(A.wheel, -A.wheel.width * s / 2, -A.wheel.height * s / 2, A.wheel.width * s, A.wheel.height * s);
    ctx.restore();
    drawPedal(A.brake, ui.brake, playing && brakeDown(), 'BRAKE');
    drawPedal(A.gas, ui.gas, playing && gasDown(), 'GAS');
  }

  function drawHud() {
    const x = W - 350, y = 24, w = 320, h = 172;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(ctx, x, y, w, h, 16);
    ctx.fill();
    const k = speed / MAX_KMH;
    ctx.fillStyle = k > 0.9 ? '#ff4d4d' : k > 0.7 ? '#ffb347' : '#fff';
    ctx.textAlign = 'right';
    ctx.font = '86px "Russo One", Impact, sans-serif';
    ctx.fillText(Math.round(speed), x + 196, y + 98);
    ctx.textAlign = 'left';
    ctx.font = '26px "Russo One", Impact, sans-serif';
    ctx.fillStyle = '#ffe9a8';
    ctx.fillText('km/h', x + 208, y + 96);
    ctx.fillStyle = '#fff';
    ctx.font = '26px "Russo One", Impact, sans-serif';
    ctx.fillText(`${dist.toFixed(2)} km`, x + 24, y + 140);
    ctx.textAlign = 'right';
    ctx.fillStyle = dist > best && best > 0 ? '#7dff8a' : 'rgba(255,255,255,0.7)';
    ctx.font = '20px "Russo One", Impact, sans-serif';
    ctx.fillText(`BEST ${Math.max(best, dist).toFixed(2)}`, x + w - 24, y + 140);
  }

  function draw() {
    const k = speed / MAX_KMH;
    let jx = 0, jy = 0;
    if (shake > 0) { jx += (Math.random() - 0.5) * 34 * shake; jy += (Math.random() - 0.5) * 34 * shake; }
    if (state === 'playing' && k > 0.6) {   // a little road rumble near top speed
      const j = (k - 0.6) * 6;
      jx += (Math.random() - 0.5) * j; jy += (Math.random() - 0.5) * j;
    }
    ctx.save();
    ctx.translate(jx, jy);
    // zoom the world around the player's car
    ctx.translate(W / 2, player.y);
    ctx.scale(zoom, zoom);
    ctx.translate(-W / 2, -player.y);
    drawRoad(player.y - player.y / zoom - 40, player.y + (H - player.y) / zoom + 40, k);
    for (const c of traffic) drawCar(c.img, c.x, c.y, c.w, c.h, 0);
    const braking = state === 'playing' && brakeDown() && speed > 0;
    drawCar(A.car, player.x, player.y, player.w, player.h, player.angle + player.tilt, braking ? brakeLights : null);
    ctx.restore();
    drawSpeedFx(k);
    if (flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${flash})`;
      ctx.fillRect(0, 0, W, H);
    }
    drawControls();
    if (state !== 'title') drawHud();
  }

  // ---- boot ----
  // Physics runs in fixed 1/60 s steps, so a slow device drops frames instead of running in slow motion.
  const STEP = 1 / 60;
  let last = 0, acc = 0;
  function frame(now) {
    acc += Math.min(0.25, (now - last) / 1000 || 0);
    last = now;
    while (acc >= STEP) { update(STEP); acc -= STEP; }
    draw();
    updateAudio();
    requestAnimationFrame(frame);
  }

  fitStage();
  addEventListener('resize', fitStage);
  muteEl.textContent = sound.muted ? 'SOUND OFF' : 'SOUND ON';
  clips.over.muted = clips.best.muted = sound.muted;
  loadAssets().then(() => {
    layout();
    resetRun();
    state = 'title';
    showScreen('title');
    requestAnimationFrame(t => { last = t; frame(t); });
  });

  // handy for poking at the game from the console while testing
  window.roadRush = {
    get state() { return state; }, get speed() { return speed; }, get dist() { return dist; },
    get steer() { return steer; }, traffic: () => traffic, player, ui,
  };
})();
