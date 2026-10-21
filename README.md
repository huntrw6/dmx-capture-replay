# DMX Monitor

Monitor, record, and play back sACN and Art-Net. Supports many universes at once.

## Setup

Needs Node.js 20 or later.

```bash
npm install
npm run build
```

## Use

```bash
# Guided setup
node dist/index.js

# Monitor and record universes 1 to 4 (sACN)
node dist/index.js -p sacn -u 1-4 -m -o ./recordings

# Record all Art-Net universes
node dist/index.js -p artnet -b --all-universes

# Play back
node dist/index.js --playback rec.dmxrec
node dist/index.js --playback rec.dmxrec --loop --speed 2
node dist/index.js --playback rec.dmxrec -u 1,3
node dist/index.js --playback rec.dmxrec --map 1=11,2=12
```

## Options

| Option | Use |
| --- | --- |
| `-p` | `sacn` or `artnet` |
| `-u` | Universes: `1`, `1,2,5`, `1-4` |
| `--all-universes` | All universes (Art-Net only) |
| `-m` / `-b` | sACN multicast / Art-Net broadcast |
| `-i` / `-a` | Network interface / IP address |
| `-o` | Folder for recordings |
| `--playback` | File to play |
| `--map` | Playback remap: `SRC=DST,...` |
| `--loop`, `--speed` | Repeat, speed from 0.1 to 10 |
| `--priority` | sACN priority from 0 to 200 |

## Keys

| Key | Action |
| --- | --- |
| `R` | Start or stop recording |
| `[` `]` | Show previous or next universe |
| `V` / `C` | Toggle values and channels / clear |
| `Space`, `S`, `L` | Play or pause, stop, loop |
| `+` `-` | Speed |
| `←` `→` | Seek 5 seconds |
| `Q` | Quit |
