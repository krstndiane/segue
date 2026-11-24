import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export interface SegueApiStackProps extends StackProps {
  /** Folder with server.js, package.json ("type": "module"), node_modules/pg and run.sh. */
  assetDir: string;
  /** Lambda Web Adapter layer version (from the adapter's Zip Packages guide). */
  adapterLayerVersion: number;
}

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

    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint, description: 'execute-api URL for the Stage 2 checks' });
    new CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new CfnOutput(this, 'CacheTable', { value: cache.tableName });
  }
}
