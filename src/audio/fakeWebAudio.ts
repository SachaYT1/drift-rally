/**
 * TEST HELPER (not shipped: only *.test.ts files import it). A strict fake Web Audio that throws
 * where real browsers throw and records every AudioParam automation call.
 */

export interface Call { m: 'set' | 'linear' | 'exp' | 'target'; v: number; t: number }

function checkArgs(v: number, t: number): void {
  if (!Number.isFinite(v) || !Number.isFinite(t)) throw new TypeError('non-finite AudioParam argument');
  if (t < 0) throw new RangeError('negative time');
}

export class FakeParam {
  calls: Call[] = [];
  constructor(private v: number) {}
  get value(): number { return this.v; }
  set value(x: number) { checkArgs(x, 0); this.v = x; }
  private push(m: Call['m'], v: number, t: number): this { checkArgs(v, t); this.calls.push({ m, v, t }); return this; }
  setValueAtTime(v: number, t: number): this { return this.push('set', v, t); }
  linearRampToValueAtTime(v: number, t: number): this { return this.push('linear', v, t); }
  exponentialRampToValueAtTime(v: number, t: number): this { if (v === 0) throw new RangeError('exp ramp to 0'); return this.push('exp', v, t); }
  setTargetAtTime(v: number, t: number, tau: number): this { if (!(tau >= 0)) throw new RangeError('bad tau'); return this.push('target', v, t); }
  cancelScheduledValues(t: number): this { checkArgs(0, t); this.calls = this.calls.filter((c) => c.t < t); return this; }
  /** Value the param is heading to (last automation target, else the static value). */
  latest(): number { return this.calls.at(-1)?.v ?? this.v; }
}

export class FakeNode {
  outputs: (FakeNode | FakeParam)[] = [];
  constructor(readonly ctx: FakeCtx, readonly kind: string) { ctx.nodes.push(this); }
  connect<T extends FakeNode | FakeParam>(dest: T): T { this.outputs.push(dest); return dest; }
  disconnect(): void { this.outputs = []; }
}
export class FakeGain extends FakeNode { gain = new FakeParam(1); }
export class FakeFilter extends FakeNode { type = 'lowpass'; frequency = new FakeParam(350); Q = new FakeParam(1); gain = new FakeParam(0); detune = new FakeParam(0); }
export class FakeShaper extends FakeNode {
  private c: Float32Array | null = null;
  oversample = 'none';
  get curve(): Float32Array | null { return this.c; }
  set curve(c: Float32Array | null) {
    if (c && (c.length < 2 || !c.every(Number.isFinite))) throw new Error('InvalidStateError: bad curve');
    this.c = c;
  }
}
export class FakeCompressor extends FakeNode {
  threshold = new FakeParam(-24); knee = new FakeParam(30); ratio = new FakeParam(12); attack = new FakeParam(0.003); release = new FakeParam(0.25);
}
export class FakeSource extends FakeNode {
  started: number | undefined; stopped: number | undefined; onended: (() => void) | null = null;
  start(t = 0): void { if (this.started !== undefined) throw new Error('InvalidStateError: start twice'); checkArgs(0, t); this.started = t; }
  stop(t = 0): void { if (this.started === undefined) throw new Error('InvalidStateError: stop before start'); checkArgs(0, t); this.stopped = t; }
}
export class FakeOsc extends FakeSource { type = 'sine'; frequency = new FakeParam(440); detune = new FakeParam(0); }
export class FakeBuffer {
  private readonly data: Float32Array;
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) { this.data = new Float32Array(length); }
  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(): Float32Array { return this.data; }
}
export class FakeBufferSource extends FakeSource { buffer: FakeBuffer | null = null; loop = false; playbackRate = new FakeParam(1); }

export class FakeCtx {
  nodes: FakeNode[] = [];
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 1; sampleRate = 48000; resumeCalls = 0; suspendCalls = 0;
  broken = false; // when set, oscillator creation throws (a browser-specific Web Audio failure)
  destination = new FakeNode(this, 'destination');
  createGain(): FakeGain { return new FakeGain(this, 'gain'); }
  createOscillator(): FakeOsc { if (this.broken) throw new Error('NotSupportedError'); return new FakeOsc(this, 'osc'); }
  createBiquadFilter(): FakeFilter { return new FakeFilter(this, 'filter'); }
  createWaveShaper(): FakeShaper { return new FakeShaper(this, 'shaper'); }
  createDynamicsCompressor(): FakeCompressor { return new FakeCompressor(this, 'compressor'); }
  createBufferSource(): FakeBufferSource { return new FakeBufferSource(this, 'bufferSource'); }
  createBuffer(ch: number, len: number, sr: number): FakeBuffer { return new FakeBuffer(ch, len, sr); }
  resume(): Promise<void> { this.resumeCalls++; this.state = 'running'; return Promise.resolve(); }
  suspend(): Promise<void> { this.suspendCalls++; this.state = 'suspended'; return Promise.resolve(); }
  close(): Promise<void> { this.state = 'closed'; return Promise.resolve(); }
  sources(): FakeSource[] { return this.nodes.filter((n): n is FakeSource => n instanceof FakeSource); }
}

const fakeNodes = (n: FakeNode): FakeNode[] => n.outputs.filter((o): o is FakeNode => o instanceof FakeNode);

/** Product of the latest gain targets on every path from `from` to `to` (max over paths). */
export function pathGain(from: FakeNode, to: FakeNode): number {
  if (from === to) return 1;
  return Math.max(0, ...fakeNodes(from).map((o) => pathGain(o, to) * (o instanceof FakeGain ? o.gain.latest() : 1)));
}

/** Gain nodes on some path from `from` to `to` (excluding `to`). */
export function gainsBetween(from: FakeNode, to: FakeNode): FakeGain[] {
  const found: FakeGain[] = [];
  const reaches = (n: FakeNode): boolean => {
    // map (not some): every branch is walked so every gain on any path is collected.
    const hit = n === to || fakeNodes(n).map(reaches).includes(true);
    if (hit && n !== to && n instanceof FakeGain && !found.includes(n)) found.push(n);
    return hit;
  };
  return reaches(from) ? found : [];
}

/** Every node downstream of `from` (audio connections only). */
export function downstream(from: FakeNode): FakeNode[] {
  const seen = new Set<FakeNode>();
  const walk = (n: FakeNode): void => { for (const o of fakeNodes(n)) if (!seen.has(o)) { seen.add(o); walk(o); } };
  walk(from);
  return [...seen];
}

export function masterOf(ctx: FakeCtx): FakeGain {
  const comp = ctx.nodes.find((n) => n instanceof FakeCompressor);
  const master = ctx.nodes.find((n): n is FakeGain => n instanceof FakeGain && n.outputs.includes(comp as FakeNode));
  if (!master) throw new Error('no master gain');
  return master;
}

const isScreechBand = (n: FakeNode): boolean => n instanceof FakeFilter && n.type === 'bandpass' && n.Q.value >= 3;

/**
 * Looping sources: the engine oscillators (audible pitch: started, never stopped, > 20 Hz; the saw
 * first) and the screech noise (the looping noise that feeds the narrow screech bandpasses).
 */
export function loopSources(ctx: FakeCtx): { engine: FakeOsc[]; screech: FakeBufferSource[] } {
  const live = ctx.sources().filter((s) => s.started !== undefined && s.stopped === undefined);
  return { engine: live.filter((s): s is FakeOsc => s instanceof FakeOsc && s.frequency.value > 20),
    screech: live.filter((s): s is FakeBufferSource => s instanceof FakeBufferSource && s.loop && fakeNodes(s).some(isScreechBand)) };
}
