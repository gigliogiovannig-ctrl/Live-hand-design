/**
 * Live Hand Design — disegna nell'aria con il gesto del pizzico.
 *
 * Pipeline:
 *   webcam -> MediaPipe HandLandmarker (21 punti per mano) -> rilevamento pizzico
 *   -> punto di disegno (medio fra punta pollice e punta indice) -> tratto sul canvas.
 */

import {
  FilesetResolver,
  HandLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Indici dei landmark usati (schema MediaPipe Hands).
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;

// Connessioni per disegnare lo scheletro della mano.
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

// --- Elementi DOM -----------------------------------------------------------

const video = document.getElementById("video");
const drawingCanvas = document.getElementById("drawing");
const overlayCanvas = document.getElementById("overlay");
const viewport = document.getElementById("viewport");
const drawCtx = drawingCanvas.getContext("2d");
const overlayCtx = overlayCanvas.getContext("2d");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const flipBtn = document.getElementById("flipBtn");
const fsBtn = document.getElementById("fsBtn");
const undoBtn = document.getElementById("undoBtn");
const clearBtn = document.getElementById("clearBtn");
const saveBtn = document.getElementById("saveBtn");
const palette = document.getElementById("palette");
const sizeInput = document.getElementById("size");
const sizeVal = document.getElementById("sizeVal");
const sensInput = document.getElementById("sensitivity");
const sensVal = document.getElementById("sensVal");
const skeletonCheck = document.getElementById("showSkeleton");
const mirrorCheck = document.getElementById("mirror");
const toolButtons = document.querySelectorAll(".tool");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

// --- Stato ------------------------------------------------------------------

const state = {
  running: false,
  landmarker: null,
  stream: null,
  lastVideoTime: -1,
  lastTimestamp: 0,
  color: "#ff2d55",
  width: 6,
  tool: "pen",
  mirror: true,
  facingMode: "user", // fotocamera frontale: la più naturale per disegnare guardandosi
  pinchOnRatio: 0.35,  // soglia di chiusura (regolabile dallo slider)
  strokes: [],         // tratti completati + in corso, in coordinate normalizzate 0..1
  hands: new Map(),    // stato per mano: { pinching, stroke, smooth }
};

// --- Utility ----------------------------------------------------------------

function setStatus(text, kind = "") {
  statusText.textContent = text;
  statusDot.className = "dot" + (kind ? " " + kind : "");
}

function resizeCanvases() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  for (const canvas of [drawingCanvas, overlayCanvas]) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  renderStrokes();
}

/**
 * Converte un landmark (normalizzato sul frame video) in pixel del canvas,
 * replicando il ritaglio `object-fit: cover` del video e l'eventuale specchiatura.
 */
function landmarkToCanvas(lm) {
  const cw = drawingCanvas.width;
  const ch = drawingCanvas.height;
  const vw = video.videoWidth || cw;
  const vh = video.videoHeight || ch;
  const scale = Math.max(cw / vw, ch / vh);
  const offsetX = (cw - vw * scale) / 2;
  const offsetY = (ch - vh * scale) / 2;

  let x = offsetX + lm.x * vw * scale;
  const y = offsetY + lm.y * vh * scale;
  if (state.mirror) x = cw - x;
  return { x, y };
}

/** Punto normalizzato 0..1 rispetto al canvas, così i tratti sopravvivono al resize. */
function toNormalized(pt) {
  return { x: pt.x / drawingCanvas.width, y: pt.y / drawingCanvas.height };
}

function fromNormalized(pt) {
  return { x: pt.x * drawingCanvas.width, y: pt.y * drawingCanvas.height };
}

function canvasScale() {
  // Fattore per convertire lo spessore "logico" in pixel reali del canvas.
  return drawingCanvas.width / viewport.clientWidth || 1;
}

/**
 * Forza del pizzico: distanza pollice-indice normalizzata sulla dimensione
 * della mano (polso -> nocca del medio). Così è indipendente dalla distanza
 * dalla camera e dalla grandezza della mano.
 */
function pinchRatio(landmarks) {
  const aspect = (video.videoWidth || 4) / (video.videoHeight || 3);
  const dist = (a, b) => {
    const dx = (a.x - b.x) * aspect;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  };
  const handSize = dist(landmarks[WRIST], landmarks[MIDDLE_MCP]) || 1e-6;
  return dist(landmarks[THUMB_TIP], landmarks[INDEX_TIP]) / handSize;
}

