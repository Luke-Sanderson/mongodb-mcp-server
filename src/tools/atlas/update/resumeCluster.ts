import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { AtlasArgs } from "../../args.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";

export class ResumeClusterTool extends AtlasToolBase {
    static toolName = "atlas-resume-cluster";
    public description = "Resume a paused MongoDB Atlas cluster to bring it back online.";
    static operationType: OperationType = "update";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID containing the cluster"),
        clusterName: AtlasArgs.clusterName().describe("Name of the cluster to resume"),
    };

    protected async execute({ projectId, clusterName }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const cluster = await this.apiClient.getCluster({
            params: { path: { groupId: projectId, clusterName } },
        });

        if (cluster.paused !== true) {
            return {
                content: [{ type: "text", text: `Cluster "${clusterName}" is not paused.` }],
            };
        }

        await this.apiClient.updateCluster({
            params: { path: { groupId: projectId, clusterName } },
            body: { paused: false } as unknown as ClusterDescription20240805,
        });

        return {
            content: [{ type: "text", text: `Cluster "${clusterName}" resume requested.` }],
        };
    }
}
