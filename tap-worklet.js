// Amatu Translator: hands the microphone's samples to the page in blocks of 2048 (about 43 ms at 48 kHz).
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.b = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const c = inputs[0] && inputs[0][0];
    if (c) {
      for (let k = 0; k < c.length; k++) {
        this.b[this.n++] = c[k];
        if (this.n === 2048) { this.port.postMessage(this.b.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('tr-tap', Tap);
