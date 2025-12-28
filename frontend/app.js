// Configuration - auto-detect local vs production
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const SIGNALING_URL = isLocal
  ? 'ws://localhost:8787/ws'
  : 'wss://voice-roulette-signaling.brazdil94.workers.dev/ws';
const CREDENTIALS_URL = isLocal
  ? 'http://localhost:8787/turn-credentials'
  : 'https://voice-roulette-signaling.brazdil94.workers.dev/turn-credentials';

// ICE configuration - fetched from server
let iceServers = [];

// Force TURN relay for testing (set to false for normal ICE behavior)
const FORCE_RELAY = false;

// Debug logging - sends to server and console
const DEBUG = true;
function sendLogToServer(level, message) {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    try {
      websocket.send(JSON.stringify({ type: 'client_log', level, message }));
    } catch {
      // Ignore send failures for logs
    }
  }
}
const log = (...args) => {
  if (!DEBUG) return;
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  console.log(`[${new Date().toISOString()}]`, ...args);
  sendLogToServer('info', message);
};
const logError = (...args) => {
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  console.error(`[${new Date().toISOString()}]`, ...args);
  sendLogToServer('error', message);
};

// DOM elements
const startBtn = document.getElementById('start-btn');
const waitingUI = document.getElementById('waiting-ui');
const mainUI = document.getElementById('main-ui');
const visualizer = document.getElementById('visualizer');
const status = document.getElementById('status');

// State
let localStream = null;
let peerConnection = null;
let websocket = null;
let audioContext = null;
let analyser = null;
let animationId = null;
let remoteAudioElement = null;

// ============================================
// INITIALIZATION
// ============================================

startBtn.addEventListener('click', async () => {
  log('User clicked start button');
  
  // Explode the button text and hide button immediately
  explodeText(startBtn);
  startBtn.classList.add('hidden');
  
  try {
    // Fetch TURN credentials first
    log('Fetching TURN credentials...');
    const credResponse = await fetch(CREDENTIALS_URL);
    if (!credResponse.ok) {
      throw new Error('Failed to fetch TURN credentials');
    }
    const credData = await credResponse.json();
    iceServers = credData.iceServers;
    log('Got ICE servers:', iceServers.map(s => s.urls));
    
    log('Requesting microphone access...');
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    log('Microphone access granted, tracks:', localStream.getTracks().map(t => ({ kind: t.kind, enabled: t.enabled, readyState: t.readyState })));

    waitingUI.classList.remove('hidden');

    connectSignaling();
  } catch (err) {
    logError('Startup failed:', err);
    alert('Failed to start: ' + err.message);
  }
});

// Click sphere to go next (only when connected)
visualizer.addEventListener('click', () => {
  if (!visualizer.classList.contains('clickable')) return;
  
  log('User clicked sphere to skip');
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    // Remove clickable state
    visualizer.classList.remove('clickable', 'active');
    
    // Tremor animation - the sphere vibrates in annoyance at rejection
    visualizer.classList.remove('tremor', 'fade-cycle', 'breathing');
    void visualizer.offsetWidth; // Force reflow to restart animation
    visualizer.classList.add('tremor');
    // After tremor, fade out then add breathing (waiting UI switch handled by 'waiting' message)
    setTimeout(() => {
      visualizer.classList.remove('tremor');
      visualizer.classList.add('fade-cycle');
      setTimeout(() => {
        visualizer.classList.remove('fade-cycle');
        visualizer.classList.add('breathing');
      }, 1200);
    }, 600);
    
    cleanupPeerConnection();
    websocket.send(JSON.stringify({ type: 'next' }));
    log('Sent: next');
  } else {
    log('Cannot send next - websocket not open, readyState:', websocket?.readyState);
  }
});

// ============================================
// SIGNALING
// ============================================

