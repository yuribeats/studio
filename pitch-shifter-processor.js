/**
 * Granular pitch shifter AudioWorklet.
 * Four overlapping Hann-windowed grains read from a circular buffer
 * at a modified rate. Larger grain size and more overlap for smoother results.
 */
class PitchShifterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pitchFactor = 1.0;
    this.bufLen = 65536;
    this.grainSize = 8192;
    this.numGrains = 4;
    this.grainSpacing = this.grainSize / this.numGrains;

    // Circular buffers per channel (max 2)
    this.buf = [new Float32Array(this.bufLen), new Float32Array(this.bufLen)];
    this.wPos = 0;

    // Read heads and phases for each grain
    this.rPos = new Float64Array(this.numGrains);
    this.rPhase = new Float64Array(this.numGrains);
    for (let g = 0; g < this.numGrains; g++) {
      this.rPos[g] = 0;
      this.rPhase[g] = g * this.grainSpacing;
    }

    // Pre-compute Hann window
    this.win = new Float32Array(this.grainSize);
    for (let i = 0; i < this.grainSize; i++) {
      this.win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / this.grainSize));
    }

    this.port.onmessage = (e) => {
      if (e.data.pitchFactor !== undefined) this.pitchFactor = e.data.pitchFactor;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;

    const pf = this.pitchFactor;

    // Passthrough when no shift needed
    if (Math.abs(pf - 1.0) < 0.0005) {
      for (let c = 0; c < output.length; c++) {
        if (input[c]) output[c].set(input[c]);
      }
      return true;
    }

    const n = input[0].length;
    const chCount = Math.min(input.length, output.length, 2);
    const mask = this.bufLen - 1;

    for (let i = 0; i < n; i++) {
      // Write all channels to circular buffer
      for (let c = 0; c < chCount; c++) {
        this.buf[c][this.wPos & mask] = input[c][i];
      }

      // Sum output from all staggered grains
      for (let c = 0; c < chCount; c++) output[c][i] = 0;

      for (let g = 0; g < this.numGrains; g++) {
        const rp = this.rPos[g];
        const idx = Math.floor(rp) & mask;
        const frac = rp - Math.floor(rp);
        const phase = Math.floor(this.rPhase[g]) % this.grainSize;
        const w = this.win[phase];

        for (let c = 0; c < chCount; c++) {
          const s = this.buf[c][idx] * (1 - frac) + this.buf[c][(idx + 1) & mask] * frac;
          output[c][i] += s * w;
        }

        // Advance read head at pitch rate
        this.rPos[g] += pf;
        this.rPhase[g]++;

        // Reset grain when expired
        if (this.rPhase[g] >= this.grainSize) {
          this.rPhase[g] = 0;
          this.rPos[g] = this.wPos - this.grainSize;
        }
      }

      // Normalize by number of grains overlap (Hann windows with 4 grains sum to ~2.0)
      const norm = 2.0 / this.numGrains;
      for (let c = 0; c < chCount; c++) {
        output[c][i] *= norm;
      }

      this.wPos++;
    }

    return true;
  }
}

registerProcessor('pitch-shifter-processor', PitchShifterProcessor);
