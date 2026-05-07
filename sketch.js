// ─────────────────────────────────────────────────────────────────────────────
//  Creative Text Editor — Head Tilt Cursor Movement
//  p5.js global-mode sketch.  ml5 FaceMesh v1 drives the cursor.
// ─────────────────────────────────────────────────────────────────────────────

// ── Tunable constants ────────────────────────────────────────────────────────
const TILT_THRESHOLD  = 0.35;   // radians (~20°) — eye-line angle to trigger left/right
const NOD_THRESHOLD   = 0.20;   // normalised — nose-drop ratio to trigger up/down
const CURSOR_COOLDOWN = 350;    // ms between successive cursor moves
const BASELINE_ALPHA  = 0.995;  // exponential smoother for nod baseline (0–1)

// ── State ────────────────────────────────────────────────────────────────────
let faceMesh;
let video;
let faces             = [];
let lastCursorMove    = 0;
let faceDetected      = false;
let baselineNoseRatio = null;

// DOM refs (set in setup)
let notebook;
let indicator;

// ─────────────────────────────────────────────────────────────────────────────
//  preload() — p5 waits for this before running setup(), giving ml5 time to
//  download the FaceMesh model weights before detection is started.
// ─────────────────────────────────────────────────────────────────────────────
function preload() {
  faceMesh = ml5.faceMesh({ maxFaces: 1, refineLandmarks: false, flipHorizontal: false });
}

// ─────────────────────────────────────────────────────────────────────────────
function setup() {
  noCanvas();
  frameRate(20);

  notebook  = document.getElementById('notebook');
  indicator = document.getElementById('face-indicator');
  notebook.focus();

  // Re-focus textarea after any click so setSelectionRange() keeps working
  document.addEventListener('click', (e) => {
    if (e.target !== notebook) notebook.focus();
  });

  // Webcam — graceful degradation if unavailable
  try {
    video = createCapture(VIDEO);
    video.size(320, 240);
    video.id('webcam-preview');   // CSS handles position; do NOT call hide()

    // Pass the p5 video element directly — this is the pattern ml5 v1 expects.
    faceMesh.detectStart(video, (results) => { faces = results; });
  } catch (err) {
    console.warn('Head tilt disabled — webcam unavailable:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function draw() {
  if (!faces || faces.length === 0) {
    setIndicator(false);
    return;
  }

  const face = faces[0];
  const kp   = face.keypoints;

  // Only verify the three specific points we actually use (33, 263, 1).
  // Checking kp.length === 468 was too strict — ml5 may return 478 (with irises)
  // or another count, causing this to silently return every frame.
  if (!kp || !kp[33] || !kp[263] || !kp[1]) return;

  setIndicator(true);

  // ── Key MediaPipe FaceMesh landmarks (image coords, no flip) ──────────────
  //   33  = right-eye outer corner  (user's right → LEFT side of image)
  //  263  = left-eye  outer corner  (user's left  → RIGHT side of image)
  //    1  = nose tip
  const rEye    = kp[33];
  const lEye    = kp[263];
  const noseTip = kp[1];

  const eyeWidth = Math.abs(lEye.x - rEye.x);

  // Guard: only skip if eyes are literally on top of each other (tracking failure).
  // The old threshold of 10 assumed pixel coordinates — normalized coords (0–1)
  // have eyeWidth ≈ 0.15–0.25, which always triggered the early return.
  if (eyeWidth < 0.001) return;

  // Debug: log coordinate scale + tilt angle once per second so you can
  // verify detection is running.  Remove once confirmed working.
  if (frameCount % 20 === 0) {
    const tiltDbg = Math.atan2(lEye.y - rEye.y, lEye.x - rEye.x);
    console.log(`[tilt] eyeW=${eyeWidth.toFixed(3)}  angle=${tiltDbg.toFixed(3)}  threshold=±${TILT_THRESHOLD}`);
  }

  // ── Head tilt angle ────────────────────────────────────────────────────────
  //  atan2 is scale-independent, so it works for both pixel and normalised coords.
  //  Tilt LEFT  (left ear down): lEye.y increases, rEye.y decreases → angle > 0
  //  Tilt RIGHT (right ear down): lEye.y decreases, rEye.y increases → angle < 0
  const tiltAngle = Math.atan2(lEye.y - rEye.y, lEye.x - rEye.x);

  // ── Normalised nod ratio ───────────────────────────────────────────────────
  const eyeMidY   = (rEye.y + lEye.y) / 2;
  const noseRatio = (noseTip.y - eyeMidY) / eyeWidth;

  if (baselineNoseRatio === null) {
    baselineNoseRatio = noseRatio;
  } else {
    baselineNoseRatio = BASELINE_ALPHA * baselineNoseRatio + (1 - BASELINE_ALPHA) * noseRatio;
  }
  const nodDelta = noseRatio - baselineNoseRatio;

  // ── Cooldown guard ─────────────────────────────────────────────────────────
  const now = Date.now();
  if (now - lastCursorMove < CURSOR_COOLDOWN) return;

  if (document.activeElement !== notebook) notebook.focus();

  // ── Left / right tilt → character cursor ──────────────────────────────────
  if (tiltAngle > TILT_THRESHOLD) {
    moveCursorChar(-1);        // tilt left  → cursor left
    lastCursorMove = now;
  } else if (tiltAngle < -TILT_THRESHOLD) {
    moveCursorChar(1);         // tilt right → cursor right
    lastCursorMove = now;
  }

  // ── Nod down / up → line cursor ───────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
//  Cursor helpers
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
  for (let i = 0; i < targetLine; i++) {
    newPos += allLines[i].length + 1;   // +1 for '\n'
  }
  newPos += Math.min(currentCol, allLines[targetLine].length);

  notebook.setSelectionRange(newPos, newPos);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Face indicator helper
// ─────────────────────────────────────────────────────────────────────────────

function setIndicator(active) {
  if (active === faceDetected) return;
  faceDetected = active;
  indicator.classList.toggle('active', active);
}
