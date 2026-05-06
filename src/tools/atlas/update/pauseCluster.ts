import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { AtlasArgs } from "../../args.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";

export class PauseClusterTool extends AtlasToolBase {
    static toolName = "atlas-pause-cluster";
    public description =
        "Pause a MongoDB Atlas cluster to stop billing for compute. The cluster must be in the IDLE state. Paused clusters retain their data and can be resumed with atlas-resume-cluster.";
    static operationType: OperationType = "update";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID containing the cluster"),
        clusterName: AtlasArgs.clusterName().describe("Name of the cluster to pause"),
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
