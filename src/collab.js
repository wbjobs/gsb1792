/**
 * 基于 BroadcastChannel 的传输层 + 因果顺序保证。
 * 每条消息携带 { site, seq, clock }：
 *  - seq 为发送方单调递增序号，接收方按站点做 FIFO 缓冲（hold-back queue），
 *    保证同一站点的操作按发出顺序应用；
 *  - clock 为发送方已见的向量时钟，用于识别并发操作（OT 变换对象）。
 */
export class CollabTransport {
  constructor(channelName, siteId, onMessage) {
    this.siteId = siteId;
    this.clock = {};            // site -> 已应用的最大 seq
    this.pending = new Map();   // site -> 乱序暂存的消息队列
    this.onMessage = onMessage;
    this.bc = new BroadcastChannel(channelName);
    this.bc.onmessage = (e) => this.#receive(e.data);
  }

  /** 发送操作；clock 快照随消息发出 */
  send(op, kind) {
    const seq = (this.clock[this.siteId] ?? 0) + 1;
    this.clock[this.siteId] = seq;
    const msg = { site: this.siteId, seq, clock: { ...this.clock }, op, kind };
    this.bc.postMessage(msg);
    return msg;
  }

  #receive(msg) {
    const expected = (this.clock[msg.site] ?? 0) + 1;
    if (msg.seq > expected) {
      // 乱序到达：暂存，等待缺失的前驱消息
      if (!this.pending.has(msg.site)) this.pending.set(msg.site, []);
      this.pending.get(msg.site).push(msg);
      this.pending.get(msg.site).sort((a, b) => a.seq - b.seq);
      return;
    }
    if (msg.seq < expected) return; // 重复消息，丢弃
    this.#deliver(msg);
    // 依次释放该站点已连续的暂存消息
    const queue = this.pending.get(msg.site);
    while (queue && queue.length > 0 && queue[0].seq === (this.clock[msg.site] ?? 0) + 1) {
      this.#deliver(queue.shift());
    }
  }

  #deliver(msg) {
    this.clock[msg.site] = msg.seq;
    this.onMessage(msg);
  }

  close() { this.bc.close(); }
}
