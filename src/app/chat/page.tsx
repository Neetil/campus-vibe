"use client";
import { useEffect, useRef, useState } from 'react';
import io, { type Socket } from "socket.io-client";
import { Button } from "@/components/ui/button";

const SOCKET_URL =
  typeof window !== "undefined"
    ? "https://campus-vibe.onrender.com"
    : undefined;
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  {
    urls: 'turn:global.turn.twilio.com:3478',
    username: 'test',
    credential: 'test'
  }
];

type ChatStatus = 'init' | 'waiting' | 'chatting' | 'disconnected' | 'skipped';

enum MediaStatus {
  Pending = 'pending',
  Granted = 'granted',
  Denied = 'denied',
}

export default function ChatRoom() {
  const [status, setStatus] = useState<ChatStatus>('init');
  const [messages, setMessages] = useState<{from: 'me'|'them', text: string}[]>([]);
  const [input, setInput] = useState("");
  const socketRef = useRef<Socket|null>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // Camera/mic
  const [mediaStatus, setMediaStatus] = useState<MediaStatus>(MediaStatus.Pending);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const [remoteConnected, setRemoteConnected] = useState(false);

  // WebRTC peer connection
  const peerRef = useRef<RTCPeerConnection|null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const isSettingUpRTCRef = useRef<boolean>(false);
  
  // Helper function to safely play video
  const safePlayVideo = (videoElement: HTMLVideoElement | null, name: string = 'video') => {
    if (!videoElement) return;
    
    // Don't play if already playing or if srcObject is not set
    if (!videoElement.srcObject) return;
    
    // Check if video is already playing
    if (!videoElement.paused && videoElement.readyState >= 2) {
      return;
    }
    
    const playPromise = videoElement.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          console.log(`✅ ${name} playing successfully`);
        })
        .catch((error) => {
          // Ignore AbortError - it means play was interrupted, which is fine
          if (error.name !== 'AbortError' && error.name !== 'NotAllowedError') {
            console.error(`❌ Error playing ${name}:`, error);
          }
        });
    }
  };

  // Function to request media permissions
  const requestMediaPermissions = async (): Promise<boolean> => {
    setMediaStatus(MediaStatus.Pending);
    try {
      // Check if mediaDevices is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Media devices API not available. Please use HTTPS or localhost.');
      }
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user'
        }, 
        audio: true 
      });
      
      localStreamRef.current = stream;
      setMediaStatus(MediaStatus.Granted);
      
      // Set stream on video element when available
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        // Wait for metadata to load before playing
        localVideoRef.current.onloadedmetadata = () => {
          safePlayVideo(localVideoRef.current, 'local video');
        };
        safePlayVideo(localVideoRef.current, 'local video');
      }
      
      return true;
    } catch (err: any) {
      console.error('Error accessing media devices:', err);
      setMediaStatus(MediaStatus.Denied);
      
      // Show specific error message
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        console.error('User denied camera/microphone permissions');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        console.error('No camera/microphone found');
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        console.error('Camera/microphone is already in use');
      }
      return false;
    }
  };

  // Camera/mic: prompt immediately
  useEffect(() => {
    requestMediaPermissions();
    return () => stopMedia();
  }, []);

  // Ensure local video element gets stream when it becomes available
  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current && mediaStatus === MediaStatus.Granted) {
      if (localVideoRef.current.srcObject !== localStreamRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
        // Use safe play function
        safePlayVideo(localVideoRef.current, 'local video');
      }
    }
    
    // If media was just granted and we're chatting, re-setup RTC
    if (mediaStatus === MediaStatus.Granted && status === 'chatting' && socketRef.current) {
      const wasInitiator = peerRef.current?.localDescription !== null;
      setupRTC(wasInitiator).catch(console.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaStatus, status]);

  // Ensure remote video plays when stream is available
  useEffect(() => {
    if (remoteVideoRef.current && remoteStreamRef.current && status === 'chatting') {
      const video = remoteVideoRef.current;
      const stream = remoteStreamRef.current;
      
      // Check if stream has video tracks
      const hasVideoTrack = stream.getTracks().some(t => t.kind === 'video' && t.readyState === 'live');
      
      if (hasVideoTrack) {
        if (video.srcObject !== stream) {
          video.srcObject = stream;
          console.log('Updated remote video srcObject in useEffect');
        }
        if (video.paused) {
          video.play().then(() => {
            console.log('Remote video playing from useEffect');
            setRemoteConnected(true);
          }).catch((err) => {
            console.error('Error playing remote video in useEffect:', err);
          });
        }
      }
    }
  }, [remoteConnected, status]);

  // Socket.IO setup and WebRTC signaling
  useEffect(() => {
    if (!SOCKET_URL) {
      console.error('Socket URL not configured');
      return;
    }

    const socket = io(SOCKET_URL, { 
      transports: ['websocket', 'polling'], // Fallback to polling if websocket fails
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });
    
    socketRef.current = socket;
    
    socket.on('connect', () => {
      console.log('✅ Socket connected:', socket.id);
      setStatus('waiting');
      socket.emit('findPartner');
    });

    socket.on('connect_error', (error) => {
      console.error('❌ Socket connection error:', error);
      setStatus('disconnected');
    });

    socket.on('disconnect', (reason) => {
      console.log('Socket disconnected:', reason);
      if (reason === 'io server disconnect') {
        // Server disconnected, try to reconnect
        socket.connect();
      }
    });

    socket.on('partnerFound', async () => {
      setStatus('chatting');
      setMessages([]);
      
      // Wait a short random delay, then check if we received an offer
      // The peer who receives an offer first is NOT the initiator
      let receivedOffer = false;
      const offerHandler = () => { receivedOffer = true; };
      socket.once('rtc-offer', offerHandler);
      
      await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 50));
      
      socket.off('rtc-offer', offerHandler);
      
      // If we received an offer, we're NOT the initiator
      // Otherwise, we ARE the initiator
      const isInitiator = !receivedOffer;
      console.log('Determined initiator status:', isInitiator, '(received offer:', receivedOffer, ')');
      await setupRTC(isInitiator);
    });

    socket.on('waiting', () => {
      setStatus('waiting');
      setMessages([]);
      cleanUpPeer();
      setRemoteConnected(false);
    });

    socket.on('partnerDisconnected', () => {
      setStatus('disconnected');
      cleanUpPeer();
      setRemoteConnected(false);
    });

    socket.on('partnerSkipped', () => {
      setStatus('skipped');
      cleanUpPeer();
      setRemoteConnected(false);
    });

    socket.on('chatMessage', (msg: string) => {
      setMessages((m) => [...m, { from: 'them', text: msg }]);
      scrollMessages();
    });

    // ---- WebRTC signaling ----
    socket.on('rtc-offer', async (desc: RTCSessionDescriptionInit) => {
      console.log('📥 Received WebRTC offer');
      
      // Only setup if we don't already have a peer connection
      if (!peerRef.current || peerRef.current.connectionState === 'closed' || peerRef.current.connectionState === 'failed') {
        await setupRTC(false); // Not initiator
      } else {
        console.log('⚠️ Already have peer connection, will use existing');
      }
      
      const pc = peerRef.current;
      if (!pc) {
        console.error('No peer connection after setup');
        return;
      }
      
      // Don't set remote description if already set
      if (pc.remoteDescription) {
        console.log('⚠️ Remote description already set, skipping');
        return;
      }
      try {
        console.log('Setting remote description from offer...');
        await pc.setRemoteDescription(new RTCSessionDescription(desc));
        console.log('✅ Set remote description from offer');
        
        // Process any queued ICE candidates
        while (pendingIceCandidatesRef.current.length > 0) {
          const candidate = pendingIceCandidatesRef.current.shift();
          if (candidate) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
              console.log('✅ Added queued ICE candidate');
            } catch (err) {
              console.error('❌ Error adding queued ICE candidate:', err);
            }
          }
        }
        
        console.log('Creating answer...');
        const answer = await pc.createAnswer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        });
        await pc.setLocalDescription(answer);
        socket.emit('rtc-answer', answer);
        console.log('✅ Sent WebRTC answer');
        isSettingUpRTCRef.current = false;
      } catch (err) {
        console.error('❌ Error handling offer:', err);
        isSettingUpRTCRef.current = false;
      }
    });
    socket.on('rtc-answer', async (desc: RTCSessionDescriptionInit) => {
      console.log('📥 Received WebRTC answer');
      const pc = peerRef.current;
      if (!pc) {
        console.error('No peer connection when answer received');
        return;
      }
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(desc));
        console.log('✅ Set remote description from answer');
        
        // Process any queued ICE candidates
        while (pendingIceCandidatesRef.current.length > 0) {
          const candidate = pendingIceCandidatesRef.current.shift();
          if (candidate) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
              console.log('✅ Added queued ICE candidate');
            } catch (err) {
              console.error('❌ Error adding queued ICE candidate:', err);
            }
          }
        }
        
        // Check if we have any remote tracks already
        const receivers = pc.getReceivers();
        console.log('Current receivers:', receivers.length);
        receivers.forEach((receiver, idx) => {
          console.log(`  Receiver ${idx}:`, receiver.track?.kind, receiver.track?.id);
        });
      } catch (err) {
        console.error('❌ Error setting remote description from answer:', err);
      }
    });
    socket.on('rtc-candidate', async (candidate: RTCIceCandidateInit) => {
      console.log('📥 Received ICE candidate');
      const pc = peerRef.current;
      if (!pc) {
        console.warn('No peer connection when candidate received, queuing...');
        pendingIceCandidatesRef.current.push(candidate);
        return;
      }
      
      // If remote description is not set yet, queue the candidate
      if (!pc.remoteDescription) {
        console.log('Remote description not set yet, queuing ICE candidate');
        pendingIceCandidatesRef.current.push(candidate);
        return;
      }
      
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        console.log('✅ Added ICE candidate');
      } catch (err: any) {
        // If error is because remote description is null, queue it
        if (err.message?.includes('remote description') || err.name === 'InvalidStateError') {
          console.log('Queuing ICE candidate (remote description issue)');
          pendingIceCandidatesRef.current.push(candidate);
        } else {
          console.error('❌ Error adding ICE candidate:', err);
        }
      }
    });
    // ---------------------------

    return () => {
      socket.disconnect();
      stopMedia();
      cleanUpPeer();
      setRemoteConnected(false);
    };
    // eslint-disable-next-line
  }, []);

  function scrollMessages() {
    setTimeout(() => {
      chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 50);
  }

  function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || status !== 'chatting') return;
    socketRef.current?.emit('chatMessage', input);
    setMessages((m) => [...m, { from: 'me', text: input }]);
    setInput("");
    scrollMessages();
  }

  function handleNext() {
    if (status === 'skipped' || status === 'disconnected') {
      // Already disconnected, just find new partner
      setStatus('waiting');
      setMessages([]);
      cleanUpPeer();
      setRemoteConnected(false);
      socketRef.current?.emit('findPartner');
    } else {
      // Currently chatting, skip current partner
      setMessages([]);
      setStatus('waiting');
      cleanUpPeer();
      setRemoteConnected(false);
      socketRef.current?.emit('next');
    }
  }
  function handleStop() {
    socketRef.current?.emit('stop');
    socketRef.current?.disconnect();
    setStatus('init');
    setMessages([]);
    stopMedia();
    cleanUpPeer();
    setRemoteConnected(false);
  }

  // --- WebRTC logic ---
  async function setupRTC(initiator: boolean) {
    // Prevent multiple simultaneous setups
    if (isSettingUpRTCRef.current) {
      console.log('⚠️ RTC setup already in progress, skipping...');
      return;
    }
    
    // Don't destroy existing working or connecting connection
    if (peerRef.current) {
      const state = peerRef.current.connectionState;
      if (state === 'connected' || state === 'connecting') {
        console.log('⚠️ Peer connection already', state, ', skipping setup');
        isSettingUpRTCRef.current = false;
        return;
      }
      // Only cleanup if connection is failed/closed/disconnected
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        console.log('Cleaning up failed/closed connection before new setup');
        cleanUpPeer();
      } else {
        // If in 'new' or 'checking' state, don't destroy it
        console.log('⚠️ Peer connection in', state, 'state, skipping setup');
        isSettingUpRTCRef.current = false;
        return;
      }
    }
    
    isSettingUpRTCRef.current = true;
    pendingIceCandidatesRef.current = []; // Clear pending candidates
    
    // Check if we have media access
    if (!localStreamRef.current || mediaStatus !== MediaStatus.Granted) {
      console.log('Media not granted, attempting to request permissions...');
      const granted = await requestMediaPermissions();
      if (!granted) {
        console.log('Media permissions denied, cannot setup RTC');
        isSettingUpRTCRef.current = false;
        return;
      }
      // Wait a moment for state to update
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Double check we have a stream
    if (!localStreamRef.current) {
      console.log('No local stream available after permission request');
      isSettingUpRTCRef.current = false;
      return;
    }
    
    console.log('Setting up RTC, initiator:', initiator);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerRef.current = pc;

    // Create a new stream to collect remote tracks
    remoteStreamRef.current = new MediaStream();
    
    // Stream local - add all tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current!);
        console.log('Added local track:', track.kind, track.enabled, track.id);
      });
    } else {
      console.warn('No local stream available');
    }

    // Remote incoming track - collect all tracks into one stream
    pc.ontrack = (event) => {
      console.log('=== ONTRACK EVENT ===');
      console.log('Track kind:', event.track.kind);
      console.log('Track id:', event.track.id);
      console.log('Track readyState:', event.track.readyState);
      console.log('Streams in event:', event.streams.length);
      console.log('Track enabled:', event.track.enabled);
      
      if (!event.track) {
        console.error('No track in event!');
        return;
      }
      
      // Initialize remote stream if needed
      if (!remoteStreamRef.current) {
        remoteStreamRef.current = new MediaStream();
        console.log('Created new remote stream');
      }
      
      // Check if track already exists
      const existingTrack = remoteStreamRef.current.getTracks().find(t => t.id === event.track.id);
      if (!existingTrack) {
        remoteStreamRef.current.addTrack(event.track);
        console.log('Added track to remote stream. Total tracks:', remoteStreamRef.current.getTracks().length);
        
        // Log all current tracks
        remoteStreamRef.current.getTracks().forEach(t => {
          console.log(`  - Track: ${t.kind}, id: ${t.id}, readyState: ${t.readyState}`);
        });
      } else {
        console.log('Track already exists, skipping');
      }
      
      // Check if we have video tracks
      const videoTracks = remoteStreamRef.current.getVideoTracks();
      const hasVideo = videoTracks.length > 0;
      
      console.log('Has video tracks:', hasVideo, 'count:', videoTracks.length);
      
      if (hasVideo && remoteVideoRef.current) {
        // Set the stream on video element
        if (remoteVideoRef.current.srcObject !== remoteStreamRef.current) {
          console.log('Setting remote video srcObject');
          remoteVideoRef.current.srcObject = remoteStreamRef.current;
        }
        
        // Use safe play function
        safePlayVideo(remoteVideoRef.current, 'remote video');
        setRemoteConnected(true);
      } else if (!hasVideo) {
        console.log('Waiting for video track...');
      }
    };
    // ICE candidate
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current?.emit('rtc-candidate', e.candidate);
      }
    };

    // Connection state logging for debugging
    pc.onconnectionstatechange = () => {
      console.log('🔗 Peer connection state:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        console.log('✅ Peer connection established!');
        // Check if we have remote tracks
        if (remoteStreamRef.current && remoteStreamRef.current.getTracks().length > 0) {
          console.log('Remote tracks available, setting connected');
          setRemoteConnected(true);
        } else {
          console.log('⚠️ Connected but no remote tracks yet. Checking receivers...');
          // Check receivers and try to get tracks
          const receivers = pc.getReceivers();
          console.log('Total receivers:', receivers.length);
          receivers.forEach((receiver, idx) => {
            const track = receiver.track;
            console.log(`  Receiver ${idx}:`, track?.kind, track?.id, track?.readyState);
            if (track && !remoteStreamRef.current?.getTracks().find(t => t.id === track.id)) {
              if (!remoteStreamRef.current) {
                remoteStreamRef.current = new MediaStream();
              }
              remoteStreamRef.current.addTrack(track);
              console.log('✅ Added track from receiver:', track.kind);
            }
          });
          
          if (remoteStreamRef.current && remoteStreamRef.current.getTracks().length > 0) {
            console.log('✅ Setting remote connected from receivers');
            setRemoteConnected(true);
            if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = remoteStreamRef.current;
              remoteVideoRef.current.play().then(() => {
                console.log('✅ Remote video playing from receiver tracks');
              }).catch(console.error);
            }
          }
        }
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        console.log('❌ Peer connection lost:', pc.connectionState);
        setRemoteConnected(false);
      }
    };
    pc.oniceconnectionstatechange = () => {
      console.log('🧊 ICE connection state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        console.log('✅ ICE connection established');
        
        // Log all receivers and tracks
        const receivers = pc.getReceivers();
        console.log('Total receivers:', receivers.length);
        receivers.forEach((receiver, idx) => {
          const track = receiver.track;
          console.log(`  Receiver ${idx}:`, {
            kind: track?.kind,
            id: track?.id,
            readyState: track?.readyState,
            enabled: track?.enabled
          });
        });
        
        // Check tracks after ICE connects
        setTimeout(() => {
          if (remoteStreamRef.current && remoteStreamRef.current.getTracks().length > 0) {
            console.log('✅ Setting remote connected after ICE completion');
            setRemoteConnected(true);
            if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== remoteStreamRef.current) {
              remoteVideoRef.current.srcObject = remoteStreamRef.current;
              remoteVideoRef.current.play().catch(console.error);
            }
          } else {
            console.log('⚠️ ICE connected but no remote tracks in stream. Checking receivers...');
            // Try to get tracks from receivers
            receivers.forEach((receiver) => {
              if (receiver.track && !remoteStreamRef.current?.getTracks().find(t => t.id === receiver.track!.id)) {
                if (!remoteStreamRef.current) {
                  remoteStreamRef.current = new MediaStream();
                }
                remoteStreamRef.current.addTrack(receiver.track);
                console.log('Added track from receiver:', receiver.track.kind);
              }
            });
            
            if (remoteStreamRef.current && remoteStreamRef.current.getTracks().length > 0 && remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = remoteStreamRef.current;
              safePlayVideo(remoteVideoRef.current, 'remote video from receivers after ICE');
              setRemoteConnected(true);
            }
          }
        }, 500);
      } else if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed' || pc.iceConnectionState === 'failed') {
        console.log('❌ ICE connection lost:', pc.iceConnectionState);
        setRemoteConnected(false);
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      }
    };

    if (initiator) {
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        });
        await pc.setLocalDescription(offer);
        socketRef.current?.emit('rtc-offer', offer);
        console.log('Sent WebRTC offer');
      } catch (err) {
        console.error('Error creating offer:', err);
      }
    }
  }

  function cleanUpPeer() {
    if (peerRef.current) {
      peerRef.current.ontrack = null;
      peerRef.current.oniceconnectionstatechange = null;
      peerRef.current.onicecandidate = null;
      peerRef.current.onconnectionstatechange = null;
      peerRef.current.close();
      peerRef.current = null;
    }
    if (remoteStreamRef.current) {
      remoteStreamRef.current.getTracks().forEach(track => track.stop());
      remoteStreamRef.current = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    setRemoteConnected(false);
  }

  function stopMedia() {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
  }

  // Status helper
  let info = '';
  if (mediaStatus === MediaStatus.Denied) info = 'Camera/mic blocked — video chat will not work.';
  else if (status === 'waiting') info = 'Looking for a partner...';
  else if (status === 'chatting') info = remoteConnected ? 'Video connected!' : 'Connecting videos...';
  else if (status === 'skipped') info = 'User has skipped you. Click Next to find someone else.';
  else if (status === 'disconnected') info = 'Partner disconnected. Click Next to find someone else.';
  else info = 'Ready to start anonymous chat.';

  return (
    <main className="bg-zinc-950 min-h-screen flex flex-col items-center py-8 px-2">
      <h1 className="text-white text-2xl md:text-3xl font-bold mt-2 mb-2">Campus Vibe</h1>
      <div className="text-zinc-400 mb-6">Anonymous Text & Video Chat</div>
      <section className="max-w-2xl w-full flex flex-col gap-4 bg-zinc-900/60 rounded-2xl shadow-xl border border-zinc-800 p-4 md:p-8 min-h-[550px]">
        <div className="flex flex-row gap-2 md:gap-4 justify-center items-center">
          <div className="flex-1 bg-zinc-800 rounded-xl h-40 md:h-56 lg:h-72 flex items-center justify-center border border-zinc-700 overflow-hidden relative">
            {mediaStatus === MediaStatus.Granted ? (
              <video 
                ref={localVideoRef} 
                autoPlay 
                muted 
                playsInline 
                className="h-full w-full object-cover rounded-xl border-2 border-indigo-700/40 shadow"
                onLoadedMetadata={() => {
                  safePlayVideo(localVideoRef.current, 'local video on metadata');
                }}
              />
            ) : mediaStatus === MediaStatus.Denied ? (
              <div className="flex flex-col items-center justify-center gap-2 p-4">
                <span className="text-red-400 text-center">Camera/mic access denied</span>
                <Button 
                  onClick={requestMediaPermissions}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm px-4 py-2"
                >
                  Grant Permissions
                </Button>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 p-4">
                <span className="text-zinc-400 text-center">Requesting camera & mic permissions...</span>
                <Button 
                  onClick={requestMediaPermissions}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm px-4 py-2"
                >
                  Allow Access
                </Button>
              </div>
            )}
          </div>
          <div className="flex-1 bg-zinc-800 rounded-xl h-40 md:h-56 lg:h-72 flex items-center justify-center border border-zinc-700 overflow-hidden relative">
            {status === 'chatting' ? (
              remoteConnected && remoteStreamRef.current && remoteStreamRef.current.getVideoTracks().length > 0 ? (
                <video 
                  ref={remoteVideoRef} 
                  autoPlay 
                  playsInline 
                  muted={false}
                  className="h-full w-full object-cover rounded-xl border-2 border-indigo-700/40 shadow"
                  onLoadedMetadata={() => {
                    console.log('Remote video metadata loaded');
                    safePlayVideo(remoteVideoRef.current, 'remote video on canplay');
                  }}
                  onCanPlay={() => {
                    console.log('Remote video can play');
                    safePlayVideo(remoteVideoRef.current, 'remote video on canplay');
                  }}
                  onPlay={() => {
                    console.log('Remote video started playing');
                    setRemoteConnected(true);
                  }}
                  onError={(e) => {
                    console.error('Remote video error:', e);
                  }}
                />
              ) : (
                <div className="flex flex-col items-center justify-center gap-2">
                  <span className="text-zinc-500">Connecting...</span>
                  {remoteStreamRef.current && (
                    <span className="text-xs text-zinc-600">
                      Tracks: {remoteStreamRef.current.getTracks().length} 
                      (Video: {remoteStreamRef.current.getVideoTracks().length})
                    </span>
                  )}
                </div>
              )
            ) : status === 'skipped' ? (
              <span className="text-red-400">User skipped</span>
            ) : (
              <span className="text-zinc-500">Stranger video</span>
            )}
          </div>
        </div>
        {/* Connected statement */}
        {status === 'chatting' && (
          <div className="text-zinc-100 text-center bg-indigo-800/20 border border-indigo-600 rounded p-2 mb-3 font-semibold">
            You are connected with a stranger.
          </div>
        )}
        {/* Skipped statement */}
        {status === 'skipped' && (
          <div className="text-red-300 text-center bg-red-900/20 border border-red-600 rounded p-2 mb-3 font-semibold">
            User has skipped you.
          </div>
        )}
        {/* Text chat area */}
        <div className="bg-zinc-800 rounded-xl mt-4 min-h-40 max-h-52 h-40 p-3 flex flex-col justify-between border border-zinc-700">
          <div className="flex-1 overflow-y-auto text-zinc-300 mb-2 space-y-2 scrollbar-thin scrollbar-thumb-zinc-700 pr-1">
            {messages.length === 0 && (
              <span className="text-zinc-500">Say hi to get started!</span>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`max-w-[85%] break-words ${msg.from === 'me' ? 'ml-auto text-right' : ''}`}>
                <span className={`inline-block px-3 py-2 rounded-xl ${msg.from === 'me' ? 'bg-indigo-500 text-white' : 'bg-zinc-700 text-zinc-100'}`}>{msg.text}</span>
              </div>
            ))}
            <div ref={chatBottomRef} />
          </div>
          <form className="flex gap-2 mt-1" onSubmit={sendMessage}>
            <input
              type="text"
              className="flex-1 rounded bg-zinc-900 text-white px-3 py-2 outline-none focus:bg-zinc-950 border border-zinc-700 placeholder:text-zinc-500"
              placeholder="Type your message..."
              autoComplete="off"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={status !== 'chatting'}
            />
            <Button type="submit" disabled={status !== 'chatting' || !input.trim()}>
              Send
            </Button>
          </form>
        </div>
        {/* Controls */}
        <div className="flex gap-4 items-center justify-center mt-2">
          <Button className="bg-gradient-to-tr from-indigo-500 via-blue-500 to-purple-700 text-white shadow-md font-semibold px-6 py-3" onClick={handleNext} disabled={status === 'waiting'}>
            Next
          </Button>
          <Button variant="outline" className="border-zinc-700 text-zinc-300 px-6 py-3" onClick={handleStop}>
            Stop
          </Button>
        </div>
        <div className="mt-4 text-center text-zinc-400 text-sm min-h-6">{info}</div>
      </section>
      {/* Footer */}
      <footer className="mt-12 mb-6 text-zinc-600 text-center text-sm max-w-lg mx-auto">
        Completely anonymous, no sign-ups, no tracking.<br />
        <span className="text-zinc-500">Built with Neetil.</span>
      </footer>
    </main>
  );
}
