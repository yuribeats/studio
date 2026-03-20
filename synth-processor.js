// KR-106 Web Audio Worklet — 6-voice polyphonic Juno-106 emulation
// Ported from the JUCE C++ DSP by Claude

const NUM_VOICES = 6;
const PARAM_SMOOTH_COEFF = 0.005;

// PolyBLEP residual for anti-aliased waveforms
function polyblep(t, dt) {
  if (t < dt) {
    const u = t / dt;
    return u + u - u * u - 1;
  } else if (t > 1 - dt) {
    const u = (t - 1) / dt;
    return u * u + u + u + 1;
  }
  return 0;
}

// Audio taper curve: (exp(3t)-1)/(exp(3)-1)
function audioTaper(t) {
  return (Math.exp(3 * t) - 1) / (Math.exp(3) - 1);
}

// 1-pole TPT lowpass filter
class OnePole {
  constructor() { this.s = 0; }
  process(x, g) {
    const v = (x - this.s) * g / (1 + g);
    const y = v + this.s;
    this.s = y + v;
    return y;
  }
  reset() { this.s = 0; }
}

// 4-pole cascaded OTA ladder filter (IR3109)
class LadderFilter {
  constructor() {
    this.s = [0, 0, 0, 0];
  }
  process(x, cutoff, res, sr) {
    const fc = Math.max(20, Math.min(cutoff, sr * 0.49));
    const g = Math.tan(Math.PI * fc / sr);
    const G = g / (1 + g);
    const G4 = G * G * G * G;
    const S = this.s[0] * G * G * G + this.s[1] * G * G + this.s[2] * G + this.s[3];
    const k = res * 4;
    const u = (x - k * S) / (1 + k * G4);
    let v = u;
    for (let i = 0; i < 4; i++) {
      const vn = (v - this.s[i]) * G;
      const out = vn + this.s[i];
      this.s[i] = out + vn;
      v = out;
    }
    return v;
  }
  reset() { this.s.fill(0); }
}

// ADSR envelope with exponential curves
class ADSR {
  constructor() {
    this.state = 0; // 0=idle, 1=attack, 2=decay, 3=sustain, 4=release
    this.output = 0;
    this.attackRate = 0;
    this.decayRate = 0;
    this.sustainLevel = 0.5;
    this.releaseRate = 0;
  }
  gate(on) {
    if (on) {
      this.state = 1;
    } else if (this.state !== 0) {
      this.state = 4;
    }
  }
  setParams(a, d, s, r, sr) {
    // Attack: 0.5ms to 2s
    const aTime = 0.0005 + a * a * 2.0;
    this.attackRate = 1.0 / (aTime * sr);
    // Decay: 5ms to 20s
    const dTime = 0.005 + d * d * 20.0;
    this.decayRate = Math.exp(-1.0 / (dTime * sr));
    this.sustainLevel = s;
    // Release: 5ms to 20s
    const rTime = 0.005 + r * r * 20.0;
    this.releaseRate = Math.exp(-1.0 / (rTime * sr));
  }
  process() {
    switch (this.state) {
      case 1: // attack
        this.output += this.attackRate;
        if (this.output >= 1) {
          this.output = 1;
          this.state = 2;
        }
        break;
      case 2: // decay
        this.output = this.sustainLevel + (this.output - this.sustainLevel) * this.decayRate;
        if (Math.abs(this.output - this.sustainLevel) < 0.001) {
          this.output = this.sustainLevel;
          this.state = 3;
        }
        break;
      case 3: // sustain
        this.output = this.sustainLevel;
        break;
      case 4: // release
        this.output *= this.releaseRate;
        if (this.output < 0.0001) {
          this.output = 0;
          this.state = 0;
        }
        break;
    }
    return this.output;
  }
  isActive() { return this.state !== 0; }
  reset() { this.state = 0; this.output = 0; }
}

