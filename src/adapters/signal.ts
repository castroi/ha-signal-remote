/**
 * Signal adapter (design §2, §6 A01, §8).
 *
 * Receives messages from the bbernhard signal-cli-rest-api JSON-RPC notification
 * stream and sends replies over its REST endpoint.
 *
 * - Identity is pinned on sourceUuid (ACI), not the phone number, which may be
 *   empty. The allowlist check runs first; an unknown UUID is dropped silently —
 *   no reply, no body logged.
 * - Send failures are swallowed (returned as false), never thrown: we cannot
 *   deliver an error if Signal itself is the broken link.
 *
 * The socket and fetch transport are injected so the adapter is testable without
 * a live signal-cli.
 */

export interface SignalSocket {
  onMessage(handler: (raw: string) => void): void;
}

export interface IncomingEnvelope {
  readonly sourceUuid: string;
  readonly sourceNumber: string | undefined;
  readonly timestamp: number;
  readonly message: string;
}

export interface SignalAdapterOptions {
  readonly socket: SignalSocket;
  readonly botNumber: string;
  readonly apiUrl: string;
  readonly allowlist: ReadonlySet<string>;
  readonly onEnvelope: (envelope: IncomingEnvelope) => void;
  readonly fetchImpl?: typeof fetch;
  /** Rate-limited log hook for dropped/unknown senders; defaults to noop. */
  readonly logDrop?: (uuidPresent: boolean) => void;
}

interface SignalEnvelope {
  sourceUuid?: string;
  sourceNumber?: string | null;
  timestamp?: number;
  dataMessage?: { timestamp?: number; message?: string };
}

interface RpcFrame {
  method?: string;
  // bbernhard /v1/receive/{number} WS emits the envelope at the top level
  // ({envelope, account}); the json-rpc notification form nests it under params.
  envelope?: SignalEnvelope;
  params?: {
    envelope?: SignalEnvelope;
  };
}

export class SignalAdapter {
  private readonly botNumber: string;
  private readonly apiUrl: string;
  private readonly allowlist: ReadonlySet<string>;
  private readonly onEnvelope: (envelope: IncomingEnvelope) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly logDrop: (uuidPresent: boolean) => void;

  constructor(opts: SignalAdapterOptions) {
    this.botNumber = opts.botNumber;
    this.apiUrl = opts.apiUrl.replace(/\/$/, '');
    this.allowlist = opts.allowlist;
    this.onEnvelope = opts.onEnvelope;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logDrop = opts.logDrop ?? (() => {});
    opts.socket.onMessage((raw) => this.handleRaw(raw));
  }

  private handleRaw(raw: string): void {
    let frame: RpcFrame;
    try {
      frame = JSON.parse(raw) as RpcFrame;
    } catch {
      return; // malformed frame
    }
    // Two transports carry the same payload: the json-rpc notification form
    // ({method:'receive', params:{envelope}}) and the bbernhard /v1/receive WS
    // form ({envelope, account}, no method). Accept either.
    const env = frame.method === 'receive' ? frame.params?.envelope : frame.envelope;
    if (!env) return;
    const sourceUuid = env?.sourceUuid;
    const message = env?.dataMessage?.message;
    // Envelope timestamp (server-assigned) is the freshness anchor (§5).
    const timestamp = env?.timestamp ?? env?.dataMessage?.timestamp;

    if (!sourceUuid || message === undefined || timestamp === undefined) return;

    // Allowlist first; unknown UUID -> silent drop, no body logged (§6 A01).
    if (!this.allowlist.has(sourceUuid)) {
      this.logDrop(true);
      return;
    }

    this.onEnvelope({
      sourceUuid,
      sourceNumber: env?.sourceNumber ?? undefined,
      timestamp,
      message,
    });
  }

  /**
   * Send a reply via the signal-cli REST endpoint. Returns true on success,
   * false on any failure (swallowed; never throws).
   */
  async send(sourceUuid: string, recipient: string, message: string): Promise<boolean> {
    // Signal envelopes often omit the sender's phone number; identity is the
    // ACI (sourceUuid). Fall back to it so the reply has a valid recipient.
    const to = recipient || sourceUuid;
    try {
      const res = await this.fetchImpl(`${this.apiUrl}/v2/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          number: this.botNumber,
          recipients: [to],
          message,
        }),
      });
      return res.ok;
    } catch {
      // Can't deliver an error if Signal is the broken link (§8): log + drop.
      return false;
    }
  }
}
