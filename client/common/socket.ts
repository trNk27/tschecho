// A WebSocket that reconnects with backoff (0.5 s, 1 s, 2 s, then max 5 s).

export type SocketStatus = 'connecting' | 'open' | 'closed';

export interface ReconnectingSocketOptions<In> {
  onOpen: () => void;
  onMessage: (msg: In) => void;
  onStatus?: (status: SocketStatus) => void;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 5000];

export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export class ReconnectingSocket<In, Out> {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: number | null = null;
  private stopped = false;

  constructor(private opts: ReconnectingSocketOptions<In>) {
    this.connect();
    // Reconnect immediately when the device comes back online or the tab is shown again.
    window.addEventListener('online', () => this.kick());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.kick();
    });
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: Out): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Stop reconnecting and close. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.ws?.close();
  }

  /** Start again after stop(). */
  restart(): void {
    this.stopped = false;
    this.attempt = 0;
    this.kick();
  }

  private kick(): void {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.connect();
  }

  private connect(): void {
    this.opts.onStatus?.('connecting');
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.opts.onStatus?.('open');
      this.opts.onOpen();
    };
    ws.onmessage = (ev) => {
      let msg: In;
      try {
        msg = JSON.parse(String(ev.data)) as In;
      } catch {
        return;
      }
      this.opts.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.opts.onStatus?.('closed');
      if (this.stopped) return;
      const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
      this.attempt++;
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.connect();
      }, delay);
    };
    ws.onerror = () => {
      // onclose follows and handles the retry.
    };
  }
}
