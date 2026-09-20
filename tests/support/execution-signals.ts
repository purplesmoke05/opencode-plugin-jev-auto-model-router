export class ExecutionHarnessError extends Error {
  override readonly name = "ExecutionHarnessError";
}

export class ExecutionSignals<Value> {
  readonly values: Value[] = [];
  readonly #listeners = new Set<() => void>();

  push(value: Value): void {
    this.values.push(value);
    for (const listener of this.#listeners) listener();
  }

  async waitFor(predicate: (value: Value) => boolean): Promise<Value> {
    const previous = this.values.find(predicate);
    if (previous !== undefined) return previous;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#listeners.delete(listener);
        reject(
          new ExecutionHarnessError(`Signal deadline exceeded: ${JSON.stringify(this.values)}`),
        );
      }, 45_000);
      const listener = () => {
        const value = this.values.find(predicate);
        if (value === undefined) return;
        clearTimeout(timer);
        this.#listeners.delete(listener);
        resolve(value);
      };
      this.#listeners.add(listener);
    });
  }
}
