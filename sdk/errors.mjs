// Typed errors, so `catch (e) { if (e instanceof TimeoutError) ... }` works.

export class SandboxError extends Error {
  constructor(message) { super(message); this.name = 'SandboxError'; }
}
export class TimeoutError extends SandboxError {
  constructor(message) { super(message); this.name = 'TimeoutError'; }
}
export class InvalidArgumentError extends SandboxError {
  constructor(message, stackTrace) { super(message); this.name = 'InvalidArgumentError'; if (stackTrace) this.stack = stackTrace; }
}
export class NotEnoughSpaceError extends SandboxError {
  constructor(message) { super(message); this.name = 'NotEnoughSpaceError'; }
}
export class NotFoundError extends SandboxError {
  constructor(message) { super(message); this.name = 'NotFoundError'; }
}
export class FileNotFoundError extends NotFoundError {
  constructor(message) { super(message); this.name = 'FileNotFoundError'; }
}
export class SandboxNotFoundError extends NotFoundError {
  constructor(message) { super(message); this.name = 'SandboxNotFoundError'; }
}
export class AuthenticationError extends Error {
  constructor(message) { super(message); this.name = 'AuthenticationError'; }
}
export class CommandExitError extends SandboxError {
  constructor(result) {
    super(result.error || `command exited with code ${result.exitCode}`);
    this.name = 'CommandExitError'; this._result = result;
  }
  get exitCode() { return this._result.exitCode; }
  get error() { return this._result.error; }
  get stdout() { return this._result.stdout; }
  get stderr() { return this._result.stderr; }
}
