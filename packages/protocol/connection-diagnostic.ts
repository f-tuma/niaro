/** Local presentation metadata; never an authentication or wire-protocol grant. */
export type ConnectionPhase =
  | "authentication"
  | "capabilities"
  | "snapshot"
  | "events";
export type ConnectionDiagnostic = {
  phase: ConnectionPhase;
  reason:
    | "network"
    | "timeout"
    | "http"
    | "response"
    | "protocol"
    | "schema"
    | "scope"
    | "payload"
    | "unknown";
  httpStatus?: number;
  expectedProfile?: string;
  receivedProfile?: string;
  fields?: string[];
};
