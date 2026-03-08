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

// Audio bitrate cap (kbps) - lower = less TURN bandwidth usage
const AUDIO_BITRATE = 24;

// Debug logging
const DEBUG = true;
const log = (...args) => {
  if (!DEBUG) return;
  console.log(`[${new Date().toISOString()}]`, ...args);
};
const logError = (...args) => {
  console.error(`[${new Date().toISOString()}]`, ...args);
};

// DOM elements
const presenceText = document.getElementById('presence-text');
const talkBtn = document.getElementById('talk-btn');
const waitingText = document.getElementById('waiting-text');
const visualizer = document.getElementById('visualizer');
const status = document.getElementById('status');
const hostInput = document.getElementById('host-input');

// State
let localStream = null;
let peerConnection = null;
let websocket = null;
let audioContext = null;
let analyser = null;
let animationId = null;
let remoteAudioElement = null;
let joined = false; // whether we've sent 'join'

// ============================================
// INITIALIZATION
// ============================================

// Handle click to talk - request mic then join immediately
async function handleTalkClick() {
  if (localStream || joined) return;

  log('User clicked to talk');

  try {
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

    // Fade out presence info
    presenceText.classList.add('fade-out');
    talkBtn.classList.add('fade-out');

    setTimeout(() => {
      presenceText.classList.add('hidden');
      talkBtn.classList.add('hidden');

      // Start subtle breathing + waiting text
      visualizer.classList.add('breathing-subtle');
      waitingText.classList.remove('hidden');
      waitingText.classList.add('pulsing');

      // Join matchmaking
      joined = true;
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ type: 'join' }));
        log('Sent: join');
      }
    }, 500);

    // Fetch TURN credentials in background
    fetchTurnCredentials();

  } catch (err) {
    logError('Microphone access failed:', err);
    alert('Microphone access is required to use voidchat');
  }
}

async function fetchTurnCredentials() {
  try {
    log('Fetching TURN credentials...');
    const credResponse = await fetch(CREDENTIALS_URL);
    if (!credResponse.ok) throw new Error('Failed to fetch TURN credentials');
    const credData = await credResponse.json();
    iceServers = credData.iceServers;
    log('Got ICE servers:', iceServers.map(s => s.urls));
  } catch (err) {
    logError('Failed to fetch TURN credentials:', err);
  }
}

// Talk button click
talkBtn.addEventListener('click', handleTalkClick);

// Sphere click - triggers talk (or skip if connected)
visualizer.addEventListener('click', () => {
  if (visualizer.classList.contains('clickable')) return;
  if (!joined) handleTalkClick();
});

// Click sphere to go next (only when connected)
visualizer.addEventListener('click', () => {
  if (!visualizer.classList.contains('clickable')) return;
  
  log('User clicked sphere to skip');
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    // Remove clickable state
    visualizer.classList.remove('clickable', 'active');
    
    // Tremor animation
    visualizer.classList.remove('tremor', 'crt-off');
    void visualizer.offsetWidth; // Force reflow
    visualizer.classList.add('tremor');
    
    // After tremor (600ms), play CRT off
    setTimeout(() => {
      visualizer.classList.remove('tremor');
      void visualizer.offsetWidth;
      visualizer.classList.add('crt-off');
      
      // After CRT (500ms), cleanup and send next
      setTimeout(() => {
        visualizer.classList.remove('crt-off');
        cleanupPeerConnection();
        
        // Show waiting text, subtle breathing
        visualizer.classList.add('breathing-subtle');
        waitingText.classList.remove('hidden');
        waitingText.classList.add('pulsing');
        
        websocket.send(JSON.stringify({ type: 'next' }));
        log('Sent: next');
      }, 500);
    }, 600);
  } else {
    log('Cannot send next - websocket not open, readyState:', websocket?.readyState);
  }
});

// Host auth input (uncomment input in index.html to enable)
if (hostInput) {
  hostInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const token = hostInput.value.trim();
      if (token && websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ type: 'auth', token }));
        log('Sent: auth');
      }
      hostInput.value = '';
      hostInput.blur();
    }
  });
}

// ============================================
// SIGNALING
// ============================================

