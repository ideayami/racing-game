/* =========================================================
   NEON APEX GP — a small pseudo-3D (Mode-7 / OutRun-style)
   racing game rendered on a single <canvas> with no
   external game libraries.

   How the 3D illusion works (short version):
   - The track is a list of flat "segments" of fixed length.
   - Each segment has a `curve` value; accumulating curve
     across segments produces a lateral centerline offset,
     which is what makes the road bend on screen.
   - For every horizontal pixel row below the horizon we
     work out how far ahead on the track that row represents,
     then project the track's centerline + width for that
     distance into a screen X position and width. Rows near
     the horizon represent far-away track (small scale), rows
     near the bottom represent nearby track (large scale).
   ========================================================= */

(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const WIDTH = canvas.width;
  const HEIGHT = canvas.height;
  const HORIZON = HEIGHT * 0.42;

  // ---- Camera / projection constants ----
  const CAMERA_HEIGHT = 900;
  const FOCAL_LENGTH = 260;
  const ROAD_HALF_WIDTH = 500;
  const SEGMENT_LENGTH = 100;
  const DRAW_DISTANCE_SPRITES = 3200;
  const GROUP_LENGTH = 300; // rumble/road color alternation period

  // ---- Race rules ----
  const TOTAL_LAPS = 3;

  // ---- Player physics constants ----
  const MAX_SPEED = 300;         // world units / sec
  const OFFROAD_MAX_SPEED = 110;
  const ACCEL = 160;
  const BRAKE = 420;
  const FRICTION = 70;
  const STEER_SPEED = 2.6;       // lateral units/sec at full speed
  const CENTRIFUGAL = 3.2;
  const X_LIMIT = 1.7;           // how far off-road you can drift before it's pointless

  // ---------------------------------------------------------
  // Track construction
  // ---------------------------------------------------------
  function buildTrack() {
    const segments = [];
    const addStraight = (n) => { for (let i = 0; i < n; i++) segments.push({ curve: 0 }); };
    const addCurve = (n, c) => { for (let i = 0; i < n; i++) segments.push({ curve: c }); };

    addStraight(15);
    addCurve(10, 0.055);   // sweeping right
    addStraight(8);
    addCurve(20, -0.055);  // long left hairpin sweep
    addCurve(10, 0.055);   // right to cancel curvature and rejoin start
    addStraight(8);

    let x = 0, z = 0;
    for (const s of segments) {
      s.z0 = z; s.centerX0 = x;
      x += s.curve;
      z += SEGMENT_LENGTH;
      s.z1 = z; s.centerX1 = x;
    }
    return { segments, length: z };
  }

  function wrap(z, len) { return ((z % len) + len) % len; }

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

  function curveAt(track, zAbs) {
    return segmentAt(track, zAbs).curve;
  }

  function buildSprites(track) {
    const sprites = [];
    for (let z = 0; z < track.length; z += 300) {
      const side = (Math.floor(z / 300) % 2 === 0) ? 1 : -1;
      sprites.push({ z, side });
    }
    return sprites;
  }

  const track = buildTrack();
  const sprites = buildSprites(track);

  // ---------------------------------------------------------
  // Game state
  // ---------------------------------------------------------
  const STORAGE_KEY = 'neonApexGp.bestTime';

  const player = { z: 0, x: 0, speed: 0 };
  let lapsCompleted = 0;
  let raceTime = 0;
  let lapTime = 0;
  let bestTime = Number(localStorage.getItem(STORAGE_KEY)) || null;

  let state = 'title'; // title | playing | paused | finished
  const keys = {};

  function resetRace() {
    player.z = 0; player.x = 0; player.speed = 0;
    lapsCompleted = 0; raceTime = 0; lapTime = 0;
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
  function update(dt) {
    if (state !== 'playing') return;

    const accelInput = keys['ArrowUp'] || keys['KeyW'];
    const brakeInput = keys['ArrowDown'] || keys['KeyS'];
    const leftInput = keys['ArrowLeft'] || keys['KeyA'];
    const rightInput = keys['ArrowRight'] || keys['KeyD'];

    const onRoad = Math.abs(player.x) <= 1;
    const maxSpeed = onRoad ? MAX_SPEED : OFFROAD_MAX_SPEED;

    if (accelInput) player.speed += ACCEL * dt;
    else if (brakeInput) player.speed -= BRAKE * dt;
    else player.speed -= FRICTION * dt;

    player.speed = Math.max(0, Math.min(player.speed, Math.max(maxSpeed, player.speed - FRICTION * dt)));
    if (player.speed > maxSpeed) player.speed = Math.max(maxSpeed, player.speed - BRAKE * 0.6 * dt);

    const speedRatio = player.speed / MAX_SPEED;
    const steerAmt = STEER_SPEED * dt * (0.35 + 0.65 * speedRatio);
    if (leftInput) player.x -= steerAmt;
    if (rightInput) player.x += steerAmt;

    const curve = curveAt(track, player.z);
    player.x -= curve * CENTRIFUGAL * speedRatio * dt;

    player.x = Math.max(-X_LIMIT, Math.min(X_LIMIT, player.x));

    player.z += player.speed * dt;
    raceTime += dt;
    lapTime += dt;

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

  function drawSky() {
    const grad = ctx.createLinearGradient(0, 0, 0, HORIZON);
    grad.addColorStop(0, '#1a0a3a');
    grad.addColorStop(0.6, '#3a1257');
    grad.addColorStop(1, '#7c1f5e');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WIDTH, HORIZON);

    // simple synthwave sun
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
    // sun stripes
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

      ctx.fillStyle = groupColor(zAbs, '#3a3a4a', '#33334a');
      ctx.fillRect(screenCenterX - roadHalfScreen, y, roadHalfScreen * 2, 1);

      if (Math.floor(wrap(zAbs, track.length) / 200) % 2 === 0) {
        const dashHalf = Math.max(1, roadHalfScreen * 0.035);
        ctx.fillStyle = '#f4f1ea';
        ctx.fillRect(screenCenterX - dashHalf, y, dashHalf * 2, 1);
      }
    }

    return playerWorldX;
  }

  function drawFinishLine(playerWorldX) {
    // checkered banner near z=0 of the lap
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
      visible.push({ ...s, d });
    }
    visible.sort((a, b) => b.d - a.d);

    for (const s of visible) {
      const scale = FOCAL_LENGTH / s.d;
      const rowFromHorizon = (CAMERA_HEIGHT * FOCAL_LENGTH) / s.d;
      const y = HORIZON + rowFromHorizon;
      const centerX = centerXAt(track, player.z + s.d);
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

      // small cap/banner top
      ctx.fillStyle = '#f4f1ea';
      ctx.fillRect(screenX - poleW, y - poleH - poleW * 0.6, poleW * 2, poleW * 0.6);
    }
  }

  function drawCar() {
    const cx = WIDTH / 2;
    const baseY = HEIGHT - 46;
    const lean = Math.max(-14, Math.min(14, (player.x) * 10));
    ctx.save();
    ctx.translate(cx + lean, baseY);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(0, 34, 60, 12, 0, 0, Math.PI * 2);
    ctx.fill();

    // body
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

    // cockpit
    ctx.fillStyle = '#0d0221';
    ctx.fillRect(-18, -22, 36, 16);

    // tail lights
    ctx.fillStyle = '#08d9d6';
    ctx.fillRect(-44, 24, 10, 8);
    ctx.fillRect(34, 24, 10, 8);

    ctx.restore();
  }

  function drawHUD() {
    document.getElementById('curTime').textContent = formatTime(state === 'title' ? 0 : lapTime);
    document.getElementById('bestTime').textContent = formatTime(bestTime);
    const kmh = Math.round((player.speed / MAX_SPEED) * 260);
    document.getElementById('speedVal').textContent = String(kmh).padStart(3, '0');
  }

  function render() {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    drawSky();
    const playerWorldX = renderRoad();
    drawFinishLine(playerWorldX);
    drawSprites(playerWorldX);
    drawCar();
    drawHUD();

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
    render();
    requestAnimationFrame(loop);
  }

  document.getElementById('bestTime').textContent = formatTime(bestTime);
  requestAnimationFrame(loop);
})();
