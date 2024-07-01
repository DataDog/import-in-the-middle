import * as core from "../fixtures/side-effects/core.mjs";
import { strictEqual } from "assert";

strictEqual(core.shimsKind, "node");
