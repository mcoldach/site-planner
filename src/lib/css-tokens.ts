/**
 * Read a CSS custom property from :root at runtime.
 * Used by MapLibre paint values and other non-Tailwind consumers.
 */
export function getCssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