function connectSignaling() {
  log('Connecting to signaling server:', SIGNALING_URL);
  setStatus('connecting...');

  websocket = new WebSocket(SIGNALING_URL);

  websocket.onopen = () => {
    log('WebSocket connected');
    websocket.send(JSON.stringify({ type: 'join' }));
    log('Sent: join');
  };

  websocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      log('Received:', data.type, data.type === 'stats' ? `(online: ${data.online})` : JSON.stringify(data).slice(0, 100));
      handleSignalingMessage(data);
    } catch (err) {
      logError('Failed to parse message:', err, event.data);
    }
  };

  websocket.onclose = (event) => {
    log('WebSocket closed, code:', event.code, 'reason:', event.reason, 'wasClean:', event.wasClean);
    setStatus('disconnected');
    
    // Attempt reconnect after delay
    setTimeout(() => {
      if (localStream) {
        log('Attempting reconnect...');
        connectSignaling();
      }
    }, 2000);
  };

  websocket.onerror = (err) => {
    logError('WebSocket error:', err);
  };
}

function handleSignalingMessage(data) {
  switch (data.type) {
    case 'waiting':
      log('Now waiting for partner');
      mainUI.classList.add('hidden');
      mainUI.classList.remove('fade-in');
      waitingUI.classList.remove('hidden');
      visualizer.classList.remove('clickable', 'breathing', 'active');
      break;

    case 'matched':
      log('Matched with partner, initiator:', data.initiator);
      // Fade out waiting, fade in sphere
      waitingUI.classList.add('fade-out');
      setTimeout(() => {
        waitingUI.classList.add('hidden');
        waitingUI.classList.remove('fade-out');
        mainUI.classList.remove('hidden');
        mainUI.classList.add('fade-in');
        visualizer.classList.add('breathing');
        setStatus('');
      }, 500);
      createPeerConnection();
      if (data.initiator) {
        createOffer();
      }
      break;

    case 'offer':
      log('Received offer');
      handleOffer(data.sdp);
      break;

    case 'answer':
      log('Received answer');
      handleAnswer(data.sdp);
      break;

    case 'ice':
      log('Received ICE candidate:', data.candidate?.candidate?.slice(0, 50));
      handleIceCandidate(data.candidate);
      break;

    case 'partner_left':
      log('Partner left');
      cleanupPeerConnection();
      mainUI.classList.add('hidden');
      waitingUI.classList.remove('hidden');
      visualizer.classList.remove('active', 'clickable', 'breathing');
      // Auto-rejoin after a moment
      setTimeout(() => {
        if (websocket && websocket.readyState === WebSocket.OPEN) {
          websocket.send(JSON.stringify({ type: 'join' }));
          log('Sent: join (auto-rejoin after partner left)');
        }
      }, 1000);
      break;

    case 'stats':
      // Ignore stats, we removed the online count display
      break;

    case 'error':
      logError('Server error:', data.message);
      if (data.message === 'rate_limited') {
        setStatus('slow down...');
      }
      break;
  }
}

// ============================================
// WEBRTC
// ============================================

function createPeerConnection() {
  const config = { 
    iceServers,
    iceTransportPolicy: FORCE_RELAY ? 'relay' : 'all'  // 'relay' forces TURN, 'all' tries direct first
  };
  log('Creating RTCPeerConnection with config:', { iceServers: iceServers.map(s => s.urls), iceTransportPolicy: config.iceTransportPolicy });
  peerConnection = new RTCPeerConnection(config);

  // Add local audio track
  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
    log('Added local track:', track.kind, track.id);
  });

  // Handle incoming audio
  peerConnection.ontrack = (event) => {
    log('Received remote track:', event.track.kind, event.track.id, 'streams:', event.streams.length);
    const remoteStream = event.streams[0];
    setupRemoteAudio(remoteStream);
    // Don't set connected status here - wait for ICE connection to actually establish
    // Status will be set in onconnectionstatechange when state is 'connected'
  };

  // Handle ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      log('Local ICE candidate:', event.candidate.candidate.slice(0, 50));
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({
          type: 'ice',
          candidate: event.candidate.toJSON(),
        }));
        log('Sent: ice');
      } else {
        log('Cannot send ICE - websocket not open');
      }
    } else {
      log('ICE gathering complete');
    }
  };

  // ICE gathering state
  peerConnection.onicegatheringstatechange = () => {
    log('ICE gathering state:', peerConnection.iceGatheringState);
  };

  // ICE connection state
  peerConnection.oniceconnectionstatechange = () => {
    log('ICE connection state:', peerConnection.iceConnectionState);
  };

  // Signaling state
  peerConnection.onsignalingstatechange = () => {
    log('Signaling state:', peerConnection.signalingState);
  };

  // Connection state monitoring
  peerConnection.onconnectionstatechange = () => {
    log('Connection state:', peerConnection.connectionState);
    
    switch (peerConnection.connectionState) {
      case 'connected':
        setStatus('');
        visualizer.classList.remove('breathing');
        visualizer.classList.add('clickable');
        // Hello wiggle using liquid distortion
        helloWiggle();
        break;
      case 'disconnected':
        setStatus('reconnecting...');
        visualizer.classList.remove('clickable');
        break;
      case 'failed':
        setStatus('connection failed');
        visualizer.classList.add('breathing');
        visualizer.classList.remove('clickable');
        break;
    }
  };
}

