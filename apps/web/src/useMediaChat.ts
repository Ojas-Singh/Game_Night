/**
 * useMediaChat — peer-to-peer voice + webcam over a full mesh.
 *
 * Signaling rides the room's existing socket.io connection (media:join /
 * media:signal / media:peers); media itself flows directly between players —
 * the server never sees a frame or a sample. Perfect negotiation resolves
 * offer collisions; the newcomer initiates offers to everyone already in the
 * mesh. A video transceiver exists on every peer connection from the start,
 * so toggling the camera later never needs renegotiation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

export interface MediaPeer {
  playerId: string;
  mic: boolean;
  cam: boolean;
  stream: MediaStream | null;
  connection: 'connecting' | 'connected' | 'failed';
  speaking: boolean;
}

export interface MediaChat {
  /** False when this browser has no WebRTC/getUserMedia support. */
  supported: boolean;
  joined: boolean;
  micOn: boolean;
  camOn: boolean;
  error: string | null;
  peers: MediaPeer[];
  /** Resolves true when the call was actually joined. */
  join(opts: { mic: boolean; cam: boolean }): Promise<boolean>;
  leave(): void;
  setMic(on: boolean): void;
  /** Resolves true when the camera state was applied. */
  setCam(on: boolean): Promise<boolean>;
}

/** Parse the VITE_ICE_SERVERS JSON (array of RTCIceServer dicts). */
export function parseIceServers(raw: string | undefined): RTCIceServer[] {
  const fallback: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const servers = parsed.filter(
      (entry): entry is RTCIceServer =>
        !!entry && typeof entry === 'object' && typeof (entry as { urls?: unknown }).urls === 'string',
    );
    return servers.length > 0 ? servers : fallback;
  } catch {
    return fallback;
  }
}

const VIDEO_CONSTRAINTS: MediaTrackConstraints = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } };
const SPEAK_THRESHOLD = 0.025;

