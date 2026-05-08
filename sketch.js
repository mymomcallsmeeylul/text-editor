// ─────────────────────────────────────────────────────────────────────────────
//  Creative Text Editor — Head Tilt Cursor + Hand Gesture Strikethrough
//  p5.js global-mode sketch.  ml5 FaceMesh + HandPose drive interaction.
// ─────────────────────────────────────────────────────────────────────────────

// ── Tunable constants ─────────────────────────────────────────────────────────
const TILT_THRESHOLD  = 0.35;   // radians (~20°)
const NOD_THRESHOLD   = 0.20;
const CURSOR_COOLDOWN = 450;    // ms
const BASELINE_ALPHA  = 0.995;

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

  // ── Hand cursor, hover, strike ────────────────────────────────────────────
  if (hands && hands.length > 0) {
    const hand = hands[0];
    const kp8  = hand.keypoints[8];    // index fingertip
    const kp12 = hand.keypoints[12];   // middle fingertip

    if (kp8 && kp12) {
      // Scale to viewport — handles both normalised (0–1) and pixel coords
      const rawX   = (kp8.x + kp12.x) / 2;
      const rawY   = (kp8.y + kp12.y) / 2;
      const isNorm = rawX <= 1.0 && rawY <= 1.0;
      const cx = isNorm ? rawX * windowWidth  : rawX * windowWidth  / (video.elt.videoWidth  || 640);
      const cy = isNorm ? rawY * windowHeight : rawY * windowHeight / (video.elt.videoHeight || 480);

      // 18px red cursor dot
      noStroke();
      fill(220, 50, 50);
      circle(cx, cy, 18);

      // Hover: rounded red outline around word under cursor
      const hovered = getWordAtPoint(cx, cy);
      if (hovered) {
        noFill();
        stroke(220, 50, 50);
        strokeWeight(2);
        const r = hovered.rect;
        rect(r.left - 2, r.top - 2, r.width + 4, r.height + 4, 4);
      }

      // Strike: horizontal swipe (large dx, small dy)
      if (prevCursorX !== null) {
        const dx = cx - prevCursorX;
        const dy = cy - prevCursorY;
        if (Math.abs(dx) > 10 && Math.abs(dy) < 50) {
          // Interpolate 16 steps so fast swipes catch every word swept over
          for (let i = 0; i <= 16; i++) {
            const t = i / 16;
            const w = getWordAtPoint(prevCursorX + dx * t, prevCursorY + dy * t);
            if (w) struckWords.add(w.index);
          }
        }
      }

      prevCursorX = cx;
      prevCursorY = cy;
    }
  } else {
    prevCursorX = null;
    prevCursorY = null;
  }

  // Redraw all persisted strike lines on top
  drawStrikes();
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

  stroke(220, 50, 50);
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
