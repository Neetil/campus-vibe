"use client";
import { useEffect, useRef, useState } from 'react';
import io, { type Socket } from "socket.io-client";
import { Button } from "@/components/ui/button";

const SOCKET_URL =
  typeof window !== "undefined"
    ? "https://campus-vibe.onrender.com"
    : undefined;
const ICE_SERVERS = [
  { urls: 'stun:global.stun.twilio.com:3478?transport=udp' },
  {
    urls: 'turn:global.turn.twilio.com:3478?transport=udp',
    username: 'test',
    credential: 'test'
  },
  {
    urls: 'turn:global.turn.twilio.com:3478?transport=tcp',
    username: 'test',
    credential: 'test'
  }
];

type ChatStatus = 'init' | 'waiting' | 'chatting' | 'disconnected';

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

  // Camera/mic: prompt immediately
  useEffect(() => {
    async function getUserMediaFn() {
      setMediaStatus(MediaStatus.Pending);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localStreamRef.current = stream;
        setMediaStatus(MediaStatus.Granted);
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      } catch {
        setMediaStatus(MediaStatus.Denied);
      }
    }
    getUserMediaFn();
    return () => stopMedia();
  }, []);

  // Socket.IO setup and WebRTC signaling
  useEffect(() => {
    const socket = io(SOCKET_URL ?? '', { transports: ['websocket'] });
    socketRef.current = socket;
    setStatus('waiting');
    socket.emit('findPartner');

    socket.on('partnerFound', async () => {
      setStatus('chatting');
      setMessages([]);
      await setupRTC(true); // true = createOffer if initiator
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

    socket.on('chatMessage', (msg: string) => {
      setMessages((m) => [...m, { from: 'them', text: msg }]);
      scrollMessages();
    });

    // ---- WebRTC signaling ----
    socket.on('rtc-offer', async (desc: RTCSessionDescriptionInit) => {
      await setupRTC(false); // Not initiator
      const pc = peerRef.current;
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(desc));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('rtc-answer', answer);
    });
    socket.on('rtc-answer', async (desc: RTCSessionDescriptionInit) => {
      const pc = peerRef.current;
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(desc));
    });
    socket.on('rtc-candidate', async (candidate: RTCIceCandidateInit) => {
      const pc = peerRef.current;
      if (!pc) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {}
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
    setMessages([]);
    setStatus('waiting');
    cleanUpPeer();
    setRemoteConnected(false);
    socketRef.current?.emit('next');
  }
  function handleStop() {
    socketRef.current?.disconnect();
    setStatus('init');
    setMessages([]);
    stopMedia();
    cleanUpPeer();
    setRemoteConnected(false);
  }

  // --- WebRTC logic ---
  async function setupRTC(initiator: boolean) {
    cleanUpPeer();
    if (mediaStatus !== MediaStatus.Granted) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerRef.current = pc;

    // Stream local
    localStreamRef.current?.getTracks().forEach((track) => {
      pc.addTrack(track, localStreamRef.current!);
    });

    // Remote incoming track
    pc.ontrack = (event) => {
      setRemoteConnected(true);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
        setRemoteConnected(false);
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      }
    };
    // ICE candidate
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current?.emit('rtc-candidate', e.candidate);
      }
    };

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.emit('rtc-offer', offer);
    }
  }

  function cleanUpPeer() {
    if (peerRef.current) {
      peerRef.current.ontrack = null;
      peerRef.current.oniceconnectionstatechange = null;
      peerRef.current.onicecandidate = null;
      peerRef.current.close();
      peerRef.current = null;
    }
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
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
  else if (status === 'disconnected') info = 'Partner disconnected. Click Next to find someone else.';
  else info = 'Ready to start anonymous chat.';

  return (
    <main className="bg-zinc-950 min-h-screen flex flex-col items-center py-8 px-2">
      <h1 className="text-white text-2xl md:text-3xl font-bold mt-2 mb-2">Campus Vibe</h1>
      <div className="text-zinc-400 mb-6">Anonymous Text & Video Chat</div>
      <section className="max-w-2xl w-full flex flex-col gap-4 bg-zinc-900/60 rounded-2xl shadow-xl border border-zinc-800 p-4 md:p-8 min-h-[550px]">
        <div className="flex flex-col md:flex-row gap-4 justify-center items-center">
          <div className="flex-1 bg-zinc-800 rounded-xl h-56 md:h-72 flex items-center justify-center border border-zinc-700 overflow-hidden relative">
            {mediaStatus === MediaStatus.Granted ? (
              <video ref={localVideoRef} autoPlay muted playsInline className="h-full w-full object-cover rounded-xl border-2 border-indigo-700/40 shadow" />
            ) : mediaStatus === MediaStatus.Denied ? (
              <span className="text-zinc-500">Camera/mic denied</span>
            ) : (
              <span className="text-zinc-400">Grant camera & mic permissions to see your video</span>
            )}
          </div>
          <div className="flex-1 bg-zinc-800 rounded-xl h-56 md:h-72 flex items-center justify-center border border-zinc-700 overflow-hidden relative">
            {status === 'chatting' && remoteConnected ? (
              <video ref={remoteVideoRef} autoPlay playsInline className="h-full w-full object-cover rounded-xl border-2 border-indigo-700/40 shadow" />
            ) : status === 'chatting' && !remoteConnected ? (
              <span className="text-zinc-500">Connecting...</span>
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
