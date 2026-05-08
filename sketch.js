// ─────────────────────────────────────────────────────────────────────────────
//  Creative Text Editor — Head Tilt Cursor + Hand Gesture Strikethrough
//  p5.js global-mode sketch.  ml5 FaceMesh + HandPose drive interaction.
// ─────────────────────────────────────────────────────────────────────────────

// ── Tunable constants ─────────────────────────────────────────────────────────
const TILT_THRESHOLD  = 0.35;   // radians (~20°)
const NOD_THRESHOLD   = 0.20;
const CURSOR_COOLDOWN = 450;    // ms
const BASELINE_ALPHA  = 0.995;
const PEN_GRACE       = 5;      // frames fist can drop before stroke closes
const STRIKE_GRACE    = 5;      // frames strike gesture can drop before prevCursor resets

// ── Models & media ────────────────────────────────────────────────────────────
let faceMesh, handPose;
let video;
let faces = [], hands = [];

// ── Face-tilt state ───────────────────────────────────────────────────────────
let lastCursorMove    = 0;
let faceDetected      = false;
let baselineNoseRatio = null;

// ── Hand-strike state ─────────────────────────────────────────────────────────
let prevCursorX = null;
let prevCursorY = null;
let struckWords = new Set();   // word-span indices that have been struck

// ── Pen drawing state ─────────────────────────────────────────────────────────
let inkStrokes    = [];        // completed strokes, each is an array of {x, y}
let currentStroke = [];        // stroke currently being drawn
let wasPencilGrip = false;
let penGraceFrm   = 0;         // consecutive frames since fist was last seen
let strikeGraceFrm = 0;        // consecutive frames since strike gesture was last seen

// ── Eraser state ──────────────────────────────────────────────────────────────
let palmActive = false;
let palmX = 0, palmY = 0;

// ── Mirror state ──────────────────────────────────────────────────────────────
let lastMirrorText = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
let notebook, indicator, mirror;

// ─────────────────────────────────────────────────────────────────────────────
//  preload — load both ml5 models before setup() runs
// ─────────────────────────────────────────────────────────────────────────────
function preload() {
  faceMesh = ml5.faceMesh({ maxFaces: 1, refineLandmarks: false, flipHorizontal: false });
  handPose = ml5.handPose({ maxHands: 1, flipHorizontal: true });
}

// ─────────────────────────────────────────────────────────────────────────────
function setup() {
  // Full-window transparent canvas for cursor dot, hover rect, and strike lines.
  // pointer-events: none so all clicks pass through to the textarea.
  const cnv = createCanvas(windowWidth, windowHeight);
  cnv.id('overlay');
  cnv.position(0, 0);
  cnv.style('pointer-events', 'none');
  cnv.style('position', 'fixed');
  cnv.style('z-index', '200');

  frameRate(20);

  notebook  = document.getElementById('notebook');
  indicator = document.getElementById('face-indicator');
  mirror    = document.getElementById('mirror');

  notebook.focus();

  document.addEventListener('click', (e) => {
    if (e.target !== notebook) notebook.focus();
  });

  try {
    video = createCapture(VIDEO);
    video.size(320, 240);
    video.id('webcam-preview');

    faceMesh.detectStart(video, (r) => { faces = r; });
    handPose.detectStart(video, (r) => { hands = r; });
  } catch (err) {
    console.warn('Camera unavailable:', err);
  }

  syncMirror();
}

// ─────────────────────────────────────────────────────────────────────────────
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  syncMirror();
}

