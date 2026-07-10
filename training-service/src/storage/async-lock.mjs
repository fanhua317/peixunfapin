export function createAsyncLock() {
  let tail = Promise.resolve();

  return async function runExclusive(work) {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await work();
    } finally {
      release();
    }
  };
}