// --- Disegno ----------------------------------------------------------------

function renderStrokes() {
  drawCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
  drawCtx.lineCap = "round";
  drawCtx.lineJoin = "round";
  const s = canvasScale();

  for (const stroke of state.strokes) {
    const pts = stroke.points;
    if (pts.length === 0) continue;

    drawCtx.strokeStyle = stroke.color;
    drawCtx.lineWidth = stroke.width * s;

    const p0 = fromNormalized(pts[0]);
    if (pts.length === 1) {
      // Un punto solo: un pallino, così anche il tocco rapido lascia un segno.
      drawCtx.fillStyle = stroke.color;
      drawCtx.beginPath();
      drawCtx.arc(p0.x, p0.y, (stroke.width * s) / 2, 0, Math.PI * 2);
      drawCtx.fill();
      continue;
    }

    // Curve quadratiche fra i punti medi: linea morbida invece che spezzata.
    drawCtx.beginPath();
    drawCtx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length - 1; i++) {
      const a = fromNormalized(pts[i]);
      const b = fromNormalized(pts[i + 1]);
      drawCtx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    const last = fromNormalized(pts[pts.length - 1]);
    drawCtx.lineTo(last.x, last.y);
    drawCtx.stroke();
  }
}

function eraseAt(normPoint) {
  // Raggio in coordinate normalizzate, con un minimo per restare "afferrabile".
  const radiusPx = Math.max(state.width * 1.6, 18) * canvasScale();
  const radius = radiusPx / drawingCanvas.width;
  const before = state.strokes.length;
  state.strokes = state.strokes.filter(
    (stroke) => !stroke.points.some((p) => Math.hypot(p.x - normPoint.x, p.y - normPoint.y) < radius)
  );
  if (state.strokes.length !== before) renderStrokes();
}

