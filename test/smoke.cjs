/**
 * Smoke test end-to-end: apre l'app in Chromium headless con una webcam finta,
 * verifica che modello e tracking si avviino, poi inietta landmark sintetici
 * (hook `?debug=1`) per collaudare la logica del pizzico, del disegno e dei comandi.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node test/smoke.cjs
 *
 * Se in `test/vendor/` sono presenti copie locali del runtime MediaPipe e del
 * modello, vengono servite al posto del CDN (utile in ambienti senza rete).
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(__dirname, 'vendor', 'package');
const MODEL = path.join(__dirname, 'vendor', 'hand_landmarker.task');
const PORT = 8123;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const errors = [];
  const browser = await chromium.launch({
    // Webcam finta: Chromium genera un video sintetico senza chiedere permessi.
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'],
  });
  const ctx = await browser.newContext({ permissions: ['camera'] });
  const page = await ctx.newPage();

  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  // Copie locali opzionali: se presenti, sostituiscono il CDN (rete non necessaria).
  if (fs.existsSync(VENDOR)) {
    await page.route('https://cdn.jsdelivr.net/**', (route) => {
      const rel = new URL(route.request().url()).pathname.replace(/^.*tasks-vision@[\d.]+\//, '');
      const file = path.join(VENDOR, rel);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'missing ' + rel });
      const ct = file.endsWith('.wasm') ? 'application/wasm'
        : /\.(mjs|js)$/.test(file) ? 'text/javascript' : 'application/octet-stream';
      route.fulfill({ status: 200, headers: { 'content-type': ct }, body: fs.readFileSync(file) });
    });
  }
  if (fs.existsSync(MODEL)) {
    await page.route('https://storage.googleapis.com/**', (route) =>
      route.fulfill({ status: 200, body: fs.readFileSync(MODEL) }));
  }

  let failed = 0;
  const check = (name, ok, extra = '') => {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  };

  await page.goto(`http://localhost:${PORT}/?debug=1`, { waitUntil: 'load' });
  check('pagina caricata', await page.title() !== '');

  await page.click('#startBtn');
  // Attende che il modello sia caricato e il loop di rilevamento stia girando.
  await page.waitForFunction(
    () => /Nessuna mano|Mano rilevata|Pronto/.test(document.getElementById('statusText').textContent),
    null, { timeout: 60000 }
  );
  const status = await page.textContent('#statusText');
  check('camera + modello avviati', true, `status: "${status}"`);

  const videoOk = await page.evaluate(() => {
    const v = document.getElementById('video');
    return v.videoWidth > 0 && v.videoHeight > 0 && !v.paused;
  });
  check('stream video attivo', videoOk);

  // Lascia girare qualche frame di rilevamento reale sul video finto.
  await page.waitForTimeout(2500);

  // Costruttori di mani sintetiche, condivisi da tutti i blocchi di test.
  // Vanno riempiti tutti e 21 i landmark: una mano con le articolazioni lasciate
  // al centro somiglia a un pugno chiuso e farebbe scattare le pose.
  await page.evaluate(() => {
    const MCP_X = { 5: 0.44, 9: 0.50, 13: 0.56, 17: 0.61 };
    const MCP_Y = { 5: 0.62, 9: 0.60, 13: 0.62, 17: 0.65 };
    const FINGERS = [
      { name: 'index', mcp: 5, pip: 6, dip: 7, tip: 8 },
      { name: 'middle', mcp: 9, pip: 10, dip: 11, tip: 12 },
      { name: 'ring', mcp: 13, pip: 14, dip: 15, tip: 16 },
      { name: 'pinky', mcp: 17, pip: 18, dip: 19, tip: 20 },
    ];

    /** Mano con le dita elencate in `extended` tese e le altre chiuse sul palmo. */
    window.__hand = (extended, thumbTip) => {
      const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
      lm[0] = { x: 0.5, y: 0.85, z: 0 };
      for (const f of FINGERS) {
        const x = MCP_X[f.mcp], my = MCP_Y[f.mcp];
        lm[f.mcp] = { x, y: my, z: 0 };
        const out = extended.includes(f.name);
        lm[f.pip] = { x, y: my - (out ? 0.08 : 0.06), z: 0 };
        lm[f.dip] = { x, y: my - (out ? 0.16 : 0.02), z: 0 };
        lm[f.tip] = { x, y: my - (out ? 0.22 : -0.02), z: 0 };
      }
      lm[1] = { x: 0.38, y: 0.78, z: 0 };
      lm[2] = { x: 0.35, y: 0.72, z: 0 };
      lm[3] = { x: 0.36, y: 0.67, z: 0 };
      lm[4] = { x: thumbTip.x, y: thumbTip.y, z: 0 };
      return lm;
    };

    /**
     * Mano che pizzica: punta del pollice in (x, y), punta dell'indice spostata
     * di `spread`, indice teso in avanti (come quando si pizzica davvero) e le
     * altre dita raccolte.
     */
    window.__mk = (x, y, spread) => {
      const lm = window.__hand(['middle'], { x, y });
      const mcp = { x: 0.44, y: 0.62 };
      const tip = { x: x + spread, y };
      lm[6] = { x: mcp.x + (tip.x - mcp.x) * 0.35, y: mcp.y + (tip.y - mcp.y) * 0.35, z: 0 };
      lm[7] = { x: mcp.x + (tip.x - mcp.x) * 0.7, y: mcp.y + (tip.y - mcp.y) * 0.7, z: 0 };
      lm[8] = { x: tip.x, y: tip.y, z: 0 };
      // Il medio resta piegato: una V richiede indice E medio tesi.
      lm[10] = { x: 0.5, y: 0.54, z: 0 };
      lm[11] = { x: 0.5, y: 0.58, z: 0 };
      lm[12] = { x: 0.5, y: 0.62, z: 0 };
      return lm;
    };

    window.__V = () => window.__hand(['index', 'middle'], { x: 0.36, y: 0.66 });
    window.__THREE = () => window.__hand(['index', 'middle', 'ring'], { x: 0.36, y: 0.66 });
    // Pugno vero: pollice ripiegato sopra le dita, vicino alla punta dell'indice.
    window.__FIST = () => window.__hand([], { x: 0.46, y: 0.66 });
    window.__OPEN = () => window.__hand(['index', 'middle', 'ring', 'pinky'], { x: 0.33, y: 0.62 });
  });

  // --- Gesto sintetico: pizzico chiuso che si muove -> deve nascere un tratto ---
  const result = await page.evaluate(({ }) => {
    const api = window.__handDesign;
    const mk = window.__mk;
    api.state.strokes = [];
    api.state.hands.clear();

    const ratioClosed = api.pinchRatio(mk(0.4, 0.5, 0.01));
    const ratioOpen = api.pinchRatio(mk(0.4, 0.5, 0.20));

    // Dita unite, mano che si muove da sinistra a destra.
    for (let i = 0; i <= 20; i++) api.processHand('Right', mk(0.3 + i * 0.015, 0.5, 0.01));
    const afterDraw = api.state.strokes.length;
    const pts = api.state.strokes[0] ? api.state.strokes[0].points.length : 0;
    const pinchingWhileClosed = api.state.hands.get('Right').pinching;

    // Dita separate: la penna si alza, ma solo dopo la conferma del rilascio
    // (un frame isolato con le dita "aperte" è spesso sfocatura da movimento).
    const tOpen = performance.now();
    api.processHand('Right', mk(0.6, 0.5, 0.25), tOpen);
    const pinchingWaitingConfirm = api.state.hands.get('Right').pinching;
    api.processHand('Right', mk(0.6, 0.5, 0.25), tOpen + 300);
    const pinchingAfterOpen = api.state.hands.get('Right').pinching;

    // Nuovo pizzico -> nuovo tratto separato.
    for (let i = 0; i <= 5; i++) api.processHand('Right', mk(0.5, 0.3 + i * 0.02, 0.01));
    const strokesAfterSecond = api.state.strokes.length;

    // Seconda mano contemporanea.
    for (let i = 0; i <= 5; i++) api.processHand('Left', mk(0.2, 0.2 + i * 0.02, 0.01));
    const strokesWithTwoHands = api.state.strokes.length;

    // Pixel effettivamente disegnati sul canvas?
    const c = document.getElementById('drawing');
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;

    // Isteresi: a metà strada fra le due soglie il pizzico resta attivo.
    api.state.hands.clear();
    api.state.strokes = [];
    api.processHand('Right', mk(0.5, 0.5, 0.01));                 // chiude
    // Ricava lo spread che dà un ratio fra soglia di chiusura (0.35) e di apertura (0.5075),
    // indipendentemente dall'aspect ratio effettivo della webcam.
    const perUnit = api.pinchRatio(mk(0.5, 0.5, 0.1)) / 0.1;
    const midSpread = 0.42 / perUnit;
    api.processHand('Right', mk(0.5, 0.5, midSpread));
    const midRatio = api.pinchRatio(mk(0.5, 0.5, midSpread));
    const holdsThroughHysteresis = api.state.hands.get('Right').pinching;
    // Oltre la soglia di apertura, confermata nel tempo, deve staccare.
    const tRel = performance.now();
    api.processHand('Right', mk(0.5, 0.5, 0.6 / perUnit), tRel);
    api.processHand('Right', mk(0.5, 0.5, 0.6 / perUnit), tRel + 300);
    const releasesAboveOff = api.state.hands.get('Right').pinching === false;

    // Gomma: cancella i tratti che tocca.
    api.state.strokes = [];
    api.state.hands.clear();
    api.state.tool = 'pen';
    for (let i = 0; i <= 10; i++) api.processHand('Right', mk(0.5, 0.4 + i * 0.01, 0.01));
    const beforeErase = api.state.strokes.length;
    api.state.tool = 'eraser';
    api.state.hands.clear();
    for (let i = 0; i <= 10; i++) api.processHand('Right', mk(0.5, 0.4 + i * 0.01, 0.01));
    const afterErase = api.state.strokes.length;
    api.state.tool = 'pen';

    return { ratioClosed, ratioOpen, afterDraw, pts, pinchingWhileClosed, pinchingAfterOpen,
             strokesAfterSecond, strokesWithTwoHands, painted, holdsThroughHysteresis,
             pinchingWaitingConfirm,
             midRatio, releasesAboveOff,
             beforeErase, afterErase };
  }, {});

  check('pizzico chiuso riconosciuto', result.pinchingWhileClosed, `ratio=${result.ratioClosed.toFixed(3)}`);
  check('dita separate = penna staccata (dopo conferma)',
    result.pinchingAfterOpen === false && result.pinchingWaitingConfirm === true,
    `ratio=${result.ratioOpen.toFixed(3)}`);
  check('isteresi tiene il tratto', result.holdsThroughHysteresis, `ratio=${result.midRatio.toFixed(3)}`);
  check('oltre la soglia di apertura stacca', result.releasesAboveOff);
  check('tratto creato durante il pizzico', result.afterDraw === 1 && result.pts > 5, `punti=${result.pts}`);
  check('nuovo pizzico = nuovo tratto', result.strokesAfterSecond === 2);
  check('due mani = due tratti indipendenti', result.strokesWithTwoHands === 3);
  check('pixel disegnati sul canvas', result.painted > 500, `pixel=${result.painted}`);
  check('gomma cancella il tratto', result.beforeErase === 1 && result.afterErase === 0);

  // --- Gesti rapidi: il tratto non deve spezzarsi né restare indietro ---
  const fast = await page.evaluate(() => {
    const api = window.__handDesign;
    const mk = window.__mk;
    // Spread corrispondente a un dato "ratio", qualunque sia l'aspect della camera.
    const perUnit = api.pinchRatio(mk(0.5, 0.5, 0.1)) / 0.1;
    const CLOSED = 0.07 / perUnit;   // dita unite
    const OPEN = 0.90 / perUnit;     // dita chiaramente separate
    const canvas = document.getElementById('drawing');
    const painted = () => {
      const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    };
    const reset = () => { api.state.strokes = []; api.state.hands.clear(); api.renderStrokes(); };
    const stroke0 = () => api.state.strokes[0];
    let t = 1000;
    const FRAME = 16; // ~60 fps

    // 1. Mano veloce: 3% del fotogramma per campione, cioè ~1.9 larghezze al secondo.
    reset();
    for (let i = 0; i < 25; i++) { api.processHand('Right', mk(0.15 + i * 0.03, 0.5, CLOSED), t); t += FRAME; }
    const fastStrokes = api.state.strokes.length;
    const fastPoints = stroke0() ? stroke0().points.length : 0;
    const fastPainted = painted();
    // Ritardo della punta rispetto alla posizione reale delle dita.
    const lastLm = mk(0.15 + 24 * 0.03, 0.5, CLOSED);
    const a = api.landmarkToCanvas(lastLm[4]), b = api.landmarkToCanvas(lastLm[8]);
    const realX = (a.x + b.x) / 2, realY = (a.y + b.y) / 2;
    const drawn = stroke0().points[stroke0().points.length - 1];
    const lag = Math.hypot(drawn.x * canvas.width - realX, drawn.y * canvas.height - realY) / canvas.width;

    // Coerenza fra disegno incrementale e rendering completo.
    const beforeRerender = painted();
    api.renderStrokes();
    const afterRerender = painted();

    // 2. Pizzico che "sfarfalla" per la sfocatura: 3 frame aperti e poi richiuso.
    reset();
    for (let i = 0; i < 10; i++) { api.processHand('Right', mk(0.2 + i * 0.02, 0.4, CLOSED), t); t += FRAME; }
    const beforeFlicker = stroke0().points.length;
    for (let i = 0; i < 3; i++) { api.processHand('Right', mk(0.4 + i * 0.02, 0.4, OPEN), t); t += FRAME; }
    const pinchingDuringFlicker = api.state.hands.get('Right').pinching;
    for (let i = 0; i < 6; i++) { api.processHand('Right', mk(0.46 + i * 0.02, 0.4, CLOSED), t); t += FRAME; }
    const flickerStrokes = api.state.strokes.length;
    const afterFlicker = stroke0().points.length;

    // 3. Rilascio vero: le dita restano aperte oltre il tempo di attesa.
    reset();
    for (let i = 0; i < 10; i++) { api.processHand('Right', mk(0.2 + i * 0.02, 0.6, CLOSED), t); t += FRAME; }
    const beforeRelease = stroke0().points.length;
    for (let i = 0; i < 12; i++) { api.processHand('Right', mk(0.4, 0.6, OPEN), t); t += 20; } // 240ms
    const releaseStrokes = api.state.strokes.length;
    const afterRelease = stroke0().points.length;
    const pinchingAfterRelease = api.state.hands.get('Right').pinching;

    // 4. Frame persi dal tracking: sotto il tempo di grazia il tratto sopravvive.
    reset();
    for (let i = 0; i < 10; i++) { api.processHand('Right', mk(0.3 + i * 0.02, 0.7, CLOSED), t); t += FRAME; }
    const hand = api.state.hands.get('Right');
    api.expireLostHand(hand, t + 120);
    const survivesShortGap = hand.stroke !== null && hand.pinching;
    api.expireLostHand(hand, t + 400);
    const closesLongGap = hand.stroke === null && !hand.pinching;

    // 5. Mano ricomparsa lontanissima: tratto nuovo, non una riga attraverso il disegno.
    reset();
    for (let i = 0; i < 5; i++) { api.processHand('Right', mk(0.15 + i * 0.01, 0.3, CLOSED), t); t += FRAME; }
    api.processHand('Right', mk(0.9, 0.8, CLOSED), t); t += FRAME;
    const jumpStrokes = api.state.strokes.length;

    // 6. Da fermo il tremolio del tracking resta filtrato.
    reset();
    for (let i = 0; i < 15; i++) {
      api.processHand('Right', mk(0.5 + (i % 2 ? 0.004 : -0.004), 0.5, CLOSED), t); t += FRAME;
    }
    const pts = stroke0().points;
    let spread = 0;
    for (const p of pts) spread = Math.max(spread, Math.abs(p.x - pts[0].x));
    const jitterRaw = 0.008 * (canvas.width / canvas.width); // ampiezza iniettata, normalizzata
    reset();

    return { fastStrokes, fastPoints, fastPainted, lag, beforeRerender, afterRerender,
             beforeFlicker, afterFlicker, flickerStrokes, pinchingDuringFlicker,
             beforeRelease, afterRelease, releaseStrokes, pinchingAfterRelease,
             survivesShortGap, closesLongGap, jumpStrokes, jitterSpread: spread, jitterRaw };
  });

  check('gesto veloce: un tratto solo', fast.fastStrokes === 1 && fast.fastPoints >= 24,
    `tratti=${fast.fastStrokes}, punti=${fast.fastPoints}`);
  check('gesto veloce: la punta non resta indietro', fast.lag < 0.02,
    `ritardo=${(fast.lag * 100).toFixed(2)}% della larghezza`);
  check('disegno incrementale = rendering completo',
    Math.abs(fast.beforeRerender - fast.afterRerender) / fast.afterRerender < 0.1,
    `${fast.beforeRerender} vs ${fast.afterRerender} pixel`);
  check('sfarfallio del pizzico: tratto non spezzato',
    fast.flickerStrokes === 1 && fast.afterFlicker > fast.beforeFlicker && fast.pinchingDuringFlicker,
    `punti ${fast.beforeFlicker} -> ${fast.afterFlicker}`);
  check('rilascio vero: penna alzata senza coda',
    fast.releaseStrokes === 1 && fast.afterRelease === fast.beforeRelease && !fast.pinchingAfterRelease,
    `punti ${fast.beforeRelease} -> ${fast.afterRelease}`);
  check('frame persi: tratto vivo sotto il tempo di grazia', fast.survivesShortGap);
  check('assenza prolungata: tratto chiuso', fast.closesLongGap);
  check('salto enorme: nuovo tratto, niente riga fantasma', fast.jumpStrokes === 2);
  check('da fermo il tremolio resta filtrato', fast.jitterSpread < fast.jitterRaw,
    `ampiezza disegnata=${fast.jitterSpread.toFixed(4)} vs iniettata=${fast.jitterRaw}`);

  // --- Pose: segno V cambia strumento, pugno chiuso pulisce ---
  const poses = await page.evaluate(() => {
    const api = window.__handDesign;
    const V = window.__V, FIST = window.__FIST, OPEN = window.__OPEN;
    // Pizzico: indice teso in avanti con la punta sul pollice.
    const PINCH = () => window.__mk(0.40, 0.40, 0.01);

    const reset = () => {
      api.state.strokes = []; api.state.cleared = null; api.state.hands.clear();
      api.setTool('pen'); api.renderStrokes();
    };

    // Riconoscimento delle pose isolato dal resto.
    const poseV = api.detectPose(V());
    const poseFist = api.detectPose(FIST());
    const poseOpen = api.detectPose(OPEN());
    const posePinch = api.detectPose(PINCH());
    const pinchRatioInFist = api.pinchRatio(FIST());
    const pinchRatioInPinch = api.pinchRatio(PINCH());

    // Segno V tenuto: cambia strumento una volta sola.
    reset();
    let t = 5000;
    api.processHand('Right', V(), t);
    const toolAtStart = api.state.tool;
    api.processHand('Right', V(), t + 200);
    const toolTooEarly = api.state.tool;                 // 200ms: non basta
    api.processHand('Right', V(), t + 500);
    const toolAfterHold = api.state.tool;                // 500ms: cambiato
    api.processHand('Right', V(), t + 2000);
    const toolStillHeld = api.state.tool;                // tenuto oltre: non rimbalza

    // Disfare e rifare la V riporta alla penna.
    api.processHand('Right', OPEN(), t + 2100);
    api.processHand('Right', V(), t + 2200);
    api.processHand('Right', V(), t + 2700);
    const toolAfterSecondV = api.state.tool;

    // Pugno chiuso: pulisce solo dopo un secondo pieno, ed è annullabile.
    reset();
    api.state.strokes = [
      { color: '#fff', width: 6, points: [{ x: .1, y: .1 }, { x: .5, y: .5 }] },
      { color: '#fff', width: 6, points: [{ x: .2, y: .2 }, { x: .6, y: .6 }] },
    ];
    api.renderStrokes();
    t = 9000;
    api.processHand('Right', FIST(), t);
    api.processHand('Right', FIST(), t + 700);
    const strokesBeforeSecond = api.state.strokes.length;   // 700ms: ancora tutto lì
    api.processHand('Right', FIST(), t + 1100);
    const strokesAfterFist = api.state.strokes.length;      // 1.1s: pulito
    const drewDuringFist = api.state.hands.get('Right').pinching;
    api.undo();
    const strokesAfterUndo = api.state.strokes.length;      // recuperabile

    // Pugno mentre si disegna: il pizzico non deve tenere in ostaggio la posa,
    // ma nemmeno il pugno deve disegnare.
    reset();
    t = 12000;
    for (let i = 0; i < 5; i++) api.processHand('Right', PINCH(), t + i * 16);
    const strokesFromPinch = api.state.strokes.length;
    const toolBeforeVWhileDrawing = api.state.tool;
    // V mentre il pizzico è ancora attivo: ignorata finché la penna non si stacca.
    api.processHand('Right', V(), t + 100);
    api.processHand('Right', V(), t + 200);
    const toolWhileDrawing = api.state.tool;

    reset();
    return { poseV, poseFist, poseOpen, posePinch, pinchRatioInFist, pinchRatioInPinch,
             toolAtStart, toolTooEarly, toolAfterHold, toolStillHeld, toolAfterSecondV,
             strokesBeforeSecond, strokesAfterFist, strokesAfterUndo, drewDuringFist,
             strokesFromPinch, toolBeforeVWhileDrawing, toolWhileDrawing };
  });

  check('riconosce il segno V', poses.poseV === 'toggleTool', `posa=${poses.poseV}`);
  check('riconosce il pugno chiuso', poses.poseFist === 'clearAll', `posa=${poses.poseFist}`);
  check('mano aperta e pizzico non sono pose', poses.poseOpen === null && poses.posePinch === null,
    `aperta=${poses.poseOpen}, pizzico=${poses.posePinch}`);
  check('il pugno non viene scambiato per un pizzico',
    poses.pinchRatioInFist < 0.35 && !poses.drewDuringFist,
    `ratio pugno=${poses.pinchRatioInFist.toFixed(2)} (sotto soglia, ma il pugno ha la precedenza)`);
  check('il pizzico sintetico disegna', poses.pinchRatioInPinch < 0.35 && poses.strokesFromPinch === 1,
    `ratio=${poses.pinchRatioInPinch.toFixed(2)}`);
  check('V: cambia strumento solo dopo 400ms',
    poses.toolAtStart === 'pen' && poses.toolTooEarly === 'pen' && poses.toolAfterHold === 'eraser',
    `${poses.toolAtStart} -> ${poses.toolTooEarly} (200ms) -> ${poses.toolAfterHold} (500ms)`);
  check('V tenuta a lungo non rimbalza', poses.toolStillHeld === 'eraser');
  check('V rifatta torna alla penna', poses.toolAfterSecondV === 'pen');
  check('pugno: pulisce solo dopo un secondo',
    poses.strokesBeforeSecond === 2 && poses.strokesAfterFist === 0,
    `${poses.strokesBeforeSecond} tratti a 700ms, ${poses.strokesAfterFist} a 1.1s`);
  check('pulizia da gesto annullabile', poses.strokesAfterUndo === 2);
  check('V ignorata mentre si disegna', poses.toolWhileDrawing === poses.toolBeforeVWhileDrawing,
    `strumento=${poses.toolWhileDrawing}`);

  // --- Segno del 3: sospende e riprende il disegno ---
  const lock = await page.evaluate(() => {
    const api = window.__handDesign;
    const THREE = window.__THREE, V = window.__V, FIST = window.__FIST, OPEN = window.__OPEN;
    const PINCH = (x = 0.40, y = 0.40) => window.__mk(x, y, 0.01);
    const reset = () => {
      api.state.strokes = []; api.state.cleared = null; api.state.hands.clear();
      api.setTool('pen'); api.setLocked(false); api.renderStrokes();
    };

    // Il 3 e la V si distinguono solo per l'anulare: non vanno confusi.
    const poseThree = api.detectPose(THREE());
    const poseV = api.detectPose(V());

    // Tenuto mezzo secondo sospende; prima no.
    reset();
    let t = 20000;
    api.processHand('Right', THREE(), t);
    api.processHand('Right', THREE(), t + 300);
    const lockedTooEarly = api.state.locked;              // 300ms: ancora attivo
    api.processHand('Right', THREE(), t + 600);
    const lockedAfterHold = api.state.locked;             // 600ms: sospeso
    const badgeVisible = !document.getElementById('pausedBadge').hidden;

    // Sospeso: il pizzico non disegna.
    for (let i = 0; i < 10; i++) api.processHand('Right', PINCH(0.3 + i * 0.02, 0.4), t + 700 + i * 16);
    const strokesWhileLocked = api.state.strokes.length;

    // Sospeso: nemmeno la gomma cancella.
    api.state.strokes = [{ color: '#fff', width: 6, points: [{ x: .5, y: .5 }] }];
    api.setTool('eraser');            // (da pulsante: sblocca, quindi si risospende)
    api.setLocked(true);
    api.state.hands.clear();
    for (let i = 0; i < 10; i++) api.processHand('Right', PINCH(0.5, 0.5), t + 900 + i * 16);
    const strokesAfterLockedEraser = api.state.strokes.length;

    // Sospeso: V e pugno restano inerti.
    api.state.hands.clear();
    let t2 = t + 2000;
    for (const f of [0, 500, 900]) api.processHand('Right', V(), t2 + f);
    const toolAfterLockedV = api.state.tool;
    api.state.hands.clear();
    for (const f of [0, 700, 1200]) api.processHand('Right', FIST(), t2 + 1000 + f);
    const strokesAfterLockedFist = api.state.strokes.length;

    // Rifare il 3 riprende, con lo strumento di prima (gomma).
    api.state.hands.clear();
    let t3 = t2 + 4000;
    api.processHand('Right', THREE(), t3);
    api.processHand('Right', THREE(), t3 + 600);
    const lockedAfterSecondThree = api.state.locked;
    const toolAfterResume = api.state.tool;

    // Ripreso: il pizzico torna a funzionare (gomma attiva -> cancella).
    api.state.hands.clear();
    api.state.strokes = [{ color: '#fff', width: 6, points: [{ x: .5, y: .5 }] }];
    for (let i = 0; i < 10; i++) api.processHand('Right', PINCH(0.5, 0.5), t3 + 700 + i * 16);
    const erasedAfterResume = api.state.strokes.length === 0;

    // Il pulsante dello strumento è la via d'uscita col mouse.
    api.setLocked(true);
    api.setTool('pen');
    const unlockedByButton = !api.state.locked;

    reset();
    return { poseThree, poseV, lockedTooEarly, lockedAfterHold, badgeVisible, strokesWhileLocked,
             strokesAfterLockedEraser, toolAfterLockedV, strokesAfterLockedFist,
             lockedAfterSecondThree, toolAfterResume, erasedAfterResume, unlockedByButton };
  });

  check('riconosce il segno del 3, distinto dalla V',
    lock.poseThree === 'toggleLock' && lock.poseV === 'toggleTool',
    `3=${lock.poseThree}, V=${lock.poseV}`);
  check('3: sospende solo dopo 500ms',
    lock.lockedTooEarly === false && lock.lockedAfterHold === true && lock.badgeVisible,
    `300ms=${lock.lockedTooEarly}, 600ms=${lock.lockedAfterHold}`);
  check('sospeso: il pizzico non disegna', lock.strokesWhileLocked === 0);
  check('sospeso: la gomma non cancella', lock.strokesAfterLockedEraser === 1);
  check('sospeso: V e pugno restano inerti',
    lock.toolAfterLockedV === 'eraser' && lock.strokesAfterLockedFist === 1,
    `strumento=${lock.toolAfterLockedV}, tratti=${lock.strokesAfterLockedFist}`);
  check('3 rifatto: riprende con lo strumento di prima',
    lock.lockedAfterSecondThree === false && lock.toolAfterResume === 'eraser',
    `strumento=${lock.toolAfterResume}`);
  check('ripreso: il gesto torna a funzionare', lock.erasedAfterResume);
  check('il pulsante strumento sblocca col mouse', lock.unlockedByButton);

  // L'anello di avanzamento della posa vive nell'overlay, che con la webcam
  // finta non vede mai una mano: lo si chiama a mano con risultati sintetici.
  const overlay = await page.evaluate(() => {
    const api = window.__handDesign;
    const canvas = document.getElementById('overlay');
    const painted = () => {
      const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    };
    api.state.hands.clear();
    const results = { landmarks: [window.__V()], handedness: [[{ categoryName: 'Right' }]] };

    // Posa appena iniziata: anello quasi vuoto.
    api.processHand('Right', window.__V(), performance.now());
    api.drawOverlay(results);
    const withPose = painted();

    // Posa già scattata: l'anello sparisce.
    api.state.hands.get('Right').poseFired = true;
    api.drawOverlay(results);
    const afterFired = painted();

    // Pugno: stessa cosa, ma anello rosso.
    api.state.hands.clear();
    api.processHand('Right', window.__FIST(), performance.now());
    api.drawOverlay({ landmarks: [window.__FIST()], handedness: [[{ categoryName: 'Right' }]] });
    const withFist = painted();

    api.drawOverlay(null);
    return { withPose, afterFired, withFist, cleared: painted() };
  });
  check('anello di avanzamento disegnato durante la posa',
    overlay.withPose > 0 && overlay.withFist > 0 && overlay.withPose > overlay.afterFired,
    `V=${overlay.withPose}px, pugno=${overlay.withFist}px, dopo lo scatto=${overlay.afterFired}px`);
  check('overlay ripulito senza mani', overlay.cleared === 0);

  // Undo / clear / salvataggio PNG.
  const uiOk = await page.evaluate(() => {
    const api = window.__handDesign;
    api.state.strokes = [{ color: '#fff', width: 6, points: [{ x: .1, y: .1 }, { x: .5, y: .5 }] },
                         { color: '#fff', width: 6, points: [{ x: .2, y: .2 }, { x: .6, y: .6 }] }];
    document.getElementById('undoBtn').click();
    const afterUndo = api.state.strokes.length;
    document.getElementById('clearBtn').click();
    return { afterUndo, afterClear: api.state.strokes.length };
  });
  check('annulla rimuove un tratto', uiOk.afterUndo === 1);
  check('pulisci svuota il disegno', uiOk.afterClear === 0);

  // La codifica PNG di un canvas grande, con il loop di tracking attivo, può richiedere secondi.
  const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.click('#saveBtn');
  const download = await dl;
  check('salva PNG', !!download, download ? download.suggestedFilename() : 'nessun download');

  // Cambio fotocamera: con la webcam finta lo stream è lo stesso, ma il giro deve reggere.
  await page.click('#flipBtn');
  await page.waitForFunction(
    () => !document.getElementById('flipBtn').disabled, null, { timeout: 10000 }
  ).catch(() => {});
  const flipped = await page.evaluate(() => ({
    facing: window.__handDesign.state.facingMode,
    mirror: window.__handDesign.state.mirror,
    playing: !document.getElementById('video').paused,
  }));
  check('cambio fotocamera', flipped.facing === 'environment' && flipped.playing,
    `facing=${flipped.facing}, mirror=${flipped.mirror}`);

  await page.click('#stopBtn');
  const stopped = await page.evaluate(() => document.getElementById('video').srcObject === null);
  check('stop libera la camera', stopped);

  // --- Layout su telefono (portrait) ---
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  const layout = await phone.evaluate(() => {
    const vp = document.getElementById('viewport').getBoundingClientRect();
    const btn = document.getElementById('startBtn').getBoundingClientRect();
    return {
      ratio: vp.width / vp.height,
      fitsWidth: vp.width <= window.innerWidth,
      touchTarget: btn.height,
      noHScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
    };
  });
  check('portrait: riquadro verticale 3/4', Math.abs(layout.ratio - 0.75) < 0.02, `ratio=${layout.ratio.toFixed(2)}`);
  check('portrait: nessuno scroll orizzontale', layout.noHScroll && layout.fitsWidth);
  check('portrait: pulsanti toccabili (>=44px)', layout.touchTarget >= 44, `${Math.round(layout.touchTarget)}px`);

  check('nessun errore in console', errors.length === 0, errors.join(' | '));

  await browser.close();
  server.close();
  console.log(failed ? `\n${failed} test falliti` : '\nTutti i test passati');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
