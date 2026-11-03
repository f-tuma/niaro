// jsdom with the platform globals a browser has and jsdom leaves out
// (fetch types, streams, text coding), taken from Node.
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
];

module.exports = class NodeGlobalsJsdomEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    for (const name of fromNode)
      if (globalThis[name] !== undefined && this.global[name] === undefined)
        this.global[name] = globalThis[name];
  }
};