function connectSignaling() {
  log('Connecting to signaling server:', SIGNALING_URL);

  websocket = new WebSocket(SIGNALING_URL);

  websocket.onopen = () => {
    log('WebSocket connected');
    // If already joined (reconnect), rejoin matchmaking
    if (joined) {
      websocket.send(JSON.stringify({ type: 'join' }));
      log('Sent: join (reconnect)');
    }
  };

  websocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      log('Received:', data.type, data.type === 'stats' ? `(online: ${data.online}, host: ${data.hostStatus})` : JSON.stringify(data).slice(0, 100));
      handleSignalingMessage(data);
    } catch (err) {
      logError('Failed to parse message:', err, event.data);
    }
  };

  websocket.onclose = (event) => {
    log('WebSocket closed, code:', event.code, 'reason:', event.reason, 'wasClean:', event.wasClean);
    // Always reconnect (for presence)
    setTimeout(() => {
      log('Attempting reconnect...');
      connectSignaling();
    }, 2000);
  };

  websocket.onerror = (err) => {
    logError('WebSocket error:', err);
  };
}

// Connect immediately for presence
connectSignaling();

function handleSignalingMessage(data) {
  switch (data.type) {
    case 'waiting':
      log('Now waiting for partner');
      // Show waiting text, subtle breathing
      waitingText.classList.remove('hidden');
      waitingText.classList.add('pulsing');
      visualizer.classList.remove('clickable', 'active', 'breathing');
      visualizer.classList.add('breathing-subtle');
      break;

    case 'matched':
      log('Matched with partner, initiator:', data.initiator);
      // Hide waiting text, full breathing
      waitingText.classList.add('hidden');
      waitingText.classList.remove('pulsing');
      visualizer.classList.remove('breathing-subtle');
      visualizer.classList.add('breathing');
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
      // Play tremor → CRT animation, then go to waiting
      visualizer.classList.remove('clickable', 'active');
      visualizer.classList.remove('tremor', 'crt-off');
      void visualizer.offsetWidth;
      visualizer.classList.add('tremor');
      
      setTimeout(() => {
        visualizer.classList.remove('tremor');
        void visualizer.offsetWidth;
        visualizer.classList.add('crt-off');
        
        setTimeout(() => {
          visualizer.classList.remove('crt-off');
          cleanupPeerConnection();
          
          // Show waiting text, subtle breathing
          visualizer.classList.add('breathing-subtle');
          waitingText.classList.remove('hidden');
          waitingText.classList.add('pulsing');
          
          // Auto-rejoin
          if (websocket && websocket.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({ type: 'join' }));
            log('Sent: join (auto-rejoin after partner left)');
          }
        }, 500);
      }, 600);
      break;

    case 'stats':
      if (!joined) {
        const hostName = data.hostName || 'Host';
        const hostStatus = data.hostStatus || 'away';
        const others = data.online || 0;

        // Line 1: host presence
        if (hostStatus === 'online') {
          presenceText.textContent = `${hostName} is online`;
        } else if (hostStatus === 'busy') {
          presenceText.textContent = `${hostName} is busy`;
        } else {
          presenceText.textContent = `${hostName} is away`;
        }

        // Line 2: subtitle / talk button
        if (hostStatus === 'online') {
          talkBtn.textContent = 'press to talk';
        } else if (hostStatus === 'busy') {
          if (others > 0) {
            talkBtn.textContent = `${others} other${others > 1 ? 's' : ''} online · press to talk`;
          } else {
            talkBtn.textContent = 'join the queue';
          }
        } else {
          // away
          if (others > 0) {
            talkBtn.textContent = `${others} other${others > 1 ? 's' : ''} online · press to talk`;
          } else {
            talkBtn.textContent = 'nobody online · step into the void';
          }
        }
      }
      break;

    case 'auth_ok':
      log('Authenticated as host');
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

// Modify SDP to cap audio bitrate
function capAudioBitrate(sdp) {
  // Add b=AS line after each m=audio line to cap bandwidth
  return sdp.replace(/m=audio.*\r\n/g, (match) => {
    return match + `b=AS:${AUDIO_BITRATE}\r\n`;
  });
}

async function createOffer() {
  try {
    log('Creating offer...');
    const offer = await peerConnection.createOffer();
    
    // Cap audio bitrate in SDP
    offer.sdp = capAudioBitrate(offer.sdp);
    log('Offer created (bitrate capped to', AUDIO_BITRATE, 'kbps), setting local description');
    
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
    
    // Cap audio bitrate in answer too
    answer.sdp = capAudioBitrate(answer.sdp);
    log('Answer created (bitrate capped to', AUDIO_BITRATE, 'kbps), setting local description');
    
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

    // Volume creates expansion - more dramatic
    const normalizedVolume = Math.min(lowAverage / 140, 1);
    const scale = 1 + normalizedVolume * 0.6;

    // High frequencies create faster turbulence (ripples)
    const highFreqIntensity = Math.min(highAverage / 80, 1);
    const baseFreq = 0.012 + highFreqIntensity * 0.05 + normalizedVolume * 0.02;
    
    // Animate turbulence phase for liquid movement - faster and more reactive
    turbulencePhase += 0.008 + normalizedVolume * 0.04 + highFreqIntensity * 0.02;
    
    // Displacement amount based on volume - significantly increased
    const displacementScale = normalizedVolume * 50 + highFreqIntensity * 25;

    // Update SVG filter
    if (turbulence && displacement) {
      turbulence.setAttribute('baseFrequency', `${baseFreq} ${baseFreq * 1.3}`);
      turbulence.setAttribute('seed', Math.floor(turbulencePhase * 15) % 100);
      displacement.setAttribute('scale', displacementScale);
    }

    visualizer.style.transform = `scale(${scale})`;

    // Dynamic underglow based on volume
    const glowIntensity = normalizedVolume * 0.25 + highFreqIntensity * 0.1;
    const glowSpread = 80 + normalizedVolume * 60;
    const glowSpreadOuter = 120 + normalizedVolume * 80;
    visualizer.style.boxShadow = `
      0 0 ${glowSpread}px rgba(255, 255, 255, ${0.08 + glowIntensity}),
      0 0 ${glowSpreadOuter}px rgba(255, 255, 255, ${0.02 + glowIntensity * 0.4}),
      inset 0 0 40px rgba(0, 0, 0, 0.3)
    `;

    // Active class for additional effects if needed
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

// Hello wiggle - simulates a brief voice-like distortion
function helloWiggle() {
  const displacement = document.getElementById('displacement');
  const turbulence = document.getElementById('turbulence');
  if (!displacement || !turbulence) return;
  
  let phase = 0;
  const duration = 900;
  const startTime = Date.now();
  
  function animate() {
    const elapsed = Date.now() - startTime;
    const progress = elapsed / duration;
    
    if (progress >= 1) {
      displacement.setAttribute('scale', 0);
      // Reset to base glow
      visualizer.style.boxShadow = `
        0 0 80px rgba(255, 255, 255, 0.15),
        0 0 120px rgba(255, 255, 255, 0.05),
        inset 0 0 40px rgba(0, 0, 0, 0.3)
      `;
      return;
    }
    
    // Bell curve intensity - ramps up then down
    const intensity = Math.sin(progress * Math.PI);
    phase += 0.15;
    
    const scale = intensity * 40;
    const freq = 0.015 + intensity * 0.04;
    
    turbulence.setAttribute('baseFrequency', `${freq} ${freq * 1.3}`);
    turbulence.setAttribute('seed', Math.floor(phase * 15) % 100);
    displacement.setAttribute('scale', scale);
    
    // Scale the sphere
    visualizer.style.transform = `scale(${1 + intensity * 0.2})`;
    
    // Pulse the underglow
    const glowIntensity = intensity * 0.3;
    const glowSpread = 80 + intensity * 50;
    visualizer.style.boxShadow = `
      0 0 ${glowSpread}px rgba(255, 255, 255, ${0.1 + glowIntensity}),
      0 0 ${glowSpread * 1.5}px rgba(255, 255, 255, ${0.03 + glowIntensity * 0.4}),
      inset 0 0 40px rgba(0, 0, 0, 0.3)
    `;
    
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
