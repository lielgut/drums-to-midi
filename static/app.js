// Drums → MIDI front-end: job control, playback (audio + synthesized MIDI), drum roll and VexFlow drum sheet.
const $ = (s) => document.querySelector(s);
const LANES = { 49: "cymbals", 42: "hihat", 47: "toms", 38: "snare", 35: "kick" };
const LANE_ORDER = [49, 42, 47, 38, 35]; // top → bottom
const COLORS = {};
const css = getComputedStyle(document.documentElement);
for (const [p, n] of Object.entries(LANES)) COLORS[p] = css.getPropertyValue(`--${n}`).trim();
// Darker variants for noteheads on the light sheet background.
const SHEET_COLORS = { 35: "#c94a16", 38: "#157fa3", 47: "#6a3fd9", 42: "#9a6b00", 49: "#17875a" };
// Percussion-clef positions (standard drum-kit notation).
const NOTATION = { 35: "f/4", 38: "c/5", 47: "e/5", 42: "g/5/x2", 49: "a/5/x2" };

let jobId = null;
let result = null;
let pollTimer = null;

// ---------------------------------------------------------------- jobs

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("#url").value.trim();
  $("#go").disabled = true;
  try {
    const r = await fetch("/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Failed to start");
    openJob(j.id);
  } catch (err) {
    alert(err.message);
    $("#go").disabled = false;
  }
});

// ---------------------------------------------------------------- MIDI upload

async function uploadMidi(file) {
  if (!file) return;
  if (!/\.midi?$/i.test(file.name)) { alert("Please choose a .mid or .midi file"); return; }
  const body = new FormData();
  body.append("file", file);
  $("#go").disabled = true;
  try {
    const r = await fetch("/api/upload", { method: "POST", body });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Upload failed");
    openJob(j.id);
  } catch (err) {
    alert(err.message);
    $("#go").disabled = false;
  } finally {
    $("#midi-file").value = "";
  }
}
$("#midi-file").addEventListener("change", (e) => uploadMidi(e.target.files[0]));
const formCard = $("#form").closest(".card");
formCard.addEventListener("dragover", (e) => { e.preventDefault(); formCard.classList.add("dragover"); });
formCard.addEventListener("dragleave", () => formCard.classList.remove("dragover"));
formCard.addEventListener("drop", (e) => {
  e.preventDefault();
  formCard.classList.remove("dragover");
  uploadMidi(e.dataTransfer.files[0]);
});

const isMidiJob = () => result?.source === "midi";

function openJob(id) {
  jobId = id;
  history.replaceState(null, "", `?job=${id}`);
  stopPlayback();
  $("#results").classList.add("hidden");
  $("#progress").classList.remove("hidden");
  clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, 1000);
}

async function poll() {
  const r = await fetch(`/api/jobs/${jobId}`);
  if (!r.ok) { clearInterval(pollTimer); return; }
  const s = await r.json();
  renderProgress(s);
  if (s.state === "done" || s.state === "error") {
    clearInterval(pollTimer);
    $("#go").disabled = false;
    loadHistory();
    if (s.state === "done") { $("#progress").classList.add("hidden"); loadResult(); }
  }
}

function renderProgress(s) {
  const steps = ["download", "separate", "transcribe"];
  const cur = steps.indexOf(s.step);
  document.querySelectorAll(".step").forEach((el, i) => {
    el.className = "step";
    if (s.state === "done" || i < cur) el.classList.add("done");
    else if (i === cur) el.classList.add(s.state === "error" ? "error" : "active");
    el.querySelector(".bar i").style.width = i === cur ? `${Math.round((s.progress || 0) * 100)}%` : "0";
  });
  $("#message").textContent = s.message || "";
  $("#message").className = s.state === "error" ? "error" : "";
  $("#log").textContent = (s.log || []).join("\n");
}

async function loadHistory() {
  const jobs = await (await fetch("/api/jobs")).json();
  $("#history").innerHTML = "";
  for (const j of jobs) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.textContent = j.title || j.url;
    a.onclick = () => openJob(j.id);
    const st = document.createElement("span");
    st.className = "state";
    st.textContent = j.state;
    li.append(a, st);
    $("#history").append(li);
  }
  $("#history-wrap").classList.toggle("hidden", jobs.length === 0);
}

async function loadResult() {
  result = await (await fetch(`/api/jobs/${jobId}/files/result.json`)).json();
  const f = (n) => `/api/jobs/${jobId}/files/${n}`;
  $("#dl-mp3").href = f("song.mp3");
  $("#dl-wav").href = f("drums.wav");
  $("#dl-mid").href = f("drums.mid");
  $("#dl-qmid").href = f("drums_quantized.mid");
  $("#dl-mp3").download = "song.mp3";
  $("#dl-wav").download = "drums.wav";
  $("#title").textContent = result.title;
  $("#bar-offset").value = String(result.bar_offset || 0);
  // MIDI uploads have no audio: hide audio-only controls; a silent clock track drives playback.
  for (const id of ["#dl-mp3", "#dl-wav", "#source-wrap", "#audio-vol-wrap", "#sens-card"]) {
    $(id).classList.toggle("hidden", isMidiJob());
  }
  setAudioSource();
  $("#results").classList.remove("hidden");
  if (!isMidiJob()) buildThresholds();
  onResultChanged();
}

function onResultChanged() {
  const counts = {};
  for (const n of result.notes) counts[n.pitch] = (counts[n.pitch] || 0) + 1;
  $("#stats").textContent =
    (isMidiJob() ? "From MIDI file · " : "") +
    `~${Math.round(result.tempo)} BPM · ${result.notes.length} hits · ` +
    result.instruments.map((i) => `${i.name} ${counts[i.pitch] || 0}`).join(" · ") +
    (result.elapsed ? ` · processed in ${Math.round(result.elapsed)}s` : "");
  $("#legend").innerHTML = result.instruments
    .map((i) => `<span><i style="background:${COLORS[i.pitch]}"></i>${i.name}</span>`).join("");
  resetScheduler();
  drawRoll(); drawKit();
  renderSheet();
}

// ---------------------------------------------------------------- sensitivity

let retuneTimer = null;
function buildThresholds() {
  const box = $("#thresholds");
  box.innerHTML = "";
  result.instruments.forEach((inst, i) => {
    const d = document.createElement("div");
    d.className = "th";
    d.innerHTML = `<span style="color:${COLORS[inst.pitch]}">${inst.name}: <b>${result.thresholds[i].toFixed(2)}</b></span>
      <input type="range" min="0.05" max="0.9" step="0.01" value="${result.thresholds[i]}">`;
    const input = d.querySelector("input");
    input.addEventListener("input", () => {
      d.querySelector("b").textContent = Number(input.value).toFixed(2);
      clearTimeout(retuneTimer);
      retuneTimer = setTimeout(retune, 250);
    });
    box.append(d);
  });
}

async function retune() {
  const thresholds = [...document.querySelectorAll("#thresholds input")].map((i) => Number(i.value));
  const r = await fetch(`/api/jobs/${jobId}/retune`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thresholds, bar_offset: Number($("#bar-offset").value) }),
  });
  if (r.ok) { result = await r.json(); onResultChanged(); }
}
$("#bar-offset").addEventListener("change", retune);

