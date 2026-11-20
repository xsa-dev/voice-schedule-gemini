class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
    this.position = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const ratio = sampleRate / 16000;
    while (this.position < input.length) {
      this.samples.push(Math.max(-32768, Math.min(32767, input[Math.floor(this.position)] * 32768)));
      this.position += ratio;
      if (this.samples.length === 1600) {
        const pcm = new Int16Array(this.samples);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.samples = [];
      }
    }
    this.position -= input.length;
    return true;
  }
}
registerProcessor('capture', Capture);
