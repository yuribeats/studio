// PedalFXChain — shared audio effects processor for studio instruments
// Include via <script src="pedal-fx.js"></script> before instrument code
// Usage: const fx = new PedalFXChain(audioContext);
//        synthOutput.connect(fx.getInput());
//        fx.getOutput().connect(mixerGain);
//        fx.update(pedalsArray);

(function() {

function createReverbIR(ctx, decay, length) {
    var rate = ctx.sampleRate;
    var len = Math.floor(rate * length);
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
        var data = buf.getChannelData(ch);
        for (var i = 0; i < len; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay * 3);
        }
    }
    return buf;
}

function makeDistortionCurve(amount) {
    var n = 44100;
    var curve = new Float32Array(n);
    var deg = Math.PI / 180;
    var k = amount * 100;
    for (var i = 0; i < n; i++) {
        var x = i * 2 / n - 1;
        curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

// norm: convert a 0-100 param to 0-1
function norm(v) { return (v || 0) / 100; }

function PedalFXChain(audioContext) {
    this.ctx = audioContext;
    this.input = this.ctx.createGain();
    this.output = this.ctx.createGain();
    this.input.connect(this.output); // passthrough by default
    this._nodes = [];
    this._pedals = [];
}

PedalFXChain.prototype.getInput = function() { return this.input; };
PedalFXChain.prototype.getOutput = function() { return this.output; };

PedalFXChain.prototype.update = function(pedals) {
    this._pedals = pedals || [];
    this._rebuild();
};

PedalFXChain.prototype._cleanup = function() {
    // Stop any oscillators/sources in old nodes
    for (var i = 0; i < this._nodes.length; i++) {
        var group = this._nodes[i];
        if (group.dispose) group.dispose();
    }
    this._nodes = [];
    // Disconnect input from everything
    try { this.input.disconnect(); } catch(e) {}
};

PedalFXChain.prototype._rebuild = function() {
    this._cleanup();
    var ctx = this.ctx;
    var activePedals = [];
    for (var i = 0; i < this._pedals.length; i++) {
        if (!this._pedals[i].bypassed) activePedals.push(this._pedals[i]);
    }

    if (activePedals.length === 0) {
        this.input.connect(this.output);
        return;
    }

    // Build each effect node group
    var groups = [];
    for (var i = 0; i < activePedals.length; i++) {
        var g = this._buildEffect(activePedals[i]);
        if (g) {
            groups.push(g);
            this._nodes.push(g);
        }
    }

    if (groups.length === 0) {
        this.input.connect(this.output);
        return;
    }

    // Chain: input -> group0.in -> group0.out -> group1.in -> ... -> output
    this.input.connect(groups[0].input);
    for (var i = 0; i < groups.length - 1; i++) {
        groups[i].output.connect(groups[i+1].input);
    }
    groups[groups.length - 1].output.connect(this.output);
};

PedalFXChain.prototype._buildEffect = function(pedal) {
    var builder = BUILDERS[pedal.type];
    if (!builder) return null;
    return builder(this.ctx, pedal.params);
};

// Dry/wet splitter helper
function dryWet(ctx, wetNode, mix) {
    var input = ctx.createGain();
    var output = ctx.createGain();
    var dry = ctx.createGain();
    var wet = ctx.createGain();
    dry.gain.value = 1 - mix;
    wet.gain.value = mix;
    input.connect(dry);
    input.connect(wetNode);
    dry.connect(output);
    wetNode.connect(wet);
    wet.connect(output);
    return { input: input, output: output, dry: dry, wet: wet };
}

var BUILDERS = {};

// ---- OVERDRIVE ----
BUILDERS.overdrive = function(ctx, p) {
    var drive = norm(p.gain || p.drive || 50);
    var tone = norm(p.tone || 50);
    var level = norm(p.level || 80);
    var input = ctx.createGain();
    var output = ctx.createGain();
    var shaper = ctx.createWaveShaper();
    shaper.curve = makeDistortionCurve(drive);
    shaper.oversample = '4x';
    var filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800 + tone * 12000;
    var outGain = ctx.createGain();
    outGain.gain.value = level;
    input.connect(shaper); shaper.connect(filter); filter.connect(outGain); outGain.connect(output);
    return { input: input, output: output, dispose: function() {
        try { shaper.disconnect(); filter.disconnect(); outGain.disconnect(); } catch(e) {}
    }};
};

// ---- EQ ----
BUILDERS.eq = function(ctx, p) {
    var low = ctx.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = 300; low.gain.value = p.low || 0;
    var mid = ctx.createBiquadFilter();
    mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 1; mid.gain.value = p.mid || 0;
    var high = ctx.createBiquadFilter();
    high.type = 'highshelf'; high.frequency.value = 3000; high.gain.value = p.high || 0;
    low.connect(mid); mid.connect(high);
    var input = ctx.createGain();
    var output = ctx.createGain();
    input.connect(low); high.connect(output);
    return { input: input, output: output, dispose: function() {
        try { low.disconnect(); mid.disconnect(); high.disconnect(); } catch(e) {}
    }};
};

// ---- COMPRESSOR ----
BUILDERS.compressor = function(ctx, p) {
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = p.threshold || -24;
    comp.ratio.value = p.ratio || 4;
    comp.attack.value = (p.attack || 20) / 1000;
    comp.release.value = (p.release || 50) / 100;
    var input = ctx.createGain();
    var output = ctx.createGain();
    input.connect(comp); comp.connect(output);
    return { input: input, output: output, dispose: function() {
        try { comp.disconnect(); } catch(e) {}
    }};
};

// ---- CHORUS ----
BUILDERS.chorus = function(ctx, p) {
    var rate = 0.1 + norm(p.rate || 40) * 5;
    var depth = norm(p.depth || 50) * 0.01;
    var mix = norm(p.mix || 50);
    var delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.015;
    var lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rate;
    var lfoGain = ctx.createGain();
    lfoGain.gain.value = depth;
    lfo.connect(lfoGain);
    lfoGain.connect(delay.delayTime);
    lfo.start();
    var dw = dryWet(ctx, delay, mix);
    return { input: dw.input, output: dw.output, dispose: function() {
        try { lfo.stop(); } catch(e) {}
        try { lfo.disconnect(); lfoGain.disconnect(); delay.disconnect(); } catch(e) {}
    }};
};

// ---- PHASER ----
BUILDERS.phaser = function(ctx, p) {
    var rate = 0.1 + norm(p.rate || 40) * 4;
    var depth = norm(p.depth || 50);
    var feedback = norm(p.feedback || 30) * 0.85;
    var input = ctx.createGain();
    var output = ctx.createGain();
    var dry = ctx.createGain(); dry.gain.value = 0.5;
    var wet = ctx.createGain(); wet.gain.value = 0.5;
    var filters = [];
    var freqs = [200, 400, 800, 1600];
    for (var i = 0; i < freqs.length; i++) {
        var f = ctx.createBiquadFilter();
        f.type = 'allpass'; f.frequency.value = freqs[i]; f.Q.value = 5;
        filters.push(f);
    }
    for (var i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i+1]);
    var feedbackGain = ctx.createGain(); feedbackGain.gain.value = feedback;
    filters[filters.length-1].connect(feedbackGain);
    feedbackGain.connect(filters[0]);
    var lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = rate;
    var lfoGain = ctx.createGain(); lfoGain.gain.value = depth * 2000;
    lfo.connect(lfoGain);
    for (var i = 0; i < filters.length; i++) lfoGain.connect(filters[i].frequency);
    lfo.start();
    input.connect(dry); input.connect(filters[0]);
    filters[filters.length-1].connect(wet);
    dry.connect(output); wet.connect(output);
    return { input: input, output: output, dispose: function() {
        try { lfo.stop(); } catch(e) {}
        try { lfo.disconnect(); lfoGain.disconnect(); feedbackGain.disconnect(); } catch(e) {}
        for (var i = 0; i < filters.length; i++) try { filters[i].disconnect(); } catch(e) {}
    }};
};

// ---- DISTORTION ----
BUILDERS.distortion = function(ctx, p) {
    var drive = norm(p.drive || 50);
    var tone = norm(p.tone || 50);
    var mix = norm(p.mix || 80);
    var shaper = ctx.createWaveShaper();
    shaper.curve = makeDistortionCurve(drive);
    shaper.oversample = '4x';
    var filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 1000 + tone * 12000;
    shaper.connect(filter);
    var dw = dryWet(ctx, shaper, mix);
    // filter is after shaper, before wet mix
    // Rewire so wet path includes filter
    try { shaper.disconnect(dw.output); } catch(e) {}
    // Actually rebuild: shaper already connects to filter above
    // We need: input -> [dry->output, input->shaper->filter->wet->output]
    var input2 = ctx.createGain();
    var output2 = ctx.createGain();
    var dryG = ctx.createGain(); dryG.gain.value = 1 - mix;
    var wetG = ctx.createGain(); wetG.gain.value = mix;
    input2.connect(dryG); dryG.connect(output2);
    input2.connect(shaper);
    filter.connect(wetG); wetG.connect(output2);
    return { input: input2, output: output2, dispose: function() {
        try { shaper.disconnect(); filter.disconnect(); } catch(e) {}
    }};
};

// ---- BITCRUSHER ----
BUILDERS.bitcrusher = function(ctx, p) {
    var bits = Math.max(1, Math.min(16, p.bits || 8));
    var rateReduce = norm(p.rate || 50);
    var mix = norm(p.mix || 80);
    // Use ScriptProcessor for bit crushing (AudioWorklet not available in all contexts)
    var bufSize = 4096;
    var crusher = ctx.createScriptProcessor(bufSize, 1, 1);
    var step = Math.pow(0.5, bits);
    var skipFactor = Math.max(1, Math.floor(1 + rateReduce * 30));
    var lastSample = 0;
    var counter = 0;
    crusher.onaudioprocess = function(e) {
        var inp = e.inputBuffer.getChannelData(0);
        var out = e.outputBuffer.getChannelData(0);
        for (var i = 0; i < inp.length; i++) {
            counter++;
            if (counter >= skipFactor) {
                counter = 0;
                lastSample = step * Math.floor(inp[i] / step + 0.5);
            }
            out[i] = lastSample;
        }
    };
    var dw = dryWet(ctx, crusher, mix);
    return { input: dw.input, output: dw.output, dispose: function() {
        crusher.onaudioprocess = null;
        try { crusher.disconnect(); } catch(e) {}
    }};
};

// ---- VINYL ----
BUILDERS.vinyl = function(ctx, p) {
    var noiseLevel = norm(p.noise || 30) * 0.05;
    var wowAmt = norm(p.wow || 20);
    var flutterAmt = norm(p.flutter || 15);
    var wear = norm(p.wear || 40);

    var input = ctx.createGain();
    var output = ctx.createGain();

    // Wow: slow pitch modulation via delay
    var wowDelay = ctx.createDelay(0.1);
    wowDelay.delayTime.value = 0.01;
    var wowLFO = ctx.createOscillator(); wowLFO.type = 'sine'; wowLFO.frequency.value = 0.4;
    var wowDepth = ctx.createGain(); wowDepth.gain.value = wowAmt * 0.003;
    wowLFO.connect(wowDepth); wowDepth.connect(wowDelay.delayTime);
    wowLFO.start();

    // Flutter: faster pitch modulation
    var flutterLFO = ctx.createOscillator(); flutterLFO.type = 'sine'; flutterLFO.frequency.value = 6;
    var flutterDepth = ctx.createGain(); flutterDepth.gain.value = flutterAmt * 0.0004;
    flutterLFO.connect(flutterDepth); flutterDepth.connect(wowDelay.delayTime);
    flutterLFO.start();

    // Wear: LP filter to dull the sound
    var wearFilter = ctx.createBiquadFilter();
    wearFilter.type = 'lowpass';
    wearFilter.frequency.value = 15000 - wear * 12000;

    // Noise layer
    var noiseLen = ctx.sampleRate * 2;
    var noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    var noiseData = noiseBuf.getChannelData(0);
    for (var i = 0; i < noiseLen; i++) noiseData[i] = Math.random() * 2 - 1;
    var noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuf; noiseSource.loop = true;
    var noiseGain = ctx.createGain(); noiseGain.gain.value = noiseLevel;
    var noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass'; noiseFilter.frequency.value = 3000; noiseFilter.Q.value = 0.5;
    noiseSource.connect(noiseFilter); noiseFilter.connect(noiseGain);
    noiseSource.start();

    input.connect(wowDelay); wowDelay.connect(wearFilter); wearFilter.connect(output);
    noiseGain.connect(output);

    return { input: input, output: output, dispose: function() {
        try { wowLFO.stop(); flutterLFO.stop(); noiseSource.stop(); } catch(e) {}
        try { wowLFO.disconnect(); flutterLFO.disconnect(); wowDelay.disconnect();
              wowDepth.disconnect(); flutterDepth.disconnect(); wearFilter.disconnect();
              noiseSource.disconnect(); noiseFilter.disconnect(); noiseGain.disconnect(); } catch(e) {}
    }};
};

// ---- SP-303 LOFI ----
BUILDERS.sp303 = function(ctx, p) {
    var drive = norm(p.drive || 60);
    var compAmt = norm(p.comp || 70);
    var filterFreq = norm(p.filter || 50);

    var input = ctx.createGain();
    var output = ctx.createGain();

    // Drive stage
    var shaper = ctx.createWaveShaper();
    shaper.curve = makeDistortionCurve(drive * 0.3);
    shaper.oversample = '2x';

    // Compressor
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -30 + (1 - compAmt) * 20;
    comp.ratio.value = 2 + compAmt * 10;
    comp.attack.value = 0.003;
    comp.release.value = 0.05 + compAmt * 0.15;

    // LP filter
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2000 + filterFreq * 10000;
    lp.Q.value = 0.7;

    input.connect(shaper); shaper.connect(comp); comp.connect(lp); lp.connect(output);

    return { input: input, output: output, dispose: function() {
        try { shaper.disconnect(); comp.disconnect(); lp.disconnect(); } catch(e) {}
    }};
};

// ---- LOFI ECHO ----
BUILDERS.lofiecho = function(ctx, p) {
    var time = 0.05 + norm(p.time || 40) * 0.95;
    var feedback = norm(p.feedback || 50) * 0.85;
    var tone = norm(p.tone || 40);
    var mix = norm(p.mix || 40);

    var input = ctx.createGain();
    var output = ctx.createGain();
    var dryG = ctx.createGain(); dryG.gain.value = 1 - mix;
    var wetG = ctx.createGain(); wetG.gain.value = mix;

    var delay = ctx.createDelay(2.0);
    delay.delayTime.value = time;

    var feedbackGain = ctx.createGain();
    feedbackGain.gain.value = feedback;

    // LP filter in feedback path
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500 + tone * 8000;

    input.connect(dryG); dryG.connect(output);
    input.connect(delay);
    delay.connect(lp); lp.connect(feedbackGain); feedbackGain.connect(delay);
    delay.connect(wetG); wetG.connect(output);

    return { input: input, output: output, dispose: function() {
        // Zero feedback first to prevent ringing
        feedbackGain.gain.value = 0;
        try { delay.disconnect(); lp.disconnect(); feedbackGain.disconnect(); } catch(e) {}
    }};
};

// ---- LOFI REVERB ----
BUILDERS.lofireverb = function(ctx, p) {
    var decay = 0.5 + norm(p.decay || 50) * 4;
    var damp = norm(p.damp || 60);
    var filterFreq = norm(p.filter || 40);
    var mix = norm(p.mix || 40);

    var input = ctx.createGain();
    var output = ctx.createGain();
    var dryG = ctx.createGain(); dryG.gain.value = 1 - mix;
    var wetG = ctx.createGain(); wetG.gain.value = mix;

    var convolver = ctx.createConvolver();
    convolver.buffer = createReverbIR(ctx, decay, 2 + decay * 0.5);

    // LP filter on wet signal to damp highs
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1000 + (1 - damp) * 12000;

    // Additional filter control
    var lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = 2000 + filterFreq * 10000;

    input.connect(dryG); dryG.connect(output);
    input.connect(convolver); convolver.connect(lp); lp.connect(lp2); lp2.connect(wetG); wetG.connect(output);

    return { input: input, output: output, dispose: function() {
        try { convolver.disconnect(); lp.disconnect(); lp2.disconnect(); } catch(e) {}
    }};
};

// ---- REVERB (generic, if ever needed separately) ----
BUILDERS.reverb = function(ctx, p) {
    return BUILDERS.lofireverb(ctx, p);
};

// ---- DELAY (generic, if ever needed separately) ----
BUILDERS.delay = function(ctx, p) {
    return BUILDERS.lofiecho(ctx, p);
};

window.PedalFXChain = PedalFXChain;

// ============================================
// MixerSends — full mixer channel strip: EQ, comp, pan, reverb/delay sends
// Usage: connect pedalFX.getOutput() to mixerSends.getInput()
//        connect mixerSends.getOutput() to mixerGain (replaces direct connection)
//        Reverb/delay sends output directly to ctx.destination
// ============================================
function MixerSends(ctx, destNode) {
    this.ctx = ctx;
    this._dest = destNode || ctx.destination;
    this.input = ctx.createGain();

    // ---- 3-BAND EQ ----
    this.eqHi = ctx.createBiquadFilter();
    this.eqHi.type = 'highshelf'; this.eqHi.frequency.value = 3000; this.eqHi.gain.value = 0;
    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking'; this.eqMid.frequency.value = 1000; this.eqMid.Q.value = 1; this.eqMid.gain.value = 0;
    this.eqLo = ctx.createBiquadFilter();
    this.eqLo.type = 'lowshelf'; this.eqLo.frequency.value = 300; this.eqLo.gain.value = 0;

    // ---- COMPRESSOR ----
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -24;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.25;

    // ---- PAN (stereo panner) ----
    this.panner = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    if (this.panner.pan) this.panner.pan.value = 0;

    // ---- DRY OUTPUT (EQ → comp → pan → output) ----
    this.output = ctx.createGain();
    this.input.connect(this.eqHi);
    this.eqHi.connect(this.eqMid);
    this.eqMid.connect(this.eqLo);
    this.eqLo.connect(this.comp);
    this.comp.connect(this.panner);
    this.panner.connect(this.output);

    // ---- REVERB SEND (post-EQ/comp) ----
    this.revSend = ctx.createGain();
    this.revSend.gain.value = 0;
    this.revReturn = ctx.createGain();
    this.revReturn.gain.value = 1;
    this.convolver = ctx.createConvolver();
    this._revDecay = 2;
    this.convolver.buffer = createReverbIR(ctx, 2, 3);
    this.revDamp = ctx.createBiquadFilter();
    this.revDamp.type = 'lowpass';
    this.revDamp.frequency.value = 8000;

    this.comp.connect(this.revSend);
    this.revSend.connect(this.convolver);
    this.convolver.connect(this.revDamp);
    this.revDamp.connect(this.revReturn);
    this.revReturn.connect(this._dest);

    // ---- DELAY SEND (post-EQ/comp) ----
    this.dlySend = ctx.createGain();
    this.dlySend.gain.value = 0;
    this.dlyReturn = ctx.createGain();
    this.dlyReturn.gain.value = 1;
    this.dlyNode = ctx.createDelay(2.0);
    this.dlyNode.delayTime.value = 0.5;
    this.dlyFeedback = ctx.createGain();
    this.dlyFeedback.gain.value = 0.3;
    this.dlyFilter = ctx.createBiquadFilter();
    this.dlyFilter.type = 'lowpass';
    this.dlyFilter.frequency.value = 8000;

    this.comp.connect(this.dlySend);
    this.dlySend.connect(this.dlyNode);
    this.dlyNode.connect(this.dlyFilter);
    this.dlyFilter.connect(this.dlyFeedback);
    this.dlyFeedback.connect(this.dlyNode);
    this.dlyFilter.connect(this.dlyReturn);
    this.dlyReturn.connect(this._dest);
}

MixerSends.prototype.getInput = function() { return this.input; };
MixerSends.prototype.getOutput = function() { return this.output; };

// Handle any mixer param
MixerSends.prototype.setParam = function(param, value) {
    if (param === 'eqHi') this.eqHi.gain.value = value;
    else if (param === 'eqMid') this.eqMid.gain.value = value;
    else if (param === 'eqLo') this.eqLo.gain.value = value;
    else if (param === 'compThresh') this.comp.threshold.value = value;
    else if (param === 'compRatio') this.comp.ratio.value = Math.max(1, value);
    else if (param === 'pan' && this.panner.pan) this.panner.pan.value = Math.max(-1, Math.min(1, value / 50));
    else if (param === 'sendRev') this.revSend.gain.value = Math.max(0, Math.min(1, (value || 0) / 100));
    else if (param === 'sendDly') this.dlySend.gain.value = Math.max(0, Math.min(1, (value || 0) / 100));
};

MixerSends.prototype.updateReverb = function(param, value) {
    if (param === 'decay') {
        this._revDecay = value;
        try { this.convolver.buffer = createReverbIR(this.ctx, value, Math.max(1, value * 0.8)); } catch(e) {}
    }
    if (param === 'damp') this.revDamp.frequency.value = 500 + (1 - value) * 15000;
    if (param === 'volume') this.revReturn.gain.value = value;
};

MixerSends.prototype.updateDelay = function(param, value) {
    if (param === 'dlyTime') this.dlyNode.delayTime.value = Math.max(0.001, value / 1000);
    if (param === 'dlyFeedback') this.dlyFeedback.gain.value = Math.min(0.95, value / 100);
    if (param === 'dlyFilter') this.dlyFilter.frequency.value = 200 + value * 150;
    if (param === 'volume') this.dlyReturn.gain.value = value;
};

window.MixerSends = MixerSends;

})();