// ─────────────────────────────────────────────────────────────────────────────
function draw() {
  clear();
  syncMirror();

  // ── Face tilt → text cursor ───────────────────────────────────────────────
  if (!faces || faces.length === 0) {
    setIndicator(false);
  } else {
    const kp = faces[0].keypoints;

    if (kp && kp[33] && kp[263] && kp[1]) {
      setIndicator(true);

      const rEye    = kp[33];   // right-eye outer corner (user's right → LEFT of image)
      const lEye    = kp[263];  // left-eye  outer corner (user's left  → RIGHT of image)
      const noseTip = kp[1];

      const eyeWidth = Math.abs(lEye.x - rEye.x);

      if (eyeWidth >= 0.001) {
        // Debug: log tilt angle once per second — remove once confirmed working
        if (frameCount % 20 === 0) {
          const dbg = Math.atan2(lEye.y - rEye.y, lEye.x - rEye.x);
          console.log(`[tilt] eyeW=${eyeWidth.toFixed(3)}  angle=${dbg.toFixed(3)}  threshold=±${TILT_THRESHOLD}`);
        }

        const tiltAngle = Math.atan2(lEye.y - rEye.y, lEye.x - rEye.x);

        const eyeMidY   = (rEye.y + lEye.y) / 2;
        const noseRatio = (noseTip.y - eyeMidY) / eyeWidth;

        if (baselineNoseRatio === null) {
          baselineNoseRatio = noseRatio;
        } else {
          baselineNoseRatio = BASELINE_ALPHA * baselineNoseRatio + (1 - BASELINE_ALPHA) * noseRatio;
        }
        const nodDelta = noseRatio - baselineNoseRatio;

        const now = Date.now();
        if (now - lastCursorMove >= CURSOR_COOLDOWN) {
          if (document.activeElement !== notebook) notebook.focus();

          if (tiltAngle > TILT_THRESHOLD) {
            moveCursorChar(-1);        // tilt left  → cursor left
            lastCursorMove = now;
          } else if (tiltAngle < -TILT_THRESHOLD) {
            moveCursorChar(1);         // tilt right → cursor right
            lastCursorMove = now;
          }

          if (nodDelta > NOD_THRESHOLD) {
            moveCursorLine(1);         // nod down → next line
            lastCursorMove = now;
            baselineNoseRatio = noseRatio - NOD_THRESHOLD * 0.75;
          } else if (nodDelta < -NOD_THRESHOLD) {
            moveCursorLine(-1);        // look up  → prev line
            lastCursorMove = now;
            baselineNoseRatio = noseRatio + NOD_THRESHOLD * 0.75;
          }
        }
      }
    }
  }

  // ── Hand gesture routing — zone-based ────────────────────────────────────
  if (hands && hands.length > 0) {
    const hand = hands[0];
    const kp8  = hand.keypoints[8];
    const kp12 = hand.keypoints[12];

    if (kp8 && kp12) {
      // Shared cursor position (midpoint of index + middle tips)
      const rawX   = (kp8.x + kp12.x) / 2;
      const rawY   = (kp8.y + kp12.y) / 2;
      const isNorm = rawX <= 1.0 && rawY <= 1.0;
      const vw     = video.elt.videoWidth  || 640;
      const vh     = video.elt.videoHeight || 480;
      const cx = isNorm ? rawX * windowWidth  : rawX * windowWidth  / vw;
      const cy = isNorm ? rawY * windowHeight : rawY * windowHeight / vh;

      const onPad       = isOverNotepad(cx, cy);
      const seeOpenPalm = isOpenPalm(hand);
      // Lower-priority gestures only evaluated when palm is not active
      const seeStrike   = !seeOpenPalm && isTwoFingerGesture(hand) && onPad;
      const seePencil   = !seeOpenPalm && isPencilGrip(hand) && !onPad;

      if (seeOpenPalm) {
        // ── Eraser: full canvas, highest priority ─────────────────────
        palmActive     = true;
        strikeGraceFrm = 0;
        prevCursorX    = null;
        prevCursorY    = null;
        if (wasPencilGrip) {
          if (currentStroke.length > 1) inkStrokes.push([...currentStroke]);
          currentStroke = [];
          wasPencilGrip = false;
          penGraceFrm   = 0;
        }
        // Palm cursor anchored at wrist (kp0)
        const kp0 = hand.keypoints[0];
        palmX = isNorm ? kp0.x * windowWidth  : kp0.x * windowWidth  / vw;
        palmY = isNorm ? kp0.y * windowHeight : kp0.y * windowHeight / vh;
        // Permanently remove data under the eraser circle
        eraseAtPoint(palmX, palmY, 30);

      } else if (seeStrike) {
        // ── Strikethrough: inside notepad ────────────────────────────
        palmActive     = false;
        strikeGraceFrm = 0;
        if (wasPencilGrip) {
          if (currentStroke.length > 1) inkStrokes.push([...currentStroke]);
          currentStroke = [];
          wasPencilGrip = false;
          penGraceFrm   = 0;
        }

        noStroke();
        fill(210, 40, 40);
        circle(cx, cy, 18);

        const hovered = getWordAtPoint(cx, cy);
        if (hovered) {
          noFill();
          stroke(210, 40, 40);
          strokeWeight(2);
          const r = hovered.rect;
          rect(r.left - 2, r.top - 2, r.width + 4, r.height + 4, 4);
        }

        if (prevCursorX !== null) {
          const dx = cx - prevCursorX;
          const dy = cy - prevCursorY;
          if (Math.abs(dx) > 10 && Math.abs(dy) < 50) {
            for (let i = 0; i <= 16; i++) {
              const t = i / 16;
              const w = getWordAtPoint(prevCursorX + dx * t, prevCursorY + dy * t);
              if (w) struckWords.add(w.index);
            }
          }
        }

        prevCursorX = cx;
        prevCursorY = cy;

      } else if (seePencil) {
        // ── Pen drawing: outside notepad ─────────────────────────────
        palmActive  = false;
        penGraceFrm = 0;
        prevCursorX = null;
        prevCursorY = null;

        currentStroke.push({ x: cx, y: cy });
        noStroke();
        fill(20, 20, 20);
        circle(cx, cy, 10);
        wasPencilGrip = true;

      } else {
        // No active gesture — run grace-period counters
        palmActive = false;

        if (prevCursorX !== null) {
          strikeGraceFrm++;
          if (strikeGraceFrm >= STRIKE_GRACE) {
            prevCursorX    = null;
            prevCursorY    = null;
            strikeGraceFrm = 0;
          }
        }

        if (wasPencilGrip) {
          penGraceFrm++;
          if (penGraceFrm >= PEN_GRACE) {
            if (currentStroke.length > 1) inkStrokes.push([...currentStroke]);
            currentStroke = [];
            wasPencilGrip = false;
            penGraceFrm   = 0;
          }
        }
      }

    } else {
      // Keypoints unavailable — hard reset
      palmActive  = false;
      prevCursorX = null;
      prevCursorY = null;
      if (wasPencilGrip) {
        if (currentStroke.length > 1) inkStrokes.push([...currentStroke]);
        currentStroke = [];
        wasPencilGrip = false;
        penGraceFrm   = 0;
      }
    }
  } else {
    // No hand detected — hard reset
    palmActive  = false;
    prevCursorX = null;
    prevCursorY = null;
    if (wasPencilGrip) {
      if (currentStroke.length > 1) inkStrokes.push([...currentStroke]);
      currentStroke = [];
      wasPencilGrip = false;
      penGraceFrm   = 0;
    }
  }

  // Ink beneath strike lines; eraser cursor on top of everything
  drawInkStrokes();
  drawStrikes();
  drawEraserCursor();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Zone + gesture helpers
// ─────────────────────────────────────────────────────────────────────────────

function isOverNotepad(x, y) {
  const r = document.getElementById('notebook').getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function isOpenPalm(hand) {
  const kp = hand.keypoints;
  if (!kp || kp.length < 21) return false;
  const isNorm = kp[8].x <= 1.0 && kp[8].y <= 1.0;
  const thresh = isNorm ? 0.05 : 15;
  return (
    kp[4].y  < kp[2].y  - thresh &&   // thumb
    kp[8].y  < kp[5].y  - thresh &&   // index
    kp[12].y < kp[9].y  - thresh &&   // middle
    kp[16].y < kp[13].y - thresh &&   // ring
    kp[20].y < kp[17].y - thresh      // pinky
  );
}

function isTwoFingerGesture(hand) {
  const kp = hand.keypoints;
  if (!kp || kp.length < 21) return false;

  const isNorm  = kp[8].x <= 1.0 && kp[8].y <= 1.0;
  const thresh  = isNorm ? 0.05 : 15;

  const indexUp  = (kp[5].y  - kp[8].y)  > thresh;
  const middleUp = (kp[9].y  - kp[12].y) > thresh;

  if (frameCount % 20 === 0) {
    console.log(`[strike] indexUp=${indexUp} (${(kp[5].y - kp[8].y).toFixed(3)}) middleUp=${middleUp} (${(kp[9].y - kp[12].y).toFixed(3)}) thresh=${thresh}`);
  }

  return indexUp && middleUp;
}

function dist2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isPencilGrip(hand) {
  const kp = hand.keypoints;
  if (!kp || kp.length < 21) return false;

  // Convert keypoints to viewport pixels so the threshold is literally in px
  const isNorm = kp[8].x <= 1.0 && kp[8].y <= 1.0;
  const vw     = video ? (video.elt.videoWidth  || 640) : 640;
  const vh     = video ? (video.elt.videoHeight || 480) : 480;
  const toVP   = p => isNorm
    ? { x: p.x * windowWidth,      y: p.y * windowHeight }
    : { x: p.x * windowWidth / vw, y: p.y * windowHeight / vh };

  const dIndex  = dist2D(toVP(kp[8]),  toVP(kp[5]));
  const dMiddle = dist2D(toVP(kp[12]), toVP(kp[9]));
  const dRing   = dist2D(toVP(kp[16]), toVP(kp[13]));
  const dPinky  = dist2D(toVP(kp[20]), toVP(kp[17]));

  console.log(`[pencil] index=${dIndex.toFixed(1)} middle=${dMiddle.toFixed(1)} ring=${dRing.toFixed(1)} pinky=${dPinky.toFixed(1)}`);

  const THRESH = 60;
  return dIndex < THRESH && dMiddle < THRESH && dRing < THRESH && dPinky < THRESH;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Ink rendering + eraser — redrawn from stored arrays every frame
// ─────────────────────────────────────────────────────────────────────────────

function drawInkStrokes() {
  for (const pts of inkStrokes)  drawCurveStroke(pts);
  if (currentStroke.length > 0) drawCurveStroke(currentStroke);
}

function drawCurveStroke(pts) {
  if (pts.length < 2) return;

  stroke(20, 20, 20);
  strokeWeight(2.5);
  noFill();

  if (pts.length === 2) {
    line(pts[0].x, pts[0].y, pts[1].x, pts[1].y);
    return;
  }

  // Catmull-Rom via p5 curveVertex — duplicate endpoints so curve reaches them
  beginShape();
  curveVertex(pts[0].x, pts[0].y);
  for (const p of pts) curveVertex(p.x, p.y);
  curveVertex(pts[pts.length - 1].x, pts[pts.length - 1].y);
  endShape();
}

function eraseAtPoint(px, py, r) {
  const r2 = r * r;
  // Remove ink stroke points inside the eraser circle
  for (let i = inkStrokes.length - 1; i >= 0; i--) {
    inkStrokes[i] = inkStrokes[i].filter(p => (p.x - px) ** 2 + (p.y - py) ** 2 > r2);
    if (inkStrokes[i].length < 2) inkStrokes.splice(i, 1);
  }
  currentStroke = currentStroke.filter(p => (p.x - px) ** 2 + (p.y - py) ** 2 > r2);

  // Remove struck words whose visual midline intersects the eraser circle
  if (struckWords.size > 0 && mirror) {
    const spans = mirror.querySelectorAll('span[data-index]');
    for (const span of spans) {
      const idx = parseInt(span.dataset.index);
      if (!struckWords.has(idx)) continue;
      const rect = span.getBoundingClientRect();
      const mx   = (rect.left + rect.right) / 2;
      const my   = rect.top + rect.height * 0.55;
      if ((mx - px) ** 2 + (my - py) ** 2 <= r2) struckWords.delete(idx);
    }
  }
}

function drawEraserCursor() {
  if (!palmActive) return;
  // Composite-erase the pixels already drawn by drawInkStrokes / drawStrikes
  erase();
  noStroke();
  fill(255);
  circle(palmX, palmY, 60);
  noErase();
  // Visible ring so the user can see the eraser boundary
  noFill();
  stroke(0, 0, 0);
  strokeWeight(2);
  circle(palmX, palmY, 60);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Text cursor helpers
// ─────────────────────────────────────────────────────────────────────────────

function moveCursorChar(delta) {
  notebook.focus();
  const pos    = notebook.selectionStart;
  const newPos = Math.max(0, Math.min(notebook.value.length, pos + delta));
  notebook.setSelectionRange(newPos, newPos);
}

function moveCursorLine(direction) {
  const pos  = notebook.selectionStart;
  const text = notebook.value;

  const beforeCursor = text.substring(0, pos);
  const linesAbove   = beforeCursor.split('\n');
  const currentLine  = linesAbove.length - 1;
  const currentCol   = linesAbove[currentLine].length;

  const allLines   = text.split('\n');
  const targetLine = Math.max(0, Math.min(allLines.length - 1, currentLine + direction));

  let newPos = 0;
  for (let i = 0; i < targetLine; i++) newPos += allLines[i].length + 1;
  newPos += Math.min(currentCol, allLines[targetLine].length);

  notebook.setSelectionRange(newPos, newPos);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Word hit-detection
// ─────────────────────────────────────────────────────────────────────────────

function getWordAtPoint(px, py) {
  const els = document.elementsFromPoint(px, py);
  const el  = els.find(e => e.tagName === 'SPAN' && e.dataset.index !== undefined);
  if (!el) return null;

  // Vertical bounds check: reject points clearly outside this span's line
  const rect = el.getBoundingClientRect();
  if (py < rect.top - 12 || py > rect.bottom + 12) return null;

  return { index: parseInt(el.dataset.index), el, text: el.textContent, rect };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Mirror sync — keeps #mirror pixel-perfect over #notebook every frame
// ─────────────────────────────────────────────────────────────────────────────

function syncMirror() {
  if (!mirror || !notebook) return;

  // Sync scroll so struck-word positions stay aligned with visible text
  mirror.scrollTop = notebook.scrollTop;

  // Only rebuild spans when the text has actually changed
  const text = notebook.value;
  if (text === lastMirrorText) return;
  lastMirrorText = text;

  // Text edited — stale word indices are invalid, clear strikes
  struckWords.clear();

  // Tokenise preserving whitespace (spaces, newlines) as raw text nodes so
  // the div wraps identically to the textarea
  const tokens = text.split(/(\s+)/);
  mirror.innerHTML = '';
  let wordIndex = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (/^\s+$/.test(token)) {
      mirror.appendChild(document.createTextNode(token));
    } else {
      const span = document.createElement('span');
      span.dataset.index = wordIndex++;
      span.textContent   = token;
      span.style.pointerEvents = 'auto';
      mirror.appendChild(span);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Strike rendering — redrawn from struckWords Set on every frame
// ─────────────────────────────────────────────────────────────────────────────

function drawStrikes() {
  if (struckWords.size === 0) return;

  stroke(210, 40, 40);
  strokeWeight(2);
  noFill();

  const spans = mirror.querySelectorAll('span[data-index]');
  for (const span of spans) {
    if (!struckWords.has(parseInt(span.dataset.index))) continue;
    const r = span.getBoundingClientRect();
    const y = r.top + r.height * 0.55;   // 55% down the line height
    line(r.left, y, r.right, y);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Face-detected indicator
// ─────────────────────────────────────────────────────────────────────────────

function setIndicator(active) {
  if (active === faceDetected) return;
  faceDetected = active;
  indicator.classList.toggle('active', active);
}
