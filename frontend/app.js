// Configuration - update this after deploying the worker
const SIGNALING_URL = 'wss://voice-roulette-signaling.brazdil94.workers.dev/ws';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

// DOM elements
const startBtn = document.getElementById('start-btn');
const mainUI = document.getElementById('main-ui');
const visualizer = document.getElementById('visualizer');
const status = document.getElementById('status');
const nextBtn = document.getElementById('next-btn');
const onlineCount = document.getElementById('online-count');

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
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    startBtn.classList.add('hidden');
    mainUI.classList.remove('hidden');
    visualizer.classList.add('breathing');

    connectSignaling();
  } catch (err) {
    console.error('Microphone access failed:', err);
    alert('Microphone access is required to enter the void.');
  }
});

nextBtn.addEventListener('click', () => {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    cleanupPeerConnection();
    websocket.send(JSON.stringify({ type: 'next' }));
    setStatus('finding someone...');
    nextBtn.disabled = true;
    visualizer.classList.add('breathing');
    visualizer.classList.remove('active');
  }
});

// ============================================
// SIGNALING
// ============================================

function connectSignaling() {
  setStatus('connecting...');

  websocket = new WebSocket(SIGNALING_URL);

  websocket.onopen = () => {
    console.log('Signaling connected');
    websocket.send(JSON.stringify({ type: 'join' }));
  };

  websocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleSignalingMessage(data);
    } catch (err) {
      console.error('Failed to parse message:', err);
    }
  };

  websocket.onclose = () => {
    console.log('Signaling disconnected');
    setStatus('disconnected');
    
    // Attempt reconnect after delay
    setTimeout(() => {
      if (localStream) {
        connectSignaling();
      }
    }, 2000);
  };

  websocket.onerror = (err) => {
    console.error('Signaling error:', err);
  };
}

function handleSignalingMessage(data) {
  switch (data.type) {
    case 'waiting':
      setStatus('waiting...');
      nextBtn.disabled = true;
      break;

    case 'matched':
      setStatus('connecting...');
      createPeerConnection();
      if (data.initiator) {
        createOffer();
      }
      break;

    case 'offer':
      handleOffer(data.sdp);
      break;

    case 'answer':
      handleAnswer(data.sdp);
      break;

    case 'ice':
      handleIceCandidate(data.candidate);
      break;

    case 'partner_left':
      cleanupPeerConnection();
      setStatus('they left');
      visualizer.classList.add('breathing');
      visualizer.classList.remove('active');
      // Auto-rejoin after a moment
      setTimeout(() => {
        if (websocket && websocket.readyState === WebSocket.OPEN) {
          websocket.send(JSON.stringify({ type: 'join' }));
        }
      }, 1000);
      break;

    case 'stats':
      updateOnlineCount(data.online);
      break;

    case 'error':
      console.error('Server error:', data.message);
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
  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Add local audio track
  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  // Handle incoming audio
  peerConnection.ontrack = (event) => {
    console.log('Received remote track');
    const remoteStream = event.streams[0];
    setupRemoteAudio(remoteStream);
    setStatus('connected', true);
    nextBtn.disabled = false;
    visualizer.classList.remove('breathing');
  };

  // Handle ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({
        type: 'ice',
        candidate: event.candidate.toJSON(),
      }));
    }
  };

  // Connection state monitoring
  peerConnection.onconnectionstatechange = () => {
    console.log('Connection state:', peerConnection.connectionState);
    
    switch (peerConnection.connectionState) {
      case 'connected':
        setStatus('connected', true);
        break;
      case 'disconnected':
        setStatus('reconnecting...');
        break;
      case 'failed':
        setStatus('connection failed');
        nextBtn.disabled = false;
        break;
    }
  };
}

async function createOffer() {
  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    
    websocket.send(JSON.stringify({
      type: 'offer',
      sdp: peerConnection.localDescription.toJSON(),
    }));
  } catch (err) {
    console.error('Failed to create offer:', err);
  }
}

async function handleOffer(sdp) {
  try {
    if (!peerConnection) {
      createPeerConnection();
    }
    
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    websocket.send(JSON.stringify({
      type: 'answer',
      sdp: peerConnection.localDescription.toJSON(),
    }));
  } catch (err) {
    console.error('Failed to handle offer:', err);
  }
}

async function handleAnswer(sdp) {
  try {
    if (peerConnection) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    }
  } catch (err) {
    console.error('Failed to handle answer:', err);
  }
}

async function handleIceCandidate(candidate) {
  try {
    if (peerConnection && candidate) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (err) {
    console.error('Failed to add ICE candidate:', err);
  }
}

function cleanupPeerConnection() {
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
    peerConnection.close();
    peerConnection = null;
  }
  
  visualizer.style.transform = 'scale(1)';
  visualizer.classList.remove('active');
}

// ============================================
// AUDIO VISUALIZATION
// ============================================

function setupRemoteAudio(stream) {
  // Create audio element for playback
  remoteAudioElement = new Audio();
  remoteAudioElement.srcObject = stream;
  remoteAudioElement.play().catch((err) => {
    console.error('Audio playback failed:', err);
  });

  // Create audio context for visualization
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
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

  function draw() {
    if (!analyser) return;

    animationId = requestAnimationFrame(draw);

    analyser.getByteFrequencyData(dataArray);

    // Calculate average volume (focus on voice frequencies 85-255 Hz range, bins ~3-10)
    let sum = 0;
    const voiceStart = 3;
    const voiceEnd = 20;
    for (let i = voiceStart; i < voiceEnd; i++) {
      sum += dataArray[i];
    }
    const average = sum / (voiceEnd - voiceStart);

    // Map to scale (1.0 to 1.6)
    const normalizedVolume = Math.min(average / 180, 1);
    const scale = 1 + normalizedVolume * 0.6;

    visualizer.style.transform = `scale(${scale})`;

    // Glow when speaking
    if (average > 25) {
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

function updateOnlineCount(count) {
  if (count > 1) {
    onlineCount.textContent = `${count} in the void`;
  } else {
    onlineCount.textContent = '';
  }
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
