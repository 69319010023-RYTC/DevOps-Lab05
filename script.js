"use strict";

const COLUMNS = 5;
const ROWS = 4;
const PIECE_COUNT = COLUMNS * ROWS;
const TRAY_SPACING = 1.62;
const TRAY_CELL_SIZE = 1.2;
const TRAY_COLUMNS = 5;
const BOARD_TO_TRAY_RATIO = ((TRAY_COLUMNS - 1) * TRAY_SPACING + TRAY_CELL_SIZE) / COLUMNS;
const TRAY_HEIGHT_RATIO = ((ROWS - 1) * TRAY_SPACING + TRAY_CELL_SIZE) / ROWS;
const PREVIEW_WIDTH_RATIO = 0.62;
const PREVIEW_GAP = 32;
const PANEL_GAP = 56;

const canvas = document.querySelector("#puzzle");
const context = canvas.getContext("2d");
const statusElement = document.querySelector("#game-status");
const progressElement = document.querySelector("#progress");
const resetButton = document.querySelector("#reset-button");
const musicButton = document.querySelector("#music-button");
const image = new Image();

let pieces = [];
let layout = null;
let pixelRatio = 1;
let drag = null;
let imageReady = false;
let musicEnabled = true;
let audioContext = null;
let musicBus = null;
let musicFilter = null;
let effectsBus = null;
let noiseBuffer = null;
let padVoices = [];
let musicTimer = null;
let musicStep = 0;
const MUSIC_STEP_SECONDS = 0.32;
const MUSIC_INTERVAL_MS = MUSIC_STEP_SECONDS * 1000;

const CHORDS = [
  [196, 246.94, 293.66],
  [174.61, 220, 261.63],
  [146.83, 196, 246.94],
  [164.81, 207.65, 246.94]
];
const MELODY = [523.25, 659.25, 587.33, 392, 440, 523.25, 392, 329.63];

function randomSign() {
  return Math.random() < 0.5 ? -1 : 1;
}

function shuffle(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [items[index], items[other]] = [items[other], items[index]];
  }
  return items;
}

function makePieces() {
  const result = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      const above = result[(row - 1) * COLUMNS + column];
      const left = result[row * COLUMNS + column - 1];
      result.push({
        column,
        row,
        top: above ? -above.bottom : 0,
        right: column < COLUMNS - 1 ? randomSign() : 0,
        bottom: row < ROWS - 1 ? randomSign() : 0,
        left: left ? -left.right : 0,
        slot: 0,
        placed: false,
        correct: false,
        x: 0,
        y: 0
      });
    }
  }
  return shuffle(result).map((piece, slot) => ({ ...piece, slot }));
}

function canvasPoint(event) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top
  };
}

function updateLayout() {
  if (!imageReady) return;

  const previousLayout = layout;
  const bounds = canvas.getBoundingClientRect();
  pixelRatio = window.devicePixelRatio || 1;
  canvas.width = Math.round(bounds.width * pixelRatio);
  canvas.height = Math.round(bounds.height * pixelRatio);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

  const aspectRatio = image.naturalWidth / image.naturalHeight;
  const width = bounds.width;
  const height = bounds.height;
  const maxBoardWidth = Math.min(
    640,
    (width - 48 - PREVIEW_GAP) / (1 + PREVIEW_WIDTH_RATIO),
    (width - 48) / BOARD_TO_TRAY_RATIO
  );
  const maxBoardHeight = Math.max(100, (height - PANEL_GAP - 96) / (1 + TRAY_HEIGHT_RATIO));
  const boardWidth = Math.max(100, Math.min(maxBoardWidth, maxBoardHeight * aspectRatio));
  const boardHeight = boardWidth / aspectRatio;
  const trayWidth = boardWidth * BOARD_TO_TRAY_RATIO;
  const trayHeight = boardHeight * TRAY_HEIGHT_RATIO;
  const previewWidth = boardWidth * PREVIEW_WIDTH_RATIO;
  const previewHeight = previewWidth / aspectRatio + 42;
  const boardX = (width - (boardWidth + PREVIEW_GAP + previewWidth)) / 2;
  const boardY = Math.max(42, (height - boardHeight - PANEL_GAP - trayHeight) / 2);
  const trayX = (width - trayWidth) / 2;
  const trayY = boardY + boardHeight + PANEL_GAP;

  layout = {
    boardX,
    boardY,
    boardWidth,
    boardHeight,
    pieceWidth: boardWidth / COLUMNS,
    pieceHeight: boardHeight / ROWS,
    previewX: boardX + boardWidth + PREVIEW_GAP,
    previewY: boardY + (boardHeight - previewHeight) / 2,
    previewWidth,
    previewHeight,
    trayX,
    trayY
  };

  for (const piece of pieces) {
    if (piece.correct) {
      piece.x = boardX + piece.column * layout.pieceWidth;
      piece.y = boardY + piece.row * layout.pieceHeight;
    } else if (piece.placed && previousLayout) {
      piece.x = boardX + (piece.x - previousLayout.boardX) * boardWidth / previousLayout.boardWidth;
      piece.y = boardY + (piece.y - previousLayout.boardY) * boardHeight / previousLayout.boardHeight;
    } else {
      setTrayPosition(piece);
    }
  }
  draw();
}

