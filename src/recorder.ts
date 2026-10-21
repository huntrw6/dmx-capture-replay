/**
 * DMX Recording and Playback
 * 
 * Highly optimized binary format for recording DMX data with delta compression.
 * Only stores channel changes with precision timestamps for minimal file size.
 *
 * File format v2 (multi-universe): every frame is
 *   varint deltaTime | uint16 LE universe | count byte | payload
 * where deltaTime is relative to the previous frame of ANY universe, so the
 * relative timing between universes is preserved. v1 files (single universe,
 * no per-frame universe field) can still be played back.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  TOTAL_CHANNELS,
  Protocol,
  DMXREC_MAGIC,
  DMXREC_VERSION,
  RecordingHeader,
  RecordingFlags,
  FrameType,
  ChannelChange,
  RecordingFrame,
  RecordingState,
  RecordingStats,
  PlaybackState,
  PlaybackStats,
} from './types';
import { logInfo, logDebug } from './logger';

/** Header size in bytes */
const HEADER_SIZE = 32;

/** Interval between full snapshots (ms) */
const SNAPSHOT_INTERVAL = 5000;

/** Write buffer size before flushing */
const WRITE_BUFFER_SIZE = 64 * 1024; // 64KB

/**
 * Encode an unsigned integer as a varint (1-4 bytes)
 * Uses continuation bit encoding for compact representation
 */
function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  while (value > 0x7F) {
    bytes.push((value & 0x7F) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7F);
  return Buffer.from(bytes);
}

/**
 * Decode a varint from a buffer at the given offset
 * Returns the decoded value and number of bytes consumed
 */
function decodeVarint(buffer: Buffer, offset: number): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  
  while (offset + bytesRead < buffer.length) {
    const byte = buffer[offset + bytesRead]!;
    bytesRead++;
    value |= (byte & 0x7F) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  
  return { value, bytesRead };
}

/**
 * Format a date as YYYYMMDD-HHMMSS for filenames
 */
