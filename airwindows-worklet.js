// Airwindows effects ported to AudioWorklet
// Original C++ by Chris Johnson (airwindows), MIT license
// Ported to JavaScript for STUDIO web DAW

class AirwindowsProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        var opts = options.processorOptions || {};
        this.effect = opts.effect || 'purestdrive';
        this.p = Object.assign({}, opts.params || {});
        this.s = {};
        this._initState();
        this.port.onmessage = function(e) {
            if (e.data.params) this.p = Object.assign({}, e.data.params);
        }.bind(this);
    }

    _initState() {
        var s = this.s = {};
        switch (this.effect) {
            case 'purestdrive':
                s.prevL = 0; s.prevR = 0;
                break;
            case 'density':
                s.iirAL = 0; s.iirBL = 0; s.iirAR = 0; s.iirBR = 0; s.flip = false;
                break;
            case 'console7':
                s.gainchase = -1; s.chasespeed = 64;
                s.bq = new Float64Array(15);
                break;
            case 'pressure4':
                s.muSpeedA = 10000; s.muSpeedB = 10000;
                s.muCoefficientA = 1; s.muCoefficientB = 1;
                s.muVary = 1; s.flip = false;
                break;
            case 'toneslant':
                s.bL = new Float64Array(103); s.bR = new Float64Array(103);
                s.f = new Float64Array(103);
                break;
            case 'chorus':
                s.dL = new Float64Array(32772); s.dR = new Float64Array(32772);
                s.gcount = 0; s.sweep = 0;
                s.airPrevL = 0; s.airEvenL = 0; s.airOddL = 0;
                s.airPrevR = 0; s.airEvenR = 0; s.airOddR = 0;
                s.fpFlip = false;
                break;
        }
    }

    process(inputs, outputs) {
        var input = inputs[0];
        var output = outputs[0];
        if (!input || !input[0]) return true;
        var inL = input[0];
        var inR = input[1] || input[0];
        var outL = output[0];
        var outR = output[1] || output[0];
        var n = inL.length;

        switch (this.effect) {
            case 'purestdrive': this._purestdrive(inL, inR, outL, outR, n); break;
            case 'density': this._density(inL, inR, outL, outR, n); break;
            case 'console7': this._console7(inL, inR, outL, outR, n); break;
            case 'pressure4': this._pressure4(inL, inR, outL, outR, n); break;
            case 'toneslant': this._toneslant(inL, inR, outL, outR, n); break;
            case 'chorus': this._chorus(inL, inR, outL, outR, n); break;
            default:
                for (var i = 0; i < n; i++) { outL[i] = inL[i]; outR[i] = inR[i]; }
        }
        return true;
    }

    // ========== PUREST DRIVE ==========
    // Clean adaptive saturation. sin() waveshaping modulated by signal envelope.
    // Params: intensity (0-1)
    _purestdrive(inL, inR, outL, outR, n) {
        var intensity = this.p.intensity !== undefined ? this.p.intensity : 0.5;
        var s = this.s;
        for (var i = 0; i < n; i++) {
            var dryL = inL[i], dryR = inR[i];
            var smpL = Math.sin(dryL);
            var apply = (Math.abs(s.prevL + smpL) / 2.0) * intensity;
            smpL = (dryL * (1.0 - apply)) + (smpL * apply);
            s.prevL = Math.sin(dryL);

            var smpR = Math.sin(dryR);
            apply = (Math.abs(s.prevR + smpR) / 2.0) * intensity;
            smpR = (dryR * (1.0 - apply)) + (smpR * apply);
            s.prevR = Math.sin(dryR);

            outL[i] = smpL;
            outR[i] = smpR;
        }
    }

    // ========== DENSITY ==========
    // Tube-style density with sine/cosine waveshaping and highpass.
    // Params: density (0-1), highpass (0-1), output (0-1), mix (0-1)
    _density(inL, inR, outL, outR, n) {
        var A = this.p.density !== undefined ? this.p.density : 0.5;
        var B = this.p.highpass || 0;
        var C = this.p.output !== undefined ? this.p.output : 1;
        var D = this.p.mix !== undefined ? this.p.mix : 1;
        var s = this.s;
        var overallscale = sampleRate / 44100.0;
        var density = (A * 5.0) - 1.0;
        var iirAmount = Math.pow(B, 3) / overallscale;
        var wet = D, dry = 1.0 - wet;
        var outAmt = Math.abs(density);
        density = density * Math.abs(density);
        var HALF_PI = 1.57079633;

        for (var i = 0; i < n; i++) {
            var smpL = inL[i], smpR = inR[i];
            var dryL = smpL, dryR = smpR;

            if (s.flip) {
                s.iirAL = (s.iirAL * (1.0 - iirAmount)) + (smpL * iirAmount); smpL -= s.iirAL;
                s.iirAR = (s.iirAR * (1.0 - iirAmount)) + (smpR * iirAmount); smpR -= s.iirAR;
            } else {
                s.iirBL = (s.iirBL * (1.0 - iirAmount)) + (smpL * iirAmount); smpL -= s.iirBL;
                s.iirBR = (s.iirBR * (1.0 - iirAmount)) + (smpR * iirAmount); smpR -= s.iirBR;
            }
            s.flip = !s.flip;

            var count = density;
            while (count > 1.0) {
                var br = Math.min(Math.abs(smpL) * HALF_PI, HALF_PI);
                br = Math.sin(br); smpL = smpL > 0 ? br : -br;
                br = Math.min(Math.abs(smpR) * HALF_PI, HALF_PI);
                br = Math.sin(br); smpR = smpR > 0 ? br : -br;
                count -= 1.0;
            }

            var frac = outAmt; while (frac > 1.0) frac -= 1.0;

            var br = Math.min(Math.abs(smpL) * HALF_PI, HALF_PI);
            br = density > 0 ? Math.sin(br) : 1 - Math.cos(br);
            smpL = smpL > 0 ? (smpL * (1 - frac)) + (br * frac) : (smpL * (1 - frac)) - (br * frac);

            br = Math.min(Math.abs(smpR) * HALF_PI, HALF_PI);
            br = density > 0 ? Math.sin(br) : 1 - Math.cos(br);
            smpR = smpR > 0 ? (smpR * (1 - frac)) + (br * frac) : (smpR * (1 - frac)) - (br * frac);

            if (C < 1.0) { smpL *= C; smpR *= C; }
            if (wet < 1.0) { smpL = (dryL * dry) + (smpL * wet); smpR = (dryR * dry) + (smpR * wet); }

            outL[i] = smpL;
            outR[i] = smpR;
        }
    }

    // ========== CONSOLE 7 CHANNEL ==========
    // Console saturation with gain chasing and Spiral/Density blend.
    // Params: gain (0-1, unity ~0.772)
    _console7(inL, inR, outL, outR, n) {
        var A = this.p.gain !== undefined ? this.p.gain : 0.772;
        var s = this.s;
        var bq = s.bq;
        var inputgain = A * 1.272019649514069;
        if (s.gainchase !== inputgain) s.chasespeed *= 2.0;
        if (s.chasespeed > n) s.chasespeed = n;
        if (s.gainchase < 0.0) s.gainchase = inputgain;

        // 20kHz lowpass biquad
        var freq = 20000.0 / sampleRate;
        var Q = 1.618033988749895;
        var K = Math.tan(Math.PI * freq);
        var norm = 1.0 / (1.0 + K / Q + K * K);
        bq[2] = K * K * norm;
        bq[3] = 2.0 * bq[2];
        bq[4] = bq[2];
        bq[5] = 2.0 * (K * K - 1.0) * norm;
        bq[6] = (1.0 - K / Q + K * K) * norm;

        for (var i = 0; i < n; i++) {
            var smpL = inL[i], smpR = inR[i];

            // Biquad lowpass
            var outSmpL = bq[2]*smpL + bq[3]*bq[7] + bq[4]*bq[8] - bq[5]*bq[9] - bq[6]*bq[10];
            bq[8] = bq[7]; bq[7] = smpL; smpL = outSmpL; bq[10] = bq[9]; bq[9] = smpL;

            var outSmpR = bq[2]*smpR + bq[3]*bq[11] + bq[4]*bq[12] - bq[5]*bq[13] - bq[6]*bq[14];
            bq[12] = bq[11]; bq[11] = smpR; smpR = outSmpR; bq[14] = bq[13]; bq[13] = smpR;

            // Gain chase
            s.chasespeed *= 0.9999; s.chasespeed -= 0.01;
            if (s.chasespeed < 64.0) s.chasespeed = 64.0;
            s.gainchase = (((s.gainchase * s.chasespeed) + inputgain) / (s.chasespeed + 1.0));

            if (s.gainchase !== 1.0) {
                var g3 = Math.pow(s.gainchase, 3);
                smpL *= g3; smpR *= g3;
            }

            // Spiral/Density saturation blend (80/20)
            if (smpL > 1.097) smpL = 1.097;
            if (smpL < -1.097) smpL = -1.097;
            var absL = Math.abs(smpL);
            smpL = ((Math.sin(smpL * absL) / (absL === 0 ? 1 : absL)) * 0.8) + (Math.sin(smpL) * 0.2);

            if (smpR > 1.097) smpR = 1.097;
            if (smpR < -1.097) smpR = -1.097;
            var absR = Math.abs(smpR);
            smpR = ((Math.sin(smpR * absR) / (absR === 0 ? 1 : absR)) * 0.8) + (Math.sin(smpR) * 0.2);

            // Inverse gain to restore level
            if (s.gainchase !== 1.0 && s.gainchase !== 0.0) {
                smpL /= s.gainchase; smpR /= s.gainchase;
            }

            outL[i] = smpL;
            outR[i] = smpR;
        }
    }

    // ========== PRESSURE 4 ==========
    // Variable-mu compressor with sine limiter output stage.
    // Params: threshold (0-1), speed (0-1), mu (0-1), output (0-1)
    _pressure4(inL, inR, outL, outR, n) {
        var A = this.p.threshold !== undefined ? this.p.threshold : 0.5;
        var B = this.p.speed !== undefined ? this.p.speed : 0.5;
        var C = this.p.mu !== undefined ? this.p.mu : 0.5;
        var D = this.p.output !== undefined ? this.p.output : 1.0;
        var s = this.s;
        var overallscale = sampleRate / 44100.0;
        var threshold = 1.0 - (A * 0.95);
        var muMakeupGain = 1.0 / threshold;
        var release = Math.pow((1.28 - B), 5) * 32768.0 / overallscale;
        var fastest = Math.sqrt(release);
        var mewiness = (C * 2.0) - 1.0;
        var positivemu = mewiness >= 0;
        if (!positivemu) mewiness = -mewiness;
        var unmewiness = 1.0 - mewiness;
        var outputGain = D;
        var HALF_PI = 1.57079633;

        for (var i = 0; i < n; i++) {
            var smpL = inL[i] * muMakeupGain;
            var smpR = inR[i] * muMakeupGain;

            var inputSense = Math.max(Math.abs(smpL), Math.abs(smpR));

            if (s.flip) {
                if (inputSense > threshold) {
                    s.muVary = threshold / inputSense;
                    var muAttack = Math.sqrt(Math.abs(s.muSpeedA));
                    s.muCoefficientA = s.muCoefficientA * (muAttack - 1.0);
                    s.muCoefficientA += (s.muVary < threshold ? threshold : s.muVary);
                    s.muCoefficientA /= muAttack;
                } else {
                    s.muCoefficientA = s.muCoefficientA * ((s.muSpeedA * s.muSpeedA) - 1.0);
                    s.muCoefficientA = (s.muCoefficientA + 1.0) / (s.muSpeedA * s.muSpeedA);
                }
                var muNewSpeed = s.muSpeedA * (s.muSpeedA - 1);
                muNewSpeed = muNewSpeed + Math.abs(inputSense * release) + fastest;
                s.muSpeedA = muNewSpeed / s.muSpeedA;
            } else {
                if (inputSense > threshold) {
                    s.muVary = threshold / inputSense;
                    var muAttack = Math.sqrt(Math.abs(s.muSpeedB));
                    s.muCoefficientB = s.muCoefficientB * (muAttack - 1.0);
                    s.muCoefficientB += (s.muVary < threshold ? threshold : s.muVary);
                    s.muCoefficientB /= muAttack;
                } else {
                    s.muCoefficientB = s.muCoefficientB * ((s.muSpeedB * s.muSpeedB) - 1.0);
                    s.muCoefficientB = (s.muCoefficientB + 1.0) / (s.muSpeedB * s.muSpeedB);
                }
                var muNewSpeed = s.muSpeedB * (s.muSpeedB - 1);
                muNewSpeed = muNewSpeed + Math.abs(inputSense * release) + fastest;
                s.muSpeedB = muNewSpeed / s.muSpeedB;
            }

            var coeff;
            if (s.flip) {
                coeff = positivemu ? Math.pow(s.muCoefficientA, 2) : Math.sqrt(Math.abs(s.muCoefficientA));
                coeff = (coeff * mewiness) + (s.muCoefficientA * unmewiness);
            } else {
                coeff = positivemu ? Math.pow(s.muCoefficientB, 2) : Math.sqrt(Math.abs(s.muCoefficientB));
                coeff = (coeff * mewiness) + (s.muCoefficientB * unmewiness);
            }
            smpL *= coeff;
            smpR *= coeff;
            s.flip = !s.flip;

            if (outputGain !== 1.0) { smpL *= outputGain; smpR *= outputGain; }

            // Sine limiter
            var br = Math.abs(smpL);
            br = br > HALF_PI ? 1.0 : Math.sin(br);
            smpL = smpL > 0 ? br : -br;

            br = Math.abs(smpR);
            br = br > HALF_PI ? 1.0 : Math.sin(br);
            smpR = smpR > 0 ? br : -br;

            outL[i] = smpL;
            outR[i] = smpR;
        }
    }

    // ========== TONE SLANT ==========
    // Tilt EQ using FIR accumulator. Boost highs or lows.
    // Params: voicing (0-1, filter length), tilt (0-1, 0.5=flat)
    _toneslant(inL, inR, outL, outR, n) {
        var A = this.p.voicing !== undefined ? this.p.voicing : 0.5;
        var B = this.p.tilt !== undefined ? this.p.tilt : 0.5;
        var s = this.s;
        var overallscale = (A * 99.0) + 1.0;
        var applySlant = (B * 2.0) - 1.0;

        s.f[0] = 1.0 / overallscale;
        for (var c = 1; c < 102; c++) {
            if (c <= overallscale) {
                s.f[c] = (1.0 - (c / overallscale)) / overallscale;
            }
        }

        for (var i = 0; i < n; i++) {
            for (var c = Math.floor(overallscale); c >= 0; c--) {
                s.bL[c + 1] = s.bL[c];
                s.bR[c + 1] = s.bR[c];
            }

            var smpL = inL[i], smpR = inR[i];
            s.bL[0] = smpL;
            s.bR[0] = smpR;

            var accL = smpL * s.f[0];
            var accR = smpR * s.f[0];
            for (var c = 1; c < overallscale; c++) {
                accL += (s.bL[c] * s.f[c]);
                accR += (s.bR[c] * s.f[c]);
            }

            var corrL = smpL - (accL * 2.0);
            var corrR = smpR - (accR * 2.0);

            outL[i] = smpL + (corrL * applySlant);
            outR[i] = smpR + (corrR * applySlant);
        }
    }

    // ========== CHORUS ==========
    // Modulated delay chorus with air compensation for highs.
    // Params: speed (0-1), range (0-1), mix (0-1)
    _chorus(inL, inR, outL, outR, n) {
        var A = this.p.speed !== undefined ? this.p.speed : 0.5;
        var B = this.p.range !== undefined ? this.p.range : 0.5;
        var C = this.p.mix !== undefined ? this.p.mix : 0.5;
        var s = this.s;
        var overallscale = sampleRate / 44100.0;
        var totalsamples = 16386;
        var speed = Math.pow(A, 4) * 0.001 * overallscale;
        var loopLimit = Math.floor(totalsamples * 0.499);
        var range = Math.pow(B, 4) * loopLimit * 0.499;
        var wet = C;
        var modulation = range * wet;
        var TWOPI = Math.PI * 2.0;

        for (var i = 0; i < n; i++) {
            var smpL = inL[i], smpR = inR[i];
            var dryL = smpL, dryR = smpR;

            // Air compensation
            var airFactorL = s.airPrevL - smpL;
            if (s.fpFlip) {
                s.airEvenL += airFactorL; s.airOddL -= airFactorL; airFactorL = s.airEvenL;
            } else {
                s.airOddL += airFactorL; s.airEvenL -= airFactorL; airFactorL = s.airOddL;
            }
            s.airOddL = (s.airOddL - ((s.airOddL - s.airEvenL) / 256.0)) / 1.0001;
            s.airEvenL = (s.airEvenL - ((s.airEvenL - s.airOddL) / 256.0)) / 1.0001;
            s.airPrevL = smpL;
            smpL += (airFactorL * wet);

            var airFactorR = s.airPrevR - smpR;
            if (s.fpFlip) {
                s.airEvenR += airFactorR; s.airOddR -= airFactorR; airFactorR = s.airEvenR;
            } else {
                s.airOddR += airFactorR; s.airEvenR -= airFactorR; airFactorR = s.airOddR;
            }
            s.airOddR = (s.airOddR - ((s.airOddR - s.airEvenR) / 256.0)) / 1.0001;
            s.airEvenR = (s.airEvenR - ((s.airEvenR - s.airOddR) / 256.0)) / 1.0001;
            s.airPrevR = smpR;
            smpR += (airFactorR * wet);

            // Double buffer write
            if (s.gcount < 1 || s.gcount > loopLimit) s.gcount = loopLimit;
            var count = s.gcount;
            s.dL[count + loopLimit] = s.dL[count] = smpL;
            s.dR[count + loopLimit] = s.dR[count] = smpR;
            s.gcount--;

            // Modulated delay read with interpolation
            var offset = range + (modulation * Math.sin(s.sweep));
            var idx = count + Math.floor(offset);
            var frac = offset - Math.floor(offset);

            smpL = s.dL[idx] * (1 - frac) + s.dL[idx + 1] + s.dL[idx + 2] * frac;
            smpL -= ((s.dL[idx] - s.dL[idx + 1]) - (s.dL[idx + 1] - s.dL[idx + 2])) / 50;
            smpL *= 0.5;

            smpR = s.dR[idx] * (1 - frac) + s.dR[idx + 1] + s.dR[idx + 2] * frac;
            smpR -= ((s.dR[idx] - s.dR[idx + 1]) - (s.dR[idx + 1] - s.dR[idx + 2])) / 50;
            smpR *= 0.5;

            s.sweep += speed;
            if (s.sweep > TWOPI) s.sweep -= TWOPI;

            if (wet !== 1.0) {
                smpL = (smpL * wet) + (dryL * (1.0 - wet));
                smpR = (smpR * wet) + (dryR * (1.0 - wet));
            }
            s.fpFlip = !s.fpFlip;

            outL[i] = smpL;
            outR[i] = smpR;
        }
    }
}

registerProcessor('airwindows-processor', AirwindowsProcessor);
