"use strict";

const { EventEmitter } = require("events");

const agentEvents = new EventEmitter();
agentEvents.setMaxListeners(30); // SSE connections + internal listeners

let _statusProvider = null;

function registerStatusProvider(fn) {
  _statusProvider = fn;
}

function getStatus() {
  return _statusProvider ? _statusProvider() : null;
}

module.exports = { agentEvents, registerStatusProvider, getStatus };
