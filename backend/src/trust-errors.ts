export class TrustError extends Error {
  constructor(public readonly status: 400 | 500 | 502, message: string) {
    super(message);
    this.name = "TrustError";
  }
}
