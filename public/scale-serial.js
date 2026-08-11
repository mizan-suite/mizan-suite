// scale-serial.js - Web Serial API wrapper for a scale connected to the POS.
// Loaded only in the cashier page. Uses Chromium's Web Serial API (available in
// Electron without any native module) to read the scale's ASCII output.
//
// The flow: cashier clicks "Connect scale", Chrome shows the device picker
// (the scale shows up as its serial/USB port). We hold the port open and parse
// each incoming chunk with window.akScale.parseWeightLine(). A live reading is
// fired through onWeight; when two consecutive readings agree (and a short
// settlement delay passed) the weight is considered stable and onStable fires,
// which the cashier can use to auto-fill the weight field.
(function (root) {
  'use strict';

  const ScaleSerial = {
    supported() {
      return !!(navigator && navigator.serial);
    },

    _port: null,
    _reader: null,
    _closedByUser: false,
    _buffer: '',
    _parse: function (chunk) {
      // Scales stream partial lines; accumulate until we hit a line break or a
      // whitespace-separated token that looks like "0.500 kg".
      this._buffer += chunk;
      const lines = this._buffer.split(/\r?\n/);
      this._buffer = lines.pop() || '';
      // Also split a run like "ST,GS,+0.500kg" that never newlines.
      const candidates = [];
      for (const line of lines) {
        candidates.push(line);
        const parts = line.split(/,(?=[-+]?\d)/);
        parts.forEach(p => candidates.push(p));
      }
      for (const cand of candidates) {
        const kg = root.akScale && root.akScale.parseWeightLine(cand);
        if (kg !== null) return kg;
      }
      return null;
    },

    async connect(onWeight, onStable, onDisconnect) {
      if (!this.supported()) throw new Error('NOT_SUPPORTED');
      if (this._port) return; // already connected
      this._closedByUser = false;
      const port = await navigator.serial.requestPort();
      this._port = port;
      const baud = parseInt(root.localStorage.getItem('mizan_scale_baud') || '9600', 10) || 9600;
      await port.open({ baudRate: baud });
      this._reader = null;
      let last = null;
      let lastAt = 0;

      const readLoop = async () => {
        const reader = port.readable.getReader();
        this._reader = reader;
        this._onDisconnect = onDisconnect;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const text = new TextDecoder().decode(value);
            const kg = this._parse(text);
            if (kg !== null) {
              if (onWeight) onWeight(kg);
              const now = Date.now();
              if (last !== null && Math.abs(last - kg) < 0.001 && (now - lastAt) > 400) {
                if (onStable) onStable(kg);
              }
              last = kg;
              lastAt = now;
            }
          }
        } catch (err) {
          if (!this._closedByUser) {
            if (this._onDisconnect) this._onDisconnect(String(err && err.message || err));
          }
        } finally {
          try { reader.releaseLock(); } catch (e) {}
        }
      };
      readLoop();
      return true;
    },

    async disconnect() {
      this._closedByUser = true;
      const port = this._port;
      this._port = null;
      if (this._reader) {
        try { await this._reader.cancel(); } catch (e) {}
        this._reader = null;
      }
      if (port) {
        try { await port.close(); } catch (e) {}
      }
      return true;
    }
  };

  root.akScaleSerial = ScaleSerial;
}(typeof self !== 'undefined' ? self : this));