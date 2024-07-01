import * as shims from "./registry.mjs";
import * as auto from "./runtime.mjs";

if (!shims.kind) {
  shims.setShims(auto.getRuntime());
}

export * from "./registry.mjs";
