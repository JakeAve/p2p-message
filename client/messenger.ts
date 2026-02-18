import { WebRTCClient } from "./webrtc-client.ts";
import { EncryptionService } from "./encryption-service.ts";

type WireMessage =
  | { type: "handshake"; publicKey: JsonWebKey; identity: PeerIdentity }
  | { type: "chat"; content: string }
  | { type: "identity-update"; identity: PeerIdentity };

export interface PeerIdentity {
  id: string;
  displayName: string;
}

export interface ChatMessage {
  sender: PeerIdentity;
  text: string;
  timestamp: number;
}

type MessengerEventMap = {
  message: ChatMessage;
  "peer-joined": PeerIdentity;
  "peer-left": PeerIdentity;
  "peer-updated": PeerIdentity;
  "connection-state": { state: string };
};

type MessengerEventListener<K extends keyof MessengerEventMap> = (
  payload: MessengerEventMap[K],
) => void;

export class Messenger extends EventTarget {
  private transport: WebRTCClient;
  private encryption: EncryptionService;

  private peers = new Map<string, PeerIdentity>();

  private messageQueue = new Map<string, WireMessage[]>();

  private myIdentity: PeerIdentity;

  constructor(signalingServerUrl: string, displayName: string) {
    super();
    this.transport = new WebRTCClient(signalingServerUrl);
    this.encryption = new EncryptionService();

    this.myIdentity = { id: "", displayName };

    this.bindTransportEvents();
  }

  async connect(): Promise<void> {
    await this.encryption.initialize();
    await this.transport.connect();
  }

  joinRoom(roomId: string): Promise<void> {
    return this.transport.joinRoom(roomId);
  }

  disconnect(): void {
    this.transport.disconnect();
  }

  async sendChat(text: string): Promise<void> {
    const peers = this.transport.getConnectedPeers();

    for (const peerId of peers) {
      if (!this.encryption.hasSharedKey(peerId)) {
        console.warn(`Skipping ${peerId}: handshake not complete`);
        continue;
      }

      const wire: WireMessage = { type: "chat", content: text };
      const encrypted = await this.encryption.encrypt(
        peerId,
        JSON.stringify(wire),
      );
      this.transport.send(peerId, JSON.stringify({ encrypted }));
    }
  }

  async updateDisplayName(displayName: string): Promise<void> {
    this.myIdentity = { ...this.myIdentity, displayName };

    const peers = this.transport.getConnectedPeers();
    for (const peerId of peers) {
      if (!this.encryption.hasSharedKey(peerId)) continue;

      const wire: WireMessage = {
        type: "identity-update",
        identity: this.myIdentity,
      };
      const encrypted = await this.encryption.encrypt(
        peerId,
        JSON.stringify(wire),
      );
      this.transport.send(peerId, JSON.stringify({ encrypted }));
    }
  }

  getConnectedPeers(): PeerIdentity[] {
    return this.transport
      .getConnectedPeers()
      .map((peerId) => this.peers.get(peerId))
      .filter((p): p is PeerIdentity => p !== undefined);
  }

  on<K extends keyof MessengerEventMap>(
    event: K,
    listener: MessengerEventListener<K>,
  ): void {
    this.addEventListener(
      event,
      (e) => listener((e as CustomEvent<MessengerEventMap[K]>).detail),
    );
  }

  private emit<K extends keyof MessengerEventMap>(
    event: K,
    detail: MessengerEventMap[K],
  ): void {
    this.dispatchEvent(new CustomEvent(event, { detail }));
  }

  private bindTransportEvents(): void {
    this.transport.on("connection-state", ({ state }) => {
      this.emit("connection-state", { state });
    });

    this.transport.on("peer-connected", ({ peerId }) => {
      this.sendHandshake(peerId);
    });

    this.transport.on("peer-disconnected", ({ peerId }) => {
      const identity = this.peers.get(peerId) ?? {
        id: peerId,
        displayName: peerId,
      };
      this.peers.delete(peerId);
      this.messageQueue.delete(peerId);
      this.encryption.removeSharedKey(peerId);
      this.emit("peer-left", identity);
    });

    this.transport.on("message", async ({ peerId, data }) => {
      await this.handleIncoming(peerId, data);
    });
  }

  private sendHandshake(peerId: string): void {
    const handshake: WireMessage = {
      type: "handshake",
      publicKey: this.encryption.getPublicKey(),
      identity: this.myIdentity,
    };
    this.transport.send(peerId, JSON.stringify({ handshake }));
  }

  private async handleIncoming(peerId: string, raw: string): Promise<void> {
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(raw);
    } catch {
      console.error("Malformed message from", peerId);
      return;
    }

    if (envelope.handshake) {
      await this.handleHandshake(
        peerId,
        envelope.handshake as WireMessage & { type: "handshake" },
      );
      return;
    }

    if (envelope.encrypted) {
      if (!this.encryption.hasSharedKey(peerId)) {
        this.enqueue(peerId, envelope);
        return;
      }

      const decrypted = await this.encryption.decrypt(
        peerId,
        envelope.encrypted as string,
      );

      let wire: WireMessage;
      try {
        wire = JSON.parse(decrypted);
      } catch {
        console.error("Failed to parse decrypted message from", peerId);
        return;
      }

      await this.handleWireMessage(peerId, wire);
    }
  }

  private async handleHandshake(
    peerId: string,
    msg: WireMessage & { type: "handshake" },
  ): Promise<void> {
    await this.encryption.deriveSharedKey(peerId, msg.publicKey);

    const identity: PeerIdentity = { ...msg.identity, id: peerId };
    this.peers.set(peerId, identity);
    this.emit("peer-joined", identity);

    await this.flushQueue(peerId);
  }

  private handleWireMessage(peerId: string, wire: WireMessage): void {
    switch (wire.type) {
      case "chat": {
        const sender = this.peers.get(peerId) ?? {
          id: peerId,
          displayName: peerId,
        };
        this.emit("message", {
          sender,
          text: wire.content,
          timestamp: Date.now(),
        });
        break;
      }

      case "identity-update": {
        const updated: PeerIdentity = { ...wire.identity, id: peerId };
        this.peers.set(peerId, updated);
        this.emit("peer-updated", updated);
        break;
      }

      default:
        console.warn("Unknown wire message type:", (wire as WireMessage).type);
    }
  }

  private enqueue(peerId: string, envelope: Record<string, unknown>): void {
    if (!this.messageQueue.has(peerId)) {
      this.messageQueue.set(peerId, []);
    }
    this.messageQueue.get(peerId)!.push(envelope as unknown as WireMessage);
  }

  private async flushQueue(peerId: string): Promise<void> {
    const queue = this.messageQueue.get(peerId) ?? [];
    this.messageQueue.delete(peerId);

    for (const envelope of queue) {
      const raw = JSON.stringify(envelope);
      await this.handleIncoming(peerId, raw);
    }
  }
}