function formatDateForFilename(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Per-universe recorder state */
interface UniverseRecordState {
  previous: Uint8Array;
  lastSnapshotTime: number;
}

/**
 * DMX Recorder - Records DMX data (one or many universes) to an optimized binary format
 */
export class DMXRecorder {
  private state: RecordingState = 'idle';
  private filePath: string | null = null;
  private fileHandle: number | null = null;
  private writeBuffer: Buffer;
  private writeOffset = 0;

  private universeState: Map<number, UniverseRecordState> = new Map();
  private startTime: number = 0;
  private lastFrameTime: number = 0;
  private frameCount = 0;
  private bytesWritten = 0;

  private protocol: Protocol = 'sacn';

  constructor() {
    this.writeBuffer = Buffer.alloc(WRITE_BUFFER_SIZE);
  }

  /**
   * Get current recording state
   */
  getState(): RecordingState {
    return this.state;
  }

  /**
   * Get recording statistics
   */
  getStats(): RecordingStats {
    return {
      state: this.state,
      startTime: this.startTime > 0 ? new Date(this.startTime) : null,
      frameCount: this.frameCount,
      bytesWritten: this.bytesWritten,
      filePath: this.filePath,
      duration: this.state === "recording" ? Date.now() - this.startTime : 0,
    };
  }

  /**
   * Universes that have been written to the current/last recording (sorted)
   */
  getRecordedUniverses(): number[] {
    return Array.from(this.universeState.keys()).sort((a, b) => a - b);
  }

  /**
   * Check if currently recording
   */
  isRecording(): boolean {
    return this.state === "recording";
  }

  /**
   * Start recording to a new file. Universes are added to the file as their
   * first frame arrives, so the caller decides which universes to feed in.
   */
  startRecording(protocol: Protocol, outputDir?: string): string {
    if (this.state === "recording") {
      throw new Error("Already recording");
    }

    this.protocol = protocol;

    // Generate filename
    const timestamp = formatDateForFilename(new Date());
    const filename = `dmx-recording-${timestamp}.dmxrec`;
    const dir = outputDir || process.cwd();
    this.filePath = path.join(dir, filename);

    // Open file for writing (binary mode)
    this.fileHandle = fs.openSync(this.filePath, 'w');

    // Write initial header (will be rewritten on stop with final values)
    const headerBuffer = this.createHeader(0);
    fs.writeSync(this.fileHandle, headerBuffer);
    this.bytesWritten = HEADER_SIZE;

    // Reset state
    this.universeState.clear();
    this.startTime = Date.now();
    this.lastFrameTime = this.startTime;
    this.frameCount = 0;
    this.writeOffset = 0;

    this.state = "recording";

    logInfo("Recording started", { filePath: this.filePath, protocol });

    return this.filePath;
  }

  /**
   * Stop recording and finalize the file
   */
  stopRecording(): RecordingStats {
    if (this.state !== "recording") {
      throw new Error("Not recording");
    }

    // Flush any remaining buffer
    this.flushBuffer();

    // Calculate final duration
    const duration = Date.now() - this.startTime;

    // Write final header
    if (this.fileHandle !== null) {
      const header = this.createHeader(duration);
      fs.writeSync(this.fileHandle, header, 0, HEADER_SIZE, 0);
      fs.fsyncSync(this.fileHandle);  // Ensure data is flushed to disk
      fs.closeSync(this.fileHandle);
      this.fileHandle = null;
    }

    const stats = this.getStats();
    stats.duration = duration;

    this.state = "idle";

    logInfo("Recording stopped", {
      filePath: this.filePath,
      duration,
      frameCount: this.frameCount,
      bytesWritten: this.bytesWritten,
      universes: this.getRecordedUniverses(),
    });

    return stats;
  }

  /**
   * Record a frame of DMX data for one universe.
   * Only stores changes from the previous frame of that universe.
   */
  recordFrame(universe: number, channels: Uint8Array): void {
    if (this.state !== "recording") return;

    const now = Date.now();
    const isFirstFrame = this.frameCount === 0;

    // First frame always has deltaTime = 0 (starts immediately on playback)
    const deltaTime = isFirstFrame ? 0 : (now - this.lastFrameTime);

    let uState = this.universeState.get(universe);
    const isNewUniverse = !uState;
    if (!uState) {
      uState = { previous: new Uint8Array(TOTAL_CHANNELS), lastSnapshotTime: now };
      this.universeState.set(universe, uState);
    }

    // Full snapshot for a universe's first frame, then periodically
    const needsSnapshot = isNewUniverse || (now - uState.lastSnapshotTime) >= SNAPSHOT_INTERVAL;

    if (needsSnapshot) {
      this.writeSnapshotFrame(universe, channels, deltaTime);
      uState.lastSnapshotTime = now;
      uState.previous.fill(0);
      uState.previous.set(channels.subarray(0, TOTAL_CHANNELS));
      this.lastFrameTime = now;
      this.frameCount++;
      return;
    }

    // Compute delta changes
    const changes: ChannelChange[] = [];
    for (let i = 0; i < TOTAL_CHANNELS; i++) {
      const newValue = channels[i] ?? 0;
      const oldValue = uState.previous[i] ?? 0;
      if (newValue !== oldValue) {
        changes.push({ channel: i, value: newValue });
      }
    }

    // Only write if there are changes (no changes = no frame, timing state untouched)
    if (changes.length > 0) {
      this.writeDeltaFrame(universe, changes, deltaTime);
      uState.previous.fill(0);
      uState.previous.set(channels.subarray(0, TOTAL_CHANNELS));
      this.lastFrameTime = now;
      this.frameCount++;
    }
  }

  /**
   * Write a delta frame to the buffer
   */
  private writeDeltaFrame(universe: number, changes: ChannelChange[], deltaTime: number): void {
    this.appendToBuffer(encodeVarint(deltaTime));
    this.appendUint16(universe);

    // Write change count
    if (changes.length < FrameType.SNAPSHOT) {
      this.appendByte(changes.length);
    } else {
      // Extended count
      this.appendByte(FrameType.EXTENDED);
      this.appendUint16(changes.length);
    }

    // Write each change
    for (const change of changes) {
      this.appendUint16(change.channel);
      this.appendByte(change.value);
    }
  }

  /**
   * Write a full snapshot frame
   */
  private writeSnapshotFrame(universe: number, channels: Uint8Array, deltaTime: number): void {
    this.appendToBuffer(encodeVarint(deltaTime));
    this.appendUint16(universe);

    // Write snapshot marker
    this.appendByte(FrameType.SNAPSHOT);

    // Write all 512 channel values (pad short input with zeros)
    const snapshot = Buffer.alloc(TOTAL_CHANNELS);
    snapshot.set(channels.subarray(0, TOTAL_CHANNELS));
    this.appendToBuffer(snapshot);

    logDebug('Wrote snapshot frame', { universe, deltaTime, frameCount: this.frameCount });
  }

  /**
   * Append a single byte to the write buffer
   */
  private appendByte(value: number): void {
    if (this.writeOffset >= this.writeBuffer.length - 1) {
      this.flushBuffer();
    }
    this.writeBuffer[this.writeOffset++] = value;
  }

  /**
   * Append a uint16 (little-endian) to the write buffer
   */
  private appendUint16(value: number): void {
    if (this.writeOffset >= this.writeBuffer.length - 2) {
      this.flushBuffer();
    }
    this.writeBuffer.writeUInt16LE(value, this.writeOffset);
    this.writeOffset += 2;
  }

  /**
   * Append a buffer to the write buffer
   */
  private appendToBuffer(data: Buffer): void {
    if (this.writeOffset + data.length >= this.writeBuffer.length) {
      this.flushBuffer();
    }

    // If data is larger than buffer, write directly
    if (data.length >= this.writeBuffer.length) {
      if (this.fileHandle !== null) {
        fs.writeSync(this.fileHandle, data);
        this.bytesWritten += data.length;
      }
      return;
    }

    data.copy(this.writeBuffer, this.writeOffset);
    this.writeOffset += data.length;
  }

  /**
   * Flush the write buffer to disk
   */
  private flushBuffer(): void {
    if (this.writeOffset > 0 && this.fileHandle !== null) {
      fs.writeSync(this.fileHandle, this.writeBuffer.subarray(0, this.writeOffset));
      this.bytesWritten += this.writeOffset;
      this.writeOffset = 0;
    }
  }

  /**
   * Create the file header buffer
   */
  private createHeader(duration: number): Buffer {
    const header = Buffer.alloc(HEADER_SIZE);
    let offset = 0;

    // Magic bytes (4 bytes)
    header.write(DMXREC_MAGIC, offset, 'ascii');
    offset += 4;

    // Version (1 byte)
    header.writeUInt8(DMXREC_VERSION, offset++);

    // Flags (1 byte)
    header.writeUInt8(RecordingFlags.HAS_SNAPSHOTS, offset++);

    // Protocol (1 byte) - 0=sACN, 1=Art-Net
    header.writeUInt8(this.protocol === 'sacn' ? 0 : 1, offset++);

    // First (lowest) universe (2 bytes) - kept for v1 compatibility
    const universes = this.getRecordedUniverses();
    header.writeUInt16LE(universes[0] ?? 0, offset);
    offset += 2;

    // Start timestamp (8 bytes)
    header.writeBigInt64LE(BigInt(this.startTime), offset);
    offset += 8;

    // Duration (4 bytes)
    header.writeUInt32LE(duration, offset);
    offset += 4;

    // Frame count (4 bytes)
    header.writeUInt32LE(this.frameCount, offset);
    offset += 4;

    // Universe count (2 bytes) - v2
    header.writeUInt16LE(universes.length, offset);

    // Remaining reserved bytes already zeroed

    return header;
  }
}

/** Speed presets for playback */
const SPEED_PRESETS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 4.0];

