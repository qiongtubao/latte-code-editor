/** Two floats per node: x, y. IDs, groups, and edges remain static on the main thread. */
export const FORCE_POSITION_STRIDE = 2;

export interface ForceLayoutTickMessage {
  positions: Float32Array;
}

export interface ForceLayoutReadyMessage {
  type: "ready";
}

export type ForceLayoutOutputMessage =
  | ForceLayoutTickMessage
  | ForceLayoutReadyMessage;
