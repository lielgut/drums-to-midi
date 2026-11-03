// 3D drum view: a WebGL drum kit (three.js) with notes falling onto each instrument.
// Shares state with app.js through its top-level globals (result, audio, activeView, COLORS, kitLook, ...).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

const wrap = document.getElementById("kit3d-wrap");
const hud = document.getElementById("kit3d-hud");
let renderer, labelRenderer, scene, camera, controls;
let pieces = null; // instrument meshes & per-lane note pools
let tween = null;

// Kit layout in metres, drummer sits at +z looking toward -z. `target` is where that lane's notes land.
const LANES = {
  42: { name: "Hi-hat", target: new THREE.Vector3(-0.75, 0.93, -0.05) },
  38: { name: "Snare", target: new THREE.Vector3(-0.38, 0.66, 0.12) },
  35: { name: "Kick", target: new THREE.Vector3(0, 0.07, 0.16) }, // the pedal
  47: { name: "Toms", target: new THREE.Vector3(0.55, 0.62, 0.05) }, // floor tom (rack toms flash too)
  49: { name: "Cymbals", target: new THREE.Vector3(-0.5, 1.33, -0.45) }, // crash (ride flashes too)
};
const SPAWN_OFFSET = new THREE.Vector3(0, 2.2, -0.2); // notes start this far above/behind their target
const MAX_NOTES = 160;

const VIEWS = {
  drummer: { pos: [0, 1.75, 1.9], target: [0, 0.85, -0.1] },
  front: { pos: [0, 1.3, -2.6], target: [0, 0.75, -0.1] },
  top: { pos: [0, 3.6, 0.01], target: [0, 0.6, -0.1] },
  side: { pos: [2.7, 1.3, 0], target: [0, 0.8, -0.1] },
};

function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  wrap.prepend(renderer.domElement);

  labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = "kit3d-labels";
  wrap.append(labelRenderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0c10);
  scene.fog = new THREE.Fog(0x0a0c10, 6, 14);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  camera = new THREE.PerspectiveCamera(48, 1, 0.05, 50);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 0.8;
  controls.maxDistance = 8;
  controls.minPolarAngle = 0; // full freedom: over the top…
  controls.maxPolarAngle = Math.PI; // …and from underneath
  controls.autoRotateSpeed = 1.2;
  setView("drummer", true);
  renderer.domElement.addEventListener("dblclick", () => setView("drummer"));

  // Lights: soft fill + a shadow-casting stage spot
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x20140c, 0.5));
  const spot = new THREE.SpotLight(0xffffff, 40, 12, Math.PI / 5, 0.5, 1.2);
  spot.position.set(1.2, 4, 2.2);
  spot.target.position.set(0, 0.5, -0.1);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  scene.add(spot, spot.target);
  const rim = new THREE.DirectionalLight(0x88aaff, 0.8);
  rim.position.set(-2, 2, -3);
  scene.add(rim);

  // Stage floor + rug
  const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 64), new THREE.MeshStandardMaterial({ color: 0x15171d, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  const rug = new THREE.Mesh(new THREE.CircleGeometry(1.35, 64), new THREE.MeshStandardMaterial({ color: 0x3a1f24, roughness: 1 }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0, 0.002, -0.1);
  rug.receiveShadow = true;
  scene.add(floor, rug);

  pieces = buildKit();
  buildLanes();

  new ResizeObserver(resize).observe(wrap);
  resize();
  renderer.setAnimationLoop(frame);
}

function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function setView(name, instant = false) {
  const v = VIEWS[name];
  const to = { pos: new THREE.Vector3(...v.pos), target: new THREE.Vector3(...v.target) };
  if (instant) {
    camera.position.copy(to.pos);
    controls.target.copy(to.target);
    controls.update();
    return;
  }
  tween = { from: { pos: camera.position.clone(), target: controls.target.clone() }, to, t0: performance.now(), dur: 700 };
}

// ---------------------------------------------------------------- kit geometry

const M = {
  chrome: () => new THREE.MeshStandardMaterial({ color: 0xdfe3ea, metalness: 1, roughness: 0.18 }),
  shell: (c) => new THREE.MeshStandardMaterial({ color: c, metalness: 0.4, roughness: 0.3 }),
  head: () => new THREE.MeshStandardMaterial({ color: 0xefeadf, roughness: 0.75, emissive: 0x000000 }),
  bronze: () => new THREE.MeshStandardMaterial({ color: 0xd4a842, metalness: 1, roughness: 0.28, emissive: 0x000000 }),
  dark: () => new THREE.MeshStandardMaterial({ color: 0x22252c, roughness: 0.6 }),
};

function shadows(obj) {
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return obj;
}

// A drum whose axis is +y; returns {group, head}. The batter head is on top.
function makeDrum(radius, depth, shellColor) {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, depth, 48, 1, true), M.shell(shellColor));
  shell.material.side = THREE.DoubleSide;
  const head = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.97, 48), M.head());
  head.rotation.x = -Math.PI / 2;
  head.position.y = depth / 2 + 0.002;
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.97, 48), M.head());
  bottom.rotation.x = Math.PI / 2;
  bottom.position.y = -depth / 2;
  const chrome = M.chrome();
  for (const y of [depth / 2, -depth / 2]) {
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.008, 8, 48), chrome);
    hoop.rotation.x = Math.PI / 2;
    hoop.position.y = y;
    g.add(hoop);
  }
  const lugs = Math.max(6, Math.round(radius * 50));
  for (let i = 0; i < lugs; i++) {
    const a = (i / lugs) * Math.PI * 2;
    const lug = new THREE.Mesh(new THREE.BoxGeometry(0.012, depth * 0.5, 0.018), chrome);
    lug.position.set(Math.cos(a) * (radius + 0.008), 0, Math.sin(a) * (radius + 0.008));
    lug.rotation.y = -a;
    g.add(lug);
  }
  g.add(shell, head, bottom);
  return { group: shadows(g), head };
}