function setTrayPosition(piece) {
  if (!layout) return;
  const column = piece.slot % TRAY_COLUMNS;
  const row = Math.floor(piece.slot / TRAY_COLUMNS);
  piece.x = layout.trayX
    + (column * TRAY_SPACING + (TRAY_SPACING - TRAY_CELL_SIZE) / 2) * layout.pieceWidth;
  piece.y = layout.trayY
    + (row * TRAY_SPACING + (TRAY_SPACING - TRAY_CELL_SIZE) / 2) * layout.pieceHeight;
}

function traceEdge(path, x1, y1, x2, y2, sign, depth) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  const nx = uy;
  const ny = -ux;
  const point = (fraction, outward = 0) => ({
    x: x1 + ux * length * fraction + nx * outward * sign,
    y: y1 + uy * length * fraction + ny * outward * sign
  });
  const line = point(0.28);
  path.lineTo(line.x, line.y);
  const neckTop = point(0.4, depth * 0.5);
  const firstControl = point(0.34);
  const firstShoulder = point(0.34, depth * 0.5);
  path.bezierCurveTo(firstControl.x, firstControl.y, firstShoulder.x, firstShoulder.y, neckTop.x, neckTop.y);
  const lobeControl = point(0.46, depth * 0.5);
  const lobePeak = point(0.42, depth);
  const peak = point(0.5, depth);
  path.bezierCurveTo(lobeControl.x, lobeControl.y, lobePeak.x, lobePeak.y, peak.x, peak.y);
  const farPeak = point(0.58, depth);
  const farShoulder = point(0.54, depth * 0.5);
  const farNeck = point(0.6, depth * 0.5);
  path.bezierCurveTo(farPeak.x, farPeak.y, farShoulder.x, farShoulder.y, farNeck.x, farNeck.y);
  const lastShoulder = point(0.66, depth * 0.5);
  const lastControl = point(0.66);
  const end = point(0.72);
  path.bezierCurveTo(lastShoulder.x, lastShoulder.y, lastControl.x, lastControl.y, end.x, end.y);
  path.lineTo(x2, y2);
}

function piecePath(piece, x = piece.x, y = piece.y) {
  const { pieceWidth: width, pieceHeight: height } = layout;
  const depth = Math.min(width, height) * 0.3;
  const path = new Path2D();
  path.moveTo(x, y);
  traceEdge(path, x, y, x + width, y, piece.top, depth);
  traceEdge(path, x + width, y, x + width, y + height, piece.right, depth);
  traceEdge(path, x + width, y + height, x, y + height, piece.bottom, depth);
  traceEdge(path, x, y + height, x, y, piece.left, depth);
  path.closePath();
  return path;
}

function drawPanel(x, y, width, height, label) {
  context.save();
  context.fillStyle = "rgba(10, 15, 24, 0.48)";
  context.strokeStyle = "rgba(164, 184, 214, 0.16)";
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(x, y, width, height, 12);
  context.fill();
  context.stroke();
  context.fillStyle = "#9caec9";
  context.font = "600 11px 'Leelawadee UI', 'Noto Sans Thai', 'Segoe UI', sans-serif";
  context.textAlign = "left";
  context.textBaseline = "bottom";
  context.fillText(label, x, y - 10);
  context.restore();
}

function drawBoard() {
  const { boardX, boardY, boardWidth, boardHeight } = layout;
  drawPanel(boardX, boardY, boardWidth, boardHeight, "BOARD");

  context.save();
  context.globalAlpha = 0.12;
  context.drawImage(image, boardX, boardY, boardWidth, boardHeight);
  context.restore();

  for (const piece of pieces) {
    const targetX = boardX + piece.column * layout.pieceWidth;
    const targetY = boardY + piece.row * layout.pieceHeight;
    const path = piecePath(piece, targetX, targetY);
    context.save();
    context.fillStyle = "rgba(188, 208, 236, 0.025)";
    context.fill(path);
    context.strokeStyle = "rgba(204, 220, 244, 0.38)";
    context.lineWidth = 1;
    context.stroke(path);
    context.restore();
  }
}

