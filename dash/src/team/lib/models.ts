// Client-side highlighting of premium models used on simple task categories.
// Mirrors the server's insight rule; categories are from src/types.ts TaskCategory.
export const PREMIUM_MODEL_PATTERN = /opus|gpt-5|o3|pro/i
export const SIMPLE_CATEGORIES = new Set(['conversation', 'exploration', 'general', 'unknown'])

export function isPremiumModel(model: string): boolean {
  return PREMIUM_MODEL_PATTERN.test(model)
}

export function isPremiumOnSimple(model: string, category: string): boolean {
  return isPremiumModel(model) && SIMPLE_CATEGORIES.has(category)
}