function makeCymbal(radius) {
  const g = new THREE.Group();
  // A shallow cone (lathe) with a bell
  const pts = [new THREE.Vector2(0.0001, 0.03), new THREE.Vector2(radius * 0.18, 0.026), new THREE.Vector2(radius * 0.22, 0.012), new THREE.Vector2(radius, 0)];
  const mat = M.bronze();
  mat.side = THREE.DoubleSide;
  const disc = new THREE.Mesh(new THREE.LatheGeometry(pts, 64), mat);
  g.add(disc);
  return { group: shadows(g), mat };
}

function stand(x, z, top, legs = true) {
  const g = new THREE.Group();
  const chrome = M.chrome();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.012, top, 12), chrome);
  pole.position.set(x, top / 2, z);
  g.add(pole);
  if (legs) {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.3, 8), chrome);
      leg.position.set(x + Math.cos(a) * 0.1, 0.09, z + Math.sin(a) * 0.1);
      leg.lookAt(x, 0.26, z);
      leg.rotateX(Math.PI / 2);
      g.add(leg);
    }
  }
  return shadows(g);
}

function buildKit() {
  const red = 0xa3201a;
  const k = { flashables: {} };
  const add = (pitch, item) => (k.flashables[pitch] ||= []).push(item);

  // Kick drum lying on its side, batter head facing the drummer
  const kick = makeDrum(0.28, 0.42, red);
  kick.group.rotation.x = Math.PI / 2;
  kick.group.position.set(0, 0.29, -0.33);
  // the drum's "top" (+y) now faces +z → batter head faces the drummer
  scene.add(kick.group);
  add(35, { type: "drum", mesh: kick.head, group: kick.group, base: kick.group.position.clone() });
  // Pedal + beater
  const pedal = new THREE.Group();
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.015, 0.28), M.dark());
  board.position.set(0, 0.04, 0.17);
  board.rotation.x = -0.18;
  const beaterPivot = new THREE.Group();
  beaterPivot.position.set(0, 0.12, 0.02);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.22, 8), M.chrome());
  shaft.position.y = 0.11;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }));
  ball.position.y = 0.22;
  beaterPivot.add(shaft, ball);
  pedal.add(board, beaterPivot);
  scene.add(shadows(pedal));
  k.beater = beaterPivot;

  // Rack toms mounted on the kick, tilted toward the drummer
  for (const [x, r] of [[-0.17, 0.12], [0.17, 0.13]]) {
    const t = makeDrum(r, 0.2, red);
    t.group.position.set(x, 0.78, -0.27);
    t.group.rotation.x = 0.4;
    t.group.rotation.z = -x * 0.8;
    scene.add(t.group);
    add(47, { type: "drum", mesh: t.head, group: t.group, base: t.group.position.clone() });
  }
  const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 8), M.chrome());
  mount.position.set(0, 0.64, -0.3);
  scene.add(mount);

  // Floor tom on legs
  const ft = makeDrum(0.2, 0.38, red);
  ft.group.position.set(0.55, 0.42, 0.05);
  scene.add(ft.group);
  add(47, { type: "drum", mesh: ft.head, group: ft.group, base: ft.group.position.clone() });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.3;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.5, 8), M.chrome());
    leg.position.set(0.55 + Math.cos(a) * 0.23, 0.25, 0.05 + Math.sin(a) * 0.23);
    scene.add(shadows(leg));
  }

  // Snare (chrome shell) on a stand
  const sn = makeDrum(0.18, 0.14, 0xb9c0cc);
  sn.group.children.find((c) => c.geometry?.type === "CylinderGeometry" && c.material.side === THREE.DoubleSide).material = M.chrome();
  sn.group.position.set(-0.38, 0.59, 0.12);
  sn.group.rotation.z = 0.08;
  scene.add(sn.group, stand(-0.38, 0.12, 0.52));
  add(38, { type: "drum", mesh: sn.head, group: sn.group, base: sn.group.position.clone() });

  // Hi-hat: bottom cymbal fixed, top cymbal lifts/closes
  const hhBottom = makeCymbal(0.18);
  hhBottom.group.rotation.x = Math.PI; // cup facing down
  hhBottom.group.position.set(-0.75, 0.88, -0.05);
  const hhTop = makeCymbal(0.18);
  hhTop.group.position.set(-0.75, 0.9, -0.05);
  scene.add(hhBottom.group, hhTop.group, stand(-0.75, -0.05, 0.96));
  add(42, { type: "hihat", top: hhTop.group, mats: [hhTop.mat, hhBottom.mat], baseY: 0.9 });

  // Crash (left, high) and ride (right)
  const crash = makeCymbal(0.23);
  crash.group.position.set(-0.5, 1.3, -0.45);
  crash.group.rotation.set(0.35, 0, -0.15);
  scene.add(crash.group, stand(-0.5, -0.45, 1.3));
  add(49, { type: "cymbal", group: crash.group, mat: crash.mat, rot: crash.group.rotation.clone() });
  const ride = makeCymbal(0.27);
  ride.group.position.set(0.82, 1.05, -0.42);
  ride.group.rotation.set(0.25, 0, 0.2);
  scene.add(ride.group, stand(0.82, -0.42, 1.05));
  add(49, { type: "cymbal", group: ride.group, mat: ride.mat, rot: ride.group.rotation.clone(), wobble: 0.5 });

  // A coloured point light at each lane target — lights up the kit on hits
  k.lights = {};
  for (const [p, lane] of Object.entries(LANES)) {
    const l = new THREE.PointLight(new THREE.Color(COLORS[p]), 0, 1.4, 1.5);
    l.position.copy(lane.target).add(new THREE.Vector3(0, 0.15, 0.05));
    scene.add(l);
    k.lights[p] = l;
  }
  return k;
}

