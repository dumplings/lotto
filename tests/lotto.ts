import { expect } from "chai";
import type { Lotto } from "../target/types/lotto";

type HasAccounts = "accounts" extends keyof Lotto ? true : false;
type HasTypes = "types" extends keyof Lotto ? true : false;
type HasErrors = "errors" extends keyof Lotto ? true : false;

const PROGRAM_ID: Lotto["address"] =
  "6pZAWE597dHz1YHqRmDdo6MMPK13BFzFLHJY9XWsmJsm";
const INSTRUCTIONS: Lotto["instructions"] = [];
const HAS_ACCOUNTS: HasAccounts = false;
const HAS_TYPES: HasTypes = false;
const HAS_ERRORS: HasErrors = false;

describe("lotto Phase 0 generated surface", () => {
  it("contains only the empty-program Phase 0 IDL surface", () => {
    expect(PROGRAM_ID).to.equal("6pZAWE597dHz1YHqRmDdo6MMPK13BFzFLHJY9XWsmJsm");
    expect(INSTRUCTIONS).to.deep.equal([]);
    expect(HAS_ACCOUNTS).to.equal(false);
    expect(HAS_TYPES).to.equal(false);
    expect(HAS_ERRORS).to.equal(false);
  });
});
