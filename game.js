/* =========================================================
   NEON APEX GP — a small pseudo-3D (Mode-7 / OutRun-style)
   racing game rendered on a single <canvas> with no
   external game libraries.

   v2: faster cars, tighter/chicane-heavy course, rival AI
   cars to race against, boost pads, oil-slick obstacles,
   and a nitro gauge.
   ========================================================= */

(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const WIDTH = canvas.width;
  const HEIGHT = canvas.height;
  const HORIZON = HEIGHT * 0.42;

  // ---- Camera / projection constants ----
  const CAMERA_HEIGHT = 900;
  const FOCAL_LENGTH = 225;      // lower = wider FOV = stronger sense of speed
  const ROAD_HALF_WIDTH = 480;
  const SEGMENT_LENGTH = 100;
  const DRAW_DISTANCE_SPRITES = 4200;
  const GROUP_LENGTH = 260;

  // ---- Race rules ----
  const TOTAL_LAPS = 3;

  // ---- Player physics constants (v3: much higher top speed) ----
  const MAX_SPEED = 750;
  const OFFROAD_MAX_SPEED = 220;
  const ACCEL = 420;
  const BRAKE = 780;
  const FRICTION = 140;
  const STEER_SPEED = 3.6;
  const CENTRIFUGAL = 5.2;
  const X_LIMIT = 1.85;

  // ---- Nitro ----
  const NITRO_MAX = 100;
  const NITRO_DRAIN = 42;     // per second while held
  const NITRO_RECHARGE = 11;  // per second while not held
  const NITRO_SPEED_MULT = 1.32;
  const NITRO_ACCEL_MULT = 1.6;

  // ---- Hazards ----
  const STUN_DURATION = 0.85;
  const STUN_SPEED_MULT = 0.35;
  const BUMP_SPEED_MULT = 0.6;

  // ---------------------------------------------------------
  // Track construction — block list + automatic closure so the
  // road always seamlessly loops back to its start, no matter
  // how the curves are designed.
  // ---------------------------------------------------------
  // NOTE: `curve` values below are a small dimensionless steering-rate
  // (kept small on purpose because the same value also drives the
  // centrifugal-force physics). The actual on-screen bend comes from
  // CURVE_TO_WORLD, which converts that rate into a real world-unit
  // lateral shift when building the centerline. Without this multiplier
  // the track's visual bend is only a few world units against a
  // 480-unit-wide road — i.e. it looks like a straight line.
  const CURVE_TO_WORLD = 850;

  function buildTrack() {
    const blocks = [];
    const straight = (n) => blocks.push({ n, c: 0 });
    const curve = (n, c) => blocks.push({ n, c });

    straight(8);
    curve(14, 0.11);               // sweeping right
    straight(4);
    curve(5, -0.22);                // sharp chicane wiggle
    curve(5, 0.22);
    curve(5, -0.22);
    curve(5, 0.22);
    straight(5);
    curve(24, -0.09);               // long sweeping left
    straight(4);
    curve(9, 0.20);                 // tight right hairpin
    straight(5);
    curve(6, -0.24);                // quick left-right flick
    curve(6, 0.24);
    straight(8);
    curve(11, 0.17);                // fast right kink into home stretch
    straight(8);

    let sum = 0, count = 0;
    for (const b of blocks) { sum += b.c * b.n; count += b.n; }
    const closingN = 16;
    blocks.push({ n: closingN, c: -sum / closingN }); // guarantees net curve = 0
    straight(6); // short finish straight

    const segments = [];
    for (const b of blocks) for (let i = 0; i < b.n; i++) segments.push({ curve: b.c });

    let x = 0, z = 0;
    for (const s of segments) {
      s.z0 = z; s.centerX0 = x;
      x += s.curve * CURVE_TO_WORLD;
      z += SEGMENT_LENGTH;
      s.z1 = z; s.centerX1 = x;
    }
    return { segments, length: z };
  }

  function wrap(z, len) { return ((z % len) + len) % len; }
  function signedDelta(a, b, len) { // shortest signed distance from b to a on a loop
    let d = wrap(a - b, len);
    if (d > len / 2) d -= len;
    return d;
  }

  function segmentAt(track, zAbs) {
    const z = wrap(zAbs, track.length);
    const idx = Math.min(track.segments.length - 1, Math.floor(z / SEGMENT_LENGTH));
    return track.segments[idx];
  }
  function centerXAt(track, zAbs) {
    const z = wrap(zAbs, track.length);
    const seg = segmentAt(track, z);
    const t = (z - seg.z0) / SEGMENT_LENGTH;
    return seg.centerX0 + (seg.centerX1 - seg.centerX0) * t;
  }
  function curveAt(track, zAbs) { return segmentAt(track, zAbs).curve; }

  function buildSprites(track) {
    const sprites = [];
    for (let z = 0; z < track.length; z += 280) {
      const side = (Math.floor(z / 280) % 2 === 0) ? 1 : -1;
      sprites.push({ z, side });
    }
    return sprites;
  }

  const track = buildTrack();
  const sprites = buildSprites(track);

  // Boost pads: [z, halfLength]
  const boostPads = [
    { z: 400, len: 220 },
    { z: 10900, len: 220 },
    { z: track.length - 300, len: 220 },
  ];

  // Hazards (oil slicks): z, lateral x, radius
  const hazards = [
    { z: 3350, x: 0.55, hit: 0 },
    { z: 6300, x: -0.6, hit: 0 },
    { z: 8350, x: 0.55, hit: 0 },
    { z: 10100, x: -0.55, hit: 0 },
  ];

  // Rival AI cars
  function makeAI(offset, baseFactor, color, laneBias) {
    return { z: wrap(offset, track.length), x: laneBias, speed: MAX_SPEED * 0.6, baseFactor, color, laneBias, hitCooldown: 0 };
  }
  let aiCars = [];
  function resetAI() {
    aiCars = [
      makeAI(260, 0.86, '#ffd23f', -0.35),
      makeAI(-220, 0.93, '#7CFF6B', 0.35),
      makeAI(560, 1.0, '#b967ff', 0),
    ];
  }
  resetAI();

  // ---------------------------------------------------------
  // Game state
  // ---------------------------------------------------------
  const STORAGE_KEY = 'neonApexGp.bestTime';

  const player = { z: 0, x: 0, speed: 0, nitro: NITRO_MAX, stun: 0 };
  let lapsCompleted = 0;
  let raceTime = 0;
  let lapTime = 0;
  let bestTime = Number(localStorage.getItem(STORAGE_KEY)) || null;
  let shake = 0;

  let state = 'title';
  const keys = {};

  function resetRace() {
    player.z = 0; player.x = 0; player.speed = 0; player.nitro = NITRO_MAX; player.stun = 0;
    lapsCompleted = 0; raceTime = 0; lapTime = 0; shake = 0;
    resetAI();
  }

  function formatTime(t) {
    if (t == null) return '--:--.--';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    const cs = Math.floor((t * 100) % 100);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------
  // Input
  // ---------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'Enter') {
      if (state === 'title' || state === 'finished') startRace();
    }
    if (e.code === 'Escape') {
      if (state === 'playing') state = 'paused';
      else if (state === 'paused') state = 'playing';
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });

  function bindTouch(id, code) {
    const el = document.getElementById(id);
    if (!el) return;
    const on = (ev) => { ev.preventDefault(); keys[code] = true; };
    const off = (ev) => { ev.preventDefault(); keys[code] = false; };
    el.addEventListener('touchstart', on, { passive: false });
    el.addEventListener('touchend', off, { passive: false });
    el.addEventListener('touchcancel', off, { passive: false });
    el.addEventListener('mousedown', on);
    el.addEventListener('mouseup', off);
    el.addEventListener('mouseleave', off);
  }
  bindTouch('btnLeft', 'ArrowLeft');
  bindTouch('btnRight', 'ArrowRight');
  bindTouch('btnGas', 'ArrowUp');
  bindTouch('btnBrake', 'ArrowDown');
  bindTouch('btnNitro', 'Space');

  document.getElementById('stage').addEventListener('click', () => {
    if (state === 'title' || state === 'finished') startRace();
  });

  function startRace() {
    resetRace();
    state = 'playing';
    document.getElementById('titleScreen').classList.add('hidden');
    document.getElementById('resultScreen').classList.add('hidden');
    document.getElementById('newRecord').classList.add('hidden');
    document.getElementById('lapNow').textContent = '1';
  }

  function finishRace() {
    state = 'finished';
    const total = raceTime;
    const isRecord = bestTime == null || total < bestTime;
    if (isRecord) {
      bestTime = total;
      localStorage.setItem(STORAGE_KEY, String(bestTime));
    }
    document.getElementById('finalTime').textContent = formatTime(total);
    document.getElementById('finalBest').textContent = formatTime(bestTime);
    document.getElementById('newRecord').classList.toggle('hidden', !isRecord);
    document.getElementById('resultScreen').classList.remove('hidden');
  }

  // ---------------------------------------------------------
  // Update
  // ---------------------------------------------------------
  function updateAI(ai, dt) {
    const curve = curveAt(track, ai.z);
    const severity = Math.min(1, Math.abs(curve) * 5);
    const target = MAX_SPEED * ai.baseFactor * (1 - severity * 0.55);
    ai.speed += (target - ai.speed) * Math.min(1, dt * 1.8);
    ai.z += ai.speed * dt;
    ai.x = ai.laneBias + Math.sin(ai.z * 0.006) * 0.12;
  }

  function checkHazards(dt) {
    for (const h of hazards) {
      if (h.hit > 0) { h.hit -= dt; continue; }
      const dz = signedDelta(h.z, player.z, track.length);
      if (Math.abs(dz) < 55 && Math.abs(player.x - h.x) < 0.13) {
        player.stun = STUN_DURATION;
        player.speed *= STUN_SPEED_MULT;
        shake = 1;
        h.hit = 2.5;
      }
    }
  }

  function checkAICollisions(dt) {
    for (const ai of aiCars) {
      if (ai.hitCooldown > 0) { ai.hitCooldown -= dt; continue; }
      const dz = signedDelta(ai.z, player.z, track.length);
      if (Math.abs(dz) < 65 && Math.abs(player.x - ai.x) < 0.22) {
        player.speed *= BUMP_SPEED_MULT;
        player.x += player.x > ai.x ? 0.35 : -0.35;
        shake = Math.max(shake, 0.5);
        ai.hitCooldown = 1.0; // prevents re-triggering every frame while still touching
      }
    }
  }

  function checkBoost() {
    for (const pad of boostPads) {
      const dz = signedDelta(pad.z, player.z, track.length);
      if (Math.abs(dz) < pad.len / 2 && Math.abs(player.x) < 0.9) {
        player.speed = Math.max(player.speed, MAX_SPEED * 1.18);
      }
    }
  }

  function currentRank() {
    const playerProgress = lapsCompleted * track.length + player.z;
    let rank = 1;
    for (const ai of aiCars) {
      // approximate AI lap progress by total distance travelled (unwrapped via speed*time is complex,
      // so we track ai.totalZ instead — see updateAI wrap handling below)
      if (ai.totalZ > playerProgress) rank++;
    }
    return rank;
  }

  function update(dt) {
    if (state !== 'playing') return;

    const accelInput = keys['ArrowUp'] || keys['KeyW'];
    const brakeInput = keys['ArrowDown'] || keys['KeyS'];
    const leftInput = keys['ArrowLeft'] || keys['KeyA'];
    const rightInput = keys['ArrowRight'] || keys['KeyD'];
    const nitroInput = keys['Space'];

    if (player.stun > 0) player.stun -= dt;

    // Nitro gauge
    let nitroActive = false;
    if (nitroInput && player.nitro > 0 && player.stun <= 0) {
      player.nitro = Math.max(0, player.nitro - NITRO_DRAIN * dt);
      nitroActive = true;
    } else {
      player.nitro = Math.min(NITRO_MAX, player.nitro + NITRO_RECHARGE * dt);
    }

    const onRoad = Math.abs(player.x) <= 1;
    let maxSpeed = onRoad ? MAX_SPEED : OFFROAD_MAX_SPEED;
    let accel = ACCEL;
    if (nitroActive) { maxSpeed *= NITRO_SPEED_MULT; accel *= NITRO_ACCEL_MULT; }
    if (player.stun > 0) maxSpeed = Math.min(maxSpeed, MAX_SPEED * 0.4);

    if (player.stun > 0) {
      player.speed -= FRICTION * 1.4 * dt;
    } else if (accelInput) {
      player.speed += accel * dt;
    } else if (brakeInput) {
      player.speed -= BRAKE * dt;
    } else {
      player.speed -= FRICTION * dt;
    }
    player.speed = Math.max(0, player.speed);
    if (player.speed > maxSpeed) player.speed = Math.max(maxSpeed, player.speed - BRAKE * 0.5 * dt);

    const speedRatio = player.speed / MAX_SPEED;
    if (player.stun <= 0) {
      const steerAmt = STEER_SPEED * dt * (0.35 + 0.65 * speedRatio);
      if (leftInput) player.x -= steerAmt;
      if (rightInput) player.x += steerAmt;
    }

    const curve = curveAt(track, player.z);
    player.x -= curve * CENTRIFUGAL * speedRatio * dt;
    player.x = Math.max(-X_LIMIT, Math.min(X_LIMIT, player.x));

    player.z += player.speed * dt;
    raceTime += dt;
    lapTime += dt;

    checkHazards(dt);
    checkAICollisions(dt);
    checkBoost();

    for (const ai of aiCars) {
      if (ai.totalZ === undefined) ai.totalZ = ai.z;
      const prevZ = ai.z;
      updateAI(ai, dt);
      let delta = ai.z - prevZ;
      if (delta < 0) delta += track.length; // shouldn't normally happen (speed>=0) but guards wrap
      ai.totalZ += delta;
      ai.z = wrap(ai.z, track.length);
    }

    if (shake > 0) shake = Math.max(0, shake - dt * 2.2);

    if (player.z >= track.length) {
      player.z -= track.length;
      lapsCompleted++;
      lapTime = 0;
      if (lapsCompleted >= TOTAL_LAPS) {
        finishRace();
      } else {
        document.getElementById('lapNow').textContent = String(lapsCompleted + 1);
      }
    }
  }

  // ---------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------
  function groupColor(zAbs, colorA, colorB) {
    const idx = Math.floor(wrap(zAbs, track.length) / GROUP_LENGTH) % 2;
    return idx === 0 ? colorA : colorB;
  }

  function isBoostZone(zAbs) {
    for (const pad of boostPads) {
      if (Math.abs(signedDelta(pad.z, zAbs, track.length)) < pad.len / 2) return true;
    }
    return false;
  }

  function drawSky() {
    const grad = ctx.createLinearGradient(0, 0, 0, HORIZON);
    grad.addColorStop(0, '#1a0a3a');
    grad.addColorStop(0.6, '#3a1257');
    grad.addColorStop(1, '#7c1f5e');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WIDTH, HORIZON);

    const sunX = WIDTH / 2;
    const sunY = HORIZON - 40;
    const sunR = 70;
    const sunGrad = ctx.createLinearGradient(0, sunY - sunR, 0, sunY + sunR);
    sunGrad.addColorStop(0, '#ffd23f');
    sunGrad.addColorStop(1, '#ff2e63');
    ctx.fillStyle = sunGrad;
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a0a3a';
    for (let i = 0; i < 5; i++) {
      const stripeY = sunY + sunR * 0.15 * i - 10;
      ctx.fillRect(sunX - sunR, stripeY, sunR * 2, 4);
    }
  }

  function renderRoad() {
    const playerZ = player.z;
    const playerCenterX = centerXAt(track, playerZ);
    const playerWorldX = playerCenterX + player.x * ROAD_HALF_WIDTH;

    for (let y = HEIGHT - 1; y > HORIZON; y--) {
      const rowFromHorizon = y - HORIZON;
      const d = (CAMERA_HEIGHT * FOCAL_LENGTH) / rowFromHorizon;
      const scale = FOCAL_LENGTH / d;
      const zAbs = playerZ + d;

      const centerX = centerXAt(track, zAbs);
      const screenCenterX = WIDTH / 2 + (centerX - playerWorldX) * scale;
      const roadHalfScreen = ROAD_HALF_WIDTH * scale;
      const rumbleHalfScreen = roadHalfScreen * 1.15;

      ctx.fillStyle = groupColor(zAbs, '#1f7a3d', '#186830');
      ctx.fillRect(0, y, WIDTH, 1);

      ctx.fillStyle = groupColor(zAbs, '#e6e6e6', '#c0392b');
      ctx.fillRect(screenCenterX - rumbleHalfScreen, y, rumbleHalfScreen * 2, 1);

      const boosting = isBoostZone(zAbs);
      ctx.fillStyle = boosting ? groupColor(zAbs, '#ff9dbb', '#33334a') : groupColor(zAbs, '#3a3a4a', '#33334a');
      ctx.fillRect(screenCenterX - roadHalfScreen, y, roadHalfScreen * 2, 1);

      if (Math.floor(wrap(zAbs, track.length) / 200) % 2 === 0) {
        const dashHalf = Math.max(1, roadHalfScreen * 0.035);
        ctx.fillStyle = boosting ? '#08d9d6' : '#f4f1ea';
        ctx.fillRect(screenCenterX - dashHalf, y, dashHalf * 2, 1);
      }
    }

    return playerWorldX;
  }

  function drawFinishLine(playerWorldX) {
    let d = wrap(0 - player.z, track.length);
    if (d > 1 && d < 2000) {
      const scale = FOCAL_LENGTH / d;
      const rowFromHorizon = (CAMERA_HEIGHT * FOCAL_LENGTH) / d;
      const y = HORIZON + rowFromHorizon;
      const centerX = centerXAt(track, player.z + d);
      const screenX = WIDTH / 2 + (centerX - playerWorldX) * scale;
      const halfW = ROAD_HALF_WIDTH * scale;
      const bannerH = Math.max(4, 60 * scale);
      const cols = 10;
      const colW = (halfW * 2) / cols;
      for (let i = 0; i < cols; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#f4f1ea' : '#111';
        ctx.fillRect(screenX - halfW + i * colW, y - bannerH, colW, bannerH);
      }
    }
  }

  function drawSprites(playerWorldX) {
    const visible = [];
    for (const s of sprites) {
      const d = wrap(s.z - player.z, track.length);
      if (d <= 1 || d > DRAW_DISTANCE_SPRITES) continue;
      visible.push({ kind: 'pole', d, side: s.side });
    }
    for (const h of hazards) {
      const d = wrap(h.z - player.z, track.length);
      if (d <= 1 || d > DRAW_DISTANCE_SPRITES) continue;
      visible.push({ kind: 'hazard', d, x: h.x });
    }
    for (const ai of aiCars) {
      const d = wrap(ai.z - player.z, track.length);
      if (d <= 1 || d > DRAW_DISTANCE_SPRITES) continue;
      visible.push({ kind: 'ai', d, x: ai.x, color: ai.color });
    }
    visible.sort((a, b) => b.d - a.d);

    for (const s of visible) {
      const scale = FOCAL_LENGTH / s.d;
      const rowFromHorizon = (CAMERA_HEIGHT * FOCAL_LENGTH) / s.d;
      const y = HORIZON + rowFromHorizon;
      const centerX = centerXAt(track, player.z + s.d);

      if (s.kind === 'pole') {
        const worldX = centerX + s.side * (ROAD_HALF_WIDTH + 160);
        const screenX = WIDTH / 2 + (worldX - playerWorldX) * scale;
        const poleH = 280 * scale;
        const poleW = Math.max(2, 30 * scale);
        const color = s.side > 0 ? '#ff2e63' : '#08d9d6';
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 14 * Math.min(1, scale * 3);
        ctx.fillStyle = color;
        ctx.fillRect(screenX - poleW / 2, y - poleH, poleW, poleH);
        ctx.restore();
        ctx.fillStyle = '#f4f1ea';
        ctx.fillRect(screenX - poleW, y - poleH - poleW * 0.6, poleW * 2, poleW * 0.6);
      } else if (s.kind === 'hazard') {
        const worldX = centerX + s.x * ROAD_HALF_WIDTH;
        const screenX = WIDTH / 2 + (worldX - playerWorldX) * scale;
        const r = Math.max(3, 55 * scale);
        ctx.save();
        // dark puddle base
        ctx.fillStyle = 'rgba(10,10,15,0.9)';
        ctx.beginPath();
        ctx.ellipse(screenX, y - r * 0.12, r, r * 0.42, 0, 0, Math.PI * 2);
        ctx.fill();
        // glossy magenta swirl
        const grad = ctx.createRadialGradient(screenX, y - r * 0.12, r * 0.1, screenX, y - r * 0.12, r);
        grad.addColorStop(0, 'rgba(230,120,255,0.85)');
        grad.addColorStop(0.5, 'rgba(180,60,255,0.55)');
        grad.addColorStop(1, 'rgba(180,60,255,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(screenX, y - r * 0.12, r * 0.8, r * 0.34, 0, 0, Math.PI * 2);
        ctx.fill();
        // bright warning ring so its extent reads clearly
        ctx.strokeStyle = 'rgba(255,120,220,0.9)';
        ctx.lineWidth = Math.max(1, r * 0.06);
        ctx.beginPath();
        ctx.ellipse(screenX, y - r * 0.12, r, r * 0.42, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      } else if (s.kind === 'ai') {
        const worldX = centerX + s.x * ROAD_HALF_WIDTH;
        const screenX = WIDTH / 2 + (worldX - playerWorldX) * scale;
        const carH = 92 * scale;
        const carW = 78 * scale;
        ctx.save();
        // ground shadow for grounding/contrast
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.beginPath();
        ctx.ellipse(screenX, y, carW * 0.55, carW * 0.16, 0, 0, Math.PI * 2);
        ctx.fill();
        // body
        ctx.shadowColor = s.color;
        ctx.shadowBlur = 16 * Math.min(1, scale * 3);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.moveTo(screenX - carW / 2, y);
        ctx.lineTo(screenX - carW / 2, y - carH * 0.5);
        ctx.lineTo(screenX - carW / 3, y - carH);
        ctx.lineTo(screenX + carW / 3, y - carH);
        ctx.lineTo(screenX + carW / 2, y - carH * 0.5);
        ctx.lineTo(screenX + carW / 2, y);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
        // cockpit for clear "this is a car" readability
        ctx.fillStyle = 'rgba(13,2,33,0.9)';
        ctx.fillRect(screenX - carW * 0.22, y - carH * 0.86, carW * 0.44, carH * 0.32);
        // headlights
        ctx.fillStyle = '#fff9d6';
        ctx.fillRect(screenX - carW * 0.42, y - carH * 0.12, carW * 0.14, carH * 0.1);
        ctx.fillRect(screenX + carW * 0.28, y - carH * 0.12, carW * 0.14, carH * 0.1);
        ctx.restore();
      }
    }
  }

  function drawBoostZones(playerWorldX) {
    for (const pad of boostPads) {
      const d = wrap(pad.z - player.z, track.length);
      if (d <= 1 || d > 2400) continue;
      const scale = FOCAL_LENGTH / d;
      const rowFromHorizon = (CAMERA_HEIGHT * FOCAL_LENGTH) / d;
      const y = HORIZON + rowFromHorizon;
      const centerX = centerXAt(track, player.z + d);
      const screenX = WIDTH / 2 + (centerX - playerWorldX) * scale;
      const halfW = ROAD_HALF_WIDTH * scale;
      const chevronH = Math.max(4, 46 * scale);
      const lanes = [-0.55, 0, 0.55];
      lanes.forEach((lane, i) => {
        const cx = screenX + lane * halfW;
        ctx.save();
        ctx.strokeStyle = i % 2 === 0 ? '#08d9d6' : '#ff2e63';
        ctx.lineWidth = Math.max(2, 9 * scale);
        ctx.lineCap = 'round';
        ctx.shadowColor = ctx.strokeStyle;
        ctx.shadowBlur = 16 * Math.min(1, scale * 3);
        ctx.beginPath();
        ctx.moveTo(cx - halfW * 0.22, y - chevronH);
        ctx.lineTo(cx, y);
        ctx.lineTo(cx + halfW * 0.22, y - chevronH);
        ctx.stroke();
        ctx.restore();
      });
    }
  }

  function drawCar(nitroActive) {
    const cx = WIDTH / 2;
    const baseY = HEIGHT - 46;
    const lean = Math.max(-16, Math.min(16, (player.x) * 11));
    const spin = player.stun > 0 ? (STUN_DURATION - player.stun) * 30 : 0;
    ctx.save();
    ctx.translate(cx + lean, baseY);
    if (spin) ctx.rotate(spin);

    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(0, 34, 60, 12, 0, 0, Math.PI * 2);
    ctx.fill();

    if (nitroActive || player.speed > MAX_SPEED * 0.85) {
      ctx.fillStyle = nitroActive ? 'rgba(8,217,214,0.85)' : 'rgba(255,210,63,0.5)';
      ctx.beginPath();
      ctx.moveTo(-16, 34);
      ctx.lineTo(0, 34 + 30 + (nitroActive ? 20 : 0));
      ctx.lineTo(16, 34);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = '#ff2e63';
    ctx.shadowColor = '#ff2e63';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.moveTo(-46, 32);
    ctx.lineTo(-40, -10);
    ctx.lineTo(-22, -30);
    ctx.lineTo(22, -30);
    ctx.lineTo(40, -10);
    ctx.lineTo(46, 32);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#0d0221';
    ctx.fillRect(-18, -22, 36, 16);

    ctx.fillStyle = '#08d9d6';
    ctx.fillRect(-44, 24, 10, 8);
    ctx.fillRect(34, 24, 10, 8);

    ctx.restore();
  }

  function drawSpeedLines() {
    const intensity = Math.max(0, (player.speed / MAX_SPEED) - 0.45) * 2.4;
    if (intensity <= 0) return;
    ctx.save();
    ctx.globalAlpha = Math.min(0.5, intensity * 0.5);
    ctx.strokeStyle = '#ffffff';
    const cx = WIDTH / 2, cy = HORIZON + (HEIGHT - HORIZON) * 0.5;
    for (let i = 0; i < 16; i++) {
      const ang = (i / 16) * Math.PI * 2;
      const r1 = 40, r2 = 40 + intensity * 260;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1 * 0.4);
      ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2 * 0.4);
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawHUD(nitroActive) {
    document.getElementById('curTime').textContent = formatTime(state === 'title' ? 0 : lapTime);
    document.getElementById('bestTime').textContent = formatTime(bestTime);
    const kmh = Math.round((player.speed / MAX_SPEED) * 300);
    document.getElementById('speedVal').textContent = String(kmh).padStart(3, '0');

    const rank = currentRank();
    document.getElementById('rankVal').textContent = `${rank}/${aiCars.length + 1}`;

    const nitroBar = document.getElementById('nitroFill');
    if (nitroBar) nitroBar.style.width = `${player.nitro}%`;
    const nitroBox = document.getElementById('hud-nitro');
    if (nitroBox) nitroBox.classList.toggle('nitro-active', !!nitroActive);
  }

  function render(nitroActive) {
    ctx.save();
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * 10 * shake, (Math.random() - 0.5) * 10 * shake);
    }
    ctx.clearRect(-20, -20, WIDTH + 40, HEIGHT + 40);
    drawSky();
    const playerWorldX = renderRoad();
    drawFinishLine(playerWorldX);
    drawBoostZones(playerWorldX);
    drawSprites(playerWorldX);
    drawSpeedLines();
    drawCar(nitroActive);
    ctx.restore();
    drawHUD(nitroActive);

    document.getElementById('pauseScreen').classList.toggle('hidden', state !== 'paused');
  }

  // ---------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------
  let lastTime = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    update(dt);
    const nitroActive = !!keys['Space'] && player.nitro > 0 && player.stun <= 0 && state === 'playing';
    render(nitroActive);
    requestAnimationFrame(loop);
  }

  document.getElementById('bestTime').textContent = formatTime(bestTime);
  requestAnimationFrame(loop);
})();