// Single synth voice
class Voice {
  constructor(sr, voiceIdx) {
    this.sr = sr;
    this.voiceIdx = voiceIdx;
    this.note = -1;
    this.velocity = 0;
    this.phase = Math.random();
    this.subToggle = 0;
    this.lastSaw = 0;
    this.filter = new LadderFilter();
    this.env = new ADSR();
    this.dcBlock = new OnePole();
    this.noiseState = 0x12345678 + voiceIdx * 1337;
    // Per-voice analog variance
    this.pitchOffset = (Math.random() - 0.5) * 0.06; // ±3 cents
    this.filterOffset = (Math.random() - 0.5) * 0.1;  // ±5%
    this.gainScale = 1.0 + (Math.random() - 0.5) * 0.12; // ±0.5dB
    this.targetFreq = 0;
    this.currentFreq = 0;
    this.portaCoeff = 0;
  }

  noteOn(note, vel, freq, porta) {
    this.note = note;
    this.velocity = Math.sqrt(vel / 127); // sqrt velocity curve
    this.targetFreq = freq;
    if (porta > 0 && this.currentFreq > 0) {
      // Portamento: glide from current to target
      const time = 0.001 + porta * porta * 3.0;
      this.portaCoeff = Math.exp(-1.0 / (time * this.sr));
    } else {
      this.currentFreq = freq;
      this.portaCoeff = 0;
    }
    this.env.gate(true);
  }

  noteOff() {
    this.env.gate(false);
  }

  lcgNoise() {
    this.noiseState = (this.noiseState * 1664525 + 1013904223) & 0xFFFFFFFF;
    return ((this.noiseState >>> 0) / 0xFFFFFFFF) * 2 - 1;
  }

  process(params) {
    if (!this.env.isActive()) return 0;

    const { sr } = this;

    // Portamento
    if (this.portaCoeff > 0) {
      this.currentFreq = this.targetFreq + (this.currentFreq - this.targetFreq) * this.portaCoeff;
    } else {
      this.currentFreq = this.targetFreq;
    }

    // LFO modulation on pitch
    const lfoMod = params.lfoValue * params.dcoLfo * 4.0; // ±4 semitones
    const pitchSemitones = lfoMod + this.pitchOffset;
    const freq = this.currentFreq * Math.pow(2, pitchSemitones / 12);
    const dt = freq / sr;

    // Oscillator phase
    this.phase += dt;
    if (this.phase >= 1) {
      this.phase -= 1;
      this.subToggle = 1 - this.subToggle;
    }

    // Sawtooth with PolyBLEP
    let saw = 2 * this.phase - 1;
    saw -= polyblep(this.phase, dt);

    // Pulse with PolyBLEP
    const pw = 0.5 + params.pwm * 0.47; // 50-97% duty
    let pulse = this.phase < pw ? 1 : -1;
    pulse += polyblep(this.phase, dt);
    pulse -= polyblep((this.phase - pw + 1) % 1, dt);
    pulse *= 0.5;

    // Sub oscillator (square one octave down)
    const sub = this.subToggle ? 0.625 : -0.625;

    // Noise (filtered)
    const n1 = this.lcgNoise();
    const n2 = this.lcgNoise();
    const noise = (n1 + n2) * 0.5;

    // Mix oscillators
    let osc = 0;
    if (params.sawOn) osc += saw * 0.5;
    if (params.pulseOn) osc += pulse * 0.5;
    if (params.subOn) osc += sub * audioTaper(params.subLevel);
    osc += noise * audioTaper(params.noiseLevel);

    // Envelope
    this.env.setParams(params.envA, params.envD, params.envS, params.envR, sr);
    const envVal = this.env.process();

    // VCF
    let cutoff = params.vcfFreq;
    // Keyboard tracking
    cutoff *= Math.pow(2, ((this.note - 60) / 12) * params.vcfKbd);
    // Envelope modulation
    const envMod = params.vcfEnvInv ? -envVal : envVal;
    cutoff *= Math.pow(2, envMod * params.vcfEnv * 5);
    // LFO modulation on filter
    cutoff *= Math.pow(2, params.lfoValue * params.vcfLfo * 3);
    // Per-voice variance
    cutoff *= (1 + this.filterOffset);

    cutoff = Math.max(20, Math.min(cutoff, sr * 0.49));

    let out = this.filter.process(osc, cutoff, params.vcfRes, sr);

    // HPF
    if (params.hpf > 0) {
      const hpfFreqs = [0, 5, 240, 720];
      const hpfIdx = Math.min(3, Math.round(params.hpf * 3));
      const hpfCut = hpfFreqs[hpfIdx];
      if (hpfCut > 5) {
        const hpfG = Math.tan(Math.PI * hpfCut / sr);
        const hpfCoeff = hpfG / (1 + hpfG);
        const lp = this.dcBlock.process(out, hpfG / (1 + hpfG));
        out = out - lp;
      }
    }

    // VCA
    const vcaMode = params.vcaMode; // 0=ADSR, 1=Gate
    const vcaEnv = vcaMode === 1 ? (envVal > 0.001 ? 1 : 0) : envVal;
    out *= vcaEnv * this.velocity * this.gainScale * params.vcaLevel;

    return out;
  }

