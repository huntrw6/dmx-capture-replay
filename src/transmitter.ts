/**
 * DMX Transmitter - Sends DMX data via Art-Net or sACN
 * 
 * Used for playback of recorded DMX data.
 */

import dgram from "dgram";
import crypto from "crypto";
import { Sender } from "sacn";
import { Protocol, TOTAL_CHANNELS, ARTNET_PORT, ARTNET_BROADCAST } from "./types";
import { logInfo, logError, logDebug } from "./logger";

/** Art-Net packet header */
const ARTNET_HEADER = Buffer.from("Art-Net\0");
const ARTNET_OPCODE_DMX = 0x5000;

/** Common transmitter interface */
export interface DMXTransmitter {
  /** Start the transmitter */
  start(): Promise<void>;
  /** Stop the transmitter */
  stop(): Promise<void>;
  /** Send DMX channel data for one universe (wire numbering of this protocol) */
  send(universe: number, channels: Uint8Array): void;
  /** Universes this transmitter has been configured for */
  getUniverses(): number[];
  /** Get the protocol type */
  getProtocol(): Protocol;
}

/** Art-Net transmitter configuration */
export interface ArtNetTransmitterConfig {
  /** Target IP address (unicast) or broadcast address */
  targetAddress?: string;
  /** Universes that will be sent (0-32767), used for logging */
  universes: number[];
  /** Bind address for the socket */
  bindAddress?: string;
}

/** sACN transmitter configuration */
export interface SACNTransmitterConfig {
  /** Universes to transmit on (1-63999). One sACN sender is created per universe. */
  universes: number[];
  /** Source name to identify this sender */
  sourceName?: string;
  /** Priority (0-200, default 100) */
  priority?: number;
  /** Network interface to use */
  interfaceAddress?: string;
}

/**
 * Art-Net DMX Transmitter
 *
 * Sends Art-Net DMX packets (OpDmx) to a target address.
 */
export class ArtNetTransmitter implements DMXTransmitter {
  private socket: dgram.Socket | null = null;
  private readonly config: ArtNetTransmitterConfig;
  /** Art-Net sequence counters, one per universe */
  private readonly sequences: Map<number, number> = new Map();
  private isRunning = false;

  constructor(config: ArtNetTransmitterConfig) {
    this.config = {
      targetAddress: config.targetAddress ?? ARTNET_BROADCAST,
      universes: config.universes,
      bindAddress: config.bindAddress ?? "0.0.0.0",
    };
  }

  getProtocol(): Protocol {
    return "artnet";
  }

