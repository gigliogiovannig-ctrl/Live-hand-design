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

  // --- Gesto sintetico: pizzico chiuso che si muove -> deve nascere un tratto ---
  const result = await page.evaluate(({ }) => {
    const api = window.__handDesign;
    const mk = (x, y, spread) => {
      const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
      lm[0] = { x: 0.5, y: 0.85, z: 0 };
      lm[9] = { x: 0.5, y: 0.60, z: 0 };
      lm[4] = { x, y, z: 0 };
      lm[8] = { x: x + spread, y, z: 0 };
      return lm;
    };
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
    const mk = (x, y, spread) => {
      const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
      lm[0] = { x: 0.5, y: 0.85, z: 0 };
      lm[9] = { x: 0.5, y: 0.60, z: 0 };
      lm[4] = { x, y, z: 0 };
      lm[8] = { x: x + spread, y, z: 0 };
      return lm;
    };
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