function drawPreview() {
  const { previewX, previewY, previewWidth, previewHeight } = layout;
  drawPanel(previewX, previewY, previewWidth, previewHeight, "ภาพตัวอย่าง");

  const imageX = previewX + 10;
  const imageY = previewY + 10;
  const imageWidth = previewWidth - 20;
  const imageHeight = imageWidth / (image.naturalWidth / image.naturalHeight);
  context.save();
  context.beginPath();
  context.roundRect(imageX, imageY, imageWidth, imageHeight, 8);
  context.clip();
  context.drawImage(image, imageX, imageY, imageWidth, imageHeight);
  context.restore();

  context.save();
  context.fillStyle = "#a9b8cb";
  context.font = "500 11px 'Leelawadee UI', 'Noto Sans Thai', 'Segoe UI', sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("ภาพรถต้นฉบับ", previewX + previewWidth / 2, imageY + imageHeight + 15);
  context.restore();
}

function drawPiece(piece) {
  const path = piecePath(piece);
  const { boardX, boardY, boardWidth, boardHeight, pieceWidth, pieceHeight } = layout;
  context.save();
  if (piece === drag?.piece) {
    context.shadowColor = "rgba(0, 0, 0, 0.52)";
    context.shadowBlur = 20;
    context.shadowOffsetY = 8;
  } else {
    context.shadowColor = "rgba(0, 0, 0, 0.32)";
    context.shadowBlur = 8;
    context.shadowOffsetY = 3;
  }
  context.fillStyle = "#dce6f5";
  context.fill(path);
  context.clip(path);
  context.drawImage(
    image,
    piece.x - piece.column * pieceWidth,
    piece.y - piece.row * pieceHeight,
    boardWidth,
    boardHeight
  );
  context.restore();

  context.save();
  context.strokeStyle = piece === drag?.piece
    ? "#ffffff"
    : piece.correct
      ? "rgba(147, 231, 205, 0.96)"
      : "rgba(255, 255, 255, 0.82)";
  context.lineWidth = piece === drag?.piece || piece.correct ? 2 : 1.2;
  context.stroke(path);
  context.restore();
}

function draw() {
  if (!layout) return;
  const { width, height } = canvas.getBoundingClientRect();
  context.clearRect(0, 0, width, height);

  const trayWidth = layout.boardWidth * BOARD_TO_TRAY_RATIO;
  const trayHeight = layout.boardHeight * TRAY_HEIGHT_RATIO;
  drawPanel(layout.trayX, layout.trayY, trayWidth, trayHeight, "ถาดชิ้นส่วน  /  20");
  for (let slot = 0; slot < PIECE_COUNT; slot += 1) {
    const column = slot % TRAY_COLUMNS;
    const row = Math.floor(slot / TRAY_COLUMNS);
    const x = layout.trayX + column * TRAY_SPACING * layout.pieceWidth;
    const y = layout.trayY + row * TRAY_SPACING * layout.pieceHeight;
    context.save();
    context.fillStyle = "rgba(30, 42, 60, 0.72)";
    context.strokeStyle = "rgba(164, 184, 214, 0.11)";
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(
      x,
      y,
      TRAY_CELL_SIZE * layout.pieceWidth,
      TRAY_CELL_SIZE * layout.pieceHeight,
      9
    );
    context.fill();
    context.stroke();
    context.restore();
  }
  drawBoard();
  drawPreview();

  for (const piece of pieces) {
    if (piece !== drag?.piece) drawPiece(piece);
  }
  if (drag?.piece) drawPiece(drag.piece);
}

function updateProgress() {
  const correct = pieces.filter((piece) => piece.correct).length;
  const onBoard = pieces.filter((piece) => piece.placed).length;
  progressElement.innerHTML = `${correct} <span>/ ${PIECE_COUNT} ถูกตำแหน่ง</span>`;
  if (correct === PIECE_COUNT) {
    statusElement.textContent = "ยอดเยี่ยม! ต่อภาพสำเร็จแล้ว";
  } else if (imageReady) {
    statusElement.textContent = onBoard > 0
      ? `วางบนกระดานแล้ว ${onBoard} ชิ้น • จับย้ายได้ทุกชิ้น`
      : "วางชิ้นส่วนตรงไหนบนกระดานก็ได้";
  }
}