// ---------------------------------------------------------------- playback

const audio = $("#audio");
let ctx = null;
let masterGain = null;
let noiseBuf = null;
let nextNoteIdx = 0;

function setAudioSource() {
  const src = $("#source").value;
  const t = audio.currentTime || 0;
  const wasPlaying = !audio.paused;
  const file = isMidiJob() ? "clock.wav" : src === "song" ? "song.mp3" : "drums.wav";
  audio.src = `/api/jobs/${jobId}/files/${file}`;
  audio.volume = src === "none" || isMidiJob() ? 0 : Number($("#audio-vol").value);
  audio.addEventListener("loadedmetadata", () => {
    applySpeed();
    audio.currentTime = t;
    if (wasPlaying) audio.play();
    updateTime();
  }, { once: true });
}
$("#source").addEventListener("change", setAudioSource);

// ---------------------------------------------------------------- slow motion

function applySpeed() {
  const rate = Number($("#speed").value);
  // Setting src resets playbackRate to defaultPlaybackRate, so set both.
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;
  audio.preservesPitch = true;
  $("#speed-bpm").textContent = result ? `≈ ${Math.round(result.tempo * rate)} BPM` : "";
}
$("#speed").addEventListener("change", applySpeed);
$("#audio-vol").addEventListener("input", (e) => {
  if ($("#source").value !== "none" && !isMidiJob()) audio.volume = Number(e.target.value);
});
$("#midi-vol").addEventListener("input", (e) => { if (masterGain) masterGain.gain.value = Number(e.target.value); });

function ensureAudioCtx() {
  if (ctx) return;
  ctx = new AudioContext();
  masterGain = ctx.createGain();
  masterGain.gain.value = Number($("#midi-vol").value);
  masterGain.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

$("#play").addEventListener("click", () => {
  ensureAudioCtx();
  ctx.resume();
  if (audio.paused) { resetScheduler(); audio.play(); } else audio.pause();
});
audio.addEventListener("play", () => { $("#play").textContent = "❚❚"; requestAnimationFrame(tick); });
audio.addEventListener("pause", () => { $("#play").textContent = "▶"; });
audio.addEventListener("seeked", resetScheduler);
audio.addEventListener("ended", () => { $("#play").textContent = "▶"; });

function stopPlayback() { audio.pause(); }

function seekTo(t) {
  audio.currentTime = Math.max(0, Math.min(t, audio.duration || t));
  resetScheduler();
  updateTime();
  drawRoll(); drawKit();
  highlightMeasure();
}

$("#seek").addEventListener("input", (e) => {
  if (audio.duration) seekTo((e.target.value / 1000) * audio.duration);
});

function resetScheduler() {
  if (!result) return;
  const t = audio.currentTime;
  nextNoteIdx = result.notes.findIndex((n) => n.time >= t - 0.01);
  if (nextNoteIdx < 0) nextNoteIdx = result.notes.length;
}

function scheduleNotes() {
  if (!ctx || audio.paused || game.open) return; // in game mode the player makes the drum sounds
  const rate = audio.playbackRate || 1;
  const lookahead = 0.15 * rate; // in song time
  const now = audio.currentTime;
  while (nextNoteIdx < result.notes.length && result.notes[nextNoteIdx].time < now + lookahead) {
    const n = result.notes[nextNoteIdx++];
    const when = ctx.currentTime + Math.max(0, n.time - now) / rate;
    playDrum(n.pitch, when, n.velocity / 127);
  }
}

// Tiny Web Audio drum synth so the MIDI can be heard without a soundfont.
function playDrum(pitch, when, vel) {
  const out = ctx.createGain();
  out.connect(masterGain);
  const env = (g, peak, dur) => {
    g.gain.setValueAtTime(peak * vel, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  };
  const noise = (hp, dur, peak, bp) => {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = bp ? "bandpass" : "highpass";
    f.frequency.value = hp;
    const g = ctx.createGain();
    env(g, peak, dur);
    s.connect(f).connect(g).connect(out);
    s.start(when, Math.random());
    s.stop(when + dur + 0.05);
  };
  const tone = (f0, f1, dur, peak, type = "sine") => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, when);
    o.frequency.exponentialRampToValueAtTime(f1, when + dur * 0.6);
    const g = ctx.createGain();
    env(g, peak, dur);
    o.connect(g).connect(out);
    o.start(when);
    o.stop(when + dur + 0.05);
  };
  switch (Number(pitch)) {
    case 35: tone(160, 45, 0.35, 1.0); break;
    case 38: noise(1200, 0.18, 0.55); tone(220, 160, 0.1, 0.4, "triangle"); break;
    case 47: tone(180, 90, 0.4, 0.8); break;
    case 42: noise(7500, 0.05, 0.35); break;
    case 49: noise(5000, 1.1, 0.25); break;
  }
}

function fmt(t) {
  if (!isFinite(t)) return "0:00";
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
}
function updateTime() {
  $("#time").textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
  if (audio.duration) $("#seek").value = (audio.currentTime / audio.duration) * 1000;
}

function tick() {
  scheduleNotes();
  updateTime();
  rollStart = null; // follow the playhead
  drawRoll(); drawKit();
  highlightMeasure();
  if (!audio.paused) requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- beat grid helpers

function timeToSlot(t) {
  // Fractional 16th-note index (0 == first tracked beat), mirroring the server-side grid.
  const b = result.beats;
  const period = 60 / result.tempo;
  if (!b.length) return (t / period) * 4;
  if (t <= b[0]) return ((t - b[0]) / period) * 4;
  if (t >= b[b.length - 1]) return (b.length - 1 + (t - b[b.length - 1]) / period) * 4;
  let lo = 0, hi = b.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (b[m] <= t) lo = m; else hi = m; }
  return (lo + (t - b[lo]) / (b[hi] - b[lo])) * 4;
}
function slotToTime(s) {
  const b = result.beats;
  const period = 60 / result.tempo;
  const beat = s / 4;
  if (!b.length) return beat * period;
  if (beat <= 0) return b[0] + beat * period;
  if (beat >= b.length - 1) return b[b.length - 1] + (beat - (b.length - 1)) * period;
  const i = Math.floor(beat);
  return b[i] + (beat - i) * (b[i + 1] - b[i]);
}

// ---------------------------------------------------------------- drum roll

const roll = $("#roll");
let rollStart = null; // null => follow playhead
let windowSec = 8;
$("#zoom").addEventListener("input", (e) => {
  windowSec = Number(e.target.value);
  $("#zoom-label").textContent = `${windowSec}s`;
  drawRoll(); drawKit();
});

function rollView() {
  const start = rollStart ?? Math.max(0, audio.currentTime - windowSec * 0.25);
  return { start, end: start + windowSec };
}