export function useMediaChat(
  socket: Socket | null,
  myPlayerId: string | null,
  roomId: string | null,
): MediaChat {
  const supported = useMemo(
    () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof RTCPeerConnection !== 'undefined',
    [],
  );
  const [joined, setJoined] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peerMap, setPeerMap] = useState<Map<string, MediaPeer>>(new Map());

  const pcsRef = useRef(new Map<string, RTCPeerConnection>());
  const transceiversRef = useRef(new Map<string, { audio?: RTCRtpTransceiver; video?: RTCRtpTransceiver }>());
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const makingOfferRef = useRef(new Set<string>());
  const joinedRef = useRef(false);
  const rosterRef = useRef(new Map<string, { mic: boolean; cam: boolean }>());
  const speakingRef = useRef(new Set<string>());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analysersRef = useRef(new Map<string, AnalyserNode>());

  const iceServers = useMemo(() => parseIceServers(
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_ICE_SERVERS,
  ), []);

  const upsertPeer = useCallback((playerId: string, patch: Partial<MediaPeer>): void => {
    setPeerMap((prev) => {
      const next = new Map(prev);
      const current = next.get(playerId) ?? { playerId, mic: false, cam: false, stream: null, connection: 'connecting' as const, speaking: false };
      next.set(playerId, { ...current, ...patch, playerId });
      return next;
    });
  }, []);

  const ensureAudioGraph = useCallback((key: string, stream: MediaStream): void => {
    try {
      audioCtxRef.current ??= new AudioContext();
      const ctx = audioCtxRef.current;
      if (analysersRef.current.has(key)) return;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analysersRef.current.set(key, analyser);
    } catch {
      /* speaking detection is decorative; never break the call over it */
    }
  }, []);

  const closePeer = useCallback((playerId: string): void => {
    pcsRef.current.get(playerId)?.close();
    pcsRef.current.delete(playerId);
    transceiversRef.current.delete(playerId);
    makingOfferRef.current.delete(playerId);
    setPeerMap((prev) => {
      if (!prev.has(playerId)) return prev;
      const next = new Map(prev);
      next.delete(playerId);
      return next;
    });
  }, []);

  const sendSignal = useCallback((to: string, data: unknown): void => {
    socket?.emit('media:signal', { to, data });
  }, [socket]);

  const createPeer = useCallback((peerId: string): RTCPeerConnection => {
    const existing = pcsRef.current.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers });
    pcsRef.current.set(peerId, pc);
    upsertPeer(peerId, { connection: 'connecting' });

    // Both transceivers exist from birth: enabling the camera later is a
    // replaceTrack, never a renegotiation round-trip.
    const audio = pc.addTransceiver(audioTrackRef.current ?? 'audio', { direction: 'sendrecv' });
    const video = pc.addTransceiver(videoTrackRef.current ?? 'video', { direction: 'sendrecv' });
    if (audioTrackRef.current) void audio.sender.replaceTrack(audioTrackRef.current);
    if (videoTrackRef.current) void video.sender.replaceTrack(videoTrackRef.current);
    transceiversRef.current.set(peerId, { audio, video });

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal(peerId, { type: 'candidate', candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      ensureAudioGraph(peerId, stream);
      upsertPeer(peerId, { stream });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') upsertPeer(peerId, { connection: 'connected' });
      else if (pc.connectionState === 'failed') upsertPeer(peerId, { connection: 'failed' });
    };
    pc.onnegotiationneeded = async () => {
      try {
        makingOfferRef.current.add(peerId);
        await pc.setLocalDescription();
        if (pc.localDescription) sendSignal(peerId, { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
      } catch {
        /* negotiation retries via the next trigger */
      } finally {
        makingOfferRef.current.delete(peerId);
      }
    };
    return pc;
  }, [iceServers, sendSignal, upsertPeer, ensureAudioGraph]);

  const teardown = useCallback((): void => {
    for (const pc of pcsRef.current.values()) pc.close();
    pcsRef.current.clear();
    transceiversRef.current.clear();
    makingOfferRef.current.clear();
    rosterRef.current.clear();
    for (const analyser of analysersRef.current.values()) {
      try { analyser.disconnect(); } catch { /* ignore */ }
    }
    analysersRef.current.clear();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    audioTrackRef.current = null;
    videoTrackRef.current = null;
    speakingRef.current.clear();
    joinedRef.current = false;
    setPeerMap(new Map());
    setJoined(false);
    setMicOn(false);
    setCamOn(false);
  }, []);

  // Speaking detection: RMS over each analyser, batched at 200ms.
  useEffect(() => {
    if (!joined) return;
    const timer = window.setInterval(() => {
      const ctx = audioCtxRef.current;
      if (!ctx || analysersRef.current.size === 0) return;
      const data = new Uint8Array(256);
      const nextSpeaking = new Set<string>();
      for (const [key, analyser] of analysersRef.current) {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i]! - 128) / 128;
          sum += v * v;
        }
        if (Math.sqrt(sum / data.length) > SPEAK_THRESHOLD) nextSpeaking.add(key);
      }
      const prev = speakingRef.current;
      const changed = [...nextSpeaking].some((k) => !prev.has(k)) || [...prev].some((k) => !nextSpeaking.has(k));
      if (!changed) return;
      speakingRef.current = nextSpeaking;
      setPeerMap((current) => {
        const next = new Map(current);
        for (const [playerId, peer] of next) next.set(playerId, { ...peer, speaking: nextSpeaking.has(playerId) });
        return next;
      });
      void ctx;
    }, 200);
    return () => window.clearInterval(timer);
  }, [joined]);

  // Mesh roster + signaling listeners live for the hook's lifetime. They
  // consult joinedRef (not state) so a roster that arrives a tick after the
  // media:join emit is still processed.
  useEffect(() => {
    if (!socket || !myPlayerId) return;

    const onPeers = ({ peers }: { peers: Array<{ playerId: string; mic: boolean; cam: boolean }> }): void => {
      if (!joinedRef.current) return;
      const roster = new Map(peers.filter((p) => p.playerId !== myPlayerId).map((p) => [p.playerId, { mic: p.mic, cam: p.cam }]));
      const previousIds = new Set(rosterRef.current.keys());
      rosterRef.current = roster;
      // New roster members get a peer connection. Both sides create one and
      // both transceivers exist from birth, so offers may collide — perfect
      // negotiation below resolves who rolls back.
      for (const peerId of roster.keys()) {
        if (!pcsRef.current.has(peerId)) createPeer(peerId);
      }
      for (const peerId of previousIds) {
        if (!roster.has(peerId)) closePeer(peerId);
      }
      for (const [peerId, flags] of roster) upsertPeer(peerId, flags);
    };

    const onSignal = async ({ from, data }: { from: string; data: { type: string; sdp?: string; candidate?: RTCIceCandidateInit } }): Promise<void> => {
      if (!joinedRef.current || typeof from !== 'string' || from === myPlayerId || !data || typeof data.type !== 'string') return;
      const pc = createPeer(from);
      const polite = myPlayerId > from;
      try {
        const readyForOffer = !makingOfferRef.current.has(from) && pc.signalingState === 'stable';
        const offerCollision = data.type === 'offer' && !readyForOffer;
        if (data.type === 'offer' && data.sdp) {
          if (offerCollision && !polite) return; // impolite peer's offer wins
          await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp }); // implicit rollback when colliding
          await pc.setLocalDescription();
          if (pc.localDescription) sendSignal(from, { type: 'answer', sdp: pc.localDescription.sdp });
        } else if (data.type === 'answer' && data.sdp) {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
          }
        } else if (data.type === 'candidate' && data.candidate) {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch {
            /* candidates can race the remote description; ICE retries */
          }
        }
      } catch {
        /* signaling errors recover via connection-state failure UI */
      }
    };

    socket.on('media:peers', onPeers);
    socket.on('media:signal', onSignal);
    const onDisconnect = (): void => teardown();
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('media:peers', onPeers);
      socket.off('media:signal', onSignal);
      socket.off('disconnect', onDisconnect);
    };
  }, [socket, myPlayerId, createPeer, closePeer, upsertPeer, sendSignal, teardown]);

  // Left the room or unmounted: hang up.
  useEffect(() => {
    if (!roomId) teardown();
  }, [roomId, teardown]);
  useEffect(() => () => teardown(), [teardown]);

  const join = useCallback(async (opts: { mic: boolean; cam: boolean }): Promise<boolean> => {
    if (!socket || !myPlayerId || !supported) {
      setError('This browser cannot do live voice.');
      return false;
    }
    if (joinedRef.current) return true;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: opts.cam ? VIDEO_CONSTRAINTS : false,
      });
      localStreamRef.current = stream;
      audioTrackRef.current = stream.getAudioTracks()[0] ?? null;
      videoTrackRef.current = stream.getVideoTracks()[0] ?? null;
      if (audioTrackRef.current) audioTrackRef.current.enabled = true;
      if (videoTrackRef.current) videoTrackRef.current.enabled = true;
      ensureAudioGraph(myPlayerId, stream);
      joinedRef.current = true;
      setJoined(true);
      setMicOn(true);
      setCamOn(Boolean(videoTrackRef.current));
      socket.emit('media:join', { mic: true, cam: Boolean(videoTrackRef.current) });
      return true;
    } catch (err) {
      setError(
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone/camera permission was denied.'
          : 'Could not start voice — check your devices.',
      );
      teardown();
      return false;
    }
  }, [socket, myPlayerId, supported, ensureAudioGraph, teardown]);

  const leave = useCallback((): void => {
    socket?.emit('media:leave');
    teardown();
  }, [socket, teardown]);

  const setMic = useCallback((on: boolean): void => {
    const track = audioTrackRef.current;
    if (track) track.enabled = on;
    setMicOn(on);
    socket?.emit('media:update', { mic: on, cam: camOn });
  }, [socket, camOn]);

  const setCam = useCallback(async (on: boolean): Promise<boolean> => {
    try {
      if (on && !videoTrackRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
        const track = stream.getVideoTracks()[0] ?? null;
        if (track) {
          videoTrackRef.current = track;
          for (const transceivers of transceiversRef.current.values()) {
            if (transceivers.video) void transceivers.video.sender.replaceTrack(track);
          }
        }
      }
      if (videoTrackRef.current) videoTrackRef.current.enabled = on;
      setCamOn(on);
      socket?.emit('media:update', { mic: micOn, cam: on });
      return true;
    } catch {
      setError('Camera is unavailable or permission was denied.');
      return false;
    }
  }, [socket, micOn]);

  return {
    supported,
    joined,
    micOn,
    camOn,
    error,
    peers: useMemo(() => [...peerMap.values()], [peerMap]),
    join,
    leave,
    setMic,
    setCam,
  };
}
