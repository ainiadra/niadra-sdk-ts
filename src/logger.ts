/**
 * Where the SDK reports what it swallowed in fail-open mode. Messages carry status codes,
 * error codes and request ids, never handles, message text or other personal data.
 */
export interface Logger {
  debug(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

const noop = (): void => undefined;

/** Warnings and errors go to the console; debug output is off unless you pass your own logger. */
export const consoleLogger: Logger = {
  debug: noop,
  warn: (message, ...details) => {
    console.warn(`[niadra] ${message}`, ...details);
  },
  error: (message, ...details) => {
    console.error(`[niadra] ${message}`, ...details);
  },
};

export const silentLogger: Logger = { debug: noop, warn: noop, error: noop };