function drawRoll() {
  if (!result || activeView !== "roll") return;
  const dpr = window.devicePixelRatio || 1;
  const W = roll.clientWidth, H = roll.clientHeight;
  if (roll.width !== W * dpr) { roll.width = W * dpr; roll.height = H * dpr; }
  const g = roll.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const labelW = 70;
  const laneH = H / LANE_ORDER.length;
  const { start, end } = rollView();
  const x = (t) => labelW + ((t - start) / (end - start)) * (W - labelW);

  // lanes
  LANE_ORDER.forEach((p, i) => {
    g.fillStyle = i % 2 ? "#10131a" : "#0c0e12";
    g.fillRect(0, i * laneH, W, laneH);
    g.fillStyle = COLORS[p];
    g.font = "12px -apple-system, sans-serif";
    g.textBaseline = "middle";
    g.fillText(result.instruments.find((x) => x.pitch === p).name, 10, i * laneH + laneH / 2);
  });

  // beat & bar lines
  const offset = Number($("#bar-offset").value) * 4;
  const s0 = Math.floor(timeToSlot(start) / 4) * 4, s1 = Math.ceil(timeToSlot(end));
  for (let s = s0; s <= s1; s += 4) {
    const t = slotToTime(s), px = x(t);
    if (px < labelW) continue;
    const isBar = ((s + offset) % 16 + 16) % 16 === 0;
    g.strokeStyle = isBar ? "#3a4252" : "#1e232d";
    g.lineWidth = isBar ? 1.5 : 1;
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
    if (isBar) {
      g.fillStyle = "#5b6477";
      g.fillText(String(Math.floor((s + offset) / 16) + 1), px + 3, 8);
    }
  }

  // notes
  const noteW = Math.max(3, Math.min(10, (W - labelW) / windowSec / 25));
  for (const n of result.notes) {
    if (n.time < start - 0.1 || n.time > end) continue;
    const lane = LANE_ORDER.indexOf(n.pitch);
    const px = x(n.time);
    if (px < labelW) continue;
    g.globalAlpha = 0.35 + 0.65 * (n.velocity / 127);
    g.fillStyle = COLORS[n.pitch];
    g.beginPath();
    g.roundRect(px - noteW / 2, lane * laneH + laneH * 0.2, noteW, laneH * 0.6, 2);
    g.fill();
  }
  g.globalAlpha = 1;

  // playhead
  const ph = x(audio.currentTime);
  if (ph >= labelW) {
    g.strokeStyle = "#fff"; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(ph, 0); g.lineTo(ph, H); g.stroke();
  }
}

let drag = null;
roll.addEventListener("mousedown", (e) => { drag = { x: e.clientX, start: rollView().start, moved: false }; });
window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  if (Math.abs(dx) > 3) drag.moved = true;
  if (drag.moved) {
    rollStart = Math.max(0, drag.start - (dx / (roll.clientWidth - 70)) * windowSec);
    drawRoll(); drawKit();
  }
});
window.addEventListener("mouseup", (e) => {
  if (drag && !drag.moved) {
    const rect = roll.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px > 70) {
      const { start, end } = rollView();
      rollStart = null;
      seekTo(start + ((px - 70) / (rect.width - 70)) * (end - start));
    }
  }
  drag = null;
});
roll.addEventListener("wheel", (e) => {
  e.preventDefault();
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  rollStart = Math.max(0, rollView().start + (d / 500) * windowSec);
  drawRoll(); drawKit();
}, { passive: false });
window.addEventListener("resize", () => { drawRoll(); drawKit(); renderSheet(); });

// ---------------------------------------------------------------- drum sheet (VexFlow)

let measureBoxes = []; // [{measure, x, y, w, h}]
let firstMeasure = 0;

// measure -> slot(0..15) -> Set(pitch), honoring the bar offset.
function buildMeasures() {
  const offset = Number($("#bar-offset").value) * 4;
  const measures = new Map();
  for (const q of result.quantized) {
    const s = q.slot + offset;
    const m = Math.floor(s / 16), pos = ((s % 16) + 16) % 16;
    if (!measures.has(m)) measures.set(m, Array.from({ length: 16 }, () => new Set()));
    measures.get(m)[pos].add(q.pitch);
  }
  if (!measures.size) return null;
  const keys = [...measures.keys()];
  const first = Math.min(...keys);
  return { measures, first, total: Math.max(...keys) - first + 1 };
}

const LINE_H = 120;

// Draw measures [from, to) of `data` into `el` as one SVG. Returns the measure boxes.
function drawMeasures(el, data, { from, to, width, perLine, color = true }) {
  const VF = Vex.Flow;
  const mW = Math.floor((width - 20) / perLine);
  const lines = Math.ceil((to - from) / perLine);
  const renderer = new VF.Renderer(el, VF.Renderer.Backends.SVG);
  renderer.resize(width, lines * LINE_H + 20);
  const c = renderer.getContext();
  const boxes = [];
  for (let i = from; i < to; i++) {
    const m = data.first + i;
    const k = i - from;
    const row = Math.floor(k / perLine), col = k % perLine;
    const xPos = 10 + col * mW, yPos = 10 + row * LINE_H;
    const stave = new VF.Stave(xPos, yPos, mW);
    if (col === 0) stave.addClef("percussion");
    if (i === 0) stave.addTimeSignature("4/4");
    stave.setMeasure(i + 1);
    stave.setContext(c).draw();

    const slots = data.measures.get(m) || Array.from({ length: 16 }, () => new Set());
    const notes = measureNotes(VF, slots, color);
    const voice = new VF.Voice({ num_beats: 4, beat_value: 4 }).setMode(VF.Voice.Mode.SOFT);
    voice.addTickables(notes);
    const beams = VF.Beam.generateBeams(notes, { groups: [new VF.Fraction(1, 4)], stem_direction: 1 });
    new VF.Formatter().joinVoices([voice]).format([voice], stave.getNoteEndX() - stave.getNoteStartX() - 10);
    voice.draw(c, stave);
    beams.forEach((b) => b.setContext(c).draw());
    boxes.push({ measure: m, x: xPos, y: yPos, w: mW, h: LINE_H - 10 });
  }
  return boxes;
}

function renderSheet() {
  // Hidden panels have no width; render when the sheet tab is shown.
  if (activeView !== "sheet") { sheetDirty = true; return; }
  sheetDirty = false;
  const el = $("#sheet");
  el.innerHTML = "";
  measureBoxes = [];
  if (!result || !window.Vex) {
    el.textContent = window.Vex ? "" : "Notation library failed to load (needs internet).";
    return;
  }
  const data = buildMeasures();
  if (!data) { el.textContent = "No drum hits detected."; return; }
  firstMeasure = data.first;
  const width = el.clientWidth || 1000;
  const perLine = width > 900 ? 4 : width > 600 ? 3 : 2;
  measureBoxes = drawMeasures(el, data, { from: 0, to: data.total, width, perLine });
  highlightMeasure(true);
}

// ---------------------------------------------------------------- sheet → PDF

$("#dl-pdf").addEventListener("click", exportPdf);