async function createOffer() {
  try {
    log('Creating offer...');
    const offer = await peerConnection.createOffer();
    log('Offer created, setting local description');
    await peerConnection.setLocalDescription(offer);
    log('Local description set, sending offer');
    
    websocket.send(JSON.stringify({
      type: 'offer',
      sdp: peerConnection.localDescription.toJSON(),
    }));
    log('Sent: offer');
  } catch (err) {
    logError('Failed to create offer:', err);
  }
}

async function handleOffer(sdp) {
  try {
    log('Handling offer...');
    if (!peerConnection) {
      log('No peer connection, creating one');
      createPeerConnection();
    }
    
    log('Setting remote description (offer)');
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    log('Remote description set, creating answer');
    const answer = await peerConnection.createAnswer();
    log('Answer created, setting local description');
    await peerConnection.setLocalDescription(answer);
    log('Local description set, sending answer');
    
    websocket.send(JSON.stringify({
      type: 'answer',
      sdp: peerConnection.localDescription.toJSON(),
    }));
    log('Sent: answer');
  } catch (err) {
    logError('Failed to handle offer:', err);
  }
}

async function handleAnswer(sdp) {
  try {
    log('Handling answer...');
    if (peerConnection) {
      log('Setting remote description (answer)');
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      log('Remote description set');
    } else {
      log('No peer connection to set answer on');
    }
  } catch (err) {
    logError('Failed to handle answer:', err);
  }
}

async function handleIceCandidate(candidate) {
  try {
    if (peerConnection && candidate) {
      log('Adding remote ICE candidate');
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      log('ICE candidate added');
    } else {
      log('Cannot add ICE candidate - no peer connection or null candidate');
    }
  } catch (err) {
    logError('Failed to add ICE candidate:', err);
  }
}

function cleanupPeerConnection() {
  log('Cleaning up peer connection');
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
  
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
  }
  
  if (remoteAudioElement) {
    remoteAudioElement.srcObject = null;
    remoteAudioElement = null;
  }
  
  if (peerConnection) {
    log('Closing peer connection, state was:', peerConnection.connectionState);
    peerConnection.close();
    peerConnection = null;
  }
  
  visualizer.style.transform = 'scale(1)';
  visualizer.classList.remove('active');
  log('Peer connection cleanup complete');
}

// ============================================
// AUDIO VISUALIZATION
// ============================================

function setupRemoteAudio(stream) {
  log('Setting up remote audio, stream tracks:', stream.getTracks().map(t => ({ kind: t.kind, enabled: t.enabled, muted: t.muted, readyState: t.readyState })));
  
  // Create audio element for playback
  remoteAudioElement = new Audio();
  remoteAudioElement.srcObject = stream;
  
  // Log audio element state
  remoteAudioElement.onplay = () => log('Audio element: playing');
  remoteAudioElement.onpause = () => log('Audio element: paused');
  remoteAudioElement.onerror = (e) => logError('Audio element error:', e);
  remoteAudioElement.onended = () => log('Audio element: ended');
  
  remoteAudioElement.play()
    .then(() => {
      log('Audio playback started successfully');
    })
    .catch((err) => {
      logError('Audio playback failed:', err.name, err.message);
    });

  // Create audio context for visualization
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  log('AudioContext state:', audioContext.state);
  
  // Resume audio context if suspended (mobile browsers)
  if (audioContext.state === 'suspended') {
    log('AudioContext suspended, attempting resume...');
    audioContext.resume().then(() => {
      log('AudioContext resumed, state:', audioContext.state);
    }).catch((err) => {
      logError('AudioContext resume failed:', err);
    });
  }
  
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.85;

  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  visualize();
}

