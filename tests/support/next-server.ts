/** Test stand-in: outside a request, `after` just runs the callback. */
export function after(fn: () => unknown) {
  void Promise.resolve().then(fn);
}