  isActive() { return this.env.isActive(); }
  reset() {
    this.phase = Math.random();
    this.subToggle = 0;
    this.filter.reset();
    this.env.reset();
    this.dcBlock.reset();
    this.note = -1;
    this.currentFreq = 0;
  }
}

// BBD Chorus (MN3009 emulation)
class BBDChorus {
  constructor(sr) {
    this.sr = sr;
    this.maxDelay = Math.ceil(sr * 0.015); // 15ms max
    this.bufferL = new Float32Array(this.maxDelay);
    this.bufferR = new Float32Array(this.maxDelay);
    this.writePos = 0;
    this.lfoPhase = 0;
    this.preFilter = [new OnePole(), new OnePole()];
    this.postFilter = [new OnePole(), new OnePole()];
  }

  hermite(buf, pos) {
    const len = buf.length;
    const i = Math.floor(pos);
    const f = pos - i;
    const xm1 = buf[(i - 1 + len) % len];
    const x0 = buf[i % len];
    const x1 = buf[(i + 1) % len];
    const x2 = buf[(i + 2) % len];
    const c = (x1 - xm1) * 0.5;
    const v = x0 - x1;
    const w = c + v;
    const a = w + v + (x2 - x0) * 0.5;
    const b = w + a;
    return ((a * f - b) * f + c) * f + x0;
  }

  process(input, mode) {
    if (mode === 0) return input; // bypass

    const sr = this.sr;
    let lfoRate, depth, centerMs;

    if (mode === 3) { // I+II (vibrato)
      lfoRate = 8.0;
      depth = 0.0004;
      centerMs = 3.0;
    } else if (mode === 1) { // I
      lfoRate = 0.45;
      depth = 0.002;
      centerMs = 3.0;
    } else { // II
      lfoRate = 0.67;
      depth = 0.002;
      centerMs = 3.0;
    }

    // LFO
    this.lfoPhase += lfoRate / sr;
    if (this.lfoPhase >= 1) this.lfoPhase -= 1;
    // Rounded triangle
    let tri = 1 - 4 * Math.abs(this.lfoPhase - 0.5);
    if (mode === 3) {
      tri = Math.sin(2 * Math.PI * this.lfoPhase); // sine for vibrato
    } else {
      tri *= (1.5 - 0.5 * tri * tri); // soft clip
    }

    // Delay times
    const centerSamples = centerMs * sr / 1000;
    const modSamples = depth * sr;
    const delayL = centerSamples + tri * modSamples;
    const delayR = centerSamples - tri * modSamples;

    // Pre-filter (anti-alias)
    const preG = Math.tan(Math.PI * 8000 / sr);
    const filtered = this.preFilter[0].process(input, preG);

    // Write to buffer
    this.bufferL[this.writePos] = filtered;
    this.bufferR[this.writePos] = filtered;

    // Read with Hermite interpolation
    const readPosL = (this.writePos - delayL + this.maxDelay * 2) % this.maxDelay;
    const readPosR = (this.writePos - delayR + this.maxDelay * 2) % this.maxDelay;
    let wetL = this.hermite(this.bufferL, readPosL);
    let wetR = this.hermite(this.bufferR, readPosR);

    // BBD charge-well saturation
    const saturate = (x) => {
      const abs = Math.abs(x);
      if (abs > 0.7) {
        const d = abs - 0.7;
        return Math.sign(x) * (0.7 + d / (1 + 2 * d));
      }
      return x;
    };
    wetL = saturate(wetL);
    wetR = saturate(wetR);

    // Post-filter
    const postG = Math.tan(Math.PI * 6000 / sr);
    wetL = this.postFilter[0].process(wetL, postG);
    wetR = this.postFilter[1].process(wetR, postG);

    this.writePos = (this.writePos + 1) % this.maxDelay;

    // Mix: dry + wet with hardware gains
    const dryGain = 1.275; // +2.1dB
    const wetGain = 1.345; // +2.6dB
    return {
      left: input * dryGain + wetL * wetGain,
      right: input * dryGain + wetR * wetGain
    };
  }