function visualize() {
  if (!analyser) return;

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  const displacement = document.getElementById('displacement');
  const turbulence = document.getElementById('turbulence');
  let turbulencePhase = 0;

  function draw() {
    if (!analyser) return;

    animationId = requestAnimationFrame(draw);

    analyser.getByteFrequencyData(dataArray);

    // Calculate average volume (focus on voice frequencies 85-255 Hz range, bins ~3-10)
    let lowSum = 0;
    const voiceStart = 3;
    const voiceEnd = 20;
    for (let i = voiceStart; i < voiceEnd; i++) {
      lowSum += dataArray[i];
    }
    const lowAverage = lowSum / (voiceEnd - voiceStart);

    // Calculate high frequency energy (for ripples - whispers, sibilants)
    let highSum = 0;
    const highStart = 40;
    const highEnd = 80;
    for (let i = highStart; i < highEnd; i++) {
      highSum += dataArray[i];
    }
    const highAverage = highSum / (highEnd - highStart);

    // Volume creates expansion
    const normalizedVolume = Math.min(lowAverage / 180, 1);
    const scale = 1 + normalizedVolume * 0.5;

    // High frequencies create faster turbulence (ripples)
    const highFreqIntensity = Math.min(highAverage / 100, 1);
    const baseFreq = 0.01 + highFreqIntensity * 0.03;
    
    // Animate turbulence phase for liquid movement
    turbulencePhase += 0.005 + normalizedVolume * 0.02;
    
    // Displacement amount based on volume
    const displacementScale = normalizedVolume * 25 + highFreqIntensity * 15;

    // Update SVG filter
    if (turbulence && displacement) {
      turbulence.setAttribute('baseFrequency', `${baseFreq} ${baseFreq * 1.2}`);
      turbulence.setAttribute('seed', Math.floor(turbulencePhase * 10) % 100);
      displacement.setAttribute('scale', displacementScale);
    }

    visualizer.style.transform = `scale(${scale})`;

    // Glow when speaking
    if (lowAverage > 25) {
      visualizer.classList.add('active');
    } else {
      visualizer.classList.remove('active');
    }
  }

  draw();
}

// ============================================
// UI HELPERS
// ============================================

function setStatus(text, isConnected = false) {
  status.textContent = text;
  status.classList.toggle('connected', isConnected);
}