/** Callback signature for player frames */
export type PlayerFrameCallback = (universe: number, channels: Uint8Array) => void;

/**
 * DMX Player - Plays back recorded DMX data (one or many universes)
 *
 * Supports speed control, seeking, loop and pause/resume.
 */
export class DMXPlayer {
  private state: PlaybackState = "idle";
  private filePath: string | null = null;
  private header: RecordingHeader | null = null;
  private frameData: Buffer | null = null;
  private frameOffset = 0;

  /** Universes found in the file (sorted) and totals from a full scan */
  private universes: number[] = [];
  private totalFrames = 0;
  private totalDuration = 0;

  /** Current channel state per universe */
  private channels: Map<number, Uint8Array> = new Map();
  private currentFrame = 0;
  private playbackStartTime = 0;
  private currentPosition = 0;
  private pausedPosition = 0;

  // Speed and loop control
  private speed = 1.0;
  private loopEnabled = false;

  private playbackTimer: NodeJS.Timeout | null = null;
  /** Frame that has been read from the file but not yet applied (timer pending) */
  private pending: { startOffset: number; deltaTime: number } | null = null;
  private onFrameCallback: PlayerFrameCallback | null = null;
  private onFinishedCallback: (() => void) | null = null;
  private onPositionCallback: ((position: number, duration: number) => void) | null = null;
  private onStateChangeCallback: ((state: PlaybackState) => void) | null = null;

