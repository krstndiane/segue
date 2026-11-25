import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { ApiMapping, CfnStage, DomainName, HttpApi, type HttpStage } from 'aws-cdk-lib/aws-apigatewayv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { addMonitoring } from './monitoring';

export interface SegueApiStackProps extends StackProps {
  /** Folder with server.js, package.json ("type": "module"), node_modules/pg and run.sh. */
  assetDir: string;
  /** Lambda Web Adapter layer version (from the adapter's Zip Packages guide). */
  adapterLayerVersion: number;
  /**
   * An ISSUED ACM certificate for api.segue.pdyntech.com in this Region. Until it is given, no custom domain is created.
   * The pdyntech.com zone lives in another AWS account, so this stack never creates DNS records.
   */
  certificateArn?: string;
  /** Alarm emails go here (decision record). Passed at deploy time so it is not committed. */
  alarmEmail?: string;
}

export const API_DOMAIN = 'api.segue.pdyntech.com';
/** Decision record: 10 requests a second, bursts of 20, to protect the free map services. */
const THROTTLE = { rate: 10, burst: 20 };
/** Decision record: p95 Lambda duration alarm at 6 s. */
const P95_THRESHOLD_MS = 6_000;

/** Where the API's settings and secrets live in SSM Parameter Store (values are set by hand, never in code). */
export const SSM_PREFIX = '/segue/';

/**
 * The unchanged API bundle on Lambda through Lambda Web Adapter, behind an HTTP API's default execute-api URL.
 * Stage 3: a shared DynamoDB cache, settings loaded from SSM at cold start, a small Postgres pool and JSON logs.
 * The custom domain comes in Stage 4.
 */
export class SegueApiStack extends Stack {
  constructor(scope: Construct, id: string, props: SegueApiStackProps) {
    super(scope, id, props);

    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      logGroupName: '/aws/lambda/segue-api',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // One table for place, place-name and weather answers. It is only a cache: it rebuilds from the public sources.
    const cache = new dynamodb.Table(this, 'Cache', {
      tableName: 'segue-cache',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const adapter = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'WebAdapter',
      `arn:aws:lambda:${this.region}:753240598075:layer:LambdaAdapterLayerArm64:${props.adapterLayerVersion}`,
    );

    const fn = new lambda.Function(this, 'Api', {
      functionName: 'segue-api',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'run.sh',
      code: lambda.Code.fromAsset(props.assetDir),
      memorySize: 512,
      timeout: Duration.seconds(15),
      layers: [adapter],
      logGroup,
      environment: {
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
        AWS_LWA_PORT: '8080',
        AWS_LWA_READINESS_CHECK_PATH: '/health',
        PORT: '8080',
        NODE_ENV: 'production',
        PLACES_PROVIDER: 'osm',
        MIGRATE_ON_START: 'off',
        // Stage 3: settings from SSM, shared cache, two Postgres connections per copy, JSON request logs.
        SSM_PREFIX,
        CACHE_STORE: 'dynamodb',
        CACHE_TABLE: cache.tableName,
        DB_POOL_MAX: '2',
        LOG_FORMAT: 'json',
        NOMINATIM_USER_AGENT: 'Segue day planner (https://segue.pdyntech.com)',
        TRUSTED_PROXY_HOPS: '1',
        READ_RATE_LIMIT: '300',
      },
    });

    // Least privilege: read and write single cache items, and read the /segue/ parameters. Nothing else.
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:PutItem'], resources: [cache.tableArn] }));
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParametersByPath'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_PREFIX.slice(0, -1)}`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_PREFIX}*`,
        ],
      }),
    );

    const api = new HttpApi(this, 'HttpApi', {
      apiName: 'segue-api',
      description: 'Segue API (default stage, Lambda proxy). Custom domain comes in Stage 4.',
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', fn),
    });

    // Stage throttling and access logs on the $default stage. Access logs carry the route key, never the full URI
    // or query string (places queries hold lat and lng), and no client IP.
    const stage = api.defaultStage as HttpStage;
    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: '/aws/apigateway/segue-api',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const cfnStage = stage.node.defaultChild as CfnStage;
    cfnStage.defaultRouteSettings = { throttlingRateLimit: THROTTLE.rate, throttlingBurstLimit: THROTTLE.burst };
    cfnStage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        requestTime: '$context.requestTime',
        routeKey: '$context.routeKey',
        status: '$context.status',
        responseLatency: '$context.responseLatency',
        integrationStatus: '$context.integrationStatus',
      }),
    };

    if (props.certificateArn) {
      const domain = new DomainName(this, 'Domain', {
        domainName: API_DOMAIN,
        certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn),
      });
      new ApiMapping(this, 'Mapping', { api, domainName: domain, stage });
      new CfnOutput(this, 'DnsRecordToAdd', {
        value: `${API_DOMAIN}  CNAME  ${domain.regionalDomainName}`,
        description: 'Add this record by hand in the team account (pdyntech.com zone).',
      });
    }

    const monitoring = addMonitoring(this, { api, stage, fn, functionLogs: logGroup, alarmEmail: props.alarmEmail, p95ThresholdMs: P95_THRESHOLD_MS });
    new CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards/dashboard/${monitoring.dashboard.dashboardName}`,
    });
    new CfnOutput(this, 'AlarmTopicArn', { value: monitoring.topic.topicArn });

    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint, description: 'execute-api URL for the Stage 2 checks' });
    new CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new CfnOutput(this, 'CacheTable', { value: cache.tableName });
  }
}
