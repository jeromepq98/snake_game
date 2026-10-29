'use strict';

/* Voice chat manager. Audio flows peer-to-peer over WebRTC; the server only
   relays signaling via Socket.IO (voice:signal / voice:peers / voice:proximity).
   Mesh topology: every member connects to every other member, so rooms are
   capped server-side (VOICE_CAP). */

(function () {
  function cmpVoiceId(a, b) {
    const na = /^p(\d+)$/.exec(a);
    const nb = /^p(\d+)$/.exec(b);
    if (na && nb) return Number(na[1]) - Number(nb[1]);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  class VoiceManager {
    constructor(net) {
      this.net = net;
      this.active = false;
      this.myId = null;
      this.pendingPeers = null;
      this.peers = new Map();   // voiceId -> { pc, audio, nickname, audible }
      this.stream = null;
      this.prefs = { enabled: true, pushToTalk: false, proximity: false, outputVolume: 80 };
      this.muted = false;
      this.pttHeld = false;
      this.onPeersChanged = null;
      this.onError = null;

      net.on('voice:peers', (data) => {
        if (!this.active) return;
        this.myId = data.you || this.myId;
        this.pendingPeers = data.peers || [];
        this.syncPeers();
      });
      net.on('voice:signal', (data) => this.onSignal(data));
      net.on('voice:proximity', (data) => this.onProximity(data));
      net.on('game:closed', () => this.stop());
    }

    updatePrefs(prefs) {
      Object.assign(this.prefs, prefs || {});
      this.applyAudioSettings();
      this.applyMicState();
    }

    async start() {
      if (this.active) return { ok: true };
      if (!(this.prefs.enabled)) return { ok: false, error: 'disabled' };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
      } catch (e) {
        return { ok: false, error: 'mic_denied', message: 'Microphone access was denied. Allow it in your browser to use voice chat.' };
      }
      this.stream = stream;
      const res = await this.net.request('voice:start', {});
      if (!res.ok) {
        stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        return res;
      }
      this.active = true;
      this.myId = res.id;
      this.muted = false;
      this.applyMicState();
      if (this.pendingPeers) this.syncPeers();
      return { ok: true };
    }

    stop() {
      if (!this.active && !this.stream) return;
      this.active = false;
      this.myId = null;
      this.pendingPeers = null;
      for (const { pc, audio } of this.peers.values()) {
        try { pc.close(); } catch (e) { /* already closed */ }
        if (audio) audio.remove();
      }
      this.peers.clear();
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
      this.net.emit('voice:stop', {});
      if (this.onPeersChanged) this.onPeersChanged();
    }

    setMuted(muted) {
      this.muted = !!muted;
      this.applyMicState();
    }

    setPttHeld(held) {
      this.pttHeld = !!held;
      this.applyMicState();
    }

    async setProximity(on) {
      this.prefs.proximity = !!on;
      this.net.emit('voice:mode', { proximity: this.prefs.proximity });
      this.applyAudioSettings();
    }

    applyMicState() {
      if (!this.stream) return;
      const live = this.prefs.pushToTalk ? this.pttHeld && !this.muted : !this.muted;
      for (const track of this.stream.getAudioTracks()) track.enabled = live;
    }

    applyAudioSettings() {
      for (const p of this.peers.values()) {
        if (p.audio) {
          p.audio.volume = this.prefs.outputVolume / 100;
          p.audio.muted = this.prefs.proximity && p.audible === false;
        }
      }
    }

    /* ---------- mesh maintenance ---------- */

    syncPeers() {
      if (!this.myId || !this.pendingPeers) return;
      const wanted = new Map(this.pendingPeers.map((p) => [p.id, p]));
      for (const id of [...this.peers.keys()]) {
        if (!wanted.has(id)) {
          const p = this.peers.get(id);
          try { p.pc.close(); } catch (e) { /* noop */ }
          if (p.audio) p.audio.remove();
          this.peers.delete(id);
        }
      }
      for (const [id, info] of wanted) {
        if (this.peers.has(id)) {
          this.peers.get(id).nickname = info.nickname;
          continue;
        }
        // Deterministic offerer avoids offer glare without extra round-trips.
        if (cmpVoiceId(this.myId, id) < 0) {
          const p = this.createPeer(id, info.nickname);
          this.makeOffer(id, p);
        } else {
          this.createPeer(id, info.nickname); // waits for their offer
        }
      }
      if (this.onPeersChanged) this.onPeersChanged();
    }

    createPeer(id, nickname) {
      const cfg = {
        iceServers: (SA.CONFIG && SA.CONFIG.iceServers) || [
          { urls: 'stun:stun.l.google.com:19302' },
        ],
      };
      const pc = new RTCPeerConnection(cfg);
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.style.display = 'none';
      document.body.appendChild(audio);
      const p = { pc, audio, nickname: nickname || id, audible: true };
      this.peers.set(id, p);
      if (this.stream) for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);
      pc.onicecandidate = (e) => {
        if (e.candidate) this.net.emit('voice:signal', { to: id, kind: 'ice', data: e.candidate.toJSON() });
      };
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0];
        this.applyAudioSettings();
      };
      pc.onconnectionstatechange = () => {
        if (['failed', 'closed'].includes(pc.connectionState)) {
          // ICE will be retried by a fresh offer on the next voice:peers sync.
        }
      };
      this.applyAudioSettings();
      return p;
    }

    async makeOffer(id, p) {
      try {
        const offer = await p.pc.createOffer();
        await p.pc.setLocalDescription(offer);
        this.net.emit('voice:signal', { to: id, kind: 'offer', data: { type: offer.type, sdp: offer.sdp } });
      } catch (e) {
        if (this.onError) this.onError('Could not start a voice connection.');
      }
    }

    async onSignal({ from, kind, data }) {
      if (!this.active || !from) return;
      let p = this.peers.get(from);
      if (!p) {
        if (kind !== 'offer') return;
        p = this.createPeer(from, from);
      }
      try {
        if (kind === 'offer') {
          await p.pc.setRemoteDescription(new RTCSessionDescription(data));
          const answer = await p.pc.createAnswer();
          await p.pc.setLocalDescription(answer);
          this.net.emit('voice:signal', { to: from, kind: 'answer', data: { type: answer.type, sdp: answer.sdp } });
        } else if (kind === 'answer') {
          if (p.pc.signalingState === 'have-local-offer') {
            await p.pc.setRemoteDescription(new RTCSessionDescription(data));
          }
        } else if (kind === 'ice') {
          await p.pc.addIceCandidate(new RTCIceCandidate(data)).catch(() => {});
        }
      } catch (e) {
        /* malformed or late signaling is dropped; peers re-sync via voice:peers */
      }
    }

    onProximity({ ids }) {
      const audible = new Set(ids || []);
      for (const [id, p] of this.peers) {
        p.audible = audible.has(id);
      }
      this.applyAudioSettings();
    }

    peerList() {
      return [...this.peers.entries()].map(([id, p]) => ({ id, nickname: p.nickname, audible: p.audible }));
    }
  }

  SA.VoiceManager = VoiceManager;
})();