function startGame() {
  if (!imageReady) return;
  pieces = makePieces();
  drag = null;
  updateProgress();
  updateLayout();
}

function onPointerDown(event) {
  if (!layout || event.button !== 0) return;
  activateAudio();
  const point = canvasPoint(event);
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index];
    if (!context.isPointInPath(piecePath(piece), point.x * pixelRatio, point.y * pixelRatio)) continue;
    drag = {
      piece,
      offsetX: point.x - piece.x,
      offsetY: point.y - piece.y
    };
    pieces.splice(index, 1);
    pieces.push(piece);
    playPickupSound();
    canvas.setPointerCapture(event.pointerId);
    draw();
    return;
  }
}

function onPointerMove(event) {
  if (!drag) return;
  const point = canvasPoint(event);
  drag.piece.x = point.x - drag.offsetX;
  drag.piece.y = point.y - drag.offsetY;
  draw();
}

function onPointerUp() {
  if (!drag) return;
  const piece = drag.piece;
  const targetX = layout.boardX + piece.column * layout.pieceWidth;
  const targetY = layout.boardY + piece.row * layout.pieceHeight;
  const distance = Math.hypot(piece.x - targetX, piece.y - targetY);
  const snapDistance = Math.min(layout.pieceWidth, layout.pieceHeight) * 0.32;
  const centerX = piece.x + layout.pieceWidth / 2;
  const centerY = piece.y + layout.pieceHeight / 2;
  const onBoard = centerX >= layout.boardX
    && centerX <= layout.boardX + layout.boardWidth
    && centerY >= layout.boardY
    && centerY <= layout.boardY + layout.boardHeight;

  if (distance <= snapDistance) {
    piece.x = targetX;
    piece.y = targetY;
    piece.placed = true;
    piece.correct = true;
  } else if (onBoard) {
    piece.placed = true;
    piece.correct = false;
  } else {
    piece.placed = false;
    piece.correct = false;
    setTrayPosition(piece);
  }
  drag = null;
  playDropSound(piece.correct);
  updateProgress();
  draw();
}

function initializeAudio() {
  if (audioContext) return true;
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) {
    musicButton.disabled = true;
    statusElement.textContent = "เบราว์เซอร์นี้ไม่รองรับเสียง";
    return false;
  }

  audioContext = new AudioContextConstructor();
  const bufferLength = Math.ceil(audioContext.sampleRate * 1.5);
  noiseBuffer = audioContext.createBuffer(1, bufferLength, audioContext.sampleRate);
  const noiseData = noiseBuffer.getChannelData(0);
  for (let index = 0; index < bufferLength; index += 1) {
    noiseData[index] = Math.random() * 2 - 1;
  }

  musicBus = audioContext.createGain();
  musicBus.gain.value = 0.0001;
  musicFilter = audioContext.createBiquadFilter();
  musicFilter.type = "lowpass";
  musicFilter.frequency.value = 1800;
  musicFilter.connect(musicBus);
  musicBus.connect(audioContext.destination);
  effectsBus = audioContext.createGain();
  effectsBus.gain.value = 0.7;
  effectsBus.connect(audioContext.destination);
  return true;
}

function scheduleTone(
  frequency,
  endFrequency,
  startTime,
  duration,
  volume,
  destination,
  waveform = "sine"
) {
  const oscillator = audioContext.createOscillator();
  const envelope = audioContext.createGain();
  oscillator.type = waveform;
  oscillator.frequency.setValueAtTime(frequency, startTime);
  if (endFrequency !== frequency) {
    oscillator.frequency.exponentialRampToValueAtTime(endFrequency, startTime + duration);
  }
  envelope.gain.setValueAtTime(0.0001, startTime);
  envelope.gain.exponentialRampToValueAtTime(volume, startTime + Math.min(0.04, duration / 3));
  envelope.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  oscillator.connect(envelope);
  envelope.connect(destination);
  oscillator.start(startTime);
  oscillator.stop(startTime + duration + 0.02);
}

function scheduleNoise(startTime, duration, volume, filterType, startFrequency, endFrequency, destination) {
  const source = audioContext.createBufferSource();
  const filter = audioContext.createBiquadFilter();
  const envelope = audioContext.createGain();
  source.buffer = noiseBuffer;
  filter.type = filterType;
  filter.frequency.setValueAtTime(startFrequency, startTime);
  filter.frequency.exponentialRampToValueAtTime(endFrequency, startTime + duration);
  envelope.gain.setValueAtTime(0.0001, startTime);
  envelope.gain.linearRampToValueAtTime(volume, startTime + Math.min(0.018, duration / 3));
  envelope.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  source.connect(filter);
  filter.connect(envelope);
  envelope.connect(destination);
  source.start(startTime);
  source.stop(startTime + duration + 0.02);
}

