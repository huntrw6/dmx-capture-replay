/**
 * sACN (E1.31) protocol handler for DMX Monitor
 */

import { Receiver } from 'sacn';
import { EventEmitter } from 'events';
import { DMXPacket, UniverseInfo, ProtocolHandler, ProtocolEvents, SACNSourceInfo, SACN_PORT, TOTAL_CHANNELS, isValidUniverse } from "../types";
import { NetworkError, ProtocolError, wrapError } from "../errors";
import { logDebug, logError, logInfo, logWarn } from "../logger";

/** sACN handler configuration */
export interface SACNConfig {
  bindAddress: string;
  useMulticast: boolean;
  universes?: number[];
  interfaceName?: string;
}

/** sACN packet from the sacn library */
interface SACNPacket {
  universe: number;
  payload: { [channel: number]: number };
  sourceName?: string;
  sourceAddress?: string;
  priority?: number;
  sequence?: number;
  cid?: Buffer;
}

/** Source timeout in milliseconds - sources not seen for this long are removed */
const SOURCE_TIMEOUT_MS = 5000;

/**
 * sACN (E1.31) protocol handler
 */
export class SACNHandler extends EventEmitter implements ProtocolHandler {
  private receiver: Receiver | null = null;
  private readonly config: SACNConfig;
  private readonly discoveredUniverses: Map<number, UniverseInfo> = new Map();
  /** Track sources (keyed by universe + sender) for priority arbitration */
  private readonly sources: Map<string, SACNSourceInfo> = new Map();
  /** Currently active (highest priority) source key, per universe */
  private readonly activeSources: Map<number, string> = new Map();
  private isRunning = false;
  /** Timer for cleaning up stale sources */
  private sourceCleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: SACNConfig) {
    super();
    this.config = config;
  }

  /**
   * Start listening for sACN packets
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logWarn("sACN handler already running");
      return;
    }

    logInfo("Starting sACN receiver", {
      bindAddress: this.config.bindAddress,
      useMulticast: this.config.useMulticast,
    });

    try {
      // For multicast, we need a specific interface. If 0.0.0.0 is specified,
      // find the first non-internal IPv4 interface
      let ifaceAddress: string | undefined;
      if (this.config.bindAddress !== "0.0.0.0") {
        ifaceAddress = this.config.bindAddress;
      } else if (this.config.useMulticast) {
        // Find first non-internal IPv4 interface for multicast
        const os = await import("os");
        const interfaces = os.networkInterfaces();
        for (const [, addrs] of Object.entries(interfaces)) {
          if (!addrs) continue;
          for (const addr of addrs) {
            if (addr.family === "IPv4" && !addr.internal) {
              ifaceAddress = addr.address;
              logInfo(`Using interface ${ifaceAddress} for sACN multicast`);
              break;
            }
          }
          if (ifaceAddress) break;
        }
      }

      // Create receiver with empty universes initially to avoid immediate multicast join
      // Universes will be added later via addUniverse() after user selects one
      const receiverOptions: ConstructorParameters<typeof Receiver>[0] = {
        universes: this.config.universes ?? [], // Empty - will add after user prompt
        iface: ifaceAddress,
        reuseAddr: true,
      };

      this.receiver = new Receiver(receiverOptions);

      // Handle incoming packets
      this.receiver.on("packet", (packet: SACNPacket) => {
        try {
          this.handlePacket(packet);
        } catch (error) {
          logError(error, "Error handling sACN packet");
          this.emit("error", wrapError(error, "sACN packet handling"));
        }
      });

      // Handle errors - but don't crash on multicast join errors during startup
      this.receiver.on("error", (error: Error) => {
        const nodeError = error as NodeJS.ErrnoException;
        // EINVAL during startup is usually a multicast join issue - log but don't crash
        if (nodeError.message?.includes("addMembership") || nodeError.message?.includes("EINVAL")) {
          logWarn("sACN multicast join warning (will retry when universe is added)", { error: error.message });
          return;
        }
        logError(error, "sACN receiver error");
        this.emit("error", this.categorizeError(error));
      });

      this.isRunning = true;

      // Start source cleanup timer to remove stale sources
      this.sourceCleanupTimer = setInterval(() => {
        this.cleanupStaleSources();
      }, 1000);

      logInfo("sACN receiver started successfully");
    } catch (error) {
      const wrappedError = this.categorizeError(error);
      logError(wrappedError, "Failed to start sACN receiver");
      throw wrappedError;
    }
  }

  /**
   * Stop the sACN receiver
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.receiver) {
      return;
    }

    logInfo("Stopping sACN receiver");

    try {
      // Stop source cleanup timer
      if (this.sourceCleanupTimer) {
        clearInterval(this.sourceCleanupTimer);
        this.sourceCleanupTimer = null;
      }

      this.receiver.removeAllListeners();
      this.receiver.close();
      this.receiver = null;
      this.isRunning = false;
      this.sources.clear();
      this.activeSources.clear();
      this.emit("close");
      logInfo("sACN receiver stopped");
    } catch (error) {
      logError(error, "Error stopping sACN receiver");
      throw wrapError(error, "sACN stop");
    }
  }

  /**
   * Get list of discovered universes
   */
  getDiscoveredUniverses(): UniverseInfo[] {
    return Array.from(this.discoveredUniverses.values());
  }

  /**
   * Add a universe to listen on
   */
  addUniverse(universe: number): void {
    if (!isValidUniverse(universe)) {
      logWarn(`Invalid universe number: ${universe}`);
      return;
    }

    if (this.receiver) {
      try {
        this.receiver.addUniverse(universe);
        logDebug(`Added universe ${universe} to sACN receiver`);
      } catch (error) {
        logWarn(`Failed to add universe ${universe}: ${error}`);
      }
    }
  }

  /**
   * Handle incoming sACN packet
   */
  private handlePacket(packet: SACNPacket): void {
    const universe = packet.universe;

    // Validate universe
    if (!isValidUniverse(universe)) {
      logWarn(`Received packet with invalid universe: ${universe}`);
      return;
    }

    // Update discovered universes
    const existingInfo = this.discoveredUniverses.get(universe);
    const now = new Date();

    if (!existingInfo) {
      // New universe discovered
      const info: UniverseInfo = {
        universe,
        lastSeen: now,
        packetCount: 1,
        source: packet.sourceName,
      };
      this.discoveredUniverses.set(universe, info);
      logInfo(`Discovered new sACN universe: ${universe}`, { source: packet.sourceName });
      this.emit("universeDiscovered", universe);
    } else {
      // Update existing universe info
      existingInfo.lastSeen = now;
      existingInfo.packetCount++;
      if (packet.sourceName) {
        existingInfo.source = packet.sourceName;
      }
    }

    // Track source for priority arbitration
    // Use CID (if available) or sourceAddress to create unique source key
    // This handles multiple senders with the same sourceName
    const sourceName = packet.sourceName ?? "Unknown";
    const sourceKey = `${universe}:${this.getSourceKey(packet)}`;
    const priority = packet.priority ?? 100;

    // Debug: log source identification info (log every 100th packet to reduce spam)
    if (existingInfo && existingInfo.packetCount % 100 === 1) {
      logInfo(`sACN source info - name: "${sourceName}", key: ${sourceKey.substring(0, 16)}..., pri: ${priority}, cid: ${packet.cid?.toString("hex")?.substring(0, 8) ?? "none"}, addr: ${packet.sourceAddress ?? "none"}, sources tracked: ${this.sources.size}`);
    }

    const shouldEmit = this.updateSourceTracking(universe, sourceKey, sourceName, packet.sourceAddress, priority, now);

    // Only emit packet if this is from the highest priority source
    if (!shouldEmit) {
      // Log ignored packets periodically
      if (existingInfo && existingInfo.packetCount % 100 === 1) {
        logInfo(`IGNORING packet from lower priority source: ${sourceName} (pri:${priority}), active source: ${this.activeSources.get(universe)?.substring(0, 16)}...`);
      }
      return;
    }

    // Extract channel data
    const channels = new Uint8Array(TOTAL_CHANNELS);
    const payload = packet.payload;

    // Copy channel data from payload object (sacn library uses object with channel keys)
    // The sacn library returns values as percentages (0-100), convert to DMX (0-255)
    for (let i = 0; i < TOTAL_CHANNELS; i++) {
      const value = payload[i + 1]; // sACN uses 1-based channel numbers
      if (value !== undefined) {
        // Convert percentage (0-100) to DMX value (0-255)
        channels[i] = Math.round((value / 100) * 255);
      }
    }

    // Create DMX packet
    const dmxPacket: DMXPacket = {
      universe,
      channels,
      source: packet.sourceName,
      priority: packet.priority,
      sequence: packet.sequence,
      timestamp: now,
    };

    this.emit("packet", dmxPacket);
  }

  /**
   * Generate a unique key for a source
   * Uses CID if available, otherwise falls back to sourceAddress, then sourceName
   */
  private getSourceKey(packet: SACNPacket): string {
    // CID is the best unique identifier (UUID per sender)
    if (packet.cid && packet.cid.length > 0) {
      return packet.cid.toString("hex");
    }
    // Fall back to sourceAddress (IP) if available
    if (packet.sourceAddress) {
      return `${packet.sourceName ?? "Unknown"}@${packet.sourceAddress}`;
    }
    // Last resort: just use sourceName (may collide)
    return packet.sourceName ?? "Unknown";
  }

  /**
   * Find the highest priority source key for one universe
   */
  private findHighestPrioritySource(universe: number): { key: string | null; priority: number } {
    let highestPriority = -1;
    let highestKey: string | null = null;
    for (const [key, info] of this.sources) {
      if (info.universe !== universe) continue;
      if (info.priority > highestPriority) {
        highestPriority = info.priority;
        highestKey = key;
      }
    }
    return { key: highestKey, priority: highestPriority };
  }

  /**
   * Update source tracking and determine if packet should be emitted.
   * Arbitration is done per universe: a high priority source on one universe
   * must not suppress an unrelated source on another.
   * @returns true if this packet is from the active (highest priority) source of its universe
   */
  private updateSourceTracking(universe: number, sourceKey: string, sourceName: string, sourceAddress: string | undefined, priority: number, now: Date): boolean {
    const existingSource = this.sources.get(sourceKey);
    const wasNewSource = !existingSource;

    // Update or create source info
    const sourceInfo: SACNSourceInfo = {
      universe,
      sourceName,
      sourceAddress,
      priority,
      lastSeen: now,
      isActive: false, // Will be set below
    };
    this.sources.set(sourceKey, sourceInfo);

    const { key: highestKey, priority: highestPriority } = this.findHighestPrioritySource(universe);

    // Update active status for all sources on this universe
    for (const [key, info] of this.sources) {
      if (info.universe === universe) {
        info.isActive = key === highestKey;
      }
    }

    // Check if active source changed
    const activeChanged = this.activeSources.get(universe) !== highestKey;
    if (highestKey) {
      this.activeSources.set(universe, highestKey);
    } else {
      this.activeSources.delete(universe);
    }

    // Emit sourcesChanged when a source appears or the active one changes
    if (wasNewSource || activeChanged) {
      const universeSources = this.getSources(universe);
      if (universeSources.length > 1) {
        logWarn(`Multiple sACN sources detected on universe ${universe}. Active: ${highestKey} (pri:${highestPriority})`);
      }
      this.emitSourcesChanged(universe);
    }

    // Return true if this packet is from the active (highest priority) source
    return sourceKey === highestKey;
  }

  /**
   * Clean up sources that haven't been seen recently
   */
  private cleanupStaleSources(): void {
    const now = Date.now();
    const touchedUniverses = new Set<number>();

    for (const [key, info] of this.sources) {
      if (now - info.lastSeen.getTime() > SOURCE_TIMEOUT_MS) {
        this.sources.delete(key);
        if (info.universe !== undefined) touchedUniverses.add(info.universe);
        logInfo(`sACN source timed out: ${key}`);
      }
    }

    for (const universe of touchedUniverses) {
      // Recalculate active source for this universe
      const { key: highestKey } = this.findHighestPrioritySource(universe);
      for (const [key, info] of this.sources) {
        if (info.universe === universe) {
          info.isActive = key === highestKey;
        }
      }
      if (highestKey) {
        this.activeSources.set(universe, highestKey);
      } else {
        this.activeSources.delete(universe);
      }
      this.emitSourcesChanged(universe);
    }
  }

  /**
   * Emit the sourcesChanged event with the current source list of a universe
   */
  private emitSourcesChanged(universe: number): void {
    this.emit("sourcesChanged", universe, this.getSources(universe));
  }

  /**
   * Get list of tracked sources (optionally for a single universe)
   */
  getSources(universe?: number): SACNSourceInfo[] {
    return Array.from(this.sources.values())
      .filter((s) => universe === undefined || s.universe === universe)
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get the currently active source (highest priority) of a universe
   */
  getActiveSource(universe: number): SACNSourceInfo | null {
    const key = this.activeSources.get(universe);
    if (!key) return null;
    return this.sources.get(key) ?? null;
  }

  /**
   * Check if there are competing sources on a universe
   */
  hasCompetingSources(universe: number): boolean {
    return this.getSources(universe).length > 1;
  }

  /**
   * Categorize error into appropriate error type
   */
  private categorizeError(error: unknown): Error {
    if (error instanceof Error) {
      const nodeError = error as NodeJS.ErrnoException;

      if (nodeError.code === "EADDRINUSE") {
        return NetworkError.portInUse(SACN_PORT, this.config.bindAddress);
      }

      if (nodeError.code === "EADDRNOTAVAIL") {
        return NetworkError.bindFailed(this.config.bindAddress, SACN_PORT, error);
      }

      if (nodeError.code === "ENODEV") {
        return NetworkError.interfaceNotFound(this.config.bindAddress);
      }

      if (nodeError.message?.includes("multicast")) {
        return NetworkError.multicastJoinFailed(this.config.bindAddress, error);
      }

      // Check for protocol-related errors
      if (nodeError.message?.includes("packet") || nodeError.message?.includes("header") || nodeError.message?.includes("invalid")) {
        return ProtocolError.malformedPacket("sACN", nodeError.message);
      }
    }

    return wrapError(error, "sACN");
  }

  /**
   * Type-safe event emitter methods
   */
  override on<K extends keyof ProtocolEvents>(event: K, listener: ProtocolEvents[K]): this {
    return super.on(event, listener);
  }

  override off<K extends keyof ProtocolEvents>(event: K, listener: ProtocolEvents[K]): this {
    return super.off(event, listener);
  }

  override emit<K extends keyof ProtocolEvents>(event: K, ...args: Parameters<ProtocolEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
}

/**
 * Create and configure an sACN handler
 */
export function createSACNHandler(config: SACNConfig): SACNHandler {
  return new SACNHandler(config);
}