// Explode text into letters - shake then crumble down
function explodeText(element) {
  const text = element.textContent;
  
  // Create container for exploding letters
  const container = document.createElement('div');
  container.id = 'exploding-text';
  
  // Split text into individual characters
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const span = document.createElement('span');
    span.textContent = char === ' ' ? '\u00A0' : char; // Use non-breaking space for spaces
    
    // Shake phase - small random trembles
    const shakeX = (Math.random() - 0.5) * 6;
    const shakeY = (Math.random() - 0.5) * 4;
    const shakeRot = (Math.random() - 0.5) * 8;
    const vibrate = (Math.random() - 0.5) * 3; // Small rotational vibration
    
    // Crumble phase - fall downward with small horizontal drift
    const driftX = (Math.random() - 0.5) * 30; // Reduced horizontal drift
    const fallY = 200 + Math.random() * 150; // Fall down
    const rot = (Math.random() - 0.5) * 180; // Tumble as they fall
    
    // Opacity fluctuation during shake phase
    const shakeOp1 = 0.6 + Math.random() * 0.4;  // 0.6-1.0
    const shakeOp2 = 0.7 + Math.random() * 0.3;  // 0.7-1.0
    const shakeOp3 = 0.5 + Math.random() * 0.5;  // 0.5-1.0
    const shakeOp4 = 0.65 + Math.random() * 0.35; // 0.65-1.0
    const shakeOp5 = 0.5 + Math.random() * 0.5;  // 0.5-1.0
    const shakeOp6 = 0.7 + Math.random() * 0.3;  // 0.7-1.0
    const shakeOp7 = 0.55 + Math.random() * 0.45; // 0.55-1.0
    const shakeOp8 = 0.6 + Math.random() * 0.4;  // 0.6-1.0
    
    // Flicker values during crumble - stronger opacity fluctuation
    const flicker1 = 0.7 + Math.random() * 0.25; // 0.7-0.95
    const flicker2 = 0.5 + Math.random() * 0.3;  // 0.5-0.8
    const flicker3 = 0.3 + Math.random() * 0.25; // 0.3-0.55
    const flicker4 = 0.1 + Math.random() * 0.2;  // 0.1-0.3
    
    // Stagger delay - first letters fall while last ones still shaking
    const delay = i * 0.08; // 80ms between each letter
    
    span.style.setProperty('--shake-x', `${shakeX}px`);
    span.style.setProperty('--shake-y', `${shakeY}px`);
    span.style.setProperty('--shake-rot', `${shakeRot}deg`);
    span.style.setProperty('--vibrate', `${vibrate}deg`);
    span.style.setProperty('--drift-x', `${driftX}px`);
    span.style.setProperty('--fall-y', `${fallY}px`);
    span.style.setProperty('--rot', `${rot}deg`);
    span.style.setProperty('--shake-op-1', shakeOp1);
    span.style.setProperty('--shake-op-2', shakeOp2);
    span.style.setProperty('--shake-op-3', shakeOp3);
    span.style.setProperty('--shake-op-4', shakeOp4);
    span.style.setProperty('--shake-op-5', shakeOp5);
    span.style.setProperty('--shake-op-6', shakeOp6);
    span.style.setProperty('--shake-op-7', shakeOp7);
    span.style.setProperty('--shake-op-8', shakeOp8);
    span.style.setProperty('--flicker-1', flicker1);
    span.style.setProperty('--flicker-2', flicker2);
    span.style.setProperty('--flicker-3', flicker3);
    span.style.setProperty('--flicker-4', flicker4);
    span.style.setProperty('--delay', `${delay}s`);
    
    container.appendChild(span);
  }
  
  document.body.appendChild(container);
  
  // Remove the container after animation completes (base + max delay)
  const totalTime = 2500 + text.length * 80;
  setTimeout(() => {
    container.remove();
  }, totalTime);
}

// Hello wiggle - simulates a brief voice-like distortion
function helloWiggle() {
  const displacement = document.getElementById('displacement');
  const turbulence = document.getElementById('turbulence');
  if (!displacement || !turbulence) return;
  
  let phase = 0;
  const duration = 800;
  const startTime = Date.now();
  
  function animate() {
    const elapsed = Date.now() - startTime;
    const progress = elapsed / duration;
    
    if (progress >= 1) {
      displacement.setAttribute('scale', 0);
      return;
    }
    
    // Bell curve intensity - ramps up then down
    const intensity = Math.sin(progress * Math.PI);
    phase += 0.1;
    
    const scale = intensity * 20;
    const freq = 0.015 + intensity * 0.02;
    
    turbulence.setAttribute('baseFrequency', `${freq} ${freq * 1.2}`);
    turbulence.setAttribute('seed', Math.floor(phase * 10) % 100);
    displacement.setAttribute('scale', scale);
    
    // Also scale the sphere slightly
    visualizer.style.transform = `scale(${1 + intensity * 0.15})`;
    
    requestAnimationFrame(animate);
  }
  
  animate();
}

// ============================================
// CLEANUP
// ============================================

window.addEventListener('beforeunload', () => {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({ type: 'leave' }));
    websocket.close();
  }
  cleanupPeerConnection();
  
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
});

// Handle visibility change (mobile tab switching)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && remoteAudioElement) {
    // Keep audio playing in background on mobile
    remoteAudioElement.play().catch(() => {});
  }
});
