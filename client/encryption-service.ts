import { E2EEncryption } from "./encryption.ts";

export class EncryptionService {
  private encryption: E2EEncryption;

  constructor() {
    this.encryption = new E2EEncryption();
  }

  async initialize(): Promise<void> {
    await this.encryption.createNewKey();
  }

  getPublicKey(): JsonWebKey {
    return this.encryption.getPublicKey();
  }

  async deriveSharedKey(
    peerId: string,
    theirPublicKey: JsonWebKey,
  ): Promise<void> {
    await this.encryption.deriveSharedKey(peerId, theirPublicKey);
  }

  hasSharedKey(peerId: string): boolean {
    return this.encryption.hasSharedKey(peerId);
  }

  encrypt(peerId: string, plaintext: string): Promise<string> {
    return this.encryption.encrypt(peerId, plaintext);
  }

  decrypt(peerId: string, ciphertext: string): Promise<string> {
    return this.encryption.decrypt(peerId, ciphertext);
  }

  removeSharedKey(peerId: string): void {
    this.encryption.removeSharedKey(peerId);
  }
}