function drawOverlay(results) {
  const ctx = overlayCtx;
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!results || !results.landmarks) return;
  const s = canvasScale();

  results.landmarks.forEach((landmarks, i) => {
    const key = handKey(results, i);
    const hand = state.hands.get(key);
    const pinching = hand ? hand.pinching : false;

    if (skeletonCheck.checked) {
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        const pa = landmarkToCanvas(landmarks[a]);
        const pb = landmarkToCanvas(landmarks[b]);
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
      }
      ctx.stroke();

      ctx.fillStyle = "rgba(10,132,255,0.9)";
      for (const lm of landmarks) {
        const p = landmarkToCanvas(lm);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3 * s, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Cursore: cerchio fra pollice e indice, pieno quando il pizzico è chiuso.
    const thumb = landmarkToCanvas(landmarks[THUMB_TIP]);
    const index = landmarkToCanvas(landmarks[INDEX_TIP]);
    const cx = (thumb.x + index.x) / 2;
    const cy = (thumb.y + index.y) / 2;
    const r = Math.max(state.width * s * 0.75, 10 * s);
    const cursorColor = state.tool === "eraser" ? "#ffffff" : state.color;

    ctx.lineWidth = 2.5 * s;
    ctx.strokeStyle = cursorColor;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    if (pinching) {
      ctx.fillStyle = cursorColor + "88";
      ctx.fill();
    } else {
      // Linea tratteggiata fra le due dita: mostra quanto manca alla chiusura.
      ctx.setLineDash([4 * s, 4 * s]);
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(thumb.x, thumb.y);
      ctx.lineTo(index.x, index.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });
}

// --- Logica del gesto -------------------------------------------------------

function handKey(results, i) {
  const h = results.handedness || results.handednesses;
  const cat = h && h[i] && h[i][0];
  return cat ? cat.categoryName : "hand" + i;
}

function processHand(key, landmarks) {
  let hand = state.hands.get(key);
  if (!hand) {
    hand = { pinching: false, stroke: null, smooth: null };
    state.hands.set(key, hand);
  }

  const ratio = pinchRatio(landmarks);
  const onThreshold = state.pinchOnRatio;
  const offThreshold = state.pinchOnRatio * 1.45; // isteresi: evita lo sfarfallio

  const wasPinching = hand.pinching;
  hand.pinching = wasPinching ? ratio < offThreshold : ratio < onThreshold;

  // Punto di disegno: a metà fra le punte di pollice e indice.
  const thumb = landmarkToCanvas(landmarks[THUMB_TIP]);
  const index = landmarkToCanvas(landmarks[INDEX_TIP]);
  const raw = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };

  // Smoothing esponenziale: toglie il tremolio del tracking.
  const alpha = 0.45;
  if (!hand.smooth || (!wasPinching && hand.pinching)) {
    hand.smooth = { ...raw };
  } else {
    hand.smooth = {
      x: hand.smooth.x + (raw.x - hand.smooth.x) * alpha,
      y: hand.smooth.y + (raw.y - hand.smooth.y) * alpha,
    };
  }

  const norm = toNormalized(hand.smooth);

  if (hand.pinching) {
    if (state.tool === "eraser") {
      eraseAt(norm);
      return;
    }
    if (!wasPinching || !hand.stroke) {
      hand.stroke = { color: state.color, width: state.width, points: [norm] };
      state.strokes.push(hand.stroke);
      renderStrokes();
    } else {
      const prev = hand.stroke.points[hand.stroke.points.length - 1];
      const minStep = 1.5 / drawingCanvas.width; // scarta i micro-movimenti
      if (Math.hypot(norm.x - prev.x, norm.y - prev.y) > minStep) {
        hand.stroke.points.push(norm);
        renderStrokes();
      }
    }
  } else {
    hand.stroke = null;
  }
}

// --- Loop -------------------------------------------------------------------

function loop() {
  if (!state.running) return;

  if (video.readyState >= 2 && video.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = video.currentTime;
    let ts = performance.now();
    if (ts <= state.lastTimestamp) ts = state.lastTimestamp + 1;
    state.lastTimestamp = ts;

    let results = null;
    try {
      results = state.landmarker.detectForVideo(video, ts);
    } catch (err) {
      console.error("Errore di rilevamento:", err);
    }

    if (results && results.landmarks && results.landmarks.length > 0) {
      const seen = new Set();
      results.landmarks.forEach((landmarks, i) => {
        const key = handKey(results, i);
        seen.add(key);
        processHand(key, landmarks);
      });
      // Mano uscita dal campo visivo: chiudi il suo tratto.
      for (const [key, hand] of state.hands) {
        if (!seen.has(key)) {
          hand.pinching = false;
          hand.stroke = null;
          hand.smooth = null;
        }
      }
      const anyPinch = [...state.hands.values()].some((h) => h.pinching);
      setStatus(
        anyPinch
          ? state.tool === "eraser" ? "Cancello…" : "Disegno…"
          : `Mano rilevata (${results.landmarks.length}) — pizzica per disegnare`,
        anyPinch ? "drawing" : "ready"
      );
    } else {
      for (const hand of state.hands.values()) {
        hand.pinching = false;
        hand.stroke = null;
        hand.smooth = null;
      }
      setStatus("Nessuna mano inquadrata", "ready");
    }

    drawOverlay(results);
  }

  requestAnimationFrame(loop);
}

// --- Avvio / stop -----------------------------------------------------------

async function ensureLandmarker() {
  if (state.landmarker) return state.landmarker;
  setStatus("Carico il modello…");
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    state.landmarker = await HandLandmarker.createFromOptions(fileset, options("GPU"));
  } catch (err) {
    console.warn("Delegate GPU non disponibile, uso la CPU:", err);
    state.landmarker = await HandLandmarker.createFromOptions(fileset, options("CPU"));
  }
  return state.landmarker;
}

async function openStream() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: { ideal: state.facingMode },
    },
    audio: false,
  });
  video.srcObject = state.stream;
  await video.play();
  if (!video.videoWidth) {
    await new Promise((resolve) => { video.onloadedmetadata = () => resolve(); });
  }
}

async function start() {
  startBtn.disabled = true;
  try {
    await ensureLandmarker();
    setStatus("Chiedo l'accesso alla webcam…");
    await openStream();

    resizeCanvases();
    state.running = true;
    stopBtn.disabled = false;
    flipBtn.disabled = false;
    setStatus("Pronto — pizzica per disegnare", "ready");
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    startBtn.disabled = false;
    const msg =
      err && err.name === "NotAllowedError"
        ? "Permesso webcam negato"
        : err && err.name === "NotFoundError"
        ? "Nessuna webcam trovata"
        : "Errore di avvio: " + (err && err.message ? err.message : err);
    setStatus(msg, "error");
  }
}