async function exportPdf() {
  const btn = $("#dl-pdf");
  if (!window.jspdf || !window.Vex) { alert("PDF libraries failed to load (needs internet)."); return; }
  const data = result && buildMeasures();
  if (!data) { alert("No drum hits to export."); return; }
  btn.textContent = "Building PDF…";
  btn.disabled = true;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:1000px;background:#fff";
  document.body.append(host);
  try {
    const doc = new jspdf.jsPDF({ unit: "pt", format: "a4" });
    const pageW = doc.internal.pageSize.getWidth(), pageH = doc.internal.pageSize.getHeight();
    const margin = 36, svgW = 1000, perLine = 4;
    const scale = (pageW - margin * 2) / svgW;
    const headerH = 64;
    const linesFor = (top) => Math.floor((pageH - top - margin - 16) / (LINE_H * scale));

    const title = result.title || "Drums";
    let i = 0, page = 0;
    while (i < data.total) {
      if (page > 0) doc.addPage();
      let top = margin;
      if (page === 0) {
        doc.setFont("helvetica", "bold").setFontSize(16).text(title, margin, top + 12, { maxWidth: pageW - margin * 2 });
        doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(90);
        doc.text(`Drums · Tempo ~${Math.round(result.tempo)} BPM · 4/4 · auto-transcribed`, margin, top + 30);
        doc.text("Kick = bottom space · Snare = 3rd space · Toms = top space · Hi-hat = x above staff · Cymbals = x on ledger line",
          margin, top + 42);
        doc.setTextColor(0);
        top += headerH;
      }
      const to = Math.min(data.total, i + linesFor(top) * perLine);
      host.innerHTML = "";
      drawMeasures(host, data, { from: i, to, width: svgW, perLine, color: false });
      const svg = host.querySelector("svg");
      const h = Number(svg.getAttribute("height"));
      await doc.svg(svg, { x: margin, y: top, width: svgW * scale, height: h * scale });
      page++;
      i = to;
    }
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p).setFontSize(8).setTextColor(120);
      doc.text(`${p} / ${pages}`, pageW / 2, pageH - 18, { align: "center" });
    }
    doc.save(`${title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "drums"}_drums.pdf`);
  } catch (err) {
    console.error(err);
    alert("PDF export failed: " + err.message);
  } finally {
    host.remove();
    btn.textContent = "Sheet PDF";
    btn.disabled = false;
  }
}

function measureNotes(VF, slots, color = true) {
  if (slots.every((s) => s.size === 0)) {
    return [new VF.StaveNote({ keys: ["b/4"], duration: "wr", clef: "percussion", align_center: true })];
  }
  const notes = [];
  for (let beat = 0; beat < 4; beat++) {
    const b = slots.slice(beat * 4, beat * 4 + 4);
    // Use the coarsest subdivision that represents this beat exactly.
    let step = 4, dur = "q";
    if (b[1].size || b[3].size) { step = 1; dur = "16"; }
    else if (b[2].size) { step = 2; dur = "8"; }
    for (let k = 0; k < 4; k += step) {
      const set = b[k];
      if (set.size) {
        const pitches = [...set].sort((a, c) => noteOrder(a) - noteOrder(c));
        const n = new VF.StaveNote({ keys: pitches.map((p) => NOTATION[p]), duration: dur, clef: "percussion", stem_direction: 1 });
        if (color) pitches.forEach((p, idx) => n.setKeyStyle(idx, { fillStyle: SHEET_COLORS[p], strokeStyle: SHEET_COLORS[p] }));
        notes.push(n);
      } else {
        notes.push(new VF.StaveNote({ keys: ["b/4"], duration: dur + "r", clef: "percussion" }));
      }
    }
  }
  return notes;
}
// VexFlow wants chord keys from lowest to highest staff position.
function noteOrder(p) { return { 35: 0, 38: 1, 47: 2, 42: 3, 49: 4 }[p]; }

let lastHl = null;
function highlightMeasure(force) {
  if (!result || !measureBoxes.length) return;
  const offset = Number($("#bar-offset").value) * 4;
  const m = Math.floor((timeToSlot(audio.currentTime) + 0.25 + offset) / 16);
  if (m === lastHl && !force) return;
  lastHl = m;
  const box = measureBoxes.find((b) => b.measure === m);
  const hl = $("#sheet-hl");
  if (!box) { hl.style.display = "none"; return; }
  Object.assign(hl.style, { display: "block", left: `${box.x}px`, top: `${box.y + 8}px`, width: `${box.w}px`, height: `${box.h}px` });
  if (!audio.paused) {
    const wrap = $("#sheet-wrap");
    if (box.y < wrap.scrollTop || box.y + box.h > wrap.scrollTop + wrap.clientHeight) {
      wrap.scrollTo({ top: box.y - 20, behavior: "smooth" });
    }
  }
}

$("#sheet-wrap").addEventListener("click", (e) => {
  const rect = $("#sheet").getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const box = measureBoxes.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  if (!box) return;
  const offset = Number($("#bar-offset").value) * 4;
  rollStart = null;
  seekTo(slotToTime(box.measure * 16 - offset));
});

// ---------------------------------------------------------------- shared by the 2D and 3D kit views

// Hit intensity per instrument (0..1), decaying ~150 ms of real time after the latest hit.
// In game mode the drums react to the player's key presses instead of the notes.
function hitFlash(now, rate) {
  const flash = {};
  if (game.open) {
    const t = performance.now();
    for (const p of LANE_ORDER) flash[p] = game.lastPress[p] ? Math.exp(-(t - game.lastPress[p]) / 150) : 0;
    return flash;
  }
  const lastHit = {};
  for (let i = lowerBound(result.notes, now - 1); i < result.notes.length && result.notes[i].time <= now; i++) {
    lastHit[result.notes[i].pitch] = result.notes[i];
  }
  for (const p of LANE_ORDER) {
    const n = lastHit[p];
    flash[p] = n ? Math.exp(-((now - n.time) / rate) / 0.15) * (0.5 + 0.5 * n.velocity / 127) : 0;
  }
  return flash;
}
// In game mode, notes stay visible a little past their target until judged; judged notes disappear.
function gameTail(rate) { return game.open ? GAME_WINDOWS.ok * rate : 0; }
function gameHides(i) { return game.open && game.judged.has(i); }

// ---------------------------------------------------------------- drum view (falling notes onto a kit)

const kitCanvas = $("#kit");
let kitLook = 2.5; // seconds of song shown ahead
$("#look").addEventListener("input", (e) => {
  kitLook = Number(e.target.value);
  $("#look-label").textContent = `${kitLook.toFixed(1)}s`;
  drawKit();
});

// Kit layout seen from the drummer's seat (fractions of canvas width/height).
// Each note lane ends on its instrument's head ("target").
const KIT_LANES = {
  42: { x: 0.13, y: 0.56 }, // hi-hat, far left
  38: { x: 0.30, y: 0.74 }, // snare, front-left
  35: { x: 0.50, y: 0.80 }, // kick, center
  47: { x: 0.72, y: 0.72 }, // toms (lane lands on floor tom; rack toms flash too)
  49: { x: 0.86, y: 0.50 }, // cymbals (ride right; crash flashes too)
};

function lowerBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].time < t) lo = m + 1; else hi = m; }
  return lo;
}

