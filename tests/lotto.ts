import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Lotto } from "../target/types/lotto";

describe("lotto", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.lotto as Program<Lotto>;

  it("todo", async () => {
    // todo
  });
});
