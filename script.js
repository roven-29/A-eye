// DOM Elements
const video = document.getElementById('video-feed');
const startOverlay = document.getElementById('start-overlay');
const statusOverlay = document.getElementById('status-overlay');
const transcriptEl = document.getElementById('transcript');
const statusBadge = document.getElementById('status-badge');

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
let recognitionActive = false;  // true only between onstart and onend
let queryDebounceTimer = null;  // auto-send after silence
const QUERY_DEBOUNCE_MS = 1500; // ms of silence before auto-sending

// ── Post-TTS deaf period ─────────────────────────────────────────────────────────────────
// After TTS stops, the speaker still outputs audio for a moment.
// Ignore all mic input for POST_TTS_DEAF_MS ms to prevent the AI hearing itself.
let ttsEndedAt = 0;
const POST_TTS_DEAF_MS = 2000;

// ── startFreshRecognition ─────────────────────────────────────────────────────────────────
// Always creates a FRESH instance — never reuses old ones.
// Chrome's SpeechRecognition gets corrupted after TTS; creating new avoids this.
function startFreshRecognition() {
  if (appState === 'idle' || appState === 'speaking') return;
  if (recognitionActive) return; // already listening

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  // Hard-abort and discard any old instance
  if (recognition) {
    try { recognition.abort(); } catch(e) {}
    recognition = null;
  }

  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-IN';

  rec.onstart = () => {
    recognitionActive = true;
    console.log('[A-eye] ✓ Listening');
  };

  rec.onresult = (event) => {
    // ── Deaf period guard: discard anything heard right after TTS ─────────────
    if (Date.now() - ttsEndedAt < POST_TTS_DEAF_MS) {
      currentTranscript = '';
      return;
    }
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += t;
      else interim += t;
    }

    // Show what's being heard in real time
    if (interim || currentTranscript) {
      transcriptEl.textContent = (currentTranscript + interim).trim() || 'Listening...';
    }

    if (final) {
      if (detectAndExecuteCommand(final)) {
        currentTranscript = '';
        if (queryDebounceTimer) { clearTimeout(queryDebounceTimer); queryDebounceTimer = null; }
        return;
      }

      currentTranscript += final;

      if (appState === 'processing' || appState === 'speaking' || appState === 'live') return;

      if (queryDebounceTimer) clearTimeout(queryDebounceTimer);
      queryDebounceTimer = setTimeout(() => {
        queryDebounceTimer = null;
        if (currentTranscript.trim()) {
          setAppState('recording');
          processCommand();
        }
      }, QUERY_DEBOUNCE_MS);
    }
  };

  rec.onerror = (e) => {
    recognitionActive = false;
    console.warn('[A-eye] Recognition error:', e.error);
    if (e.error === 'not-allowed') {
      alert('Microphone permission denied. Please allow microphone access.');
      return;
    }
    // Restart after any non-fatal error
    if (e.error !== 'aborted') {
      setTimeout(() => startFreshRecognition(), 600);
    }
  };

  rec.onend = () => {
    recognitionActive = false;
    console.log('[A-eye] Recognition ended');
    // Only auto-restart when NOT blocked by TTS — utterance.onend handles the TTS case
    if (appState !== 'idle' && appState !== 'speaking') {
      setTimeout(() => startFreshRecognition(), 400);
    }
  };

  recognition = rec;
  try {
    rec.start();
  } catch(e) {
    recognitionActive = false;
    console.warn('[A-eye] start() threw:', e.message);
    setTimeout(() => startFreshRecognition(), 600);
  }
}

// Watchdog: every 2 s, kick recognition if it's supposed to be on but isn't
setInterval(() => {
  if (appState !== 'idle' && appState !== 'speaking' && !recognitionActive) {
    startFreshRecognition();
  }
}, 2000);

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
    transcriptEl.textContent = 'Listening — just speak...';
  } else if (appState === 'recording') {
    transcriptEl.textContent = 'Heard you — sending...';
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

// setupSpeechRecognition is replaced by startFreshRecognition() above.
// This stub exists only to check browser support at app start.
function checkSpeechSupport() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert('Speech Recognition is not supported. Please use Google Chrome or Microsoft Edge.');
    return false;
  }
  return true;
}

// ── TTS (Text to Speech) ───────────────────────────────────────────────────────
window.utterances = [];

// ── Audible Welcome Prompt ─────────────────────────────────────────────────────
// Fires once on page load to guide visually impaired users before any tap.
function speakWelcomePrompt() {
  try {
    const utterance = new SpeechSynthesisUtterance('A-eye. Tap anywhere to start.');
    utterance.lang = 'en-US';
    utterance.rate = 0.85;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
  } catch(e) {
    // Browser blocked autoplay speech — visual prompt is still shown
    console.log('[A-eye] Autoplay speech blocked by browser.');
  }
}

