import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("built-in provider drivers", () => {
  it("registers the universal ACP driver", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toContain("acpRegistry");
  });
});