  reset() {
    this.bufferL.fill(0);
    this.bufferR.fill(0);
    this.writePos = 0;
    this.lfoPhase = 0;
    this.preFilter.forEach(f => f.reset());
    this.postFilter.forEach(f => f.reset());
  }
}

// LFO with delay envelope
class LFO {
  constructor(sr) {
    this.sr = sr;
    this.phase = 0;
    this.delayEnv = 0;
    this.delayCoeff = 0;
    this.rate = 1;
  }

  setParams(rate, delay) {
    this.rate = 0.1 + rate * rate * 15; // 0.1-15 Hz
    const delayTime = delay * 1.5;
    if (delayTime > 0.001) {
      this.delayCoeff = 1 - Math.exp(-1 / (delayTime * this.sr));
    } else {
      this.delayCoeff = 1;
    }
  }

  process(gateOn) {
    this.phase += this.rate / this.sr;
    if (this.phase >= 1) this.phase -= 1;
    // Rounded triangle
    let tri = 1 - 4 * Math.abs(this.phase - 0.5);
    tri *= (1.5 - 0.5 * tri * tri);
    // Delay envelope
    if (gateOn) {
      this.delayEnv += (1 - this.delayEnv) * this.delayCoeff;
    } else {
      this.delayEnv *= 0.999;
    }
    return tri * this.delayEnv;
  }

  reset() { this.phase = 0; this.delayEnv = 0; }
}

// Arpeggiator
class Arpeggiator {
  constructor(sr) {
    this.sr = sr;
    this.enabled = false;
    this.mode = 0; // 0=up, 1=up-down, 2=down
    this.range = 0; // 0=1oct, 1=2oct, 2=3oct
    this.rate = 0.5;
    this.notes = [];
    this.stepIdx = 0;
    this.direction = 1;
    this.octave = 0;
    this.sampleCounter = 0;
    this.samplesPerStep = 0;
    this.currentNote = -1;
  }

  setRate(r) {
    const hz = 1.5 + r * 47;
    this.samplesPerStep = Math.floor(this.sr / hz);
  }

  addNote(note) {
    if (!this.notes.includes(note)) {
      this.notes.push(note);
      this.notes.sort((a, b) => a - b);
    }
  }

  removeNote(note) {
    this.notes = this.notes.filter(n => n !== note);
  }

  tick() {
    if (!this.enabled || this.notes.length === 0) return null;

    this.sampleCounter++;
    if (this.sampleCounter < this.samplesPerStep) return undefined; // no change
    this.sampleCounter = 0;

    const numOctaves = this.range + 1;
    const len = this.notes.length;
    let note;

    if (this.mode === 0) { // up
      note = this.notes[this.stepIdx % len] + this.octave * 12;
      this.stepIdx++;
      if (this.stepIdx >= len) {
        this.stepIdx = 0;
        this.octave = (this.octave + 1) % numOctaves;
      }
    } else if (this.mode === 2) { // down
      const idx = len - 1 - (this.stepIdx % len);
      note = this.notes[idx] + (numOctaves - 1 - this.octave) * 12;
      this.stepIdx++;
      if (this.stepIdx >= len) {
        this.stepIdx = 0;
        this.octave = (this.octave + 1) % numOctaves;
      }
    } else { // up-down
      note = this.notes[this.stepIdx] + this.octave * 12;
      if (this.direction === 1) {
        this.stepIdx++;
        if (this.stepIdx >= len) {
          if (this.octave < numOctaves - 1) {
            this.octave++;
            this.stepIdx = 0;
          } else {
            this.direction = -1;
            this.stepIdx = Math.max(0, len - 2);
          }
        }
      } else {
        this.stepIdx--;
        if (this.stepIdx < 0) {
          if (this.octave > 0) {
            this.octave--;
            this.stepIdx = len - 1;
          } else {
            this.direction = 1;
            this.stepIdx = Math.min(1, len - 1);
            this.octave = 0;
          }
        }
      }
    }

    this.currentNote = note;
    return note;
  }

