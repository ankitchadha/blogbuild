import * as path from "path";
import {
  aws_route53 as r53,
  aws_ec2 as ec2,
  custom_resources as cr,
  aws_logs as logs,
  aws_lambda,
  aws_iam as iam,
} from "aws-cdk-lib";

import * as cdk from "aws-cdk-lib";

import * as constructs from "constructs";
export interface RemoteVpc {
  readonly vpcId: string;
  readonly vpcRegion: string;
}

export interface CentralAccount {
  readonly accountId: string;
  readonly roleArn: string;
}

export interface EnterpriseZoneProps {
  readonly enterpriseDomainName: string;
  readonly localVpc: ec2.Vpc;
  readonly remoteVpc: RemoteVpc[];
  readonly centralAccount: CentralAccount;
}

/**
 * create forwarding rules and associate them with a vpc.
 */
export class EnterpriseZone extends constructs.Construct {
  public readonly privateZone: r53.PrivateHostedZone;

  constructor(scope: constructs.Construct, id: string, props: EnterpriseZoneProps) {
    super(scope, id);

    new cdk.CfnOutput(this, 'domain', { value: props.enterpriseDomainName})

    // create a private zone.
    this.privateZone = new r53.PrivateHostedZone(this, "privatezone", {
      zoneName: props.enterpriseDomainName,
      vpc: props.localVpc,
    });

    props.remoteVpc.forEach((remoteVpc, index) => {
      // create an association authorisization tp a
      //aws route53 create-vpc-association-authorization --hosted-zone-id <hosted-zone-id> --vpc VPCRegion=<region>,VPCId=<vpc-id> --region us-east-1
      const createAssn = new cr.AwsCustomResource(
        this,
        `createR53Assn${index}`,
        {
          onCreate: {
            service: "Route53",
            action: "createVPCAssociationAuthorization",
            parameters: {
              HostedZoneId: this.privateZone.hostedZoneId,
              VPC: {
                VPCId: remoteVpc.vpcId,
                VPCRegion: remoteVpc.vpcRegion,
              },
            },
            physicalResourceId: cr.PhysicalResourceId.of(
              props.enterpriseDomainName
            ),
          },
          onDelete: {
            service: "Route53",
            action: "deleteVPCAssociationAuthorization",
            parameters: {
              HostedZoneId: this.privateZone.hostedZoneId,
              VPC: {
                VPCId: remoteVpc.vpcId,
                VPCRegion: remoteVpc.vpcRegion,
              },
            },
          },
          logRetention: logs.RetentionDays.ONE_DAY,
          policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
            resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
          }),
        }
      );

      const associateCentralVpcwithZone = new aws_lambda.Function(
        this,
        `${index}associateLambda`,
        {
          runtime: aws_lambda.Runtime.PYTHON_3_9,
          logRetention: logs.RetentionDays.ONE_MONTH,
          handler: "associateCentralVPC.on_event",
          code: aws_lambda.Code.fromAsset(path.join(__dirname, "./")),
          timeout: cdk.Duration.seconds(899),
        }
      );

      // this lambda will assume a role in the central account, so it does not need any local permissions
      associateCentralVpcwithZone.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["sts:AssumeRole"],
          effect: iam.Effect.ALLOW,
          resources: [props.centralAccount.roleArn],
        })
      );

      const associateVPCCustomResources = new cdk.CustomResource(this, `${index}associateVPCcustomResources`, {
        resourceType: 'Custom::AssociateInternalZone',
        properties: {
          ZoneId: this.privateZone.hostedZoneId, // this is the zone
          VPCId: remoteVpc.vpcId,
          VPCRegion: remoteVpc.vpcRegion,
          CentralAccountRole: props.centralAccount.roleArn,
        },
        serviceToken: new cr.Provider(this, `${index}associateProvider`, {
          onEventHandler: associateCentralVpcwithZone,
        }).serviceToken,
      });

      associateVPCCustomResources.node.addDependency(createAssn);
    });
  }
}
