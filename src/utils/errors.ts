export class NovaError extends Error {
  constructor(message: string, readonly code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NovaError';
  }
}

export function asNovaError(error: unknown): NovaError {
  if (error instanceof NovaError) return error;
  return new NovaError(error instanceof Error ? error.message : String(error), 'UNEXPECTED_ERROR', { cause: error });
}