function playKick(startTime, volume = 0.08) {
  const oscillator = audioContext.createOscillator();
  const envelope = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(115, startTime);
  oscillator.frequency.exponentialRampToValueAtTime(48, startTime + 0.16);
  envelope.gain.setValueAtTime(volume, startTime);
  envelope.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.2);
  oscillator.connect(envelope);
  envelope.connect(musicBus);
  oscillator.start(startTime);
  oscillator.stop(startTime + 0.22);
}

function updateMusicButton() {
  musicButton.textContent = musicEnabled ? "♫ เพลง: เปิด" : "♫ เพลง: ปิด";
  musicButton.setAttribute("aria-pressed", String(musicEnabled));
}

function startAmbientMusic() {
  if (!musicEnabled || musicTimer || !audioContext) return;

  if (padVoices.length === 0) {
    for (const frequency of CHORDS[0]) {
      const oscillator = audioContext.createOscillator();
      const volume = audioContext.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.value = frequency;
      volume.gain.value = 0.0001;
      oscillator.connect(volume);
      volume.connect(musicFilter);
      oscillator.start();
      padVoices.push({ oscillator, volume });
    }
  }

  musicBus.gain.setTargetAtTime(0.42, audioContext.currentTime, 0.8);
  musicTimer = window.setInterval(() => {
    if (!musicEnabled || audioContext.state !== "running") return;
    const now = audioContext.currentTime;
    const chord = CHORDS[Math.floor(musicStep / 16) % CHORDS.length];
    if (musicStep % 16 === 0) {
      padVoices.forEach((voice, index) => {
        voice.oscillator.frequency.setTargetAtTime(chord[index], now, 1.2);
        voice.volume.gain.setTargetAtTime(0.035, now, 1.2);
      });
    }
    if (musicStep % 8 === 0) {
      playKick(now, musicStep % 16 === 0 ? 0.095 : 0.065);
      scheduleTone(chord[0] / 2, chord[0] / 2, now, 0.28, 0.055, musicBus, "triangle");
    }
    if (musicStep % 4 === 2) {
      scheduleNoise(now, 0.08, 0.012, "highpass", 7000, 4200, musicBus);
    }
    if (musicStep % 2 === 0) {
      const noteIndex = (musicStep / 2 + Math.floor(musicStep / 16)) % MELODY.length;
      const frequency = MELODY[noteIndex];
      scheduleTone(frequency, frequency * 0.999, now, 0.24, 0.045, musicBus, "triangle");
    }
    musicStep += 1;
  }, MUSIC_INTERVAL_MS);
}

function activateAudio() {
  if (!initializeAudio()) return;
  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => {
      statusElement.textContent = "เปิดเสียงไม่ได้ กรุณาตรวจสอบการตั้งค่า Browser";
    });
  }
  startAmbientMusic();
}

function playPickupSound() {
  if (!audioContext) return;
  const now = audioContext.currentTime;
  scheduleNoise(now, 0.14, 0.22, "bandpass", 650, 2400, effectsBus);
  scheduleTone(250, 610, now, 0.16, 0.16, effectsBus, "triangle");
}

function playDropSound(correct) {
  if (!audioContext) return;
  const now = audioContext.currentTime;
  if (correct) {
    scheduleTone(660, 660, now, 0.2, 0.14, effectsBus);
    scheduleTone(880, 880, now + 0.08, 0.26, 0.12, effectsBus);
  } else {
    scheduleTone(440, 392, now, 0.2, 0.1, effectsBus);
  }
}

canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("pointercancel", onPointerUp);
resetButton.addEventListener("click", () => {
  startGame();
  activateAudio();
});
musicButton.addEventListener("click", () => {
  musicEnabled = !musicEnabled;
  updateMusicButton();
  if (musicEnabled) {
    activateAudio();
  } else if (audioContext) {
    if (musicTimer) {
      window.clearInterval(musicTimer);
      musicTimer = null;
    }
    musicBus.gain.setTargetAtTime(0, audioContext.currentTime, 0.35);
  }
});
window.addEventListener("resize", updateLayout);

image.addEventListener("load", () => {
  imageReady = true;
  startGame();
});
image.addEventListener("error", () => {
  statusElement.textContent = "โหลด car.webp ไม่สำเร็จ กรุณาตรวจสอบไฟล์ภาพ";
  resetButton.disabled = true;
});
updateMusicButton();
image.src = "car.webp";
