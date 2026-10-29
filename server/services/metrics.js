'use strict';

const os = require('os');

class MetricsService {
  constructor() {
    this.eventLoopDelayMs = 0;
    this.processCpuPercent = 0;
    this.startedAt = Date.now();
    this._lastCpu = process.cpuUsage();
    this._lastCpuAt = Date.now();
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    const self = this;
    let expected = Date.now();
    this._timer = setInterval(() => {
      const now = Date.now();
      // Event-loop delay: how late this interval fired.
      self.eventLoopDelayMs = Math.max(0, now - expected - 1000);
      expected = now;
      const usage = process.cpuUsage();
      const elapsed = (Date.now() - self._lastCpuAt) / 1000;
      if (elapsed > 0) {
        const used = (usage.user - self._lastCpu.user + usage.system - self._lastCpu.system) / 1000000;
        self.processCpuPercent = Math.round((used / elapsed) * 100) / 100; // % of one core
      }
      self._lastCpu = usage;
      self._lastCpuAt = Date.now();
    }, 1000);
  }

  snapshot() {
    const mem = process.memoryUsage();
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      eventLoopDelayMs: Math.round(this.eventLoopDelayMs * 100) / 100,
      processCpuPercent: this.processCpuPercent,
      loadavg: os.loadavg().map((v) => Math.round(v * 100) / 100),
      cores: os.cpus().length,
      memory: {
        rssMb: Math.round(mem.rss / 1048576),
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
        heapTotalMb: Math.round(mem.heapTotal / 1048576),
        externalMb: Math.round((mem.external || 0) / 1048576),
        osFreeMb: Math.round(os.freemem() / 1048576),
        osTotalMb: Math.round(os.totalmem() / 1048576),
      },
      nodeVersion: process.version,
      platform: `${os.type()} ${os.release()}`,
    };
  }
}

module.exports = { MetricsService };