  getUniverses(): number[] {
    return this.config.universes.slice();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    logInfo("Starting Art-Net transmitter", {
      targetAddress: this.config.targetAddress,
      universes: this.config.universes,
    });

    return new Promise((resolve, reject) => {
      try {
        this.socket = dgram.createSocket({
          type: "udp4",
          reuseAddr: true,
        });

        this.socket.on("error", (error: Error) => {
          logError(error, "Art-Net transmitter socket error");
          if (!this.isRunning) {
            reject(error);
          }
        });

        this.socket.bind(0, this.config.bindAddress, () => {
          if (!this.socket) return;

          // Enable broadcast
          try {
            this.socket.setBroadcast(true);
          } catch (error) {
            logDebug("Failed to enable broadcast", { error });
          }

          this.isRunning = true;
          const address = this.socket.address();
          logInfo("Art-Net transmitter started", {
            localPort: address.port,
            targetAddress: this.config.targetAddress,
            universes: this.config.universes,
          });
          resolve();
        });
      } catch (error) {
        logError(error, "Failed to start Art-Net transmitter");
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning || !this.socket) {
      return;
    }

    logInfo("Stopping Art-Net transmitter");

    return new Promise((resolve) => {
      if (!this.socket) {
        resolve();
        return;
      }

      this.socket.close(() => {
        this.socket = null;
        this.isRunning = false;
        logInfo("Art-Net transmitter stopped");
        resolve();
      });
    });
  }

  /**
   * Send DMX data via Art-Net
   *
   * Packet structure:
   * Offset | Size | Description
   * -------|------|------------
   * 0      | 8    | "Art-Net\0"
   * 8      | 2    | OpCode (0x5000, little-endian)
   * 10     | 2    | Protocol Version (14, big-endian)
   * 12     | 1    | Sequence
   * 13     | 1    | Physical
   * 14     | 2    | Universe (little-endian)
   * 16     | 2    | Length (big-endian)
   * 18     | n    | DMX data
   */
  send(universe: number, channels: Uint8Array): void {
    if (!this.socket || !this.isRunning) {
      return;
    }

    const dataLength = Math.min(channels.length, TOTAL_CHANNELS);
    const packet = Buffer.alloc(18 + dataLength);

    // Art-Net header
    ARTNET_HEADER.copy(packet, 0);

    // OpCode (little-endian)
    packet.writeUInt16LE(ARTNET_OPCODE_DMX, 8);

    // Protocol version (big-endian)
    packet.writeUInt16BE(14, 10);

    // Sequence (0-255, wraps around)
    const sequence = this.sequences.get(universe) ?? 0;
    packet.writeUInt8(sequence, 12);
    this.sequences.set(universe, (sequence + 1) & 0xff);

    // Physical port (0)
    packet.writeUInt8(0, 13);

    // Universe (little-endian)
    packet.writeUInt16LE(universe, 14);

    // Data length (big-endian)
    packet.writeUInt16BE(dataLength, 16);

    // DMX data
    for (let i = 0; i < dataLength; i++) {
      packet[18 + i] = channels[i] ?? 0;
    }

    // Send packet
    this.socket.send(packet, ARTNET_PORT, this.config.targetAddress!, (error) => {
      if (error) {
        logError(error, "Failed to send Art-Net packet");
      }
    });
  }
}

/**
 * sACN (E1.31) DMX Transmitter
 *
 * Sends sACN packets to the multicast group of each universe. The sacn
 * library binds one sender per universe, so this keeps a sender per universe
 * (all sharing a single CID so receivers see one source with many universes).
 */
export class SACNTransmitter implements DMXTransmitter {
  private readonly senders: Map<number, Sender> = new Map();
  private readonly config: SACNTransmitterConfig;
  private isRunning = false;
  /** Unique CID (Component Identifier) for this transmitter instance */
  private readonly cid: Buffer;

  constructor(config: SACNTransmitterConfig) {
    this.config = {
      universes: Array.from(new Set(config.universes)).sort((a, b) => a - b),
      sourceName: config.sourceName ?? "DMX Monitor Playback",
      priority: config.priority ?? 100,
      interfaceAddress: config.interfaceAddress,
    };
    // Generate a unique CID (UUID) for this transmitter instance
    this.cid = crypto.randomBytes(16);
  }

  getProtocol(): Protocol {
    return "sacn";
  }

  getUniverses(): number[] {
    return this.config.universes.slice();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    logInfo("Starting sACN transmitter", {
      universes: this.config.universes,
      sourceName: this.config.sourceName,
      priority: this.config.priority,
      cid: this.cid.toString("hex").substring(0, 8) + "...",
    });

    try {
      // Find interface address if not specified
      let ifaceAddress = this.config.interfaceAddress;
      if (!ifaceAddress) {
        const os = await import("os");
        const interfaces = os.networkInterfaces();
        for (const [, addrs] of Object.entries(interfaces)) {
          if (!addrs) continue;
          for (const addr of addrs) {
            if (addr.family === "IPv4" && !addr.internal) {
              ifaceAddress = addr.address;
              break;
            }
          }
          if (ifaceAddress) break;
        }
      }

      for (const universe of this.config.universes) {
        this.senders.set(universe, this.createSender(universe, ifaceAddress));
      }

      this.isRunning = true;
      logInfo("sACN transmitter started", {
        universes: this.config.universes,
        interface: ifaceAddress,
      });
    } catch (error) {
      this.closeSenders();
      logError(error, "Failed to start sACN transmitter");
      throw error;
    }
  }

  private createSender(universe: number, iface: string | undefined): Sender {
    return new Sender({
      universe,
      iface,
      reuseAddr: true,
      defaultPacketOptions: {
        cid: this.cid,
        sourceName: this.config.sourceName,
        priority: this.config.priority,
        // Send exact 0-255 values (default is 0-100 percent, which rounds)
        useRawDmxValues: true,
      },
    });
  }

  private closeSenders(): void {
    for (const sender of this.senders.values()) {
      try {
        sender.close();
      } catch (error) {
        logError(error, "Error closing sACN sender");
      }
    }
    this.senders.clear();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logInfo("Stopping sACN transmitter");
    this.closeSenders();
    this.isRunning = false;
    logInfo("sACN transmitter stopped");
  }

  /**
   * Send DMX data for one universe via sACN (values are raw 0-255).
   */
  send(universe: number, channels: Uint8Array): void {
    if (!this.isRunning) {
      return;
    }

    const sender = this.senders.get(universe);
    if (!sender) {
      logDebug("sACN send for unconfigured universe ignored", { universe });
      return;
    }

    // Channel numbers are 1-based in the sacn library
    const payload: { [channel: number]: number } = {};
    for (let i = 0; i < Math.min(channels.length, TOTAL_CHANNELS); i++) {
      payload[i + 1] = channels[i] ?? 0;
    }

    sender
      .send({
        payload,
        sourceName: this.config.sourceName,
        priority: this.config.priority,
      })
      .catch((error: unknown) => {
        logError(error, "Failed to send sACN packet");
      });
  }
}

/**
 * Create a transmitter based on protocol
 */
export function createTransmitter(
  protocol: Protocol,
  universes: number[],
  options?: {
    targetAddress?: string;
    sourceName?: string;
    priority?: number;
    interfaceAddress?: string;
  }
): DMXTransmitter {
  if (protocol === "artnet") {
    return new ArtNetTransmitter({
      universes,
      targetAddress: options?.targetAddress,
    });
  } else {
    return new SACNTransmitter({
      universes,
      sourceName: options?.sourceName,
      priority: options?.priority,
      interfaceAddress: options?.interfaceAddress,
    });
  }
}
