// Multi-universe record/playback tests. Run: npm run build && node --test test/
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dgram = require("dgram");
const { createRecorder, createPlayer } = require("../dist/recorder");
const { parseUniverseList, parseUniverseMap, convertUniverse } = require("../dist/types");
const { ArtNetTransmitter, SACNTransmitter } = require("../dist/transmitter");
const { ArtNetHandler } = require("../dist/protocols/artnet");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "dmxrec-"));
const frame = (fill) => new Uint8Array(512).fill(fill);

function playAll(player, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const t0 = Date.now();
    player.onFrame((u, ch) => events.push({ u, t: Date.now() - t0, first: ch[0], c10: ch[10], copy: Uint8Array.from(ch) }));
    player.onFinished(() => resolve(events));
    setTimeout(() => reject(new Error("playback timeout")), timeoutMs);
    player.play();
  });
}

test("parseUniverseList / parseUniverseMap / convertUniverse", () => {
  assert.deepStrictEqual(parseUniverseList("1"), [1]);
  assert.deepStrictEqual(parseUniverseList("3,1,2,2"), [1, 2, 3]);
  assert.deepStrictEqual(parseUniverseList("1-3, 7"), [1, 2, 3, 7]);
  assert.throws(() => parseUniverseList("a"));
  assert.throws(() => parseUniverseList("5-2"));
  assert.throws(() => parseUniverseList(""));
  assert.deepStrictEqual([...parseUniverseMap("1=5,2=6")], [[1, 5], [2, 6]]);
  assert.throws(() => parseUniverseMap("1:5"));
  assert.strictEqual(convertUniverse(0, "artnet", "sacn"), 1);
  assert.strictEqual(convertUniverse(1, "sacn", "artnet"), 0);
  assert.strictEqual(convertUniverse(4, "sacn", "sacn"), 4);
});

test("record 3 universes, play back: all universes, order, timing, data", async () => {
  const dir = tmp();
  const rec = createRecorder();
  const file = rec.startRecording("sacn", dir);
  rec.recordFrame(1, frame(10));
  await sleep(100);
  rec.recordFrame(2, frame(20));
  await sleep(100);
  rec.recordFrame(3, frame(30));
  await sleep(100);
  const u1 = frame(10); u1[10] = 99; // delta frame on universe 1 only
  rec.recordFrame(1, u1);
  rec.recordFrame(2, frame(20)); // unchanged -> no frame written
  await sleep(50);
  rec.stopRecording();
  assert.deepStrictEqual(rec.getRecordedUniverses(), [1, 2, 3]);

  const p = createPlayer();
  const header = p.load(file);
  assert.strictEqual(header.version, 2);
  assert.strictEqual(header.universeCount, 3);
  assert.deepStrictEqual(p.getUniverses(), [1, 2, 3]);
  assert.strictEqual(p.getTotalFrames(), 4);

  const ev = await playAll(p);
  assert.deepStrictEqual(ev.map((e) => e.u), [1, 2, 3, 1]);
  assert.deepStrictEqual(ev.map((e) => e.first), [10, 20, 30, 10]);
  assert.strictEqual(ev[3].c10, 99);
  assert.strictEqual(ev[0].c10, 10, "universe 1 snapshot");
  // inter-universe timing preserved (±40ms)
  assert.ok(Math.abs(ev[1].t - ev[0].t - 100) < 40, `gap1 ${ev[1].t - ev[0].t}`);
  assert.ok(Math.abs(ev[2].t - ev[1].t - 100) < 40, `gap2 ${ev[2].t - ev[1].t}`);
  assert.ok(Math.abs(ev[3].t - ev[2].t - 100) < 40, `gap3 ${ev[3].t - ev[2].t}`);
});

test("universe filter drops other universes but keeps timing", async () => {
  const dir = tmp();
  const rec = createRecorder();
  const file = rec.startRecording("artnet", dir);
  rec.recordFrame(0, frame(1));
  await sleep(60);
  rec.recordFrame(1, frame(2));
  await sleep(60);
  rec.recordFrame(2, frame(3));
  rec.stopRecording();
  const p = createPlayer();
  p.load(file);
  p.setUniverseFilter([2]);
  const ev = await playAll(p);
  assert.deepStrictEqual(ev.map((e) => e.u), [2]);
  assert.ok(ev[0].t >= 100, `waited for recorded offset, got ${ev[0].t}`);
});