function drawKit() {
  if (!result || activeView !== "kit") return;
  const dpr = window.devicePixelRatio || 1;
  const W = kitCanvas.clientWidth, H = kitCanvas.clientHeight;
  if (kitCanvas.width !== W * dpr || kitCanvas.height !== H * dpr) { kitCanvas.width = W * dpr; kitCanvas.height = H * dpr; }
  const g = kitCanvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const s = Math.min(W / 1000, H / 520);
  const now = audio.currentTime;
  const rate = audio.playbackRate || 1;
  const P = (p) => ({ x: KIT_LANES[p].x * W, y: KIT_LANES[p].y * H });

  const flash = hitFlash(now, rate);

  // Stage floor + spotlight
  const bg = g.createRadialGradient(W / 2, H * 0.75, 10, W / 2, H * 0.75, W * 0.6);
  bg.addColorStop(0, "#1c2030");
  bg.addColorStop(1, "#0a0c10");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  // Highway: lanes converge to a vanishing point above the canvas.
  const vx = W / 2, vy = -H * 0.05, topY = H * 0.02;
  const project = (p, prog) => {
    const t = KIT_LANES[p], q = prog * prog; // perspective: far notes move slower
    const tx = t.x * W, ty = t.y * H;
    const x0 = vx + (tx - vx) * 0.3;
    return { x: x0 + (tx - x0) * q, y: topY + (ty - topY) * q, q };
  };
  for (const p of LANE_ORDER) {
    const a = project(p, 0), b = project(p, 1);
    const grad = g.createLinearGradient(a.x, a.y, b.x, b.y);
    grad.addColorStop(0, "transparent");
    grad.addColorStop(1, COLORS[p] + "66");
    g.strokeStyle = grad;
    g.lineWidth = 2 * s + 6 * s * flash[p];
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  }
  // Beat ticks on each lane
  const offset = Number($("#bar-offset").value) * 4;
  const firstBeat = Math.ceil(timeToSlot(now) / 4), lastBeat = Math.floor(timeToSlot(now + kitLook) / 4);
  for (let b = firstBeat; b <= lastBeat; b++) {
    const prog = 1 - (slotToTime(b * 4) - now) / kitLook;
    if (prog < 0 || prog > 1) continue;
    const isBar = (((b * 4 + offset) % 16) + 16) % 16 === 0;
    g.strokeStyle = isBar ? "rgba(255,255,255,.35)" : "rgba(255,255,255,.12)";
    g.lineWidth = isBar ? 2 : 1;
    for (const p of LANE_ORDER) {
      const pt = project(p, prog), w = (isBar ? 22 : 12) * s * (0.3 + 0.7 * pt.q);
      g.beginPath(); g.moveTo(pt.x - w, pt.y); g.lineTo(pt.x + w, pt.y); g.stroke();
    }
  }

  drawKitIllustration(g, W, H, s, flash);

  // Targets (where notes land)
  for (const p of LANE_ORDER) {
    const { x, y } = P(p);
    g.strokeStyle = COLORS[p];
    g.globalAlpha = 0.55 + 0.45 * flash[p];
    g.lineWidth = 2.5 * s;
    g.beginPath(); g.ellipse(x, y, 26 * s, 10 * s, 0, 0, Math.PI * 2); g.stroke();
    // Expanding ring right after a hit
    if (flash[p] > 0.02) {
      const r = 1 + (1 - flash[p]) * 1.6;
      g.globalAlpha = flash[p];
      g.beginPath(); g.ellipse(x, y, 26 * s * r, 10 * s * r, 0, 0, Math.PI * 2); g.stroke();
    }
    g.globalAlpha = 1;
  }

  // Falling notes (drawn far → near so closer gems overlap farther ones)
  const visible = [];
  for (let i = lowerBound(result.notes, now - gameTail(rate)); i < result.notes.length && result.notes[i].time <= now + kitLook; i++) {
    if (!gameHides(i)) visible.push(result.notes[i]);
  }
  for (let i = visible.length - 1; i >= 0; i--) {
    const n = visible[i];
    const pt = project(n.pitch, 1 - (n.time - now) / kitLook);
    const size = (0.35 + 0.65 * pt.q) * (0.75 + 0.45 * n.velocity / 127) * s;
    drawGem(g, pt.x, pt.y, 24 * size, 10 * size, COLORS[n.pitch]);
  }

  // Labels + position readout
  g.font = `${Math.round(12 * Math.max(s, 0.8))}px -apple-system, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "top";
  for (const p of LANE_ORDER) {
    const { x, y } = P(p);
    const name = result.instruments.find((i) => i.pitch === p).name;
    g.fillStyle = COLORS[p];
    g.globalAlpha = 0.7 + 0.3 * flash[p];
    const [lx, ly] = { 35: [-48, 42], 38: [0, 62], 47: [0, 96] }[p] || [0, 30];
    g.fillText(name, x + lx * s, y + ly * s);
  }
  g.globalAlpha = 1;
  const slot = Math.floor(timeToSlot(now) + 0.25) + offset;
  g.textAlign = "left";
  g.fillStyle = "#8b93a7";
  if (!game.open) g.fillText(`Bar ${Math.floor(slot / 16) + 1} · Beat ${Math.floor((((slot % 16) + 16) % 16) / 4) + 1} · ${Math.round(result.tempo * rate)} BPM`, 12, 10);
}

function drawGem(g, x, y, rx, ry, color) {
  g.save();
  g.shadowColor = color;
  g.shadowBlur = rx * 0.8;
  const grad = g.createLinearGradient(x, y - ry, x, y + ry);
  grad.addColorStop(0, "#fff");
  grad.addColorStop(0.35, color);
  grad.addColorStop(1, shade(color, -0.45));
  g.fillStyle = grad;
  g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fill();
  g.shadowBlur = 0;
  g.strokeStyle = "rgba(255,255,255,.8)";
  g.lineWidth = Math.max(1, ry * 0.18);
  g.beginPath(); g.ellipse(x, y, rx * 0.92, ry * 0.85, 0, 0, Math.PI * 2); g.stroke();
  g.restore();
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + c * amt)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function drawKitIllustration(g, W, H, s, flash) {
  const glow = (p, fn) => {
    g.save();
    if (flash[p] > 0.02) { g.shadowColor = COLORS[p]; g.shadowBlur = 40 * s * flash[p]; }
    fn();
    g.restore();
  };
  const stand = (x, yTop, yBot, legs = true) => {
    g.strokeStyle = "#7c8291"; g.lineWidth = 3 * s;
    g.beginPath(); g.moveTo(x, yTop); g.lineTo(x, yBot); g.stroke();
    if (legs) {
      g.lineWidth = 2 * s;
      g.beginPath();
      g.moveTo(x, yBot - 18 * s); g.lineTo(x - 22 * s, yBot);
      g.moveTo(x, yBot - 18 * s); g.lineTo(x + 22 * s, yBot);
      g.moveTo(x, yBot - 18 * s); g.lineTo(x, yBot + 4 * s);
      g.stroke();
    }
  };
  const floor = H * 0.97;

  const cymbal = (x, y, rx, ry, p, wobble) => {
    const f = flash[p];
    stand(x, y, floor);
    glow(p, () => {
      g.translate(x, y);
      g.rotate(Math.sin(performance.now() / 40) * 0.04 * f * wobble);
      const grad = g.createRadialGradient(-rx * 0.3, -ry * 0.6, 2, 0, 0, rx);
      grad.addColorStop(0, f > 0.05 ? "#fff6c9" : "#f3d98b");
      grad.addColorStop(0.6, "#c99a2e");
      grad.addColorStop(1, "#8a6418");
      g.fillStyle = grad;
      g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "rgba(255,240,200,.35)"; g.lineWidth = 1;
      for (let k = 0.35; k < 1; k += 0.2) { g.beginPath(); g.ellipse(0, 0, rx * k, ry * k, 0, 0, Math.PI * 2); g.stroke(); }
      g.fillStyle = "#e9c766";
      g.beginPath(); g.ellipse(0, -ry * 0.15, rx * 0.16, ry * 0.4, 0, 0, Math.PI * 2); g.fill();
    });
  };

  const drum = (x, y, rx, ry, depth, p, shell = "#b3261e") => {
    const f = flash[p];
    const dy = f * 2 * s; // head gives a little on impact
    glow(p, () => {
      // shell
      const sg = g.createLinearGradient(x - rx, 0, x + rx, 0);
      sg.addColorStop(0, shade(shell, -0.5)); sg.addColorStop(0.45, shell); sg.addColorStop(1, shade(shell, -0.6));
      g.fillStyle = sg;
      g.beginPath();
      g.moveTo(x - rx, y); g.lineTo(x - rx, y + depth);
      g.ellipse(x, y + depth, rx, ry, 0, Math.PI, 0, true);
      g.lineTo(x + rx, y); g.closePath(); g.fill();
      // lugs
      g.fillStyle = "#c9ced8";
      for (let k = -0.7; k <= 0.71; k += 0.35) g.fillRect(x + rx * k - 2 * s, y + depth * 0.3, 4 * s, depth * 0.4);
      // head
      g.fillStyle = f > 0.05 ? `rgb(${255},${250},${240})` : "#e8e3d8";
      g.beginPath(); g.ellipse(x, y + dy, rx, ry, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "#d6dbe4"; g.lineWidth = 3 * s;
      g.beginPath(); g.ellipse(x, y + dy, rx, ry, 0, 0, Math.PI * 2); g.stroke();
    });
  };

  // Back to front so nearer pieces overlap farther ones.
  cymbal(W * 0.08, H * 0.30, 60 * s, 13 * s, 49, 1); // crash, left of the hi-hat lane
  cymbal(W * 0.86, H * 0.50, 85 * s, 18 * s, 49, 0.6); // ride

  // Kick (front head facing the audience; we see it from behind as a big drum)
  const kx = W * 0.5, ky = H * 0.80, kr = 95 * s, kf = flash[35];
  glow(35, () => {
    g.fillStyle = "#7d1a14";
    g.beginPath(); g.arc(kx, ky, kr + 10 * s, 0, Math.PI * 2); g.fill();
    const hg = g.createRadialGradient(kx, ky - kr * 0.3, 5, kx, ky, kr);
    hg.addColorStop(0, kf > 0.05 ? "#fffaf0" : "#efeae0");
    hg.addColorStop(1, "#cfc8b8");
    g.fillStyle = hg;
    g.beginPath(); g.arc(kx, ky, kr * (1 - 0.015 * kf), 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#d6dbe4"; g.lineWidth = 5 * s;
    g.beginPath(); g.arc(kx, ky, kr + 8 * s, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "#1a1d24";
    g.beginPath(); g.arc(kx + kr * 0.45, ky + kr * 0.4, kr * 0.14, 0, Math.PI * 2); g.fill();
  });
  // pedal beater swings toward the head on a hit
  g.strokeStyle = "#9aa0ad"; g.lineWidth = 4 * s;
  g.beginPath(); g.moveTo(kx, floor); g.lineTo(kx, ky + kr * (0.35 + 0.3 * (1 - kf))); g.stroke();
  g.fillStyle = "#3b3f4a";
  g.beginPath(); g.arc(kx, ky + kr * (0.35 + 0.3 * (1 - kf)), 9 * s, 0, Math.PI * 2); g.fill();

  // Rack toms on the kick, floor tom on the right
  drum(W * 0.42, H * 0.55, 40 * s, 15 * s, 40 * s, 47);
  drum(W * 0.58, H * 0.55, 44 * s, 16 * s, 44 * s, 47);
  [-0.8, 0.8].forEach((k) => stand(W * 0.72 + 55 * s * k, H * 0.72 + 60 * s, floor, false));
  drum(W * 0.72, H * 0.72, 56 * s, 20 * s, 80 * s, 47);

  // Snare (chrome shell) on a stand
  stand(W * 0.30, H * 0.74 + 30 * s, floor);
  drum(W * 0.30, H * 0.74, 52 * s, 18 * s, 28 * s, 38, "#8d96a6");

  // Hi-hat: two cymbals that close on a hit
  const hx = W * 0.13, hy = H * 0.56, hf = flash[42];
  stand(hx, hy, floor);
  glow(42, () => {
    const gap = 7 * s * (1 - hf);
    for (const [dy, top] of [[gap, false], [-gap * 0.2, true]]) {
      const grad = g.createRadialGradient(hx - 15 * s, hy + dy - 6 * s, 2, hx, hy + dy, 60 * s);
      grad.addColorStop(0, top && hf > 0.05 ? "#fff6c9" : "#f0d27e");
      grad.addColorStop(1, "#8a6418");
      g.fillStyle = grad;
      g.beginPath(); g.ellipse(hx, hy + dy, 58 * s, 11 * s, 0, 0, Math.PI * 2); g.fill();
    }
  });
}

// ---------------------------------------------------------------- game mode

// Physical keys (KeyboardEvent.code), so the mapping works on any keyboard layout.
const GAME_KEYS = { 42: "KeyD", 38: "KeyF", 35: "Space", 47: "KeyJ", 49: "KeyK" };
const KEY_LABELS = { KeyD: "D", KeyF: "F", Space: "Space", KeyJ: "J", KeyK: "K" };
const CODE_TO_PITCH = Object.fromEntries(Object.entries(GAME_KEYS).map(([p, c]) => [c, Number(p)]));
// Timing windows in real seconds (scaled by playback speed when compared with song time).
const GAME_WINDOWS = { perfect: 0.05, good: 0.1, ok: 0.18 };
const POINTS = { perfect: 300, good: 200, early: 100, late: 100 };

const game = {
  open: false, state: "idle", // idle | countdown | playing | done
  view: "kit", mode: "play", judged: new Map(), lastPress: {},
  score: 0, combo: 0, maxCombo: 0, counts: {}, ptr: 0, waiting: false, countdownEnd: 0,
  prevView: null, prevSource: null, canvasHome: null,
};
const gEl = $("#game");

$("#game-btn").addEventListener("click", openGame);

function openGame() {
  if (!result || !result.notes.length) { alert("No drum notes to play."); return; }
  audio.pause();
  game.open = true;
  game.prevView = activeView;
  game.prevSource = $("#source").value;
  game.view = activeView === "kit3d" ? "kit3d" : "kit";
  gEl.classList.remove("hidden");
  gEl.requestFullscreen?.().catch(() => {}); // the overlay covers the window even if fullscreen is refused
  mountView();
  showStartPanel();
  requestAnimationFrame(gameLoop);
}

function closeGame() {
  if (!game.open) return;
  game.open = false;
  game.state = "idle";
  audio.pause();
  unmountView();
  gEl.classList.add("hidden");
  $("#g-panel").classList.add("hidden");
  $("#g-center").textContent = "";
  $("#game-keys").innerHTML = "";
  $("#game-fx").innerHTML = "";
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (!isMidiJob() && $("#source").value !== game.prevSource) { $("#source").value = game.prevSource; setAudioSource(); }
  showView(game.prevView);
}

// Move the chosen view's canvas into the full-screen stage (and back on exit).
function mountView() {
  unmountView();
  const el = game.view === "kit3d" ? $("#kit3d-wrap") : $("#kit");
  game.canvasHome = { el, parent: el.parentNode, next: el.nextSibling };
  $("#game-stage").append(el);
  activeView = game.view;
  if (game.view === "kit3d") window.kit3dShown?.();
  buildKeycaps();
}
function unmountView() {
  const h = game.canvasHome;
  if (!h) return;
  h.parent.insertBefore(h.el, h.next);
  game.canvasHome = null;
}

function lanePos(p) {
  if (game.view === "kit3d") return window.kit3dScreenPos?.(p);
  const c = $("#kit");
  return { x: KIT_LANES[p].x * c.clientWidth, y: KIT_LANES[p].y * c.clientHeight, visible: true };
}

function buildKeycaps() {
  const box = $("#game-keys");
  box.innerHTML = "";
  for (const p of LANE_ORDER) {
    const k = document.createElement("div");
    k.className = "keycap";
    k.dataset.pitch = p;
    k.style.borderColor = COLORS[p];
    k.style.color = COLORS[p];
    k.textContent = KEY_LABELS[GAME_KEYS[p]];
    box.append(k);
  }
}

function placeKeycaps() {
  const t = performance.now();
  for (const k of $("#game-keys").children) {
    const p = Number(k.dataset.pitch);
    const pos = lanePos(p);
    if (!pos || !pos.visible) { k.style.display = "none"; continue; }
    k.style.display = "";
    const pressed = game.lastPress[p] && t - game.lastPress[p] < 90;
    k.style.transform = `translate(${pos.x}px, ${pos.y - 46}px) translate(-50%, -50%) scale(${pressed ? 0.88 : 1})`;
    k.classList.toggle("down", pressed);
  }
}

function popup(p, text, kind) {
  const pos = lanePos(p);
  if (!pos) return;
  const d = document.createElement("div");
  d.className = `fb ${kind}`;
  d.textContent = text;
  d.style.left = `${pos.x}px`;
  d.style.top = `${pos.y - 80}px`;
  $("#game-fx").append(d);
  setTimeout(() => d.remove(), 750);
}

// ------------------------------------------------ panels

function showStartPanel() {
  game.state = "idle";
  const speeds = [...$("#speed").options].map((o) => `<option value="${o.value}" ${o.selected ? "selected" : ""}>${o.textContent}</option>`).join("");
  const keys = LANE_ORDER.slice().reverse().map((p) =>
    `<div class="g-key"><span class="keycap static" style="border-color:${COLORS[p]};color:${COLORS[p]}">${KEY_LABELS[GAME_KEYS[p]]}</span>${result.instruments.find((i) => i.pitch === p).name}</div>`).join("");
  panel(`
    <h2>🎮 Game mode</h2>
    <p class="sub">${escapeHtml(result.title || "")}</p>
    <div class="g-row"><span>View</span>
      <div class="seg" data-opt="view"><button data-v="kit">Drum view</button><button data-v="kit3d">3D view</button></div></div>
    <div class="g-row"><span>Mode</span>
      <div class="seg" data-opt="mode"><button data-v="play">Play along</button><button data-v="wait">Wait for me</button></div></div>
    <p class="hint g-mode-hint"></p>
    ${isMidiJob() ? "" : `<div class="g-row"><span>Backing</span><select id="g-source">
      <option value="song">Original song</option><option value="drums">Drum stem (doubles your drums)</option><option value="none">None (only your drums)</option></select></div>`}
    <div class="g-row"><span>Speed</span><select id="g-speed">${speeds}</select></div>
    <div class="g-keys">${keys}</div>
    <div class="g-actions"><button id="g-start" class="btn">Start (Enter)</button><button id="g-exit" class="btn ghost">Exit (Esc)</button></div>`);
  const sync = () => {
    $("#g-panel").querySelectorAll(".seg").forEach((seg) =>
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === game[seg.dataset.opt])));
    $(".g-mode-hint").textContent = game.mode === "play"
      ? "The song keeps going: hit each note on time. Misses and off-time hits are scored."
      : "Practice: the song pauses at every note until you hit the right key.";
  };
  $("#g-panel").querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
    const opt = b.closest(".seg").dataset.opt;
    game[opt] = b.dataset.v;
    if (opt === "view") mountView();
    sync();
  }));
  sync();
  if ($("#g-source")) $("#g-source").value = isMidiJob() ? "none" : "song";
  $("#g-start").addEventListener("click", startGame);
  $("#g-exit").addEventListener("click", closeGame);
}

function showResults() {
  game.state = "done";
  audio.pause();
  const c = game.counts, total = result.notes.length;
  const acc = accuracy();
  const grade = acc >= 95 ? "S" : acc >= 90 ? "A" : acc >= 80 ? "B" : acc >= 70 ? "C" : "D";
  panel(`
    <h2>${game.mode === "wait" ? "Practice complete" : "Song complete"}</h2>
    <div class="g-grade g-${grade}">${grade}</div>
    <div class="g-stats">
      <div><b>${game.score.toLocaleString()}</b><span>Score</span></div>
      <div><b>${acc.toFixed(1)}%</b><span>Accuracy</span></div>
      <div><b>${game.maxCombo}</b><span>Max combo</span></div>
    </div>
    <div class="g-counts">
      <span class="perfect">Perfect ${c.perfect || 0}</span><span class="good">Good ${c.good || 0}</span>
      <span class="early">Early ${c.early || 0}</span><span class="late">Late ${c.late || 0}</span>
      <span class="miss">Miss ${c.miss || 0}</span><span class="extra">No note ${c.extra || 0}</span>
      <span>of ${total} notes</span>
    </div>
    <div class="g-actions"><button id="g-again" class="btn">Play again (Enter)</button><button id="g-settings" class="btn ghost">Settings</button><button id="g-exit" class="btn ghost">Exit (Esc)</button></div>`);
  $("#g-again").addEventListener("click", startGame);
  $("#g-settings").addEventListener("click", showStartPanel);
  $("#g-exit").addEventListener("click", closeGame);
}

function panel(html) {
  const p = $("#g-panel");
  p.innerHTML = html;
  p.classList.remove("hidden");
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

// ------------------------------------------------ run

function startGame() {
  if ($("#g-speed")) { $("#speed").value = $("#g-speed").value; applySpeed(); }
  const src = $("#g-source")?.value ?? "none";
  if (!isMidiJob() && $("#source").value !== src) { $("#source").value = src; setAudioSource(); }
  ensureAudioCtx();
  ctx.resume();
  document.activeElement?.blur(); // so Space doesn't click a focused button
  $("#g-panel").classList.add("hidden");
  Object.assign(game, { judged: new Map(), score: 0, combo: 0, maxCombo: 0, counts: {}, ptr: 0, waiting: false });
  $("#game-fx").innerHTML = "";
  const first = result.notes[0].time;
  const start = Math.max(0, first - kitLook * (audio.playbackRate || 1) - 1);
  const go = () => {
    seekTo(start);
    game.state = "countdown";
    game.countdownEnd = performance.now() + 3000;
  };
  if (audio.readyState >= 1) go(); else audio.addEventListener("loadedmetadata", go, { once: true });
}

function judge(pitch) {
  const now = audio.currentTime, rate = audio.playbackRate || 1;
  const win = GAME_WINDOWS.ok * rate;
  let best = -1, bestDt = Infinity;
  for (let i = lowerBound(result.notes, now - win); i < result.notes.length && result.notes[i].time <= now + win; i++) {
    const n = result.notes[i];
    if (n.pitch !== pitch || game.judged.has(i)) continue;
    const dt = Math.abs(n.time - now);
    if (dt < bestDt) { best = i; bestDt = dt; }
  }
  if (best < 0) {
    // In practice mode, pressing while the song waits on a different drum is just a nudge.
    popup(pitch, game.waiting ? "✕ wrong drum" : "✕ no note", "extra");
    if (!game.waiting) { game.counts.extra = (game.counts.extra || 0) + 1; game.combo = 0; }
    return;
  }
  const dtReal = (now - result.notes[best].time) / rate; // negative = early
  const a = Math.abs(dtReal);
  const kind = a <= GAME_WINDOWS.perfect ? "perfect" : a <= GAME_WINDOWS.good ? "good" : dtReal < 0 ? "early" : "late";
  game.judged.set(best, kind);
  game.counts[kind] = (game.counts[kind] || 0) + 1;
  game.combo++;
  game.maxCombo = Math.max(game.maxCombo, game.combo);
  game.score += POINTS[kind] * multiplier();
  const ms = Math.round(Math.abs(dtReal) * 1000);
  popup(pitch, { perfect: "Perfect!", good: "Good", early: `Early ${ms}ms`, late: `Late ${ms}ms` }[kind], kind);
}

function multiplier() { return 1 + Math.min(3, Math.floor(game.combo / 10)); }
function accuracy() {
  const c = game.counts;
  const judged = (c.perfect || 0) + (c.good || 0) + (c.early || 0) + (c.late || 0) + (c.miss || 0);
  if (!judged) return 100;
  return (100 * ((c.perfect || 0) + 0.7 * (c.good || 0) + 0.4 * ((c.early || 0) + (c.late || 0)))) / judged;
}

function gameLoop() {
  if (!game.open) return;
  const now = audio.currentTime, rate = audio.playbackRate || 1;
  const notes = result.notes;

  if (game.state === "countdown") {
    const left = Math.ceil((game.countdownEnd - performance.now()) / 1000);
    $("#g-center").textContent = left > 0 ? String(left) : "Go!";
    if (left <= 0) { game.state = "playing"; audio.play(); setTimeout(() => game.state === "playing" && ($("#g-center").textContent = ""), 400); }
  }

  if (game.state === "playing") {
    // Skip past judged notes; resolve the ones that are due.
    while (game.ptr < notes.length && game.judged.has(game.ptr)) game.ptr++;
    if (game.mode === "play") {
      for (let i = game.ptr; i < notes.length && notes[i].time < now - GAME_WINDOWS.ok * rate; i++) {
        if (game.judged.has(i)) continue;
        game.judged.set(i, "miss");
        game.counts.miss = (game.counts.miss || 0) + 1;
        game.combo = 0;
        popup(notes[i].pitch, "Miss", "miss");
      }
    } else if (game.ptr < notes.length) {
      // Practice: hold at the next note (and any chord partners) until they're all hit.
      const due = notes[game.ptr].time;
      if (!game.waiting && now >= due) { game.waiting = true; game.waitDue = due; audio.pause(); audio.currentTime = due; }
    }
    if (game.mode === "wait" && game.waiting) {
      // Everything due at the held moment (chords count as one stop).
      const pending = {};
      for (let i = game.ptr; i < notes.length && notes[i].time <= game.waitDue + 0.03; i++) {
        if (!game.judged.has(i)) pending[notes[i].pitch] = (pending[notes[i].pitch] || 0) + 1;
      }
      const keys = Object.entries(pending);
      if (!keys.length) { game.waiting = false; audio.play(); $("#g-center").textContent = ""; }
      else $("#g-center").innerHTML = `<span class="g-wait">Hit ${keys.map(([p, n]) =>
        `<span class="keycap static" style="border-color:${COLORS[p]};color:${COLORS[p]}">${KEY_LABELS[GAME_KEYS[p]]}</span>${n > 1 ? `×${n}` : ""}`).join(" + ")}</span>`;
    }
    const last = notes[notes.length - 1].time;
    if ((game.ptr >= notes.length && now > last + 1) || audio.ended) showResults();
  }

  // HUD
  const c = game.combo;
  $("#g-score").textContent = game.score.toLocaleString();
  $("#g-acc").textContent = `${accuracy().toFixed(1)}% · ×${multiplier()}`;
  $("#g-combo").textContent = c >= 5 ? `${c} combo` : "";
  $("#g-combo").classList.toggle("hot", c >= 30);
  $("#g-title").textContent = result.title || "";
  const end = notes[notes.length - 1].time;
  $("#g-progress i").style.width = `${Math.min(100, (100 * now) / Math.max(1, end))}%`;

  if (game.view === "kit") drawKit(); // the 3D view renders itself
  placeKeycaps();
  requestAnimationFrame(gameLoop);
}

window.addEventListener("keydown", (e) => {
  if (!game.open) return;
  if (e.key === "Escape") { e.preventDefault(); closeGame(); return; }
  if (e.key === "Enter" && game.state !== "playing" && game.state !== "countdown") { e.preventDefault(); startGame(); return; }
  const pitch = CODE_TO_PITCH[e.code];
  if (pitch === undefined) return;
  e.preventDefault();
  if (e.repeat) return;
  ensureAudioCtx();
  playDrum(pitch, ctx.currentTime, 0.9); // the player is the drummer
  game.lastPress[pitch] = performance.now();
  if (game.state === "playing") judge(pitch);
}, true);

// Leaving full screen (the browser handles Esc there) also closes the game.
document.addEventListener("fullscreenchange", () => {
  if (game.open && !document.fullscreenElement) closeGame();
});

// ---------------------------------------------------------------- roll / sheet tabs

let activeView = ["roll", "sheet", "kit", "kit3d"].includes(localStorage.getItem("view")) ? localStorage.getItem("view") : "roll";
let sheetDirty = true;

function showView(view) {
  activeView = view;
  localStorage.setItem("view", view);
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === view)));
  document.querySelectorAll(".view, [data-for]").forEach((el) => {
    el.classList.toggle("hidden", !(el.dataset.view || el.dataset.for).split(" ").includes(view));
  });
  if (view === "roll") drawRoll();
  else if (view === "kit") drawKit();
  else if (view === "kit3d") window.kit3dShown?.(); // kit3d.js renders continuously while shown
  else if (sheetDirty) renderSheet();
  else highlightMeasure(true);
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
showView(activeView);

// ---------------------------------------------------------------- boot

loadHistory();
const qJob = new URLSearchParams(location.search).get("job");
if (qJob) openJob(qJob);
