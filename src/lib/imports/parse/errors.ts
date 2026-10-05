/**
 * Parser failures. Messages are written for the person who uploaded the file:
 * no stack traces, no SQL, no internals - just what is wrong and what to do.
 */
export class ImportParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ImportParseError';
    this.code = code;
  }
}
