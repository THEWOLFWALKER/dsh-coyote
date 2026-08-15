/** Error type for invalid state, unsafe parameters, or protocol failures. */
export class CoyoteError extends Error {
  /**
   * @param message - Actionable operator- or model-facing failure text.
   * @param code - Optional machine-readable tag, e.g. a V3 protocol error code.
   */
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'CoyoteError'
  }
}