function stop() {
  state.running = false;
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  video.srcObject = null;
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  state.hands.clear();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  flipBtn.disabled = true;
  setStatus("Camera ferma");
}

/** Passa da fotocamera frontale a posteriore (e viceversa) senza ricaricare il modello. */
async function flipCamera() {
  if (!state.stream) return;
  flipBtn.disabled = true;
  const previous = state.facingMode;
  state.facingMode = previous === "user" ? "environment" : "user";
  try {
    await openStream();
    // Con la fotocamera posteriore l'immagine non va specchiata.
    state.mirror = state.facingMode === "user";
    mirrorCheck.checked = state.mirror;
    video.classList.toggle("mirrored", state.mirror);
    state.lastVideoTime = -1;
    resizeCanvases();
    setStatus(state.facingMode === "user" ? "Fotocamera frontale" : "Fotocamera posteriore", "ready");
  } catch (err) {
    console.error(err);
    state.facingMode = previous;
    try { await openStream(); } catch (_) { /* la camera è già stata persa */ }
    setStatus("Cambio fotocamera non riuscito", "error");
  }
  flipBtn.disabled = false;
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else if (document.body.requestFullscreen) {
    document.body.requestFullscreen().catch((err) => console.warn("Schermo intero non disponibile:", err));
  }
}

// --- Interfaccia ------------------------------------------------------------

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
flipBtn.addEventListener("click", flipCamera);
fsBtn.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  // Il riquadro cambia dimensione: ricalcola i canvas.
  requestAnimationFrame(resizeCanvases);
});

palette.addEventListener("click", (e) => {
  const btn = e.target.closest(".swatch");
  if (!btn) return;
  palette.querySelectorAll(".swatch").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  state.color = btn.dataset.color;
});

toolButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    toolButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.tool = btn.dataset.tool;
    // Cambio strumento a metà gesto: chiudi i tratti aperti.
    for (const hand of state.hands.values()) hand.stroke = null;
  });
});

sizeInput.addEventListener("input", () => {
  state.width = Number(sizeInput.value);
  sizeVal.textContent = sizeInput.value;
});

sensInput.addEventListener("input", () => {
  state.pinchOnRatio = Number(sensInput.value);
  sensVal.textContent = Number(sensInput.value).toFixed(2);
});

mirrorCheck.addEventListener("change", () => {
  state.mirror = mirrorCheck.checked;
  video.classList.toggle("mirrored", state.mirror);
});

function undo() {
  if (state.strokes.length === 0) return;
  state.strokes.pop();
  for (const hand of state.hands.values()) hand.stroke = null;
  renderStrokes();
}

function clearAll() {
  state.strokes = [];
  for (const hand of state.hands.values()) hand.stroke = null;
  renderStrokes();
}

function save() {
  // Compone video (già specchiato se serve) + disegno in un unico PNG.
  const out = document.createElement("canvas");
  out.width = drawingCanvas.width;
  out.height = drawingCanvas.height;
  const ctx = out.getContext("2d");

  if (video.videoWidth) {
    const scale = Math.max(out.width / video.videoWidth, out.height / video.videoHeight);
    const w = video.videoWidth * scale;
    const h = video.videoHeight * scale;
    ctx.save();
    if (state.mirror) {
      ctx.translate(out.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, (out.width - w) / 2, (out.height - h) / 2, w, h);
    ctx.restore();
  } else {
    ctx.fillStyle = "#0b0d12";
    ctx.fillRect(0, 0, out.width, out.height);
  }

  ctx.drawImage(drawingCanvas, 0, 0);

  out.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `hand-design-${Date.now()}.png`;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, "image/png");
}

undoBtn.addEventListener("click", undo);
clearBtn.addEventListener("click", clearAll);
saveBtn.addEventListener("click", save);

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if (k === "z") undo();
  else if (k === "c") clearAll();
  else if (k === "s") save();
});

window.addEventListener("resize", resizeCanvases);

// Init
video.classList.toggle("mirrored", state.mirror);
resizeCanvases();
setStatus("Premi «Avvia camera»");

// Hook per i test automatici: permette di iniettare landmark sintetici.
// Attivo solo se la pagina è aperta con ?debug=1.
if (new URLSearchParams(location.search).has("debug")) {
  window.__handDesign = { state, processHand, renderStrokes, pinchRatio, landmarkToCanvas };
}
