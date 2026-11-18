// The cookie attributes of the first-party cookies that an edition shares with core.
export function secureCookie(name: string, value: string, ttl = 60 * 60 * 24 * 30): string {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttl}`;
}
