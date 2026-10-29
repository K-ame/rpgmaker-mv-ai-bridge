export const PLUGIN_NAME = 'MV_AI_Bridge';
export const VERSION = '0.2.0';
export const DEFAULT_PORT = 7321;
export const DEFAULT_HOST = '127.0.0.1';

// Binding anywhere else exposes an unauthenticated-by-origin surface to the
// network, even though every request still needs the token.
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}
