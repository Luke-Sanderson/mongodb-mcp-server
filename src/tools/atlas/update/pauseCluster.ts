import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { AtlasArgs } from "../../args.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";

export class PauseClusterTool extends AtlasToolBase {
    static toolName = "atlas-pause-cluster";
    public description =
        "Pause a MongoDB Atlas cluster to stop compute billing. Cluster must be IDLE (retry if CREATING or UPDATING).";
    static operationType: OperationType = "update";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID."),
        clusterName: AtlasArgs.clusterName().describe("Cluster name."),
    };

    protected async execute({ projectId, clusterName }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const cluster = await this.apiClient.getCluster({
            params: { path: { groupId: projectId, clusterName } },
        });

        if (cluster.paused === true) {
            return {
                content: [{ type: "text", text: `Cluster "${clusterName}" is already paused.` }],
            };
        }

        if (cluster.stateName && cluster.stateName !== "IDLE") {
            return {
                content: [
                    {
                        type: "text",
                        text: `Cluster "${clusterName}" is in state ${cluster.stateName}. Pausing requires the cluster to be IDLE. Wait for the cluster to reach IDLE and try again.`,
                    },
                ],
                isError: true,
            };
        }

        await this.apiClient.updateCluster({
            params: { path: { groupId: projectId, clusterName } },
            body: { paused: true } as unknown as ClusterDescription20240805,
        });

        return {
            content: [{ type: "text", text: `Cluster "${clusterName}" pause requested.` }],
        };
    }
}
