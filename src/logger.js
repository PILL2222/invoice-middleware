// src/logger.js - Simple structured logger
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function log(level, message, meta = {}) {
  if (LEVELS[level] > LEVELS[LOG_LEVEL]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  const out = level === "error" ? console.error : console.log;
  out(JSON.stringify(entry));
}

module.exports = {
  error: (msg, meta) => log("error", msg, meta),
  warn: (msg, meta) => log("warn", msg, meta),
  info: (msg, meta) => log("info", msg, meta),
  debug: (msg, meta) => log("debug", msg, meta),
};