// Chrome loads voices asynchronously — wait for them before speaking
let welcomeSpoken = false;
function triggerWelcome() {
  if (welcomeSpoken) return;
  welcomeSpoken = true;
  speakWelcomePrompt();
}

window.speechSynthesis.onvoiceschanged = () => {
  window.speechSynthesis.getVoices();
  triggerWelcome();
};

// Fallback: if voices already loaded (Firefox / Edge) fire immediately
if (window.speechSynthesis.getVoices().length > 0) {
  triggerWelcome();
}

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
    ttsEndedAt = Date.now(); // stamp when TTS audio stopped
    if (onEnd) onEnd();
    window.utterances = window.utterances.filter(u => u !== utterance);
    // TTS has finished — now safe to start fresh recognition
    setTimeout(() => {
      currentTranscript = ''; // discard anything picked up during TTS
      startFreshRecognition();
    }, 600);
  };
  utterance.onerror = (e) => {
    ttsEndedAt = Date.now(); // stamp even on cancel/interrupt
    if (e.error !== 'interrupted' && e.error !== 'canceled') {
      console.error('Speech synthesis error:', e.error);
    }
    if (onEnd) onEnd();
    setTimeout(() => startFreshRecognition(), 600);
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

// ── Voice Command Detection ────────────────────────────────────────────────────
const CMD_STOP = [
  'stop', 'quiet', 'silence', 'shut up', 'be quiet', 'cancel', 'nevermind', 'never mind',
];
const CMD_LIVE_ON  = [
  'live mode on', 'turn on live mode', 'start live mode',
  'enable live mode', 'activate live mode', 'go live',
];
const CMD_LIVE_OFF = [
  'live mode off', 'turn off live mode', 'stop live mode',
  'disable live mode', 'exit live mode', 'stop live',
];
const CMD_DESCRIBE = [
  'describe this', 'describe what you see', 'what do you see',
  "what's in front", "what's around", 'what am i looking at',
  'describe my surroundings', 'describe the scene',
  'look around', 'tell me what you see', "what's here",
  'scan the room', 'describe everything',
];
const CMD_CLOSE = [
  'turn off app', 'close app', 'exit app', 'close the app',
  'turn off the app', 'shutdown app', 'shut down app', 'goodbye', 'good bye',
];

function detectAndExecuteCommand(text) {
  const t = text.toLowerCase().trim();

  // ── Stop wins over everything — checked first ──────────────────────────────
  // Exact-word match to avoid false positives (e.g. "stop live mode" handled separately)
  const words = t.split(/\s+/);
  if (CMD_STOP.some(p => t === p || words.includes(p))) {
    window.speechSynthesis.cancel();
    stopLoadingSound();
    currentTranscript = '';
    if (isLiveMode) stopLiveMode();
    else setAppState('listening');
    setTimeout(() => ensureListening(), 400);
    return true;
  }

  if (CMD_LIVE_ON.some(p => t.includes(p))) {
    if (!isLiveMode) startLiveMode();
    return true;
  }
  if (CMD_LIVE_OFF.some(p => t.includes(p))) {
    if (isLiveMode) stopLiveMode();
    return true;
  }
  if (CMD_DESCRIBE.some(p => t.includes(p))) {
    oneShotDescribe();
    return true;
  }
  if (CMD_CLOSE.some(p => t.includes(p))) {
    closeApp();
    return true;
  }
  return false;
}

function closeApp() {
  window.speechSynthesis.cancel();
  stopLoadingSound();
  if (recognition) { try { recognition.abort(); } catch(e) {} }

  // Speak goodbye, then close
  const bye = new SpeechSynthesisUtterance('Goodbye.');
  bye.lang = 'en-US';
  bye.rate = 0.9;
  bye.onend = () => {
    // window.close() works in PWA standalone mode and script-opened windows
    window.close();
    // Fallback for regular browser tabs (window.close blocked)
    setTimeout(() => { window.location.href = 'about:blank'; }, 300);
  };
  window.speechSynthesis.speak(bye);
}

async function oneShotDescribe() {
  if (appState === 'processing' || appState === 'live') return;
  window.speechSynthesis.cancel();
  stopLoadingSound();
  currentTranscript = '';

  const base64Image = captureImage();
  setAppState('processing', 'Describing the scene...');
  await startLoadingSound();

  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: 'Describe what is directly in front of the camera in 2 to 3 sentences. Be specific and helpful for a visually impaired person. English only. No markdown. No filler phrases.',
        images: [base64Image],
        stream: false
      })
    });
    if (!response.ok) throw new Error('Ollama unreachable');
    const data = await response.json();
    const desc = data.response ? data.response.trim() : null;
    stopLoadingSound();
    if (desc) {
      setAppState('speaking');
      speak(desc, 'en-US', () => setAppState('listening'));
    } else {
      setAppState('listening');
    }
  } catch (err) {
    stopLoadingSound();
    console.error(err);
    speak('Could not describe the scene. Make sure Ollama is running.', 'en-US', () => setAppState('listening'));
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
  window.speechSynthesis.cancel();
  stopLoadingSound();
  currentTranscript = '';

  isLiveMode = true;
  speak('Live mode on. Tap anywhere to stop. Describing your surroundings.', 'en-US', () => {
    runLiveLoop();
  });
}