test("seek rebuilds state of every universe; pause/resume loses no frames", async () => {
  const dir = tmp();
  const rec = createRecorder();
  const file = rec.startRecording("sacn", dir);
  rec.recordFrame(1, frame(1)); rec.recordFrame(2, frame(2));
  await sleep(200);
  const a = frame(1); a[5] = 50; rec.recordFrame(1, a);
  await sleep(200);
  const b = frame(2); b[5] = 60; rec.recordFrame(2, b);
  await sleep(100);
  rec.stopRecording();

  const p = createPlayer();
  p.load(file);
  let seen = [];
  p.onFrame((u, ch) => seen.push({ u, c5: ch[5] }));
  p.seek(250);
  const lastSeek = new Map(seen.map((e) => [e.u, e.c5]));
  assert.strictEqual(lastSeek.get(1), 50, "u1 delta applied by seek");
  assert.strictEqual(lastSeek.get(2), 2, "u2 still at snapshot value (delta at 400ms not applied yet)");
  p.seek(1000);
  seen = []; p.seek(1000);
  assert.strictEqual(new Map(seen.map((e) => [e.u, e.c5])).get(2), 60);

  // pause/resume: play, pause mid-way, resume, expect all 4 frames exactly once
  const p2 = createPlayer();
  p2.load(file);
  const got = [];
  p2.onFrame((u) => got.push(u));
  const done = new Promise((r) => p2.onFinished(r));
  p2.play();
  await sleep(100);
  p2.pause();
  await sleep(300);
  p2.play();
  await done;
  assert.deepStrictEqual(got, [1, 2, 1, 2]);
});

test("loop restarts and stop emits blackout for all universes", async () => {
  const dir = tmp();
  const rec = createRecorder();
  const file = rec.startRecording("sacn", dir);
  rec.recordFrame(1, frame(7)); rec.recordFrame(2, frame(8));
  await sleep(50);
  const x = frame(7); x[0] = 9; rec.recordFrame(1, x);
  rec.stopRecording();
  const p = createPlayer();
  p.load(file);
  p.setLoop(true);
  const got = [];
  p.onFrame((u, ch) => got.push([u, ch[0]]));
  p.play();
  await sleep(250);
  assert.ok(got.filter(([u]) => u === 2).length >= 2, "looped at least twice");
  got.length = 0;
  p.stop();
  assert.deepStrictEqual(got.sort((a, b) => a[0] - b[0]), [[1, 0], [2, 0]]);
});

test("v1 (single-universe) recordings still play", async () => {
  // Build a v1 file by hand: 32-byte header (version 1) + frames without universe field
  const hdr = Buffer.alloc(32);
  hdr.write("DMXR", 0, "ascii"); hdr.writeUInt8(1, 4); hdr.writeUInt8(1, 5); hdr.writeUInt8(0, 6);
  hdr.writeUInt16LE(7, 7); hdr.writeBigInt64LE(BigInt(Date.now()), 9); hdr.writeUInt32LE(40, 17); hdr.writeUInt32LE(2, 21);
  const snap = Buffer.concat([Buffer.from([0x00, 0xfe]), Buffer.alloc(512, 5)]);
  const delta = Buffer.from([40, 1, 3, 0, 77]); // +40ms, 1 change: ch3=77
  const file = path.join(tmp(), "v1.dmxrec");
  fs.writeFileSync(file, Buffer.concat([hdr, snap, delta]));
  const p = createPlayer();
  const h = p.load(file);
  assert.strictEqual(h.version, 1);
  assert.deepStrictEqual(p.getUniverses(), [7]);
  const ev = await playAll(p);
  assert.deepStrictEqual(ev.map((e) => e.u), [7, 7]);
  assert.strictEqual(ev[1].copy[3], 77);
  assert.strictEqual(ev[1].copy[0], 5);
});

