/** 长会话快照可以超过 64 MiB；只分配一份有界帧缓冲，按块复制，避免反复拼接整个快照。 */
export const MAX_IPC_FRAME_BYTES = 128 * 1024 * 1024;

export class IpcFramer {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private length = 0;
  private received = 0;
  private body: Buffer | null = null;
  private generation = 0;

  constructor(
    private readonly onFrame: (body: Buffer) => void,
    private readonly onOversizedFrame: (bytes: number) => void,
    private readonly maxFrameBytes = MAX_IPC_FRAME_BYTES,
  ) {}

  reset(): void {
    this.generation++;
    this.clearFrame();
  }

  private clearFrame(): void {
    this.headerBytes = 0;
    this.length = 0;
    this.received = 0;
    this.body = null;
  }

  push(chunk: Buffer): void {
    const generation = this.generation;
    let offset = 0;
    while (offset < chunk.length && generation === this.generation) {
      if (this.headerBytes < 4) {
        const bytes = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + bytes);
        this.headerBytes += bytes;
        offset += bytes;
        if (this.headerBytes < 4) return;
        this.length = this.header.readUInt32LE(0);
        if (this.length > this.maxFrameBytes) {
          // 只跳过这一帧；它的剩余正文不能当作下一帧头，也不能让其他会话一起掉线。
          this.onOversizedFrame(this.length);
        } else {
          this.body = Buffer.allocUnsafe(this.length);
        }
      }
      const bytes = Math.min(this.length - this.received, chunk.length - offset);
      if (this.body) chunk.copy(this.body, this.received, offset, offset + bytes);
      this.received += bytes;
      offset += bytes;
      if (this.received !== this.length) continue;
      const body = this.body;
      this.clearFrame();
      if (body) this.onFrame(body);
    }
  }
}
