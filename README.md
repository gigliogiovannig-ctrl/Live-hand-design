# Live Hand Design

Disegna nell'aria davanti alla webcam: quando unisci **pollice e indice** (il gesto del pizzico)
l'app traccia una linea che segue il movimento della mano; quando separi le dita, la penna si stacca.

Tutto gira nel browser: i frame della webcam non lasciano mai il dispositivo.

## Come si usa

1. Avvia un server locale nella cartella del progetto (la webcam richiede `https` oppure `localhost`):

   ```bash
   python3 -m http.server 8000
   # oppure: npx serve .
   ```

2. Apri <http://localhost:8000> in Chrome, Edge o Safari recenti.
3. Premi **Avvia camera** e concedi il permesso.
4. Inquadra la mano, unisci pollice e indice e muovi la mano per disegnare.

### Controlli

| Comando | Cosa fa |
| --- | --- |
| Pizzico pollice + indice | Disegna (o cancella, con la gomma attiva) |
| Penna / Gomma | Cambia strumento; la gomma elimina i tratti che tocca |
| Tavolozza e slider spessore | Colore e larghezza del tratto |
| Sensibilità pizzico | Quanto devono essere vicine le dita perché il gesto scatti |
| Specchia (selfie) | Vista a specchio, più naturale da usare |
| `Z` / `C` / `S` | Annulla ultimo tratto / pulisci tutto / salva PNG (video + disegno) |

Sono supportate **due mani** contemporaneamente: ognuna disegna il proprio tratto.

## Come funziona

- **Tracking**: [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
  (via CDN jsDelivr) restituisce 21 punti per mano a ogni frame.
- **Rilevamento del pizzico**: si misura la distanza fra punta del pollice (landmark 4) e punta
  dell'indice (landmark 8), **normalizzata sulla dimensione della mano** (polso → nocca del medio).
  Il rapporto è quindi indipendente da quanto sei lontano dalla camera. Due soglie con isteresi
  (chiusura a `ratio`, apertura a `ratio × 1.45`) evitano che il tratto lampeggi al limite del gesto.
- **Punto di disegno**: il punto medio fra le due punte, filtrato con una media esponenziale
  (α = 0.45) per togliere il tremolio del tracking.
- **Tratti**: memorizzati in coordinate normalizzate 0–1 e ridisegnati con curve quadratiche fra i
  punti medi, così le linee restano morbide e sopravvivono al ridimensionamento della finestra.

## File

- `index.html` — struttura e pannello dei controlli
- `style.css` — stile
- `app.js` — webcam, rilevamento della mano, logica del gesto e rendering
- `test/smoke.cjs` — smoke test end-to-end in Chromium headless

## Test

```bash
npm i -D playwright && npx playwright install chromium
node test/smoke.cjs
```

Il test apre l'app con una webcam finta di Chromium, verifica che runtime e modello si carichino e
che il loop di rilevamento giri, poi inietta landmark sintetici (tramite l'hook attivo con `?debug=1`)
per collaudare soglie del pizzico e isteresi, creazione dei tratti, disegno su due mani, gomma,
annulla/pulisci e salvataggio PNG.

## Requisiti

Browser desktop o mobile con supporto a WebAssembly e `getUserMedia` (Chrome/Edge 94+, Safari 16+,
Firefox recente). Serve connessione a internet al primo avvio per scaricare modello e runtime dal CDN.