// ---------------------------------------------------------------- note lanes

function buildLanes() {
  pieces.lanes = {};
  const gemGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.022, 32);
  const tickGeo = new THREE.TorusGeometry(0.045, 0.003, 6, 32);
  for (const [p, lane] of Object.entries(LANES)) {
    const color = new THREE.Color(COLORS[p]);
    const spawn = lane.target.clone().add(SPAWN_OFFSET);

    // Guide rail from spawn to target
    const dir = lane.target.clone().sub(spawn);
    const rail = new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.004, dir.length(), 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25 })
    );
    rail.position.copy(spawn).addScaledVector(dir, 0.5);
    rail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    scene.add(rail);

    // Landing marker + hit shockwave
    const marker = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.085, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
    marker.rotation.x = -Math.PI / 2;
    marker.position.copy(lane.target).add(new THREE.Vector3(0, 0.01, 0));
    const wave = marker.clone();
    wave.material = marker.material.clone();
    scene.add(marker, wave);

    // Note gems (instanced)
    const gemMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.45, metalness: 0.1, roughness: 0.35 });
    const gems = new THREE.InstancedMesh(gemGeo, gemMat, MAX_NOTES);
    gems.count = 0;
    gems.frustumCulled = false;
    scene.add(gems);

    // Beat ticks along the rail
    const ticks = new THREE.InstancedMesh(tickGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 }), 24);
    ticks.count = 0;
    ticks.frustumCulled = false;
    scene.add(ticks);

    // Floating label
    const div = document.createElement("div");
    div.className = "kit3d-label";
    div.textContent = lane.name;
    div.style.color = COLORS[p];
    const label = new CSS2DObject(div);
    label.position.copy(lane.target).add(new THREE.Vector3(0, -0.09, 0.12));
    scene.add(label);

    pieces.lanes[p] = { spawn, target: lane.target, gems, ticks, marker, wave };
  }
}

