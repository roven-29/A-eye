// DOM Elements
const video = document.getElementById('video-feed');
const startOverlay = document.getElementById('start-overlay');
const statusOverlay = document.getElementById('status-overlay');
const startBtn = document.getElementById('start-btn');
const transcriptEl = document.getElementById('transcript');
const statusBadge = document.getElementById('status-badge');
const liveModeBtn = document.getElementById('live-mode-btn');

// ── Ollama Config ──────────────────────────────────────────────────────────────
const OLLAMA_URL = 'http://localhost:11434';
const OLLAMA_MODEL = 'minicpm-v';

// ── App State ──────────────────────────────────────────────────────────────────
let appState = 'idle'; // idle, listening, recording, processing, speaking, error, live
let isLiveMode = false;
let liveLoopRunning = false; // prevents multiple concurrent loops

// ── Speech Recognition ─────────────────────────────────────────────────────────
let recognition = null;
let currentTranscript = '';

// ── Audio Context for Sound Cues ───────────────────────────────────────────────
let sharedAudioCtx = null;
let loadingInterval = null;

function getAudioCtx() {
  if (!sharedAudioCtx) {
    sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return sharedAudioCtx;
}

async function resumeAudioCtx() {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

async function startLoadingSound() {
  const ctx = await resumeAudioCtx();
  if (loadingInterval) clearInterval(loadingInterval);

  // Randomized "thinking" note sequences
  const noteSequences = [
    [440, 494, 523, 494],
    [523, 440, 494, 523],
    [392, 440, 494, 440],
    [494, 523, 587, 523],
  ];
  const sequence = noteSequences[Math.floor(Math.random() * noteSequences.length)];
  let noteIndex = 0;

  const playNote = async () => {
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = sequence[noteIndex % sequence.length];
      noteIndex++;
      gainNode.gain.setValueAtTime(0.4, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch(e) { console.error('Audio error:', e); }
  };

  await playNote();
  loadingInterval = setInterval(playNote, 400);
}

function stopLoadingSound() {
  if (loadingInterval) {
    clearInterval(loadingInterval);
    loadingInterval = null;
  }
}

function playBeep(freq = 800, duration = 0.1) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.05);
  } catch(e) {}
}

// ── UI State ───────────────────────────────────────────────────────────────────
function setAppState(newState, message = '') {
  appState = newState;
  statusBadge.className = 'status-badge';
  statusBadge.classList.add(`status-${appState}`);
  statusBadge.textContent = appState.toUpperCase();

  if (message) {
    transcriptEl.textContent = message;
  } else if (appState === 'listening') {
    transcriptEl.textContent = 'Tap screen to speak';
  } else if (appState === 'recording') {
    transcriptEl.textContent = 'Listening... Tap to send';
  } else if (appState === 'processing') {
    transcriptEl.textContent = 'Analyzing...';
  } else if (appState === 'speaking') {
    transcriptEl.textContent = 'Speaking...';
  }
}

// ── Camera Capture ─────────────────────────────────────────────────────────────
function captureImage() {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
}

