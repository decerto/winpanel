/**
 * The one error type every database engine reports through.
 *
 * Kept on its own so the engine adapters, the naming rules and the router can
 * all use it without importing each other.
 */
export class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseError';
  }
}
