// Writes a 3-universe, ~1.5 s recording to the path in argv[2]
const { createRecorder } = require("../dist/recorder");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const dir = require("path").dirname(process.argv[2]);
  const rec = createRecorder();
  const f = rec.startRecording("sacn", dir);
  for (let i = 0; i < 6; i++) {
    for (const u of [1, 2, 3]) { const c = new Uint8Array(512).fill(u * 10); c[0] = i * 40; rec.recordFrame(u, c); }
    await sleep(250);
  }
  rec.stopRecording();
  require("fs").renameSync(f, process.argv[2]);
})();
