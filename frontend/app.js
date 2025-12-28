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
const micBtn = document.getElementById('mic-btn');
const startBtn = document.getElementById('start-btn');
const waitingText = document.getElementById('waiting-text');
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

// Handle mic/enter actions (can be triggered by button or sphere click)
async function handleMicClick() {
  if (localStream) return; // Already have mic access
  
  log('User clicked to enable mic');
  
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

    // Add underglow to sphere (no breathing yet)
    visualizer.classList.add('underglow');
    
    // Fade out mic button, then show enter button
    micBtn.classList.add('fade-out');
    setTimeout(() => {
      micBtn.classList.add('hidden');
      startBtn.classList.remove('hidden');
    }, 500);
  } catch (err) {
    logError('Microphone access failed:', err);
    alert('Microphone access is required to use voidchat');
  }
}

async function handleEnterClick() {
  if (!localStream || startBtn.classList.contains('hidden')) return; // Not ready yet
  
  log('User clicked to enter');
  
  // Start sphere breathing (subtle)
  visualizer.classList.remove('underglow');
  visualizer.classList.add('breathing-subtle');
  
  // Explode the button text and hide button immediately
  explodeText(startBtn);
  startBtn.classList.add('hidden');
  
  try {
    // Fetch TURN credentials
    log('Fetching TURN credentials...');
    const credResponse = await fetch(CREDENTIALS_URL);
    if (!credResponse.ok) {
      throw new Error('Failed to fetch TURN credentials');
    }
    const credData = await credResponse.json();
    iceServers = credData.iceServers;
    log('Got ICE servers:', iceServers.map(s => s.urls));

    // Delay showing waiting text until exploding animation finishes
    setTimeout(() => {
      waitingText.classList.remove('hidden');
      waitingText.classList.add('pulsing');
      connectSignaling();
    }, 2400);
  } catch (err) {
    logError('Startup failed:', err);
    alert('Failed to start: ' + err.message);
  }
}

// Step 1: Request microphone permission
micBtn.addEventListener('click', handleMicClick);

// Step 2: Enter the void
startBtn.addEventListener('click', handleEnterClick);