// ── Ollama API Call ────────────────────────────────────────────────────────────
async function callOllama(base64Image, transcript) {
  const prompt = `You are a helpful AI assistant for visually impaired people.
The user said: "${transcript}"
Look at the image carefully and respond to their request clearly and concisely.
You MUST always respond in ENGLISH ONLY. Do not use any other language under any circumstances.
Respond in plain text only — no markdown, no bullet points, no special characters.`;

  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: prompt,
      images: [base64Image],
      stream: false
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama error ${response.status}: ${response.statusText}. Is Ollama running?`);
  }

  const data = await response.json();

  if (!data.response) {
    throw new Error('Empty response from Ollama.');
  }

  return { lang: 'en-US', text: data.response.trim() };
}

// ── Speech Recognition Setup ───────────────────────────────────────────────────
function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    alert('Speech Recognition is not supported in this browser. Please use Google Chrome or Microsoft Edge.');
    return null;
  }

  const rec = new SpeechRecognition();
  rec.continuous = true;      // keep listening until manually stopped
  rec.interimResults = true;  // show live transcript
  rec.lang = 'en-IN';         // Works for English, Hindi, and Marathi in Chrome

  rec.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        final += t;
      } else {
        interim += t;
      }
    }
    if (final) currentTranscript += final;
    // Show live transcript on screen
    transcriptEl.textContent = (currentTranscript + interim) || 'Listening...';
  };

  rec.onerror = (e) => {
    console.error('SpeechRecognition error:', e.error);
    if (e.error === 'not-allowed') {
      alert('Microphone permission denied. Please allow microphone access.');
    }
  };

  rec.onend = () => {
    // If still in recording state (e.g. silence timeout), restart to keep listening
    if (appState === 'recording') {
      try { rec.start(); } catch(e) {}
    }
  };

  return rec;
}

// ── TTS (Text to Speech) ───────────────────────────────────────────────────────
window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
window.speechSynthesis.getVoices();
window.utterances = [];

function speak(text, langCode = 'en-US', onEnd) {
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = langCode;

  const voices = window.speechSynthesis.getVoices();
  let voice = voices.find(v => v.lang === langCode || v.lang.replace('_', '-') === langCode);
  if (!voice) {
    const prefix = langCode.split('-')[0];
    voice = voices.find(v => v.lang.startsWith(prefix));
  }
  if (!voice && langCode.includes('hi')) {
    voice = voices.find(v => v.name.toLowerCase().includes('hindi'));
  }
  if (voice) utterance.voice = voice;

  utterance.rate = 0.9;
  window.utterances.push(utterance);

  utterance.onend = () => {
    if (onEnd) onEnd();
    window.utterances = window.utterances.filter(u => u !== utterance);
  };
  utterance.onerror = (e) => {
    console.error('Speech synthesis error:', e);
    if (onEnd) onEnd();
  };

  window.speechSynthesis.speak(utterance);
}

// ── Process the recorded transcript + image ────────────────────────────────────
async function processCommand() {
  const transcript = currentTranscript.trim();
  currentTranscript = '';

  if (!transcript) {
    speak("I didn't catch that. Please try again.", 'en-US', () => setAppState('listening'));
    return;
  }

  const base64Image = captureImage();

  // Acknowledge the request
  const ackPhrases = ['Got it!', 'On it!', 'Processing your request.', 'Looking into that.'];
  speak(ackPhrases[Math.floor(Math.random() * ackPhrases.length)], 'en-US');

  setAppState('processing', `You said: "${transcript}"`);
  await startLoadingSound();

  try {
    const responseObj = await callOllama(base64Image, transcript);
    stopLoadingSound();
    setAppState('speaking');
    speak(responseObj.text, responseObj.lang, () => setAppState('listening'));
  } catch (error) {
    stopLoadingSound();
    console.error(error);
    setAppState('error', error.message);
    speak('Something went wrong. Make sure Ollama is running and try again.', 'en-US', () => setAppState('listening'));
  }
}

// ── Live Mode ──────────────────────────────────────────────────────────────────

// Fetches a single live description from Ollama
async function fetchLiveDescription() {
  const base64Image = captureImage();
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      // Ultra-short prompt for fastest possible response
      prompt: `Describe what's directly in front of the camera in ONE sentence (max 15 words). Be specific. English only. No filler phrases like "I see" or "In the image".`,
      images: [base64Image],
      stream: false
    })
  });
  if (!response.ok) throw new Error('Ollama unreachable');
  const data = await response.json();
  return data.response ? data.response.trim() : null;
}

