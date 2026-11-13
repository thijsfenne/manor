/** A provider-side transport reset whose existing session is safe to resume once. */
export const isRetryableProviderTransportError = (message: string): boolean =>
  /RetriableError:\s*\[canceled\]\s*http\/2 stream closed with error code CANCEL \(0x8\)/i.test(message)
