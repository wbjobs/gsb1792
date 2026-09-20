/**
 * BroadcastChannel transport. Any object with postMessage/onmessage/close
 * satisfies the transport interface, which keeps tests deterministic.
 */
export class BroadcastTransport {
  constructor(channelName) {
    this.channel = new BroadcastChannel(channelName);
    this.channel.onmessage = (e) => {
      if (this.onmessage) this.onmessage(e.data);
    };
  }
  postMessage(msg) {
    this.channel.postMessage(msg);
  }
  close() {
    this.channel.close();
  }
}

/** In-process bus for tests and demos: manual or async delivery. */
export class LocalBus {
  constructor({ asyncDelivery = false } = {}) {
    this.peers = new Set();
    this.asyncDelivery = asyncDelivery;
  }
  connect() {
    const bus = this;
    const transport = {
      onmessage: null,
      postMessage(msg) {
        for (const peer of bus.peers) {
          if (peer === transport || !peer.onmessage) continue;
          const copy = structuredClone(msg);
          if (bus.asyncDelivery) queueMicrotask(() => peer.onmessage(copy));
          else peer.onmessage(copy);
        }
      },
      close() {
        bus.peers.delete(transport);
      },
    };
    bus.peers.add(transport);
    return transport;
  }
}