  reset() {
    this.stepIdx = 0;
    this.direction = 1;
    this.octave = 0;
    this.sampleCounter = 0;
    this.currentNote = -1;
  }
}

class KR106Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate;
    this.voices = [];
    for (let i = 0; i < NUM_VOICES; i++) {
      this.voices.push(new Voice(this.sr, i));
    }
    this.chorus = new BBDChorus(this.sr);
    this.lfo = new LFO(this.sr);
    this.arp = new Arpeggiator(this.sr);

    // Scope buffer for waveform display
    this.scopeBuf = new Float32Array(256);
    this.scopeIdx = 0;
    this.scopeCounter = 0;
    this.scopeDownsample = Math.floor(this.sr / 256 / 30); // ~30fps

    // Current params (all 0-1 slider values)
    this.p = {
      dcoLfo: 0, dcoPwm: 0.5, dcoSub: 0.5, dcoNoise: 0,
      sawOn: true, pulseOn: false, subOn: true,
      vcfFreq: 0.5, vcfRes: 0, vcfEnv: 0.3, vcfLfo: 0, vcfKbd: 0.5,
      vcfEnvInv: false,
      envA: 0.02, envD: 0.3, envS: 0.6, envR: 0.2,
      vcaLevel: 0.8, vcaMode: 0,
      hpf: 0,
      chorusMode: 1,
      lfoRate: 0.3, lfoDelay: 0.3,
      portaRate: 0,
      transpose: 0,
      masterVol: 0.8,
      arpEnabled: false, arpMode: 0, arpRange: 0, arpRate: 0.5
    };

    // Target params (from UI)
    this.target = { ...this.p };

    // Voice allocation
    this.nextVoice = 0;
    this.heldNotes = new Map(); // note -> voice index

    this.anyGateOn = false;

    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    if (msg.type === 'noteOn') {
      this.doNoteOn(msg.note, msg.velocity || 100);
    } else if (msg.type === 'noteOff') {
      this.doNoteOff(msg.note);
    } else if (msg.type === 'param') {
      this.target[msg.name] = msg.value;
    } else if (msg.type === 'preset') {
      Object.assign(this.target, msg.params);
      // Instant apply for presets (no smoothing lag)
      Object.assign(this.p, msg.params);
    }
  }

  doNoteOn(note, vel) {
    const transposedNote = note + this.p.transpose;

    if (this.arp.enabled) {
      this.arp.addNote(transposedNote);
      return;
    }

    const freq = 440 * Math.pow(2, (transposedNote - 69) / 12);
    let voiceIdx;

    // Check if note is already playing
    if (this.heldNotes.has(transposedNote)) {
      voiceIdx = this.heldNotes.get(transposedNote);
    } else {
      // Find free voice or steal oldest
      voiceIdx = -1;
      for (let i = 0; i < NUM_VOICES; i++) {
        if (!this.voices[i].isActive()) {
          voiceIdx = i;
          break;
        }
      }
      if (voiceIdx === -1) {
        voiceIdx = this.nextVoice;
        // Remove old note mapping
        for (const [n, v] of this.heldNotes) {
          if (v === voiceIdx) { this.heldNotes.delete(n); break; }
        }
      }
      this.nextVoice = (this.nextVoice + 1) % NUM_VOICES;
    }

    this.voices[voiceIdx].noteOn(transposedNote, vel, freq, this.p.portaRate);
    this.heldNotes.set(transposedNote, voiceIdx);
    this.anyGateOn = true;
  }

  doNoteOff(note) {
    const transposedNote = note + this.p.transpose;

    if (this.arp.enabled) {
      this.arp.removeNote(transposedNote);
      if (this.arp.notes.length === 0) {
        // Release all voices
        for (const v of this.voices) v.noteOff();
        this.heldNotes.clear();
        this.anyGateOn = false;
      }
      return;
    }

    if (this.heldNotes.has(transposedNote)) {
      const idx = this.heldNotes.get(transposedNote);
      this.voices[idx].noteOff();
      this.heldNotes.delete(transposedNote);
    }
    this.anyGateOn = this.heldNotes.size > 0;
  }

  // PWM computation
  getPWM() {
    // PWM from LFO or manual
    return this.p.dcoPwm;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || left;
    const len = left.length;

    // Smooth params
    const s = PARAM_SMOOTH_COEFF;
    for (const key of ['dcoLfo', 'dcoPwm', 'dcoSub', 'dcoNoise',
      'vcfFreq', 'vcfRes', 'vcfEnv', 'vcfLfo', 'vcfKbd',
      'envA', 'envD', 'envS', 'envR',
      'vcaLevel', 'hpf', 'lfoRate', 'lfoDelay', 'portaRate', 'masterVol']) {
      this.p[key] += (this.target[key] - this.p[key]) * s;
    }
    // Instant switches
    this.p.sawOn = this.target.sawOn;
    this.p.pulseOn = this.target.pulseOn;
    this.p.subOn = this.target.subOn;
    this.p.vcfEnvInv = this.target.vcfEnvInv;
    this.p.vcaMode = this.target.vcaMode;
    this.p.chorusMode = this.target.chorusMode;
    this.p.transpose = this.target.transpose;

    // Arp params
    this.arp.enabled = this.target.arpEnabled || false;
    this.arp.mode = this.target.arpMode || 0;
    this.arp.range = this.target.arpRange || 0;
    this.arp.setRate(this.target.arpRate || 0.5);

    // LFO
    this.lfo.setParams(this.p.lfoRate, this.p.lfoDelay);

    // Map VCF freq slider to Hz (j6 curve approximation)
    const vcfSlider = this.p.vcfFreq;
    const vcfHz = 20 * Math.pow(750, vcfSlider); // 20Hz to 15kHz

    const voiceParams = {
      sr: this.sr,
      dcoLfo: this.p.dcoLfo,
      pwm: this.getPWM(),
      subLevel: this.p.dcoSub,
      noiseLevel: this.p.dcoNoise,
      sawOn: this.p.sawOn,
      pulseOn: this.p.pulseOn,
      subOn: this.p.subOn,
      vcfFreq: vcfHz,
      vcfRes: this.p.vcfRes,
      vcfEnv: this.p.vcfEnv,
      vcfLfo: this.p.vcfLfo,
      vcfKbd: this.p.vcfKbd,
      vcfEnvInv: this.p.vcfEnvInv,
      envA: this.p.envA, envD: this.p.envD, envS: this.p.envS, envR: this.p.envR,
      vcaLevel: this.p.vcaLevel,
      vcaMode: this.p.vcaMode,
      hpf: this.p.hpf,
      lfoValue: 0
    };

    for (let i = 0; i < len; i++) {
      // LFO
      const lfoVal = this.lfo.process(this.anyGateOn);
      voiceParams.lfoValue = lfoVal;

      // Arpeggiator
      const arpNote = this.arp.tick();
      if (arpNote !== undefined && arpNote !== null) {
        // Release previous arp note
        for (const v of this.voices) v.noteOff();
        this.heldNotes.clear();
        // Play new note
        const freq = 440 * Math.pow(2, (arpNote - 69) / 12);
        const vi = this.nextVoice;
        this.nextVoice = (this.nextVoice + 1) % NUM_VOICES;
        this.voices[vi].noteOn(arpNote, 100, freq, 0);
        this.heldNotes.set(arpNote, vi);
        this.anyGateOn = true;
      }

      // Sum voices
      let mono = 0;
      for (let v = 0; v < NUM_VOICES; v++) {
        mono += this.voices[v].process(voiceParams);
      }
      mono *= 0.25; // headroom

      // Chorus
      const { left: cl, right: cr } = this.chorus.process(mono, this.p.chorusMode);

      // Master volume
      const vol = this.p.masterVol;
      left[i] = cl * vol;
      right[i] = cr * vol;

      // Scope
      this.scopeCounter++;
      if (this.scopeCounter >= this.scopeDownsample) {
        this.scopeCounter = 0;
        this.scopeBuf[this.scopeIdx] = left[i];
        this.scopeIdx = (this.scopeIdx + 1) % 256;
      }
    }

    // Send scope data periodically
    if (this.scopeIdx === 0) {
      this.port.postMessage({ type: 'scope', data: Array.from(this.scopeBuf) });
    }

    return true;
  }
}

registerProcessor('kr106-processor', KR106Processor);