  /**
   * Get current playback state
   */
  getState(): PlaybackState {
    return this.state;
  }

  /**
   * Get playback statistics
   */
  getStats(): PlaybackStats {
    return {
      state: this.state,
      position: this.currentPosition,
      duration: this.totalDuration,
      frameIndex: this.currentFrame,
      totalFrames: this.totalFrames,
      filePath: this.filePath,
    };
  }

  /**
   * Get the recording header info
   */
  getHeader(): RecordingHeader | null {
    return this.header;
  }

  /**
   * Universes contained in the loaded recording (sorted)
   */
  getUniverses(): number[] {
    return this.universes.slice();
  }

  /**
   * Total duration of the loaded recording in ms
   */
  getDuration(): number {
    return this.totalDuration;
  }

  /**
   * Total frames in the loaded recording
   */
  getTotalFrames(): number {
    return this.totalFrames;
  }

  /**
   * Restrict playback to a subset of the recorded universes.
   * Frames for other universes are skipped (timing is unaffected).
   */
  private universeFilter: Set<number> | null = null;
  setUniverseFilter(universes: number[] | null): void {
    this.universeFilter = universes ? new Set(universes) : null;
  }

  /**
   * Get current playback speed
   */
  getSpeed(): number {
    return this.speed;
  }

  /**
   * Get loop enabled status
   */
  isLoopEnabled(): boolean {
    return this.loopEnabled;
  }

  /**
   * Get current channel data for a universe
   */
  getChannels(universe: number): Uint8Array {
    return this.channels.get(universe) ?? new Uint8Array(TOTAL_CHANNELS);
  }

  /**
   * Load a recording file for playback
   */
  load(filePath: string): RecordingHeader {
    if (this.state === "playing") {
      this.stop();
    }

    this.filePath = filePath;

    // Read entire file into memory
    const fileBuffer = fs.readFileSync(filePath);

    // Parse header
    this.header = this.parseHeader(fileBuffer);

    // Store frame data (everything after header)
    this.frameData = fileBuffer.subarray(HEADER_SIZE);
    this.frameOffset = 0;

    // Scan the whole file once: universes, real frame count and duration.
    // This also makes playback work for recordings whose header was never
    // finalised (e.g. the recorder was killed).
    this.scan();

    // Reset state
    this.channels.clear();
    this.currentFrame = 0;
    this.currentPosition = 0;
    this.pausedPosition = 0;
    this.pending = null;

    this.state = "idle";

    logInfo("Recording loaded", {
      filePath,
      version: this.header.version,
      duration: this.totalDuration,
      frameCount: this.totalFrames,
      universes: this.universes,
    });

    return this.header;
  }

  /**
   * Walk the frame stream to collect universes, frame count and duration
   */
  private scan(): void {
    const found = new Set<number>();
    let frames = 0;
    let position = 0;
    this.frameOffset = 0;
    try {
      for (;;) {
        const frame = this.readNextFrame();
        if (!frame) break;
        position += frame.deltaTime;
        frames++;
        found.add(frame.universe);
      }
    } catch (error) {
      // Truncated final frame (unfinalised recording) - keep what we have
      logDebug("Recording scan stopped at truncated frame", { error: String(error) });
    }
    this.frameOffset = 0;
    this.universes = Array.from(found).sort((a, b) => a - b);
    this.totalFrames = frames;
    this.totalDuration = Math.max(position, this.header?.duration ?? 0);
  }

