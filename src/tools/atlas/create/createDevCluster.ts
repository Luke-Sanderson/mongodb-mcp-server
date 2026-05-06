import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { ensureCurrentIpInAccessList } from "../../../common/atlas/accessListUtils.js";
import { AtlasArgs } from "../../args.js";
import { z } from "zod";

const DevInstanceSize = z.enum(["M10", "M20", "M30"]);

export class CreateDevClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-dev-cluster";
    public description =
        "Create the lowest-cost auto-scaling MongoDB Atlas development cluster: M10 REPLICASET on AWS US_EAST_1, 3 nodes, compute and disk autoscaling, no backup.";
    static operationType: OperationType = "create";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID."),
        name: AtlasArgs.clusterName().describe("Cluster name."),
        instanceSize: DevInstanceSize.default("M10").describe("M10 (default) is cheapest."),
    };

    protected async execute({
        projectId,
        name,
        instanceSize,
    }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const body = {
            name,
            clusterType: "REPLICASET",
            backupEnabled: false,
            terminationProtectionEnabled: false,
            replicationSpecs: [
                {
                    zoneName: "Zone 1",
                    regionConfigs: [
                        {
                            providerName: "AWS",
                            regionName: "US_EAST_1",
                            priority: 7,
                            electableSpecs: { instanceSize, nodeCount: 3 },
                            autoScaling: {
                                compute: {
                                    enabled: true,
                                    scaleDownEnabled: true,
                                    minInstanceSize: instanceSize,
                                    maxInstanceSize: maxForDev(instanceSize),
                                },
                                diskGB: { enabled: true },
                            },
                        },
                    ],
                },
            ],
        } as unknown as ClusterDescription20240805;

        await ensureCurrentIpInAccessList(this.apiClient, projectId);
        await this.apiClient.createCluster({
            params: { path: { groupId: projectId } },
            body,
        });

        return {
            content: [
                {
                    type: "text",
                    text: `Dev cluster "${name}" provisioning: ${instanceSize} REPLICASET on AWS US_EAST_1, autoscaling on, no backup.`,
                },
            ],
        };
    }
}

function maxForDev(size: string): string {
    const ladder = ["M10", "M20", "M30", "M40", "M50"];
    const idx = ladder.indexOf(size);
    return idx === -1 ? size : (ladder[Math.min(idx + 2, ladder.length - 1)] ?? size);
}