async function runLiveLoop() {
  if (!isLiveMode || liveLoopRunning) return;
  liveLoopRunning = true;

  // ── Pipeline approach ──────────────────────────────────────────────────────
  // Step 1: Kick off first fetch immediately
  // Step 2: While speaking result N, fetch result N+1 in the background
  // Step 3: The moment speaking ends, speak result N+1 (already ready)
  // → Zero gap between descriptions

  let nextFetchPromise = fetchLiveDescription(); // start fetching immediately

  while (isLiveMode) {
    let description = null;

    try {
      setAppState('live', '🔴 Scanning...');
      description = await nextFetchPromise; // wait for the in-flight fetch
    } catch(err) {
      console.error('Live fetch error:', err);
      setAppState('live', 'Connection error — retrying...');
      await new Promise(r => setTimeout(r, 2000));
      if (!isLiveMode) break;
      nextFetchPromise = fetchLiveDescription();
      continue;
    }

    if (!isLiveMode) break;

    if (description) {
      stopLoadingSound();
      setAppState('live', description);

      // Immediately kick off the NEXT fetch in parallel — don't wait for speech
      nextFetchPromise = fetchLiveDescription();

      // Speak current description — by the time it finishes, next fetch is likely done
      await new Promise(resolve => speak(description, 'en-US', resolve));
    } else {
      // Empty response — refetch immediately
      nextFetchPromise = fetchLiveDescription();
    }

    if (!isLiveMode) break;
  }

  stopLoadingSound();
  liveLoopRunning = false;
}

function startLiveMode() {
  if (appState === 'recording') {
    recognition.stop();
  }
  window.speechSynthesis.cancel();
  stopLoadingSound();

  isLiveMode = true;
  liveModeBtn.classList.add('active');
  liveModeBtn.innerHTML = '<span class="live-icon">🔴</span> Stop Live';
  speak('Live mode on. Describing your surroundings.', 'en-US', () => {
    runLiveLoop();
  });
}

function stopLiveMode() {
  isLiveMode = false;
  liveModeBtn.classList.remove('active');
  liveModeBtn.innerHTML = '<span class="live-icon">👁</span> Live Mode';
  stopLoadingSound();
  window.speechSynthesis.cancel();
  setAppState('listening');
  speak('Live mode off.', 'en-US');
}

liveModeBtn.addEventListener('click', (e) => {
  e.stopPropagation(); // don't trigger the tap-to-talk handler
  if (isLiveMode) {
    stopLiveMode();
  } else {
    startLiveMode();
  }
});

// ── Start App ──────────────────────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  try {
    // Camera only — SpeechRecognition handles mic separately
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
    video.srcObject = stream;

    // Setup Speech Recognition
    recognition = setupSpeechRecognition();
    if (!recognition) return;

    startOverlay.classList.add('hidden');
    statusOverlay.classList.remove('hidden');

    // Warm up AudioContext immediately on user gesture
    await resumeAudioCtx();

    setAppState('speaking');
    speak(
      'System ready. Tap anywhere to start speaking, then tap again to send.',
      'en-US',
      () => setAppState('listening')
    );

  } catch (err) {
    console.error(err);
    alert('Please grant camera permission.');
  }
});

// ── Tap to Talk ────────────────────────────────────────────────────────────────
document.body.addEventListener('click', async (e) => {
  if (e.target.closest('#start-overlay')) return;
  if (e.target.closest('#live-mode-btn')) return; // handled by its own listener

  // Tapping anywhere while in live mode stops it
  if (isLiveMode) {
    stopLiveMode();
    return;
  }

  if (appState === 'listening') {
    // Start listening
    currentTranscript = '';
    try {
      recognition.start();
    } catch(e) { /* already started */ }
    setAppState('recording');

    // Warm up audio context + play start beep
    await resumeAudioCtx();
    playBeep(800, 0.12);

  } else if (appState === 'recording') {
    // Stop listening and process
    recognition.stop();

    // Play stop beep
    playBeep(400, 0.12);

    // processCommand handles everything from here
    await processCommand();
  }
});