function stopLiveMode() {
  isLiveMode = false;
  stopLoadingSound();
  window.speechSynthesis.cancel();
  setAppState('listening');
  speak('Live mode off.', 'en-US');
}


// ── Start App (tap anywhere on start screen) ───────────────────────────────────
startOverlay.addEventListener('click', async () => {
  try {
    // Camera only — SpeechRecognition handles mic separately
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
    video.srcObject = stream;

    // Check browser support
    if (!checkSpeechSupport()) return;

    startOverlay.classList.add('hidden');
    statusOverlay.classList.remove('hidden');

    // Warm up AudioContext immediately on user gesture
    await resumeAudioCtx();

    setAppState('speaking');
    speak(
      'System ready. Just speak your question. Say describe this or live mode on.',
      'en-US',
      () => setAppState('listening')
    );
    // startFreshRecognition will be called by utterance.onend above

  } catch (err) {
    console.error(err);
    alert('Please grant camera permission.');
  }
});

// ── Triple-Tap Detection ────────────────────────────────────────────────────────
let tapCount = 0;
let tapTimer = null;
const TRIPLE_TAP_DELAY = 600; // ms window to register 3 taps

document.body.addEventListener('click', async (e) => {
  if (e.target.closest('#start-overlay')) return;
  if (e.target.closest('#live-mode-btn')) return; // handled by its own listener

  tapCount++;

  if (tapTimer) clearTimeout(tapTimer);

  tapTimer = setTimeout(async () => {
    const taps = tapCount;
    tapCount = 0;
    tapTimer = null;

    if (taps >= 3) {
      // ── Triple tap: toggle Live Mode ───────────────────────────────────────
      if (isLiveMode) {
        stopLiveMode();
      } else {
        startLiveMode();
      }
      return;
    }

    // ── Single tap in live mode: stop it ──────────────────────────────────────
    if (isLiveMode) {
      stopLiveMode();
      return;
    }

    // ── Single tap while AI is speaking: cut it off immediately ───────────────
    if (appState === 'speaking') {
      window.speechSynthesis.cancel();
      stopLoadingSound();
      currentTranscript = '';
      if (queryDebounceTimer) { clearTimeout(queryDebounceTimer); queryDebounceTimer = null; }

      // Hard-reset the recognition state — cancel() leaves Chrome in a dirty state
      if (recognition) { try { recognition.abort(); } catch(e) {} recognition = null; }
      recognitionActive = false;
      ttsEndedAt = Date.now(); // start deaf period so AI doesn't hear its own cutoff

      setAppState('listening');
      // 1000ms: enough for Chrome to fully release the mic after TTS cancel
      setTimeout(() => startFreshRecognition(), 1000);
      return;
    }

    // All other taps are ignored — voice auto-send handles everything
  }, TRIPLE_TAP_DELAY);
});

// ── Settings Modal ─────────────────────────────────────────────────────────────
const settingsBtn    = document.getElementById('settings-btn');
const settingsModal  = document.getElementById('settings-modal');
const ollamaUrlInput = document.getElementById('ollama-url-input');
const settingsSave   = document.getElementById('settings-save');
const settingsCancel = document.getElementById('settings-cancel');

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation(); // don't trigger the start overlay click
  ollamaUrlInput.value = localStorage.getItem('ollama_url') || '';
  settingsModal.classList.remove('hidden');
});

settingsSave.addEventListener('click', () => {
  const url = ollamaUrlInput.value.trim().replace(/\/$/, '');
  if (url) localStorage.setItem('ollama_url', url);
  else localStorage.removeItem('ollama_url');
  settingsModal.classList.add('hidden');
});

settingsCancel.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});
