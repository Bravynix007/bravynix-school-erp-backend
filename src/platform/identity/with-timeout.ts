/** Rejects with `Error(reason)` if `work` takes longer than `ms`; always clears its timer. */
export async function withTimeout<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
