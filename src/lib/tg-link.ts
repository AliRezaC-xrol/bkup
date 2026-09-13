/**
 * Telegram deep links — jump from a backup history row straight to the
 * actual Telegram message the backup was sent to.
 *
 * Supports the three chat-id shapes the bot API hands out:
 *  • "-100XXXXXXXXXX"  → channel / supergroup  → https://t.me/c/<id>/<msg>
 *  • "-XXXXXXXXX"      → basic group (best effort, same c/ form)
 *  • "@username"/plain → public chat           → https://t.me/<user>/<msg>
 * A configured forum topic is appended as ?topic=<id>.
 */

export function tgMessageUrl(
  chatId: string,
  threadId: string | null | undefined,
  msgId: number | null | undefined
): string | null {
  const chat = (chatId || "").trim();
  const id = Number(msgId);
  if (!chat || !Number.isFinite(id) || id <= 0) return null;

  let base: string;
  if (/^-100\d+$/.test(chat)) base = `https://t.me/c/${chat.slice(4)}/${id}`;
  else if (/^-\d+$/.test(chat)) base = `https://t.me/c/${chat.slice(1)}/${id}`;
  else base = `https://t.me/${chat.replace(/^@/, "")}/${id}`;

  const topic = (threadId || "").trim();
  return topic ? `${base}?topic=${topic}` : base;
}

/** First declared message id of a multi-part send (tgMessageIds JSON), if any. */
export function firstTgMessageId(primary: number | null | undefined, multiJson: string | null | undefined): number | null {
  if (primary && primary > 0) return primary;
  if (multiJson) {
    try {
      const arr = JSON.parse(multiJson) as unknown;
      if (Array.isArray(arr)) {
        const first = arr.map(Number).find((n) => Number.isFinite(n) && n > 0);
        if (first) return first;
      }
    } catch { /* corrupt json — ignore */ }
  }
  return null;
}
