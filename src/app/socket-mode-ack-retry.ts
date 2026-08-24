import type { SocketModeReceiver } from "@slack/bolt";

const ACK_RETRY_DELAY_MS = 250;

type SendFn = (id: string, body?: unknown) => Promise<void>;

/**
 * Exactly one retry after a short fixed delay: Socket Mode reconnects on its
 * own within roughly this window after a drop, and Bolt's ack() has no
 * built-in fallback the way its HTTP receiver does, so a longer wait or
 * backoff would only make a click hang for no benefit.
 */
export async function withOneRetry<T>(
  attempt: () => Promise<T>,
  delayMs = ACK_RETRY_DELAY_MS,
): Promise<T> {
  try {
    return await attempt();
  } catch {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    try {
      return await attempt();
    } catch (error) {
      (error as { ackRetryExhausted?: boolean }).ackRetryExhausted = true;
      throw error;
    }
  }
}

/**
 * Bolt's ack() marks its envelope acknowledged the instant it's called, before
 * the underlying send is attempted — calling ack() again after it throws is a
 * guaranteed no-op. A real retry can only happen inside SocketModeClient.send()
 * itself, which Bolt has no hook for, so this patches the receiver's own
 * client instance directly. `send` is typed private upstream; guarded in case
 * a future library version changes its shape.
 */
export function patchAckRetry(receiver: SocketModeReceiver): void {
  const client = receiver.client as unknown as { send: SendFn };
  if (typeof client.send !== "function") {
    console.warn(
      "patchAckRetry: SocketModeClient.send is not a function — ack retry is disabled. " +
        "Check whether @slack/socket-mode changed its internals.",
    );
    return;
  }
  const originalSend = client.send.bind(client);
  client.send = (id, body) => withOneRetry(() => originalSend(id, body));
}