test("truncated/unfinalised recording loads what is complete", async () => {
  const dir = tmp();
  const rec = createRecorder();
  const file = rec.startRecording("sacn", dir);
  rec.recordFrame(1, frame(1)); rec.recordFrame(2, frame(2));
  rec.stopRecording();
  const buf = fs.readFileSync(file);
  fs.writeFileSync(file, buf.subarray(0, buf.length - 100)); // cut into last snapshot
  const p = createPlayer();
  p.load(file);
  assert.deepStrictEqual(p.getUniverses(), [1]);
});

test("Art-Net end to end: receive 3 universes -> record -> play back -> receive again", async () => {
  const { ArtNetHandler } = require("../dist/protocols/artnet");
  const rxA = new ArtNetHandler({ bindAddress: "127.0.0.1", useBroadcast: false });
  const live = [];
  rxA.on("packet", (pk) => live.push(pk));
  await rxA.start();

  const rec = createRecorder();
  const file = rec.startRecording("artnet", tmp());
  rxA.on("packet", (pk) => rec.recordFrame(pk.universe, pk.channels));

  const tx = new ArtNetTransmitter({ universes: [0, 1, 2], targetAddress: "127.0.0.1" });
  await tx.start();
  for (let step = 0; step < 4; step++) {
    for (const u of [0, 1, 2]) {
      const f = frame(10 * (u + 1)); f[100] = step * 20 + u; // distinct per universe + step
      tx.send(u, f);
    }
    await sleep(60);
  }
  await sleep(100);
  rec.stopRecording();
  await tx.stop(); await rxA.stop();
  assert.deepStrictEqual(rec.getRecordedUniverses(), [0, 1, 2]);
  const sent = live.map((pk) => `${pk.universe}:${pk.channels[0]}:${pk.channels[100]}`);
  assert.strictEqual(sent.length, 12);

  // Replay through the real transmitter, remapped 0,1,2 -> 10,11,12, into a fresh receiver
  const rxB = new ArtNetHandler({ bindAddress: "127.0.0.1", useBroadcast: false });
  const replayed = [];
  rxB.on("packet", (pk) => replayed.push(pk));
  await rxB.start();
  const out = new ArtNetTransmitter({ universes: [10, 11, 12], targetAddress: "127.0.0.1" });
  await out.start();
  const p = createPlayer();
  p.load(file);
  p.onFrame((u, ch) => out.send(u + 10, ch));
  const done = new Promise((r) => p.onFinished(r));
  p.play();
  await done;
  await sleep(150);
  await out.stop(); await rxB.stop();

  const norm = replayed.map((pk) => `${pk.universe - 10}:${pk.channels[0]}:${pk.channels[100]}`);
  assert.deepStrictEqual(norm, sent, "replayed packets identical (universe, level, per-step value, order)");
});

test("sACN end to end over multicast (skipped if the host cannot do loopback multicast)", async (t) => {
  const { SACNHandler } = require("../dist/protocols/sacn");
  const rx = new SACNHandler({ bindAddress: "127.0.0.1", useMulticast: true, universes: [1, 2, 3] });
  const got = [];
  rx.on("packet", (pk) => got.push(pk));
  await rx.start();
  const tx = new SACNTransmitter({ universes: [1, 2, 3], interfaceAddress: "127.0.0.1" });
  await tx.start();
  for (const u of [1, 2, 3]) { const f = new Uint8Array(512); f[0] = 1; f[1] = 128; f[2] = 255; f[3] = u; tx.send(u, f); }
  await sleep(300);
  await tx.stop(); await rx.stop();
  if (got.length === 0) return t.skip("no loopback multicast delivery on this host");
  assert.deepStrictEqual([...new Set(got.map((p) => p.universe))].sort(), [1, 2, 3]);
  const g = got.find((p) => p.universe === 2);
  // exact values survive: 1 and 128 and 255 (the old percent path rounded 1 -> 1, 128 -> 128 but is lossy in general)
  assert.deepStrictEqual([g.channels[0], g.channels[1], g.channels[2], g.channels[3]], [1, 128, 255, 2]);
});
