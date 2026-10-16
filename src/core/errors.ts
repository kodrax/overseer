export type ErrorCode =
  | 'NO_PROJECT'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INVALID_STATUS'
  | 'INVALID_LINK'
  | 'INVALID_PARENT'
  | 'NOT_MANAGED'
  | 'CONFIG_PARSE'
  | 'DISABLED'
  | 'CONFLICT'
  | 'GIT_FAILED'
  | 'SETUP_FAILED';

/** User-facing error: surfaces as `<CODE>: <message>` in the CLI, MCP tools and the board API. */
export class OverseerError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'OverseerError';
    this.code = code;
    this.details = details;
  }
}

export function isOverseerError(error: unknown): error is OverseerError {
  return error instanceof OverseerError;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