  /**
   * Parse the file header
   */
  private parseHeader(buffer: Buffer): RecordingHeader {
    if (buffer.length < HEADER_SIZE) {
      throw new Error("Invalid recording file: too small");
    }

    let offset = 0;

    // Magic bytes
    const magic = buffer.toString("ascii", offset, offset + 4);
    offset += 4;

    if (magic !== DMXREC_MAGIC) {
      throw new Error(`Invalid recording file: bad magic bytes "${magic}"`);
    }

    // Version
    const version = buffer.readUInt8(offset++);
    if (version > DMXREC_VERSION) {
      throw new Error(`Unsupported recording version: ${version}`);
    }

    // Flags
    const flags = buffer.readUInt8(offset++);

    // Protocol
    const protocol = buffer.readUInt8(offset++);

    // Universe (first universe for v2, the only universe for v1)
    const universe = buffer.readUInt16LE(offset);
    offset += 2;

    // Start timestamp
    const startTime = Number(buffer.readBigInt64LE(offset));
    offset += 8;

    // Duration
    const duration = buffer.readUInt32LE(offset);
    offset += 4;

    // Frame count
    const frameCount = buffer.readUInt32LE(offset);
    offset += 4;

    // Universe count (v2 only; v1 reserved bytes are zero)
    const universeCount = version >= 2 ? buffer.readUInt16LE(offset) : 1;

    return {
      magic,
      version,
      flags,
      protocol,
      universe,
      universeCount,
      startTime,
      duration,
      frameCount,
    };
  }

  /**
   * Set callback for frame updates during playback
   */
  onFrame(callback: PlayerFrameCallback): void {
    this.onFrameCallback = callback;
  }

  /**
   * Set callback for playback finished
   */
  onFinished(callback: () => void): void {
    this.onFinishedCallback = callback;
  }

  /**
   * Set callback for position updates
   */
  onPosition(callback: (position: number, duration: number) => void): void {
    this.onPositionCallback = callback;
  }

  /**
   * Set callback for state changes
   */
  onStateChange(callback: (state: PlaybackState) => void): void {
    this.onStateChangeCallback = callback;
  }

  /**
   * Set playback state and notify listeners
   */
  private setState(newState: PlaybackState): void {
    if (this.state !== newState) {
      this.state = newState;
      if (this.onStateChangeCallback) {
        this.onStateChangeCallback(newState);
      }
    }
  }

  /** True if frames for this universe should be output */
  private isUniverseEnabled(universe: number): boolean {
    return !this.universeFilter || this.universeFilter.has(universe);
  }

  /** Apply a decoded frame to the per-universe state */
  private applyFrame(frame: RecordingFrame): Uint8Array {
    let ch = this.channels.get(frame.universe);
    if (!ch) {
      ch = new Uint8Array(TOTAL_CHANNELS);
      this.channels.set(frame.universe, ch);
    }
    if (frame.isSnapshot && frame.snapshotData) {
      ch.set(frame.snapshotData);
    } else {
      for (const change of frame.changes) {
        ch[change.channel] = change.value;
      }
    }
    return ch;
  }

  /** Emit the current state of every (enabled) universe */
  private emitAllUniverses(): void {
    if (!this.onFrameCallback) return;
    const list = this.universes.length > 0 ? this.universes : Array.from(this.channels.keys());
    for (const universe of list) {
      if (!this.isUniverseEnabled(universe)) continue;
      this.onFrameCallback(universe, this.getChannels(universe));
    }
  }

  /** Cancel the frame timer, returning any read-but-unapplied frame to the stream */
  private cancelPendingFrame(): void {
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    if (this.pending) {
      this.frameOffset = this.pending.startOffset;
      this.currentPosition -= this.pending.deltaTime;
      this.pending = null;
    }
  }

  /**
   * Start or resume playback
   */
  play(): void {
    if (!this.frameData || !this.header) {
      throw new Error("No recording loaded");
    }

    if (this.state === "playing") return;

    if (this.state === "paused") {
      // Resume from paused position - adjust for speed
      this.playbackStartTime = Date.now() - (this.pausedPosition / this.speed);
    } else {
      // Start from beginning
      this.playbackStartTime = Date.now();
      this.frameOffset = 0;
      this.currentFrame = 0;
      this.currentPosition = 0;
      this.channels.clear();
    }

    this.setState("playing");
    this.scheduleNextFrame();

    logInfo("Playback started", { position: this.currentPosition, speed: this.speed });
  }

  /**
   * Pause playback
   */
  pause(): void {
    if (this.state !== "playing") return;

    this.cancelPendingFrame();

    this.pausedPosition = this.currentPosition;
    this.setState("paused");

    logInfo("Playback paused", { position: this.currentPosition });
  }

  /**
   * Toggle play/pause
   */
  togglePlayPause(): void {
    if (this.state === "playing") {
      this.pause();
    } else if (this.state === "paused" || this.state === "idle" || this.state === "finished") {
      if (this.state === "finished") {
        // Reset to beginning if finished
        this.frameOffset = 0;
        this.currentFrame = 0;
        this.currentPosition = 0;
        this.pausedPosition = 0;
        this.channels.clear();
      }
      this.play();
    }
  }

