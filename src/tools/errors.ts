/**
 * An error caused by the caller's input (e.g. an unknown repo name).
 * Its message is safe to show to the client verbatim; any other thrown
 * error is reduced to a generic message by the server (SEC-09).
 */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserInputError';
  }
}
