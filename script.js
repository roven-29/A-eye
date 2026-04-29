// DOM Elements
const video = document.getElementById('video-feed');
const startOverlay = document.getElementById('start-overlay');
const statusOverlay = document.getElementById('status-overlay');
const startBtn = document.getElementById('start-btn');
const transcriptEl = document.getElementById('transcript');
const statusBadge = document.getElementById('status-badge');

// State
let appState = 'idle'; // idle, listening, recording, processing, speaking, error
let isListening = false;
const GEMINI_API_KEY = 'AIzaSyB_TeZh3lWDVn_QST9nfmLqcfxFPFktcHw';

// MediaRecorder State
let mediaRecorder = null;
let audioChunks = [];

// Audio Context for Sound Cues
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
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  return ctx;
}

async function startLoadingSound() {
  const ctx = await resumeAudioCtx();
  if (loadingInterval) clearInterval(loadingInterval);
  
  // Randomized note sequences that sound like "thinking"
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
      
      // Clear audible tone - starts at 0.4 volume and fades smoothly
      gainNode.gain.setValueAtTime(0.4, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch(e) {
      console.error("Audio error: ", e);
    }
  };

  await playNote(); // play first note immediately
  loadingInterval = setInterval(playNote, 400);
}

function stopLoadingSound() {
  if (loadingInterval) {
    clearInterval(loadingInterval);
    loadingInterval = null;
  }
}

// Update UI State
function setAppState(newState, message = '') {
  appState = newState;
  
  // Remove old status classes
  statusBadge.className = 'status-badge';
  statusBadge.classList.add(`status-${appState}`);
  statusBadge.textContent = appState.toUpperCase();

  if (message) {
    transcriptEl.textContent = message;
  } else if (appState === 'listening') {
    transcriptEl.textContent = "Tap screen to record";
  } else if (appState === 'recording') {
    transcriptEl.textContent = "Recording... Tap to stop";
  } else if (appState === 'processing') {
    transcriptEl.textContent = "Analyzing...";
  } else if (appState === 'speaking') {
    transcriptEl.textContent = "Speaking...";
  }
}

// Camera Capture
function captureImage() {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
}

// Gemini API Call
async function callGemini(base64Image, base64Audio) {
  if (!GEMINI_API_KEY) throw new Error("API Key is missing");

  const parts = [
    { text: `You are an AI assistant for the visually impaired. Listen to the audio command and look at the image. 
1. Respond to the command clearly and concisely.
2. You MUST respond in English, Hindi, or Marathi ONLY. If the user speaks Hindi, respond in native Hindi (Devanagari script). If Marathi, respond in native Marathi. Otherwise default to English.
3. Your final output MUST be a valid JSON object in this exact format, with NO markdown formatting around it:
{"lang": "<en-US, hi-IN, or mr-IN>", "text": "<your translated response>"}` },
    {
      inlineData: {
        mimeType: "image/jpeg",
        data: base64Image
      }
    }
  ];

  if (base64Audio) {
    parts.push({
      inlineData: {
        mimeType: "audio/webm",
        data: base64Audio
      }
    });
  }

  const payload = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: parts }]
    })
  };

  // List of models to try in order (most capable to lightest)
  const models = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-pro-latest',
  ];

  let data = null;
  const MAX_GLOBAL_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_GLOBAL_RETRIES; attempt++) {
    for (const model of models) {
      console.log(`Attempt ${attempt + 1}, trying model: ${model}`);
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          payload
        );
        data = await response.json();
      } catch(fetchErr) {
        console.warn(`Fetch failed for ${model}:`, fetchErr);
        continue;
      }

      if (!data.error) break; // Success! exit inner loop

      const errCode = data.error.code;
      const errMsg = data.error.message || '';
      const isRateLimit = errCode === 429 || errCode === 503 || errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('demand');

      if (isRateLimit) {
        console.warn(`Model ${model} rate limited, trying next model...`);
        data = null; // mark as not successful, try next
        continue;
      }

      // Non-rate-limit error, still try next model
      console.warn(`Model ${model} error (${errCode}): ${errMsg}`);
      data = null;
    }

    if (data && !data.error) break; // Got a successful response, exit global retry loop

    // All models busy — wait before trying the whole chain again
    const waitSec = (attempt + 1) * 10; // 10s, 20s, 30s
    console.warn(`All models busy. Waiting ${waitSec}s before retry ${attempt + 2}...`);
    stopLoadingSound();
    setAppState('processing', `All servers busy. Retrying in ${waitSec}s... (${attempt + 1}/${MAX_GLOBAL_RETRIES})`);
    // Speak only on first retry, then stay silent to avoid being annoying
    if (attempt === 0) speak('All servers are busy. Please wait a moment.', 'en-US');
    await new Promise(resolve => setTimeout(resolve, waitSec * 1000));
    setAppState('processing', 'Analyzing...');
    await startLoadingSound();
  }

  if (!data || data.error) throw new Error(data?.error?.message || 'All models are currently busy. Please try again in a moment.');
  
  let rawText = data.candidates[0].content.parts[0].text;
  
  // Clean markdown if Gemini ignored instructions
  rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
  
  try {
    return JSON.parse(rawText);
  } catch(e) {
    console.error("Failed to parse JSON response:", rawText);
    // Fallback if it's not valid JSON
    return { lang: 'en-US', text: rawText };
  }
}