  /**
   * Stop playback and reset to beginning
   */
  stop(): void {
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.pending = null;

    this.frameOffset = 0;
    this.currentFrame = 0;
    this.currentPosition = 0;
    this.pausedPosition = 0;
    this.channels.clear();
    this.setState("idle");

    // Emit position update
    if (this.onPositionCallback && this.header) {
      this.onPositionCallback(0, this.totalDuration);
    }

    // Emit zeroed frames (blackout) for every universe in the recording
    this.emitAllUniverses();

    logInfo("Playback stopped");
  }

  /**
   * Set playback speed
   */
  setSpeed(speed: number): void {
    const clampedSpeed = Math.max(0.1, Math.min(10.0, speed));

    if (this.state === "playing") {
      // Adjust playback start time to maintain position
      const elapsed = this.currentPosition;
      this.speed = clampedSpeed;
      this.playbackStartTime = Date.now() - (elapsed / this.speed);
    } else {
      this.speed = clampedSpeed;
    }

    logInfo("Playback speed changed", { speed: this.speed });
  }

  /**
   * Increase speed to next preset
   */
  increaseSpeed(): void {
    const currentIndex = SPEED_PRESETS.findIndex(s => s >= this.speed);
    if (currentIndex < SPEED_PRESETS.length - 1) {
      this.setSpeed(SPEED_PRESETS[currentIndex + 1] ?? this.speed);
    }
  }

  /**
   * Decrease speed to previous preset
   */
  decreaseSpeed(): void {
    const currentIndex = SPEED_PRESETS.findIndex(s => s >= this.speed);
    if (currentIndex > 0) {
      this.setSpeed(SPEED_PRESETS[currentIndex - 1] ?? this.speed);
    } else if (currentIndex === -1) {
      // Speed is higher than all presets, go to highest preset
      this.setSpeed(SPEED_PRESETS[SPEED_PRESETS.length - 1] ?? this.speed);
    }
  }

  /**
   * Toggle loop mode
   */
  toggleLoop(): void {
    this.loopEnabled = !this.loopEnabled;
    logInfo("Loop mode changed", { enabled: this.loopEnabled });
  }

  /**
   * Set loop mode
   */
  setLoop(enabled: boolean): void {
    this.loopEnabled = enabled;
    logInfo("Loop mode set", { enabled: this.loopEnabled });
  }

  /**
   * Seek to a specific position (ms).
   *
   * Frames of different universes are interleaved with per-universe
   * snapshots, so the state at any position is rebuilt by replaying the
   * (in-memory) stream from the start without emitting anything.
   */
  seek(positionMs: number): void {
    if (!this.frameData || !this.header) return;

    const wasPlaying = this.state === "playing";

    if (wasPlaying) {
      if (this.playbackTimer) {
        clearTimeout(this.playbackTimer);
        this.playbackTimer = null;
      }
      this.pending = null;
    }

    // Clamp position
    const targetPosition = Math.max(0, Math.min(positionMs, this.totalDuration));

    this.channels.clear();
    this.frameOffset = 0;
    this.currentPosition = 0;
    this.currentFrame = 0;

    // Replay frames up to the target position
    for (;;) {
      const startOffset = this.frameOffset;
      const frame = this.readNextFrame();
      if (!frame) break;

      if (this.currentPosition + frame.deltaTime > targetPosition) {
        // Went past target, back up
        this.frameOffset = startOffset;
        break;
      }

      this.currentPosition += frame.deltaTime;
      this.currentFrame++;
      this.applyFrame(frame);
    }

    this.pausedPosition = this.currentPosition;

    // Emit position update
    if (this.onPositionCallback) {
      this.onPositionCallback(this.currentPosition, this.totalDuration);
    }

    // Emit the rebuilt state of every universe
    this.emitAllUniverses();

    logInfo("Seeked to position", { position: this.currentPosition, target: targetPosition });

    // Resume if was playing
    if (wasPlaying) {
      this.playbackStartTime = Date.now() - (this.currentPosition / this.speed);
      this.setState("playing");
      this.scheduleNextFrame();
    }
  }

  /**
   * Seek forward by specified milliseconds
   */
  seekForward(ms: number = 5000): void {
    this.seek(this.currentPosition + ms);
  }

