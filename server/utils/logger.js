'use strict';

const ts = () => new Date().toISOString().slice(11, 23);

module.exports = {
  info: (...a) => console.log(`[${ts()}] [info]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] [warn]`, ...a),
  error: (...a) => console.error(`[${ts()}] [error]`, ...a),
};