// Preload voices to fix empty array bug in Chrome
window.speechSynthesis.onvoiceschanged = () => {
    window.speechSynthesis.getVoices();
};
window.speechSynthesis.getVoices();

// Global array to prevent garbage collection of utterances (Chrome bug)
window.utterances = [];

// Text to Speech
function speak(text, langCode = 'en-US', onEnd) {
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = langCode;
  
  // Try to explicitly find a matching voice
  const voices = window.speechSynthesis.getVoices();
  let voice = voices.find(v => v.lang === langCode || v.lang.replace('_', '-') === langCode);
  
  if (!voice) {
      const prefix = langCode.split('-')[0];
      voice = voices.find(v => v.lang.startsWith(prefix));
  }
  
  // Fallback for names if language code doesn't match perfectly
  if (!voice && langCode.includes('hi')) {
     voice = voices.find(v => v.name.toLowerCase().includes('hindi'));
  }

  if (voice) {
      utterance.voice = voice;
  }
  
  utterance.rate = 0.9;
  
  window.utterances.push(utterance);
  
  utterance.onend = () => {
    if (onEnd) onEnd();
    window.utterances = window.utterances.filter(u => u !== utterance);
  };
  
  utterance.onerror = (e) => {
    console.error("Speech synthesis error:", e);
    if (onEnd) onEnd();
  }

  window.speechSynthesis.speak(utterance);
}

// Setup MediaRecorder
function setupMediaRecorder(stream) {
  mediaRecorder = new MediaRecorder(stream);
  
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      audioChunks.push(event.data);
    }
  };
  
  mediaRecorder.onstop = async () => {
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    audioChunks = []; // reset
    
    setAppState('processing', 'Processing recording...');
    
    try {
      // Convert Blob to Base64
      const reader = new FileReader();
      reader.readAsDataURL(audioBlob);
      reader.onloadend = async () => {
        const base64Audio = reader.result.split(',')[1];
        const base64Image = captureImage();
        
        try {
          // Voice prompt: let the user know their request was received
          const processingPhrases = [
            "Got it, analyzing...",
            "On it!",
            "Processing your request.",
            "Looking into that for you.",
          ];
          const phrase = processingPhrases[Math.floor(Math.random() * processingPhrases.length)];
          speak(phrase, 'en-US');
          await startLoadingSound(); // await so audio context is definitely running
          const responseObj = await callGemini(base64Image, base64Audio);
          stopLoadingSound();
          setAppState('speaking');
          speak(responseObj.text, responseObj.lang, () => setAppState('listening'));
        } catch (error) {
          stopLoadingSound();
          console.error(error);
          setAppState('error', 'Error: ' + error.message);
          speak("Something went wrong. Please try again.", "en-US", () => setAppState('listening'));
        }
      };
    } catch (err) {
      console.error(err);
      setAppState('error', 'Audio error');
    }
  };
}

// Start App
startBtn.addEventListener('click', async () => {
  try {
    // Request Camera AND Microphone
    const stream = await navigator.mediaDevices.getUserMedia({ 
      video: { facingMode: "environment" },
      audio: true 
    });
    video.srcObject = stream;
    
    // Hide overlay, show status
    startOverlay.classList.add('hidden');
    statusOverlay.classList.remove('hidden');
    
    // Initialize MediaRecorder
    setupMediaRecorder(stream);
    
    setAppState('speaking');
    speak("System ready. Tap anywhere on the screen to start recording your command. Tap again to process.", "en-US", () => {
      isListening = true;
      setAppState('listening');
    });

  } catch (err) {
    console.error(err);
    alert("Please grant camera and microphone permissions.");
  }
});

// Tap to Talk Interaction
document.body.addEventListener('click', async (e) => {
  // Ignore clicks on the start button
  if (e.target.closest('#start-overlay')) return;
  
  if (appState === 'listening' && mediaRecorder && mediaRecorder.state === 'inactive') {
    // Start Recording
    audioChunks = [];
    mediaRecorder.start();
    setAppState('recording');
    
    // Provide an audio cue (short high beep) - use resumeAudioCtx to unlock
    try {
        const ctx = await resumeAudioCtx();
        const osc = ctx.createOscillator();
        osc.frequency.value = 800;
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.1);
    } catch(err) {}

  } else if (appState === 'recording' && mediaRecorder && mediaRecorder.state === 'recording') {
    // Unlock AudioContext NOW while we still have the user gesture
    const ctx = await resumeAudioCtx();
    
    mediaRecorder.stop();
    
    // Provide an audio cue (short low beep)
    try {
        const osc = ctx.createOscillator();
        osc.frequency.value = 400;
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.1);
    } catch(err) {}
  }
});