// Sphere click - triggers current action (mic or enter)
visualizer.addEventListener('click', () => {
  // If already in connected state, this is handled by the skip logic below
  if (visualizer.classList.contains('clickable')) return;
  
  // If mic not enabled yet, trigger mic
  if (!localStream) {
    handleMicClick();
    return;
  }
  
  // If mic enabled but not entered yet, trigger enter
  if (!startBtn.classList.contains('hidden')) {
    handleEnterClick();
    return;
  }
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

// Explode text into letters - shake then crumble down with coupled physics
function explodeText(element) {
  const text = element.textContent;
  
  // Get the button's position to spawn letters there
  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  
  // Create container for exploding letters
  const container = document.createElement('div');
  container.id = 'exploding-text';
  container.style.left = `${centerX}px`;
  container.style.top = `${centerY}px`;
  
  // Build letter data with physics state
  const letters = [];
  const couplingStrength = 0.15; // How much neighbors influence each other (reduced)
  const shakeDuration = 1400; // ms
  const fallDuration = 900; // ms
  const totalDuration = shakeDuration + fallDuration;
  
  // Create clinging groups (2-3 adjacent letters that fall together initially)
  const clingGroups = [];
  let i = 0;
  while (i < text.length) {
    if (Math.random() < 0.4 && i < text.length - 1) {
      // Start a cling group
      const groupSize = Math.random() < 0.5 ? 2 : 3;
      const group = {
        start: i,
        end: Math.min(i + groupSize, text.length),
        driftX: (Math.random() - 0.5) * 25,
        fallY: 200 + Math.random() * 120,
        breakTime: 0.3 + Math.random() * 0.4, // When they separate (0-1 of fall phase)
      };
      clingGroups.push(group);
      i = group.end;
    } else {
      i++;
    }
  }
  
  // Check if letter index is in a cling group
  function getClingGroup(idx) {
    for (const g of clingGroups) {
      if (idx >= g.start && idx < g.end) return g;
    }
    return null;
  }
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const span = document.createElement('span');
    span.textContent = char === ' ' ? '\u00A0' : char;
    span.style.display = 'inline-block';
    container.appendChild(span);
    
    const clingGroup = getClingGroup(i);
    
    letters.push({
      el: span,
      // Position offsets
      x: 0,
      y: 0,
      rot: 0,
      // Velocities for shake phase
      vx: 0,
      vy: 0,
      vrot: 0,
      // Target shake values (randomized each frame)
      targetX: 0,
      targetY: 0,
      targetRot: 0,
      // Fall phase values
      driftX: clingGroup ? clingGroup.driftX + (i - clingGroup.start) * 2 : (Math.random() - 0.5) * 35,
      fallY: clingGroup ? clingGroup.fallY : 200 + Math.random() * 150,
      finalRot: (Math.random() - 0.5) * 180,
      // Stagger - letters on the ends break off first
      staggerDelay: Math.min(i, text.length - 1 - i) * 40, // middle letters fall last
      // Cling group reference
      clingGroup,
      clingIndex: clingGroup ? i - clingGroup.start : -1,
      // Opacity
      opacity: 1,
    });
  }
  
  document.body.appendChild(container);
  
  const startTime = Date.now();
  let lastFrame = startTime;
  
  function animate() {
    const now = Date.now();
    const elapsed = now - startTime;
    const dt = Math.min((now - lastFrame) / 1000, 0.05); // Cap dt to avoid jumps
    lastFrame = now;
    
    if (elapsed > totalDuration + 200) {
      container.remove();
      return;
    }
    
    // Update each letter
    for (let i = 0; i < letters.length; i++) {
      const letter = letters[i];
      const letterElapsed = Math.max(0, elapsed - letter.staggerDelay);
      
      if (letterElapsed < shakeDuration) {
        // === SHAKE PHASE: coupled vibrations ===
        const shakeProgress = letterElapsed / shakeDuration;
        // Intensity peaks at 60% then winds down to zero
        const intensity = shakeProgress < 0.6 
          ? Math.sin(shakeProgress / 0.6 * Math.PI * 0.5) 
          : Math.cos((shakeProgress - 0.6) / 0.4 * Math.PI * 0.5);
        
        // Generate new random targets periodically
        if (Math.random() < 0.12) {
          letter.targetX = (Math.random() - 0.5) * 6 * intensity;
          letter.targetY = (Math.random() - 0.5) * 4 * intensity;
          letter.targetRot = (Math.random() - 0.5) * 10 * intensity;
        }
        
        // Wind down targets as we approach end
        if (shakeProgress > 0.7) {
          const windDown = (shakeProgress - 0.7) / 0.3;
          letter.targetX *= (1 - windDown);
          letter.targetY *= (1 - windDown);
          letter.targetRot *= (1 - windDown);
        }
        
        // Get neighbor influence (weak spring coupling)
        let neighborInfluenceX = 0;
        let neighborInfluenceY = 0;
        let neighborInfluenceRot = 0;
        
        if (i > 0) {
          const left = letters[i - 1];
          neighborInfluenceX += (left.x - letter.x) * couplingStrength;
          neighborInfluenceY += (left.y - letter.y) * couplingStrength;
          neighborInfluenceRot += (left.rot - letter.rot) * couplingStrength * 0.3;
        }
        if (i < letters.length - 1) {
          const right = letters[i + 1];
          neighborInfluenceX += (right.x - letter.x) * couplingStrength;
          neighborInfluenceY += (right.y - letter.y) * couplingStrength;
          neighborInfluenceRot += (right.rot - letter.rot) * couplingStrength * 0.3;
        }
        
        // Spring toward target + neighbor influence
        const springK = 0.12;
        const damping = 0.88;
        
        letter.vx += (letter.targetX - letter.x) * springK + neighborInfluenceX;
        letter.vy += (letter.targetY - letter.y) * springK + neighborInfluenceY;
        letter.vrot += (letter.targetRot - letter.rot) * springK + neighborInfluenceRot;
        
        letter.vx *= damping;
        letter.vy *= damping;
        letter.vrot *= damping;
        
        letter.x += letter.vx;
        letter.y += letter.vy;
        letter.rot += letter.vrot;
        
        // Flicker opacity
        letter.opacity = 0.7 + Math.random() * 0.3;
        
      } else {
        // Reset velocities on first frame of fall phase
        if (!letter.inFallPhase) {
          letter.inFallPhase = true;
          letter.vx = 0;
          letter.vy = 0;
          letter.vrot = 0;
          // Start fall from near zero
          letter.x *= 0.3;
          letter.y *= 0.3;
          letter.rot *= 0.3;
        }
        // === FALL PHASE: crumble with clinging ===
        const fallElapsed = letterElapsed - shakeDuration;
        const fallProgress = Math.min(fallElapsed / fallDuration, 1);
        
        // Easing for fall (ease-out cubic)
        const eased = 1 - Math.pow(1 - fallProgress, 3);
        
        let targetX, targetY, targetRot;
        
        if (letter.clingGroup && fallProgress < letter.clingGroup.breakTime) {
          // Still clinging - move together with slight offset
          const groupProgress = fallProgress / letter.clingGroup.breakTime;
          targetX = letter.clingGroup.driftX * groupProgress * 0.5 + letter.clingIndex * 1.5;
          targetY = letter.clingGroup.fallY * groupProgress * 0.3;
          targetRot = letter.finalRot * groupProgress * 0.2;
        } else {
          // Broken free or solo - fall independently
          let breakProgress = fallProgress;
          if (letter.clingGroup) {
            // Adjust progress to start from break point
            breakProgress = (fallProgress - letter.clingGroup.breakTime) / (1 - letter.clingGroup.breakTime);
            breakProgress = Math.max(0, breakProgress);
          }
          const breakEased = 1 - Math.pow(1 - breakProgress, 2);
          
          targetX = letter.driftX * eased;
          targetY = letter.fallY * eased;
          targetRot = letter.finalRot * breakEased;
        }
        
        // Smooth transition
        letter.x += (targetX - letter.x) * 0.15;
        letter.y += (targetY - letter.y) * 0.15;
        letter.rot += (targetRot - letter.rot) * 0.1;
        
        // Fade out with flicker
        const fadeStart = 0.4;
        if (fallProgress > fadeStart) {
          const fadeProgress = (fallProgress - fadeStart) / (1 - fadeStart);
          letter.opacity = (1 - fadeProgress) * (0.7 + Math.random() * 0.3);
        }
      }
      
      // Apply transform
      letter.el.style.transform = `translate(${letter.x}px, ${letter.y}px) rotate(${letter.rot}deg)`;
      letter.el.style.opacity = letter.opacity;
    }
    
    requestAnimationFrame(animate);
  }
  
  // Initial glimmer flash
  container.style.textShadow = '0 0 40px rgba(255, 255, 255, 1), 0 0 80px rgba(255, 255, 255, 0.7)';
  setTimeout(() => {
    container.style.textShadow = '0 0 20px rgba(255, 255, 255, 0.5)';
  }, 100);
  
  animate();
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
