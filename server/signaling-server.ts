interface Client {
  id: string;
  socket: WebSocket;
  roomId?: string;
}

interface SignalMessage {
  type:
    | "join"
    | "offer"
    | "answer"
    | "ice-candidate"
    | "peer-list"
    | "peer-joined"
    | "peer-left";
  roomId?: string;
  target?: string;
  from?: string;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  peers?: string[];
}

const clients = new Map<string, Client>();
const rooms = new Map<string, Set<string>>();

function generateId(): string {
  return crypto.randomUUID();
}

function broadcast(roomId: string, message: SignalMessage, excludeId?: string) {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const clientId of room) {
    if (clientId === excludeId) continue;
    const client = clients.get(clientId);
    if (client?.socket.readyState === WebSocket.OPEN) {
      client.socket.send(JSON.stringify(message));
    }
  }
}

function sendTo(clientId: string, message: SignalMessage) {
  const client = clients.get(clientId);
  if (client?.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify(message));
  }
}

export function handleConnection(socket: WebSocket) {
  const clientId = generateId();
  const client: Client = { id: clientId, socket };
  clients.set(clientId, client);

  console.log(`Client connected: ${clientId}`);

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: "connected", id: clientId }));
  };

  socket.onmessage = (event) => {
    try {
      const message: SignalMessage = JSON.parse(event.data);

      switch (message.type) {
        case "join": {
          if (!message.roomId) break;

          client.roomId = message.roomId;
          if (!rooms.has(message.roomId)) {
            rooms.set(message.roomId, new Set());
          }
          rooms.get(message.roomId)!.add(clientId);

          const existingPeers = Array.from(rooms.get(message.roomId)!).filter(
            (id) => id !== clientId,
          );

          sendTo(clientId, {
            type: "peer-list",
            peers: existingPeers,
          });

          broadcast(
            message.roomId,
            {
              type: "peer-joined",
              from: clientId,
            },
            clientId,
          );

          console.log(`Client ${clientId} joined room ${message.roomId}`);
          break;
        }
        case "offer":
          if (!message.target) break;
          sendTo(message.target, {
            type: "offer",
            from: clientId,
            offer: message.offer,
          });
          break;

        case "answer":
          if (!message.target) break;
          sendTo(message.target, {
            type: "answer",
            from: clientId,
            answer: message.answer,
          });
          break;

        case "ice-candidate":
          if (!message.target) break;
          sendTo(message.target, {
            type: "ice-candidate",
            from: clientId,
            candidate: message.candidate,
          });
          break;
      }
    } catch (error) {
      console.error("Error handling message:", error);
    }
  };

  socket.onclose = () => {
    console.log(`Client disconnected: ${clientId}`);

    if (client.roomId) {
      const room = rooms.get(client.roomId);
      if (room) {
        room.delete(clientId);

        broadcast(client.roomId, {
          type: "peer-left",
          from: clientId,
        });

        if (room.size === 0) {
          rooms.delete(client.roomId);
        }
      }
    }

    clients.delete(clientId);
  };

  socket.onerror = (error) => {
    console.error(`WebSocket error for ${clientId}:`, error);
  };
}
