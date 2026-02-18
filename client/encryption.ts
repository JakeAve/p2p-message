interface EncryptedMessage {
  iv: string; // base64 encoded
  cipherText: string; // base64 encoded
}

export class E2EEncryption {
  private keyPair: CryptoKeyPair | null = null;
  private sharedKeys = new Map<string, CryptoKey>();
  private publicKey: JsonWebKey | null = null;

  async createNewKey(): Promise<void> {
    this.keyPair = await crypto.subtle.generateKey(
      {
        name: "ECDH",
        namedCurve: "P-256",
      },
      true,
      ["deriveKey"],
    );

    this.publicKey = await crypto.subtle.exportKey(
      "jwk",
      this.keyPair.publicKey,
    );
  }

  getPublicKey(): JsonWebKey {
    if (!this.publicKey) {
      throw new Error("Encryption not initialized");
    }
    return this.publicKey;
  }

  async deriveSharedKey(
    peerId: string,
    theirPublicKeyJwk: JsonWebKey,
  ): Promise<void> {
    if (!this.keyPair) {
      throw new Error("Encryption not initialized");
    }

    const theirPublicKey = await crypto.subtle.importKey(
      "jwk",
      theirPublicKeyJwk,
      {
        name: "ECDH",
        namedCurve: "P-256",
      },
      true,
      [],
    );

    const sharedKey = await crypto.subtle.deriveKey(
      {
        name: "ECDH",
        public: theirPublicKey,
      },
      this.keyPair.privateKey,
      {
        name: "AES-GCM",
        length: 256,
      },
      false,
      ["encrypt", "decrypt"],
    );

    this.sharedKeys.set(peerId, sharedKey);
  }

  async encrypt(peerId: string, message: string): Promise<string> {
    const sharedKey = this.sharedKeys.get(peerId);
    if (!sharedKey) {
      throw new Error(`No shared key for peer ${peerId}`);
    }

    const paddedMessage = this.padMessage(
      message,
      [256, 512, 1024, 2048, 4096],
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));

    const encodedMessage = new TextEncoder().encode(paddedMessage);
    const cipherText = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
      },
      sharedKey,
      encodedMessage,
    );

    const encrypted: EncryptedMessage = {
      iv: this.arrayBufferToBase64(iv.buffer),
      cipherText: this.arrayBufferToBase64(cipherText),
    };

    return JSON.stringify(encrypted);
  }

  async decrypt(peerId: string, encryptedData: string): Promise<string> {
    const sharedKey = this.sharedKeys.get(peerId);
    if (!sharedKey) {
      throw new Error(`No shared key for peer ${peerId}`);
    }

    const encrypted: EncryptedMessage = JSON.parse(encryptedData);

    const iv = this.base64ToArrayBuffer(encrypted.iv);
    const cipherText = this.base64ToArrayBuffer(encrypted.cipherText);

    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
      },
      sharedKey,
      cipherText,
    );

    const decryptedText = new TextDecoder().decode(decrypted);

    return this.unpadMessage(decryptedText);
  }

  hasSharedKey(peerId: string): boolean {
    return this.sharedKeys.has(peerId);
  }

  removeSharedKey(peerId: string): void {
    this.sharedKeys.delete(peerId);
  }

  private padMessage(message: string, buckets: number[]): string {
    const messageBytes = new TextEncoder().encode(message);
    const length = messageBytes.length;

    const targetSize = buckets.find((size) => size >= length) ||
      buckets[buckets.length - 1];

    const finalSize = length > buckets[buckets.length - 1]
      ? Math.ceil(length / buckets[buckets.length - 1]) *
        buckets[buckets.length - 1]
      : targetSize;

    const delimiter = "\x00";
    const paddingLength = finalSize - length - 1;
    const padding = "\x01".repeat(Math.max(0, paddingLength));

    return message + delimiter + padding;
  }

  private unpadMessage(paddedMessage: string): string {
    const delimiterIndex = paddedMessage.indexOf("\x00");
    return delimiterIndex >= 0
      ? paddedMessage.substring(0, delimiterIndex)
      : paddedMessage;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
