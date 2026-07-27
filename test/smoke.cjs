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

    // Dita separate: il tratto si chiude.
    api.processHand('Right', mk(0.6, 0.5, 0.25));
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
    // Oltre la soglia di apertura invece deve staccare.
    api.processHand('Right', mk(0.5, 0.5, 0.6 / perUnit));
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
             midRatio, releasesAboveOff,
             beforeErase, afterErase };
  }, {});

  check('pizzico chiuso riconosciuto', result.pinchingWhileClosed, `ratio=${result.ratioClosed.toFixed(3)}`);
  check('dita separate = penna staccata', result.pinchingAfterOpen === false, `ratio=${result.ratioOpen.toFixed(3)}`);
  check('isteresi tiene il tratto', result.holdsThroughHysteresis, `ratio=${result.midRatio.toFixed(3)}`);
  check('oltre la soglia di apertura stacca', result.releasesAboveOff);
  check('tratto creato durante il pizzico', result.afterDraw === 1 && result.pts > 5, `punti=${result.pts}`);
  check('nuovo pizzico = nuovo tratto', result.strokesAfterSecond === 2);
  check('due mani = due tratti indipendenti', result.strokesWithTwoHands === 3);
  check('pixel disegnati sul canvas', result.painted > 500, `pixel=${result.painted}`);
  check('gomma cancella il tratto', result.beforeErase === 1 && result.afterErase === 0);

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

  await page.click('#stopBtn');
  const stopped = await page.evaluate(() => document.getElementById('video').srcObject === null);
  check('stop libera la camera', stopped);

  check('nessun errore in console', errors.length === 0, errors.join(' | '));

  await browser.close();
  server.close();
  console.log(failed ? `\n${failed} test falliti` : '\nTutti i test passati');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
