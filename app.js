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

// Articolazioni per capire se un dito è teso o chiuso.
const FINGERS = [
  { name: "index", mcp: 5, pip: 6, tip: 8 },
  { name: "middle", mcp: 9, pip: 10, tip: 12 },
  { name: "ring", mcp: 13, pip: 14, tip: 16 },
  { name: "pinky", mcp: 17, pip: 18, tip: 20 },
];

// Quanto va tenuta una posa prima che faccia effetto.
const POSE_HOLD = { toggleTool: 400, toggleLock: 500, clearAll: 1000 };

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
const pausedBadge = document.getElementById("pausedBadge");
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
  releaseMs: 130,      // quanto si aspetta prima di credere a un rilascio
  graceMs: 260,        // quanto si tiene vivo il tratto se la mano sparisce
  strokes: [],         // tratti completati + in corso, in coordinate normalizzate 0..1
  cleared: null,       // ultima tela cancellata, per poter annullare la pulizia
  locked: false,       // disegno sospeso: la mano si muove senza lasciare segni
  hands: new Map(),    // stato per mano
};

// Smoothing adattivo: alpha = SMOOTH_MIN + velocità (larghezze di canvas al
// secondo) * SMOOTH_GAIN, con tetto a 1 (nessun filtro, nessun ritardo).
const SMOOTH_MIN = 0.35;
const SMOOTH_GAIN = 0.5;

// Salto massimo (in frazione di canvas) che si accetta di collegare con una linea.
const MAX_BRIDGE = 0.28;

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