  /**
   * Seek backward by specified milliseconds
   */
  seekBackward(ms: number = 5000): void {
    this.seek(this.currentPosition - ms);
  }

  /** Restart from the beginning for looping */
  private restartForLoop(): void {
    logInfo("Looping playback");
    this.frameOffset = 0;
    this.currentFrame = 0;
    this.currentPosition = 0;
    this.channels.clear();
    this.playbackStartTime = Date.now();
    this.scheduleNextFrame();
  }

  /**
   * Schedule the next frame for playback
   */
  private scheduleNextFrame(): void {
    if (this.state !== "playing" || !this.frameData || !this.header) return;

    const startOffset = this.frameOffset;
    const frame = this.frameOffset >= this.frameData.length ? null : this.readNextFrame();

    // End of recording
    if (!frame) {
      if (this.loopEnabled && this.totalFrames > 0) {
        this.restartForLoop();
        return;
      }

      this.setState("finished");
      if (this.onFinishedCallback) {
        this.onFinishedCallback();
      }
      return;
    }

    // Calculate when this frame should be output (adjusted for speed)
    this.currentPosition += frame.deltaTime;
    const adjustedPosition = this.currentPosition / this.speed;
    const targetTime = this.playbackStartTime + adjustedPosition;
    const delay = Math.max(0, targetTime - Date.now());

    this.pending = { startOffset, deltaTime: frame.deltaTime };
    this.playbackTimer = setTimeout(() => {
      this.playbackTimer = null;
      this.pending = null;

      // Apply frame to the universe's channel data
      const channels = this.applyFrame(frame);
      this.currentFrame++;

      // Emit frame (only for enabled universes)
      if (this.onFrameCallback && this.isUniverseEnabled(frame.universe)) {
        this.onFrameCallback(frame.universe, channels);
      }

      // Emit position update
      if (this.onPositionCallback) {
        this.onPositionCallback(this.currentPosition, this.totalDuration);
      }

      // Schedule next frame
      this.scheduleNextFrame();
    }, delay);
  }

  /**
   * Read the next frame from the buffer. Returns null at end of data.
   * Throws RangeError on a truncated frame.
   */
  private readNextFrame(): RecordingFrame | null {
    if (!this.frameData || !this.header || this.frameOffset >= this.frameData.length) {
      return null;
    }

    const isV2 = this.header.version >= 2;
    const data = this.frameData;

    // Read delta time (varint)
    const { value: deltaTime, bytesRead: deltaBytes } = decodeVarint(data, this.frameOffset);
    let offset = this.frameOffset + deltaBytes;

    // v2: universe for this frame
    let universe = this.header.universe;
    if (isV2) {
      universe = data.readUInt16LE(offset);
      offset += 2;
    }

    // Read change count
    const changeCount = data[offset++];
    if (changeCount === undefined) return null;

    // Check for snapshot frame
    if (changeCount === FrameType.SNAPSHOT) {
      if (offset + TOTAL_CHANNELS > data.length) {
        throw new RangeError("Truncated snapshot frame");
      }
      const snapshotData = new Uint8Array(data.subarray(offset, offset + TOTAL_CHANNELS));
      this.frameOffset = offset + TOTAL_CHANNELS;

      return {
        universe,
        deltaTime,
        changes: [],
        isSnapshot: true,
        snapshotData,
      };
    }

    // Read change count (possibly extended)
    let actualChangeCount = changeCount;
    if (changeCount === FrameType.EXTENDED) {
      actualChangeCount = data.readUInt16LE(offset);
      offset += 2;
    }

    if (offset + actualChangeCount * 3 > data.length) {
      throw new RangeError("Truncated delta frame");
    }

    // Read changes
    const changes: ChannelChange[] = [];
    for (let i = 0; i < actualChangeCount; i++) {
      const channel = data.readUInt16LE(offset);
      offset += 2;
      const value = data[offset++];
      if (value !== undefined && channel < TOTAL_CHANNELS) {
        changes.push({ channel, value });
      }
    }

    this.frameOffset = offset;

    return {
      universe,
      deltaTime,
      changes,
      isSnapshot: false,
    };
  }
}

/**
 * Create a new DMX recorder
 */
export function createRecorder(): DMXRecorder {
  return new DMXRecorder();
}

/**
 * Create a new DMX player
 */
export function createPlayer(): DMXPlayer {
  return new DMXPlayer();
}
