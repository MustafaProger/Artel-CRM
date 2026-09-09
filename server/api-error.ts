/** Only deliberately authored messages may be returned to the browser. */
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