/** Distanza fra due punti normalizzati, corretta per le proporzioni del video. */
function handDist(a, b) {
  const aspect = (video.videoWidth || 4) / (video.videoHeight || 3);
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

/**
 * Forza del pizzico: distanza pollice-indice normalizzata sulla dimensione
 * della mano (polso -> nocca del medio). Così è indipendente dalla distanza
 * dalla camera e dalla grandezza della mano.
 */
function pinchRatio(landmarks) {
  const handSize = handDist(landmarks[WRIST], landmarks[MIDDLE_MCP]) || 1e-6;
  return handDist(landmarks[THUMB_TIP], landmarks[INDEX_TIP]) / handSize;
}

/**
 * Dito teso o chiuso: si confronta quanto dista dal polso la punta rispetto
 * alla nocca centrale. È un rapporto, quindi non dipende da quanto è lontana
 * la mano né da come è ruotata.
 */
function fingerReach(landmarks, finger) {
  const wrist = landmarks[WRIST];
  return handDist(landmarks[finger.tip], wrist) / (handDist(landmarks[finger.pip], wrist) || 1e-6);
}

/** Pugno stretto: dita chiuse e punte raccolte contro il palmo. */
function isTightFist(landmarks) {
  if (!FINGERS.every((f) => fingerReach(landmarks, f) < 1.02)) return false;
  const palm = { x: 0, y: 0 };
  for (const f of FINGERS) {
    palm.x += landmarks[f.mcp].x / FINGERS.length;
    palm.y += landmarks[f.mcp].y / FINGERS.length;
  }
  const size = handDist(landmarks[WRIST], landmarks[MIDDLE_MCP]) || 1e-6;
  // Nel pizzico l'indice sta davanti alla mano, ben lontano dal palmo: è questo
  // che distingue il pugno da un pizzico, in cui pure il pollice tocca l'indice.
  return FINGERS.every((f) => handDist(landmarks[f.tip], palm) < size * 0.75);
}

/**
 * Posa riconosciuta: segno V (cambia strumento), segno del 3 (sospende o
 * riprende il disegno) o pugno chiuso (pulisce la tela).
 */
function detectPose(landmarks) {
  const reach = {};
  for (const f of FINGERS) reach[f.name] = fingerReach(landmarks, f);
  const up = (name) => reach[name] > 1.15;
  const down = (name) => reach[name] < 1.02;

  // Il 3 va provato prima della V: differiscono solo per l'anulare.
  if (up("index") && up("middle") && up("ring") && down("pinky")) return "toggleLock";
  if (up("index") && up("middle") && down("ring") && down("pinky")) return "toggleTool";
  if (isTightFist(landmarks)) return "clearAll";
  return null;
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

/**
 * Disegna solo l'ultimo pezzo del tratto invece di ricomporre tutta la tela.
 * Ridisegnare ogni punto di ogni tratto a ogni frame costa sempre di più man mano
 * che il disegno cresce, e il rallentamento si sente proprio quando la mano corre.
 */
function drawStrokeTail(stroke) {
  const pts = stroke.points;
  const s = canvasScale();
  drawCtx.lineCap = "round";
  drawCtx.lineJoin = "round";
  drawCtx.strokeStyle = stroke.color;
  drawCtx.lineWidth = stroke.width * s;

  const n = pts.length;
  const P = (i) => fromNormalized(pts[i]);

  if (n === 1) {
    const p = P(0);
    drawCtx.fillStyle = stroke.color;
    drawCtx.beginPath();
    drawCtx.arc(p.x, p.y, (stroke.width * s) / 2, 0, Math.PI * 2);
    drawCtx.fill();
    return;
  }

  drawCtx.beginPath();
  if (n === 2) {
    const a = P(0), b = P(1);
    drawCtx.moveTo(a.x, a.y);
    drawCtx.lineTo(b.x, b.y);
  } else {
    // Stessa curva quadratica del rendering completo: dal punto medio del
    // segmento precedente, con vertice sul penultimo punto.
    const a = P(n - 3), b = P(n - 2), c = P(n - 1);
    drawCtx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
    drawCtx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
    // Coda provvisoria fino all'ultimo punto: la punta segue la mano senza
    // ritardo di un campione, e il punto successivo la ridisegna sopra.
    drawCtx.lineTo(c.x, c.y);
  }
  drawCtx.stroke();
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

    // Posa in corso: anello che si riempie, per vedere cosa sta per scattare
    // e avere il tempo di disfare il gesto.
    if (hand && hand.poseName && !hand.poseFired) {
      const progress = Math.min((performance.now() - hand.poseSince) / POSE_HOLD[hand.poseName], 1);
      const palm = landmarkToCanvas(landmarks[MIDDLE_MCP]);
      const wrist = landmarkToCanvas(landmarks[WRIST]);
      const radius = Math.max(Math.hypot(palm.x - wrist.x, palm.y - wrist.y) * 0.9, 30 * s);
      const clearing = hand.poseName === "clearAll";

      ctx.lineWidth = 5 * s;
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.beginPath();
      ctx.arc(palm.x, palm.y, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = clearing ? "#ff453a" : hand.poseName === "toggleLock" ? "#ffd60a" : "#0a84ff";
      ctx.beginPath();
      ctx.arc(palm.x, palm.y, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      ctx.stroke();

      ctx.fillStyle = "#fff";
      ctx.font = `${13 * s}px -apple-system, system-ui, sans-serif`;
      ctx.textAlign = "center";
      const labels = {
        clearAll: "Pulisco tutto…",
        toggleLock: state.locked ? "→ Riprendi" : "→ Sospendi",
        toggleTool: state.tool === "pen" ? "→ Gomma" : "→ Penna",
      };
      ctx.fillText(labels[hand.poseName], palm.x, palm.y - radius - 10 * s);
      ctx.textAlign = "start";
    }

    // Cursore: cerchio fra pollice e indice, pieno quando il pizzico è chiuso.
    const thumb = landmarkToCanvas(landmarks[THUMB_TIP]);
    const index = landmarkToCanvas(landmarks[INDEX_TIP]);
    const cx = (thumb.x + index.x) / 2;
    const cy = (thumb.y + index.y) / 2;
    const r = Math.max(state.width * s * 0.75, 10 * s);
    const cursorColor = state.locked ? "#8e97a8"
      : state.tool === "eraser" ? "#ffffff" : state.color;

    ctx.lineWidth = 2.5 * s;
    ctx.strokeStyle = cursorColor;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    if (pinching && !state.locked) {
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

function processHand(key, landmarks, now = performance.now()) {
  let hand = state.hands.get(key);
  if (!hand) {
    hand = { pinching: false, stroke: null, smooth: null, pendingRelease: null, suspendMark: 0,
             poseName: null, poseSince: now, poseFired: false, lastSeen: now, lastTs: now };
    state.hands.set(key, hand);
  }
  hand.lastSeen = now;

  const pose = detectPose(landmarks);

  const ratio = pinchRatio(landmarks);
  const onThreshold = state.pinchOnRatio;
  const offThreshold = state.pinchOnRatio * 1.45; // isteresi: evita lo sfarfallio

  const wasPinching = hand.pinching;
  // In un pugno chiuso il pollice si ripiega sopra le dita e finisce vicino alla
  // punta dell'indice: senza questa precedenza sembrerebbe un pizzico.
  const rawPinch = pose === "clearAll" ? false
    : wasPinching ? ratio < offThreshold : ratio < onThreshold;

  // Quando la mano corre, la sfocatura da movimento sballa i landmark e il
  // pizzico può sembrare aperto per un frame o due. Invece di alzare subito la
  // penna, si continua a disegnare e si aspetta conferma: se le dita si
  // richiudono in fretta il tratto prosegue intero, se il rilascio è vero i
  // punti aggiunti nel frattempo vengono tolti (niente codina finale).
  let pinching = rawPinch;
  if (wasPinching && !rawPinch) {
    if (hand.pendingRelease === null) {
      hand.pendingRelease = now;
      hand.suspendMark = hand.stroke ? hand.stroke.points.length : 0;
    }
    if (now - hand.pendingRelease < state.releaseMs) {
      pinching = true;
    } else if (hand.stroke && hand.stroke.points.length > hand.suspendMark) {
      hand.stroke.points.length = Math.max(hand.suspendMark, 1);
      renderStrokes();
    }
  } else if (rawPinch) {
    hand.pendingRelease = null;
  }
  hand.pinching = pinching;

  // Mentre si disegna non si cambia strumento; e a disegno sospeso l'unica posa
  // che conta è quella che lo riprende, così in pausa nulla tocca la tela.
  const gated = pinching && pose === "toggleTool" ? null : pose;
  updatePose(hand, state.locked && gated !== "toggleLock" ? null : gated, now);

  // Punto di disegno: a metà fra le punte di pollice e indice.
  const thumb = landmarkToCanvas(landmarks[THUMB_TIP]);
  const index = landmarkToCanvas(landmarks[INDEX_TIP]);
  const raw = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };

  const dt = Math.min(Math.max((now - hand.lastTs) / 1000, 1 / 120), 0.25);
  hand.lastTs = now;

  if (!hand.smooth || (!wasPinching && pinching)) {
    hand.smooth = { ...raw };
  } else {
    // Smoothing adattivo alla velocità: da fermo filtra il tremolio del
    // tracking, in corsa lascia passare il movimento quasi intatto. Con un
    // fattore fisso la punta resterebbe indietro proprio nei tratti veloci.
    const speed = Math.hypot(raw.x - hand.smooth.x, raw.y - hand.smooth.y) / drawingCanvas.width / dt;
    const alpha = Math.min(SMOOTH_MIN + speed * SMOOTH_GAIN, 1);
    hand.smooth = {
      x: hand.smooth.x + (raw.x - hand.smooth.x) * alpha,
      y: hand.smooth.y + (raw.y - hand.smooth.y) * alpha,
    };
  }

  // Disegno sospeso: la mano si muove liberamente senza lasciare segni.
  if (!pinching || state.locked) {
    hand.stroke = null;
    return;
  }

  const norm = toNormalized(hand.smooth);

  if (state.tool === "eraser") {
    eraseAt(norm);
    return;
  }

  // Dopo una perdita di tracking la mano può ricomparire lontana: meglio un
  // tratto nuovo che una riga dritta attraverso il disegno.
  const prev = hand.stroke && hand.stroke.points[hand.stroke.points.length - 1];
  const jumped = prev && Math.hypot(norm.x - prev.x, norm.y - prev.y) > MAX_BRIDGE;

  if (!hand.stroke || jumped) {
    hand.stroke = { color: state.color, width: state.width, points: [norm] };
    state.strokes.push(hand.stroke);
    drawStrokeTail(hand.stroke);
    return;
  }

  const minStep = 1.5 / drawingCanvas.width; // scarta i micro-movimenti
  if (Math.hypot(norm.x - prev.x, norm.y - prev.y) > minStep) {
    hand.stroke.points.push(norm);
    drawStrokeTail(hand.stroke);
  }
}

/**
 * Tiene il conto di quanto una posa è stata mantenuta e la fa scattare una volta
 * sola: per ripeterla bisogna disfare il gesto e rifarlo.
 */
function updatePose(hand, pose, now) {
  if (pose !== hand.poseName) {
    hand.poseName = pose;
    hand.poseSince = now;
    hand.poseFired = false;
    return;
  }
  if (!pose || hand.poseFired || now - hand.poseSince < POSE_HOLD[pose]) return;

  hand.poseFired = true;
  if (pose === "toggleLock") {
    setLocked(!state.locked);
    setStatus(state.locked ? "Segno del 3 — disegno sospeso" : "Segno del 3 — disegno ripreso", "ready");
  } else if (pose === "toggleTool") {
    setTool(state.tool === "pen" ? "eraser" : "pen");
    setStatus(state.tool === "eraser" ? "Segno V — gomma" : "Segno V — penna", "ready");
  } else if (pose === "clearAll") {
    clearAll();
    setStatus("Pugno chiuso — tela pulita (annullabile)", "ready");
  }
}

/**
 * Mano non rilevata in questo frame: la si tiene "viva" per un attimo. Un buco
 * di uno o due frame è normale quando il movimento è rapido, e chiudere subito
 * il tratto è ciò che spezzava le linee veloci.
 */
function expireLostHand(hand, now) {
  if (now - hand.lastSeen < state.graceMs) return;
  hand.pinching = false;
  hand.stroke = null;
  hand.smooth = null;
  hand.pendingRelease = null;
  hand.poseName = null;
  hand.poseFired = false;
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
        processHand(key, landmarks, ts);
      });
      // Mano uscita dal campo visivo: il tratto resta aperto per il tempo di grazia.
      for (const [key, hand] of state.hands) {
        if (!seen.has(key)) expireLostHand(hand, ts);
      }
      const anyPinch = [...state.hands.values()].some((h) => h.pinching);
      if (state.locked) {
        setStatus("Disegno sospeso — rifai il 3 per riprendere", "ready");
      } else {
        setStatus(
          anyPinch
            ? state.tool === "eraser" ? "Cancello…" : "Disegno…"
            : `Mano rilevata (${results.landmarks.length}) — pizzica per disegnare`,
          anyPinch ? "drawing" : "ready"
        );
      }
    } else {
      for (const hand of state.hands.values()) expireLostHand(hand, ts);
      const holding = [...state.hands.values()].some((h) => h.pinching);
      if (!holding) setStatus("Nessuna mano inquadrata", "ready");
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
    // Soglie di presenza e inseguimento basse: con la mano in movimento
    // l'immagine è sfocata e il modello, se è severo, la perde a metà tratto.
    minHandPresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
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
      // Più frame al secondo = campioni più fitti e meno sfocatura sui gesti rapidi.
      frameRate: { ideal: 60 },
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

function setLocked(locked) {
  state.locked = locked;
  pausedBadge.hidden = !locked;
  viewport.classList.toggle("paused", locked);
  // Niente tratti in sospeso da riprendere quando si torna a disegnare.
  for (const hand of state.hands.values()) hand.stroke = null;
}

function setTool(tool) {
  state.tool = tool;
  toolButtons.forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  // Scegliere uno strumento è anche il modo per uscire dalla pausa col mouse,
  // se il gesto non venisse riconosciuto.
  if (state.locked) setLocked(false);
  // Cambio strumento a metà gesto: chiudi i tratti aperti.
  for (const hand of state.hands.values()) hand.stroke = null;
}

toolButtons.forEach((btn) => {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
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
  // Una pulizia totale si annulla: il pugno chiuso è un gesto che può scappare.
  if (state.strokes.length === 0 && state.cleared) {
    state.strokes = state.cleared;
    state.cleared = null;
    renderStrokes();
    return;
  }
  if (state.strokes.length === 0) return;
  state.strokes.pop();
  for (const hand of state.hands.values()) hand.stroke = null;
  renderStrokes();
}

function clearAll() {
  if (state.strokes.length) state.cleared = state.strokes;
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
  window.__handDesign = {
    state, processHand, expireLostHand, renderStrokes, drawStrokeTail, pinchRatio, landmarkToCanvas,
    detectPose, isTightFist, fingerReach, setTool, setLocked, undo, clearAll, drawOverlay,
    FINGERS, POSE_HOLD,
  };
}
