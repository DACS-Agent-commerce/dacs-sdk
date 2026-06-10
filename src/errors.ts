/** Base error for everything this SDK throws. */
export class DacsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DacsError";
  }
}

/**
 * Thrown by seam methods that are defined but not yet implemented in the MVP
 * scaffold. The task ref points at the IMPLEMENTATION.md task that lands it.
 */
export class NotImplementedError extends DacsError {
  constructor(feature: string, taskRef?: string) {
    super(
      `Not implemented in MVP scaffold: ${feature}` +
        (taskRef ? ` (planned: ${taskRef})` : ""),
    );
    this.name = "NotImplementedError";
  }
}
