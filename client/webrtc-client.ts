interface SignalMessage {
  type: string;
  id?: string;
  from?: string;
  peers?: string[];
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

type TransportEventMap = {
  message: { peerId: string; data: string };
  "peer-connected": { peerId: string };
  "peer-disconnected": { peerId: string };
  "connection-state": { state: "connected" | "disconnected" | "error" };
};

type TransportEventListener<K extends keyof TransportEventMap> = (
  payload: TransportEventMap[K],
) => void;

export class WebRTCClient extends EventTarget {
  private signalingSocket: WebSocket | null = null;
  private peerConnections = new Map<string, RTCPeerConnection>();
  private dataChannels = new Map<string, RTCDataChannel>();
  private clientId: string | null = null;
  private resolveJoin: (() => void) | null = null;

  constructor(private signalingServerUrl: string) {
    super();
  }

  // Typed event emitter helpers so callers don't have to cast

  on<K extends keyof TransportEventMap>(
    event: K,
    listener: TransportEventListener<K>,
  ): void {
    this.addEventListener(
      event,
      (e) => listener((e as CustomEvent<TransportEventMap[K]>).detail),
    );
  }

  private emit<K extends keyof TransportEventMap>(
    event: K,
    detail: TransportEventMap[K],
  ): void {
    this.dispatchEvent(new CustomEvent(event, { detail }));
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.signalingSocket = new WebSocket(this.signalingServerUrl);

      this.signalingSocket.onopen = () => {
        this.emit("connection-state", { state: "connected" });
        resolve();
      };

      this.signalingSocket.onerror = (error) => {
        console.error("Signaling error:", error);
        this.emit("connection-state", { state: "error" });
        reject(error);
      };

      this.signalingSocket.onclose = () => {
        this.emit("connection-state", { state: "disconnected" });
      };

      this.signalingSocket.onmessage = async (event) => {
        const message: SignalMessage = JSON.parse(event.data);
        await this.handleSignalingMessage(message);
      };
    });
  }

  joinRoom(roomId: string): Promise<void> {
    return new Promise((resolve, _reject) => {
      this.resolveJoin = resolve;
      this.signalingSocket?.send(JSON.stringify({ type: "join", roomId }));
    });
  }

  disconnect(): void {
    for (const peerId of [...this.peerConnections.keys()]) {
      this.closePeerConnection(peerId);
    }
    this.signalingSocket?.close();
  }

  send(peerId: string, data: string): void {
    const channel = this.dataChannels.get(peerId);
    if (channel?.readyState === "open") {
      channel.send(data);
    } else {
      console.error(`Cannot send to ${peerId}: channel not open`);
    }
  }

  broadcast(data: string): void {
    for (const [_peerId, channel] of this.dataChannels) {
      if (channel.readyState === "open") {
        channel.send(data);
      }
    }
  }

  getConnectedPeers(): string[] {
    return Array.from(this.dataChannels.keys()).filter(
      (peerId) => this.dataChannels.get(peerId)?.readyState === "open",
    );
  }

  private async handleSignalingMessage(message: SignalMessage): Promise<void> {
    switch (message.type) {
      case "connected":
        this.clientId = message.id!;
        break;

      case "peer-list":
        for (const peerId of message.peers ?? []) {
          await this.createOffer(peerId);
        }
        this.resolveJoin?.();
        break;

      case "offer":
        if (message.from && message.offer) {
          await this.handleOffer(message.from, message.offer);
        }
        break;

      case "answer":
        if (message.from && message.answer) {
          await this.handleAnswer(message.from, message.answer);
        }
        break;

      case "ice-candidate":
        if (message.from && message.candidate) {
          await this.handleIceCandidate(message.from, message.candidate);
        }
        break;

      case "peer-left":
        if (message.from) {
          this.closePeerConnection(message.from);
        }
        break;
    }
  }

  private createPeerConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingSocket?.send(
          JSON.stringify({
            type: "ice-candidate",
            target: peerId,
            candidate: event.candidate.toJSON(),
          }),
        );
      }
    };

    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === "disconnected" ||
        pc.connectionState === "failed"
      ) {
        this.closePeerConnection(peerId);
      }
    };

    pc.ondatachannel = (event) => {
      this.setupDataChannel(peerId, event.channel);
    };

    this.peerConnections.set(peerId, pc);
    return pc;
  }

  private setupDataChannel(peerId: string, channel: RTCDataChannel): void {
    this.dataChannels.set(peerId, channel);

    channel.onopen = () => {
      this.emit("peer-connected", { peerId });
    };

    channel.onmessage = (event) => {
      this.emit("message", { peerId, data: event.data });
    };

    channel.onclose = () => {
      this.dataChannels.delete(peerId);
    };

    channel.onerror = (error) => {
      console.error(`Data channel error with ${peerId}:`, error);
    };
  }

  private async createOffer(peerId: string): Promise<void> {
    const pc = this.createPeerConnection(peerId);
    const channel = pc.createDataChannel("messaging", { ordered: true });
    this.setupDataChannel(peerId, channel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.signalingSocket?.send(
      JSON.stringify({
        type: "offer",
        target: peerId,
        offer: pc.localDescription,
      }),
    );
  }

  private async handleOffer(
    peerId: string,
    offer: RTCSessionDescriptionInit,
  ): Promise<void> {
    const pc = this.createPeerConnection(peerId);
    await pc.setRemoteDescription(offer);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.signalingSocket?.send(
      JSON.stringify({
        type: "answer",
        target: peerId,
        answer: pc.localDescription,
      }),
    );
  }

  private async handleAnswer(
    peerId: string,
    answer: RTCSessionDescriptionInit,
  ): Promise<void> {
    const pc = this.peerConnections.get(peerId);
    if (pc) await pc.setRemoteDescription(answer);
  }

  private async handleIceCandidate(
    peerId: string,
    candidate: RTCIceCandidateInit,
  ): Promise<void> {
    const pc = this.peerConnections.get(peerId);
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  private closePeerConnection(peerId: string): void {
    this.peerConnections.get(peerId)?.close();
    this.peerConnections.delete(peerId);

    this.dataChannels.get(peerId)?.close();
    this.dataChannels.delete(peerId);

    this.emit("peer-disconnected", { peerId });
  }
}
