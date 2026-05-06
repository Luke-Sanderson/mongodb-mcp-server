import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { ensureCurrentIpInAccessList } from "../../../common/atlas/accessListUtils.js";
import { AtlasArgs } from "../../args.js";
import { z } from "zod";

const ProdInstanceSize = z.enum(["M30", "M40", "M50", "M60", "M80", "M100", "M140", "M200", "M300", "M400", "M700"]);

export class CreateProdClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-prod-cluster";
    public description =
        "Create a single-region MongoDB Atlas production cluster: M30 REPLICASET on AWS US_EAST_1, 3 nodes, compute and disk autoscaling, Cloud Backups, termination protection.";
    static operationType: OperationType = "create";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID."),
        name: AtlasArgs.clusterName().describe("Cluster name."),
        instanceSize: ProdInstanceSize.default("M30").describe("M30 (default) is the smallest production tier."),
    };

    protected async execute({
        projectId,
        name,
        instanceSize,
    }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const body = {
            name,
            clusterType: "REPLICASET",
            backupEnabled: true,
            terminationProtectionEnabled: true,
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
                                    maxInstanceSize: maxForProd(instanceSize),
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
                    text: `Production cluster "${name}" provisioning: ${instanceSize} REPLICASET on AWS US_EAST_1, autoscaling on, Cloud Backups on, termination protection on.`,
                },
            ],
        };
    }
}

function maxForProd(size: string): string {
    const ladder = ["M30", "M40", "M50", "M60", "M80", "M100", "M140", "M200", "M300", "M400", "M700"];
    const idx = ladder.indexOf(size);
    return idx === -1 ? size : (ladder[Math.min(idx + 2, ladder.length - 1)] ?? size);
}
