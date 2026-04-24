import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CliConfig, t3Cli } from "./main";
import { OpenLive } from "./open";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json" with { type: "json" };
import { ServerLive } from "./wsServer";
import { NetService } from "@t3tools/shared/Net";
import { FetchHttpClient } from "effect/unstable/http";
import { runBrowserUseMcpServer } from "./provider/browserUseMcpServer";

const RuntimeLayer = Layer.empty.pipe(
  Layer.provideMerge(CliConfig.layer),
  Layer.provideMerge(ServerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

if (process.argv[2] === "browser-use-mcp") {
  runBrowserUseMcpServer()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
} else {
  Command.run(t3Cli, { version }).pipe(Effect.provide(RuntimeLayer), NodeRuntime.runMain);
}
