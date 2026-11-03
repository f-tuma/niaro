// jsdom with the platform globals a browser has and jsdom leaves out
// (fetch types, streams, text coding), taken from Node. setImmediate is
// passed on too: React's scheduler prefers it to MessageChannel, whose open
// port would keep Jest from exiting after the run.
const { TestEnvironment } = require("jest-environment-jsdom");

const fromNode = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "Blob",
  "File",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "TextEncoderStream",
  "TextDecoderStream",
  "TextEncoder",
  "TextDecoder",
  "AbortController",
  "AbortSignal",
  "structuredClone",
  "MessageChannel",
  "BroadcastChannel",
  "setImmediate",
  "clearImmediate",
];

module.exports = class NodeGlobalsJsdomEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    for (const name of fromNode)
      if (globalThis[name] !== undefined && this.global[name] === undefined)
        this.global[name] = globalThis[name];
  }
};
