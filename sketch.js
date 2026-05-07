// ─────────────────────────────────────────────────────────────────────────────
//  Creative Text Editor — Head Tilt Cursor Movement
//  p5.js global-mode sketch.  ml5 FaceMesh v1 drives the cursor.
// ─────────────────────────────────────────────────────────────────────────────

// ── Tunable constants ────────────────────────────────────────────────────────
const TILT_THRESHOLD  = 0.10;   // radians  — eye-line angle to trigger left/right
const NOD_THRESHOLD   = 0.13;   // normalised — nose-drop ratio to trigger up/down
const CURSOR_COOLDOWN = 150;    // ms between successive cursor moves
const BASELINE_ALPHA  = 0.995;  // exponential smoother for nod baseline (0–1)
                                 //  higher = slower drift correction

// ── State ────────────────────────────────────────────────────────────────────
let faceMesh;
let video;
let faces            = [];
let lastCursorMove   = 0;
let faceDetected     = false;
let baselineNoseRatio = null;   // slowly-adapting neutral head position

// DOM refs (set in setup)
let notebook;
let indicator;

// ─────────────────────────────────────────────────────────────────────────────
function setup() {
  noCanvas();
  frameRate(20);   // 20 fps is plenty; reduces idle CPU

  notebook  = document.getElementById('notebook');
  indicator = document.getElementById('face-indicator');

  notebook.focus();

  // Keep textarea focused so setSelectionRange() always works
  document.addEventListener('click', (e) => {
    if (e.target !== notebook) notebook.focus();
  });

  // Webcam + FaceMesh — graceful degradation if webcam is unavailable
  try {
    video = createCapture(VIDEO);
    video.size(320, 240);
    video.hide();

    // ml5 v1 FaceMesh API
    faceMesh = ml5.faceMesh({ maxFaces: 1, refineLandmarks: false, flipHorizontal: false });
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
  if (!kp || kp.length < 468) return;

  setIndicator(true);

  // ── Key MediaPipe FaceMesh landmarks (image coordinates, no flip) ──────────
  //   33  = right-eye outer corner  (user's right → appears on LEFT of image)
  //  263  = left-eye  outer corner  (user's left  → appears on RIGHT of image)
  //    1  = nose tip
  const rEye    = kp[33];
  const lEye    = kp[263];
  const noseTip = kp[1];

  // Guard: reject if eyes are too close (face too far or badly tracked)
  const eyeWidth = Math.abs(lEye.x - rEye.x);
  if (eyeWidth < 10) return;

  // ── Head tilt angle ────────────────────────────────────────────────────────
  //  Without flip: lEye.x > rEye.x
  //  Tilt LEFT  (left ear down): lEye.y rises, rEye.y drops → angle > 0
  //  Tilt RIGHT (right ear down): lEye.y drops, rEye.y rises → angle < 0
  const tiltAngle = Math.atan2(lEye.y - rEye.y, lEye.x - rEye.x);

  // ── Normalised nod ratio ───────────────────────────────────────────────────
  //  nose.y relative to eye midpoint, scaled by eye width (distance-invariant)
  const eyeMidY   = (rEye.y + lEye.y) / 2;
  const noseRatio = (noseTip.y - eyeMidY) / eyeWidth;

  // Drift-correcting baseline (adapts very slowly to the user's neutral pose)
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
    moveCursorChar(-1);          // tilt left  → cursor left
    lastCursorMove = now;
  } else if (tiltAngle < -TILT_THRESHOLD) {
    moveCursorChar(1);           // tilt right → cursor right
    lastCursorMove = now;
  }

  // ── Nod down / up → line cursor ───────────────────────────────────────────
  //  After a trigger we nudge the baseline so the user must return to neutral
  //  before the next trigger fires (prevents runaway scrolling).
  if (nodDelta > NOD_THRESHOLD) {
    moveCursorLine(1);           // nod down  → next line
    lastCursorMove = now;
    baselineNoseRatio = noseRatio - NOD_THRESHOLD * 0.75;
  } else if (nodDelta < -NOD_THRESHOLD) {
    moveCursorLine(-1);          // look up   → prev line
    lastCursorMove = now;
    baselineNoseRatio = noseRatio + NOD_THRESHOLD * 0.75;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cursor helpers
// ─────────────────────────────────────────────────────────────────────────────

function moveCursorChar(delta) {
  const pos    = notebook.selectionStart;
  const newPos = Math.max(0, Math.min(notebook.value.length, pos + delta));
  notebook.setSelectionRange(newPos, newPos);
}

function moveCursorLine(direction) {
  const pos  = notebook.selectionStart;
  const text = notebook.value;

  // Split at cursor to find current line & column
  const beforeCursor = text.substring(0, pos);
  const linesAbove   = beforeCursor.split('\n');
  const currentLine  = linesAbove.length - 1;
  const currentCol   = linesAbove[currentLine].length;

  const allLines   = text.split('\n');
  const targetLine = Math.max(0, Math.min(allLines.length - 1, currentLine + direction));

  // Rebuild character position for target line
  let newPos = 0;
  for (let i = 0; i < targetLine; i++) {
    newPos += allLines[i].length + 1;   // +1 for the '\n'
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
