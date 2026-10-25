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
  /** Inbound media from this peer. Always carries audio; carries video when
   *  their camera is on. Consume `videoStream` for pictures and `stream` for
   *  sound — an <audio> element fed a video-bearing stream is unreliable. */
  stream: MediaStream | null;
  /** Inbound video only, or null while their camera is off. */
  videoStream: MediaStream | null;
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
  /** My own outbound stream when joined (for self-view in avatar slots). */
  localStream: MediaStream | null;
  /** Player ids whose voice is currently above the speaking threshold
   *  (includes me). */
  speaking: ReadonlySet<string>;
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
// RMS of the processed mic signal (browsers apply noise suppression and
// gain control, so normal speech sits around 0.01-0.1).
const SPEAK_THRESHOLD = 0.01;
/** Keep "talking" on briefly after the last loud sample so it doesn't flicker
 *  between words. */
const SPEAK_HOLD_MS = 450;

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
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peerMap, setPeerMap] = useState<Map<string, MediaPeer>>(new Map());
  const [speakingIds, setSpeakingIds] = useState<ReadonlySet<string>>(new Set());

  const pcsRef = useRef(new Map<string, RTCPeerConnection>());
  const transceiversRef = useRef(new Map<string, { audio?: RTCRtpTransceiver; video?: RTCRtpTransceiver }>());
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const makingOfferRef = useRef(new Set<string>());
  const joinedRef = useRef(false);
  const rosterRef = useRef(new Map<string, { mic: boolean; cam: boolean }>());
  const speakingRef = useRef(new Set<string>());
  const lastLoudRef = useRef(new Map<string, number>());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analysersRef = useRef(new Map<string, AnalyserNode>());

  const buildIceServers = useMemo(() => parseIceServers(
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_ICE_SERVERS,
  ), []);
  // The server can add a TURN relay at runtime (/api/ice); players on mobile
  // data or strict NATs cannot reach each other without one.
  const iceServersRef = useRef<RTCIceServer[]>(buildIceServers);

  const upsertPeer = useCallback((playerId: string, patch: Partial<MediaPeer>): void => {
    setPeerMap((prev) => {
      const next = new Map(prev);
      const current = next.get(playerId)
        ?? { playerId, mic: false, cam: false, stream: null, videoStream: null, connection: 'connecting' as const, speaking: false };
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
      analyser.smoothingTimeConstant = 0;
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

  /**
   * Force a fresh offer on a peer connection. ReplaceTrack on an existing
   * sender does not always fire onnegotiationneeded, so the side that gains a
   * track must offer explicitly for the media direction to change.
   */
  const renegotiate = useCallback((pc: RTCPeerConnection): void => {
    if (pc.signalingState !== 'stable') return;
    void (async () => {
      try {
        await pc.setLocalDescription();
        const peerId = [...pcsRef.current.entries()].find(([, candidate]) => candidate === pc)?.[0];
        if (peerId && pc.localDescription) {
          makingOfferRef.current.add(peerId);
          sendSignal(peerId, { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
          makingOfferRef.current.delete(peerId);
        }
      } catch {
        /* the next track change retries */
      }
    })();
  }, [sendSignal]);

  const createPeer = useCallback((peerId: string): RTCPeerConnection => {
    const existing = pcsRef.current.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
    pcsRef.current.set(peerId, pc);
    upsertPeer(peerId, { connection: 'connecting' });

    // Exactly one side of each pair opens the connection (the lower player
    // id). When both sides offered at once, the rollback that resolved the
    // collision could leave Chrome's ICE gathering stalled with no candidates,
    // and that pair never connected. The answering side adopts the
    // transceivers the offer creates (see adoptTransceivers).
    if (myPlayerId !== null && myPlayerId < peerId) {
      // Both m-lines exist from birth so toggling the camera later is a cheap
      // replaceTrack. The direction MUST be sendrecv: if we ever negotiated a
      // track-less m-line as recvonly, a later replaceTrack would be silently
      // ignored by the browser and the picture would never reach the peer.
      const audio = pc.addTransceiver('audio', { direction: 'sendrecv' });
      const video = pc.addTransceiver('video', { direction: 'sendrecv' });
      transceiversRef.current.set(peerId, { audio, video });
      // Attach whatever we already have. replaceTrack resolves once the track is
      // actually plugged in, so renegotiation that follows sees a live sender.
      if (audioTrackRef.current) void audio.sender.replaceTrack(audioTrackRef.current).catch(() => undefined);
      if (videoTrackRef.current) void video.sender.replaceTrack(videoTrackRef.current).catch(() => undefined);
    }

    // Watchdog: a pair that has not connected after a few seconds gets an ICE
    // restart (fresh candidates) — up to three tries.
    let restarts = 0;
    const watchdog = window.setInterval(() => {
      const state = pc.connectionState;
      if (state === 'closed' || state === 'connected' || restarts >= 3) {
        window.clearInterval(watchdog);
        return;
      }
      if (pc.signalingState !== 'stable' || !pc.remoteDescription) return;
      restarts += 1;
      try { pc.restartIce(); } catch { /* older browsers: next join rebuilds */ }
    }, 6000);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'closed') window.clearInterval(watchdog);
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal(peerId, { type: 'candidate', candidate: event.candidate.toJSON() });
    };
    // A failed or dropped transport is recoverable: restart ICE rather than
    // leaving the peer stuck on a dead socket for the rest of the night.
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' && pc.signalingState === 'stable') {
        try { pc.restartIce(); } catch { /* older browsers: next join rebuilds */ }
      }
    };
    pc.ontrack = (event) => {
      const track = event.track;
      // Keep inbound audio and video in SEPARATE streams. A remote stream often
      // contains a silent video track; handing that to an <audio> element is
      // what made peers inaudible.
      //
      // Tracks can land before the roster record exists, so create it on demand
      // instead of dropping the media on the floor.
      setPeerMap((prev) => {
        const next = new Map(prev);
        const current = next.get(peerId)
          ?? { playerId: peerId, mic: true, cam: false, stream: null, videoStream: null, connection: 'connecting' as const, speaking: false };
        if (track.kind === 'video') {
          const videoStream = current.videoStream ?? new MediaStream();
          if (!videoStream.getTracks().includes(track)) videoStream.addTrack(track);
          next.set(peerId, { ...current, videoStream });
        } else {
          const stream = current.stream ?? new MediaStream();
          if (!stream.getTracks().includes(track)) stream.addTrack(track);
          next.set(peerId, { ...current, stream });
          ensureAudioGraph(peerId, stream);
        }
        return next;
      });
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
  }, [sendSignal, upsertPeer, ensureAudioGraph, myPlayerId]);

  /** Answering side: take over the transceivers the remote offer created and
   *  send our own tracks on them. */
  const adoptTransceivers = useCallback(async (peerId: string, pc: RTCPeerConnection): Promise<void> => {
    if (transceiversRef.current.has(peerId)) return;
    const all = pc.getTransceivers();
    const audio = all.find((t) => t.receiver.track.kind === 'audio');
    const video = all.find((t) => t.receiver.track.kind === 'video');
    if (!audio && !video) return;
    transceiversRef.current.set(peerId, { audio, video });
    for (const t of [audio, video]) if (t) t.direction = 'sendrecv';
    try {
      if (audio && audioTrackRef.current) await audio.sender.replaceTrack(audioTrackRef.current);
      if (video && videoTrackRef.current) await video.sender.replaceTrack(videoTrackRef.current);
    } catch {
      /* peer may be mid-teardown */
    }
  }, []);

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
    setLocalStream(null);
    audioTrackRef.current = null;
    videoTrackRef.current = null;
    speakingRef.current.clear();
    setSpeakingIds(new Set());
    joinedRef.current = false;
    setPeerMap(new Map());
    setJoined(false);
    setMicOn(false);
    setCamOn(false);
  }, []);

  // Speaking detection: RMS over each analyser, sampled every 120ms.
  useEffect(() => {
    if (!joined) return;
    const timer = window.setInterval(() => {
      const ctx = audioCtxRef.current;
      if (!ctx || analysersRef.current.size === 0) return;
      const data = new Float32Array(256);
      const now = performance.now();
      const nextSpeaking = new Set<string>();
      for (const [key, analyser] of analysersRef.current) {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
        if (Math.sqrt(sum / data.length) > SPEAK_THRESHOLD) lastLoudRef.current.set(key, now);
        if (now - (lastLoudRef.current.get(key) ?? -Infinity) < SPEAK_HOLD_MS) nextSpeaking.add(key);
      }
      const prev = speakingRef.current;
      const changed = [...nextSpeaking].some((k) => !prev.has(k)) || [...prev].some((k) => !nextSpeaking.has(k));
      if (!changed) return;
      speakingRef.current = nextSpeaking;
      setSpeakingIds(new Set(nextSpeaking));
      setPeerMap((current) => {
        const next = new Map(current);
        for (const [playerId, peer] of next) next.set(playerId, { ...peer, speaking: nextSpeaking.has(playerId) });
        return next;
      });
      void ctx;
    }, 120);
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
      // A peer who turned their camera off keeps a live (black) video track in
      // the transport. Drop it from our video stream so the UI falls back to
      // their avatar instead of showing a frozen frame.
      for (const [peerId, flags] of roster) {
        if (flags.cam) continue;
        setPeerMap((prev) => {
          const peer = prev.get(peerId);
          if (!peer?.videoStream || peer.videoStream.getVideoTracks().length === 0) return prev;
          const next = new Map(prev);
          next.set(peerId, { ...peer, videoStream: null });
          return next;
        });
      }
    };

    // Signals from one peer MUST be applied strictly in order. The handler
    // awaits browser calls, so letting messages run concurrently meant an
    // offer that arrived while the previous answer was still being applied
    // saw 'have-local-offer', was treated as a collision and dropped — the
    // other side then never sent its audio (one-way voice).
    const queues = new Map<string, Promise<void>>();
    // ICE candidates can be emitted (and so arrive) before the description
    // they belong to. Hold them until a remote description exists instead of
    // letting addIceCandidate fail and silently lose the only route.
    const pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
    const flushCandidates = async (peerId: string, pc: RTCPeerConnection): Promise<void> => {
      const held = pendingCandidates.get(peerId);
      if (!held || !pc.remoteDescription) return;
      pendingCandidates.delete(peerId);
      for (const candidate of held) {
        try { await pc.addIceCandidate(candidate); } catch { /* stale candidate from a rolled-back offer */ }
      }
    };
    const onSignal = (msg: { from: string; data: { type: string; sdp?: string; candidate?: RTCIceCandidateInit } }): void => {
      if (typeof msg?.from !== 'string') return;
      const prev = queues.get(msg.from) ?? Promise.resolve();
      const next = prev.then(() => handleSignal(msg)).catch(() => undefined);
      queues.set(msg.from, next);
    };

    const handleSignal = async ({ from, data }: { from: string; data: { type: string; sdp?: string; candidate?: RTCIceCandidateInit } }): Promise<void> => {
      if (!joinedRef.current || typeof from !== 'string' || from === myPlayerId || !data || typeof data.type !== 'string') return;
      const pc = createPeer(from);
      const polite = myPlayerId > from;
      try {
        const readyForOffer = !makingOfferRef.current.has(from) && pc.signalingState === 'stable';
        const offerCollision = data.type === 'offer' && !readyForOffer;
        if (data.type === 'offer' && data.sdp) {
          if (offerCollision && !polite) return; // impolite peer's offer wins
          await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp }); // implicit rollback when colliding
          await adoptTransceivers(from, pc);
          await flushCandidates(from, pc);
          await pc.setLocalDescription();
          if (pc.localDescription) sendSignal(from, { type: 'answer', sdp: pc.localDescription.sdp });
        } else if (data.type === 'answer' && data.sdp) {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
            await flushCandidates(from, pc);
          }
        } else if (data.type === 'candidate' && data.candidate) {
          if (!pc.remoteDescription) {
            pendingCandidates.set(from, [...(pendingCandidates.get(from) ?? []), data.candidate]);
            return;
          }
          try {
            await pc.addIceCandidate(data.candidate);
          } catch {
            /* a candidate for an offer we ignored in a collision */
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
  }, [socket, myPlayerId, createPeer, closePeer, upsertPeer, sendSignal, teardown, adoptTransceivers]);

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
      const res = await fetch('/api/ice', { cache: 'no-store' });
      if (res.ok) {
        const body = (await res.json()) as { iceServers?: RTCIceServer[] };
        if (Array.isArray(body.iceServers) && body.iceServers.length > 0) {
          iceServersRef.current = [...body.iceServers, ...buildIceServers.filter((b) => !body.iceServers!.some((s) => JSON.stringify(s.urls) === JSON.stringify(b.urls)))];
        }
      }
    } catch {
      /* offline or older server: keep the built-in list */
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: opts.cam ? VIDEO_CONSTRAINTS : false,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
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
      return true;    } catch (err) {
      setError(
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone/camera permission was denied.'
          : 'Could not start voice — check your devices.',
      );
      teardown();
      return false;
    }
  }, [socket, myPlayerId, supported, ensureAudioGraph, teardown, buildIceServers]);

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
          localStreamRef.current?.addTrack(track);
          // Plug the track into every peer's video sender and WAIT for it: a
          // fire-and-forget replaceTrack lets the following negotiation race
          // ahead of the sender and the peer never learns video is available.
          await Promise.all([...transceiversRef.current.values()].map(async (transceivers) => {
            const sender = transceivers.video?.sender;
            if (!sender) return;
            try { await sender.replaceTrack(track); } catch { /* peer may be mid-teardown */ }
          }));
          // Self-view: publish the new track with the existing audio.
          setLocalStream((cur) => {
            const next = new MediaStream(cur ? cur.getAudioTracks() : []);
            next.addTrack(track);
            return next;
          });
          // Nudge any peer that connected before the camera existed.
          for (const pc of pcsRef.current.values()) renegotiate(pc);
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
  }, [socket, micOn, renegotiate]);

  return {
    supported,
    joined,
    micOn,
    camOn,
    error,
    localStream,
    speaking: speakingIds,
    peers: useMemo(() => [...peerMap.values()], [peerMap]),
    join,
    leave,
    setMic,
    setCam,
  };
}
