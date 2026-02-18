import { Messenger, PeerIdentity } from "./messenger.ts";

const elements = {
  roomIdInput: document.getElementById("room-id") as HTMLInputElement,
  displayNameInput: document.getElementById("display-name") as HTMLInputElement,
  joinBtn: document.getElementById("join-btn") as HTMLButtonElement,
  messages: document.getElementById("messages") as HTMLDivElement,
  peersList: document.getElementById("peers-list") as HTMLDivElement,
  statusDot: document.getElementById("status-dot") as HTMLSpanElement,
  statusText: document.getElementById("status-text") as HTMLSpanElement,
  messageInput: document.getElementById("message-input") as HTMLInputElement,
  sendBtn: document.getElementById("send-btn") as HTMLButtonElement,
  joinSection: document.getElementById("join-section") as HTMLDivElement,
  chatSection: document.getElementById("chat-section") as HTMLDivElement,
  roomInfo: document.getElementById("room-info") as HTMLSpanElement,
  // updateNameBtn: document.getElementById(
  //   "update-name-btn",
  // ) as HTMLButtonElement,
  // newNameInput: document.getElementById("new-name-input") as HTMLInputElement,
};

let messenger: Messenger | null = null;

function addMessage(
  content: string,
  type: "system" | "sent" | "received" = "system",
  sender: PeerIdentity | null = null,
): void {
  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${type}`;

  if (sender && type === "received") {
    const senderDiv = document.createElement("div");
    senderDiv.className = "message-sender";
    senderDiv.textContent = sender.displayName || sender.id.substring(0, 8);
    messageDiv.appendChild(senderDiv);
  }

  const contentDiv = document.createElement("div");
  contentDiv.className = "message-content";
  contentDiv.textContent = content;
  messageDiv.appendChild(contentDiv);

  elements.messages.appendChild(messageDiv);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function updatePeersList(): void {
  if (!messenger) return;

  const peers = messenger.getConnectedPeers();
  elements.peersList.innerHTML = "";

  if (peers.length === 0) {
    elements.peersList.innerHTML =
      '<span style="color: #9ca3af;">No peers connected</span>';
  } else {
    peers.forEach((peer) => {
      const badge = document.createElement("span");
      badge.className = "peer-badge";
      badge.textContent = peer.displayName || peer.id.substring(0, 8);
      elements.peersList.appendChild(badge);
    });
  }
}

function updateConnectionStatus(state: string): void {
  if (state === "connected") {
    elements.statusDot.classList.add("connected");
    elements.statusText.textContent = "Connected";
  } else {
    elements.statusDot.classList.remove("connected");
    elements.statusText.textContent = "Disconnected";
  }
}

async function joinRoom(): Promise<void> {
  const roomId = elements.roomIdInput.value.trim();
  const displayName = elements.displayNameInput.value.trim() || "Anonymous";

  if (!roomId) {
    alert("Please enter a room ID");
    return;
  }

  elements.joinBtn.disabled = true;
  elements.joinBtn.textContent = "Connecting...";

  try {
    const wsProtocol = globalThis.location.protocol === "https:"
      ? "wss:"
      : "ws:";
    const wsUrl = `${wsProtocol}//${globalThis.location.host}`;

    messenger = new Messenger(wsUrl, displayName);

    messenger.on("connection-state", ({ state }) => {
      updateConnectionStatus(state);
    });

    messenger.on("message", (msg) => {
      addMessage(msg.text, "received", msg.sender);
    });

    messenger.on("peer-joined", (peer) => {
      addMessage(
        `${peer.displayName || peer.id.substring(0, 8)} joined`,
        "system",
      );
      updatePeersList();
    });

    messenger.on("peer-left", (peer) => {
      addMessage(
        `${peer.displayName || peer.id.substring(0, 8)} left`,
        "system",
      );
      updatePeersList();
    });

    messenger.on("peer-updated", (peer) => {
      addMessage(`A peer updated their name to ${peer.displayName}`, "system");
      updatePeersList();
    });

    await messenger.connect();
    await messenger.joinRoom(roomId);

    elements.joinSection.classList.add("hidden");
    elements.chatSection.classList.add("active");
    elements.roomInfo.textContent = `Room: ${roomId}`;

    addMessage(`Joined room: ${roomId}`, "system");
  } catch (error) {
    console.error("Failed to connect:", error);
    alert("Failed to connect to signaling server");
    elements.joinBtn.disabled = false;
    elements.joinBtn.textContent = "Join Room";
  }
}

async function sendMessage(): Promise<void> {
  if (!messenger) return;

  const text = elements.messageInput.value.trim();
  if (!text) return;

  if (messenger.getConnectedPeers().length === 0) {
    addMessage("No peers connected to send message to", "system");
    return;
  }

  await messenger.sendChat(text);
  addMessage(text, "sent");
  elements.messageInput.value = "";
}

// async function updateName(): Promise<void> {
//   if (!messenger) return;

//   const newName = elements.newNameInput.value.trim();
//   if (!newName) return;

//   await messenger.updateDisplayName(newName);
//   addMessage(`You updated your name to "${newName}"`, "system");
//   elements.newNameInput.value = "";
// }

elements.joinBtn.addEventListener("click", joinRoom);

elements.sendBtn.addEventListener("click", sendMessage);

elements.messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// elements.updateNameBtn.addEventListener("click", updateName);

// elements.newNameInput.addEventListener("keydown", (e) => {
//   if (e.key === "Enter") {
//     e.preventDefault();
//     updateName();
//   }
// });
