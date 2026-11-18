const messages: Record<string, string> = {}

export function t(key: string): string {
  return messages[key] ?? key
}

export function setMessages(next: Record<string, string>): void {
  Object.assign(messages, next)
}