// ---------------------------------------------------------------- per-frame update

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3();
const flatQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

function frame() {
  if (activeView !== "kit3d" || !result) return;
  if (tween) {
    const k = Math.min(1, (performance.now() - tween.t0) / tween.dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    camera.position.lerpVectors(tween.from.pos, tween.to.pos, e);
    controls.target.lerpVectors(tween.from.target, tween.to.target, e);
    if (k === 1) tween = null;
  }
  controls.update();

  const now = audio.currentTime;
  const rate = audio.playbackRate || 1;
  const look = kitLook;
  const notes = result.notes;

  const flash = hitFlash(now, rate); // shared with the 2D view (app.js)

  // Falling gems
  const counts = {};
  for (const p of LANE_ORDER) counts[p] = 0;
  for (let i = lowerBound(notes, now - gameTail(rate)); i < notes.length && notes[i].time <= now + look; i++) {
    const n = notes[i];
    const lane = pieces.lanes[n.pitch];
    if (!lane || counts[n.pitch] >= MAX_NOTES || gameHides(i)) continue;
    const prog = 1 - (n.time - now) / look;
    tmpP.lerpVectors(lane.spawn, lane.target, prog);
    const sz = 0.75 + 0.5 * (n.velocity / 127);
    tmpS.set(sz, sz, sz);
    tmpM.compose(tmpP, tmpQ.identity(), tmpS);
    lane.gems.setMatrixAt(counts[n.pitch]++, tmpM);
  }
  for (const p of LANE_ORDER) {
    const lane = pieces.lanes[p];
    lane.gems.count = counts[p];
    lane.gems.instanceMatrix.needsUpdate = true;
  }

  // Beat ticks along each rail
  const offset = Number(document.getElementById("bar-offset").value) * 4;
  const b0 = Math.ceil(timeToSlot(now) / 4), b1 = Math.floor(timeToSlot(now + look) / 4);
  for (const p of LANE_ORDER) {
    const lane = pieces.lanes[p];
    let c = 0;
    for (let b = b0; b <= b1 && c < 24; b++) {
      const prog = 1 - (slotToTime(b * 4) - now) / look;
      if (prog < 0 || prog > 1) continue;
      const isBar = (((b * 4 + offset) % 16) + 16) % 16 === 0;
      tmpP.lerpVectors(lane.spawn, lane.target, prog);
      const sz = isBar ? 1.6 : 1;
      tmpS.set(sz, sz, sz);
      tmpM.compose(tmpP, flatQ, tmpS);
      lane.ticks.setMatrixAt(c++, tmpM);
    }
    lane.ticks.count = c;
    lane.ticks.instanceMatrix.needsUpdate = true;

    // Landing marker + expanding shockwave
    const f = flash[p];
    lane.marker.material.opacity = 0.45 + 0.55 * f;
    lane.wave.visible = f > 0.02;
    const r = 1 + (1 - f) * 2.2;
    lane.wave.scale.set(r, r, r);
    lane.wave.material.opacity = f;
    pieces.lights[p].intensity = f * 3;
  }

  // Instrument reactions
  const t = performance.now() / 1000;
  for (const [p, items] of Object.entries(pieces.flashables)) {
    const f = flash[p];
    const col = new THREE.Color(COLORS[p]);
    for (const it of items) {
      if (it.type === "drum") {
        it.mesh.material.emissive.copy(col);
        it.mesh.material.emissiveIntensity = f * 1.2;
        it.group.position.copy(it.base);
        it.group.position.y -= f * 0.006; // the drum gives a little on impact
      } else if (it.type === "cymbal") {
        it.mat.emissive.copy(col);
        it.mat.emissiveIntensity = f * 0.6;
        const w = (it.wobble ?? 1) * f;
        it.group.rotation.set(it.rot.x + Math.sin(t * 38) * 0.08 * w, it.rot.y, it.rot.z + Math.cos(t * 31) * 0.08 * w);
      } else if (it.type === "hihat") {
        it.top.position.y = it.baseY + 0.012 * (1 - f); // closes on a hit
        for (const m of it.mats) { m.emissive.copy(col); m.emissiveIntensity = f * 0.6; }
      }
    }
  }
  pieces.beater.rotation.x = 0.3 - 0.82 * flash[35]; // rests back, swings into the kick head on a hit

  const slot = Math.floor(timeToSlot(now) + 0.25) + offset;
  hud.textContent = `Bar ${Math.floor(slot / 16) + 1} · Beat ${Math.floor((((slot % 16) + 16) % 16) / 4) + 1} · ${Math.round(result.tempo * rate)} BPM`;

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

// ---------------------------------------------------------------- controls wiring

document.querySelectorAll("[data-cam]").forEach((b) => b.addEventListener("click", () => {
  if (!renderer) return;
  controls.autoRotate = false;
  document.getElementById("autorotate").checked = false;
  setView(b.dataset.cam);
}));
document.getElementById("autorotate").addEventListener("change", (e) => { if (controls) controls.autoRotate = e.target.checked; });

// Screen position (px, relative to the 3D view) of a lane's landing target — used by game mode overlays.
window.kit3dScreenPos = (pitch) => {
  if (!renderer || !LANES[pitch]) return null;
  const v = LANES[pitch].target.clone().project(camera);
  return { x: ((v.x + 1) / 2) * wrap.clientWidth, y: ((1 - v.y) / 2) * wrap.clientHeight, visible: v.z < 1 };
};

window.kit3dShown = () => {
  try {
    if (!renderer) init();
    resize();
  } catch (err) {
    console.error(err);
    wrap.textContent = "3D view needs WebGL, which isn't available in this browser.";
  }
};
if (activeView === "kit3d") window.kit3dShown();
