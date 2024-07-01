export let kind = undefined;

export function setShims(shims) {
  if (kind) {
    throw new Error(`shims already set to ${kind}`);
  }

  kind = shims.kind;
}
