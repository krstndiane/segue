import { Duration, type Stack } from 'aws-cdk-lib';
import type { HttpApi, HttpStage } from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';

export interface MonitoringProps {
  api: HttpApi;
  stage: HttpStage;
  fn: lambda.Function;
  functionLogs: logs.ILogGroup;
  /** Where alarm emails go. Kept out of the repo: pass -c alarmEmail=… (or ALARM_EMAIL). */
  alarmEmail?: string;
  /** Lambda p95 duration that counts as slow (decision record: 6 s). */
  p95ThresholdMs: number;
}

const FIVE_MIN = Duration.minutes(5);
/** The map sources the API reports (see apps/api/src/requestLog.ts): cache, osm (Overpass), nominatim, none. */
const SOURCES = ['cache', 'osm', 'nominatim', 'none'];

/** One SNS email topic, three alarms and one dashboard. No X-Ray (not in the decision record). */
export function addMonitoring(stack: Stack, props: MonitoringProps) {
  const { stage, fn } = props;

  const topic = new sns.Topic(stack, 'AlarmTopic', { topicName: 'segue-alarms', displayName: 'Segue API alarms' });
  if (props.alarmEmail) topic.addSubscription(new EmailSubscription(props.alarmEmail));
  const notify = new SnsAction(topic);

  const api5xx = stage.metricServerError({ period: FIVE_MIN, statistic: 'Sum' });
  const lambdaErrors = fn.metricErrors({ period: FIVE_MIN, statistic: 'Sum' });
  const p95 = fn.metricDuration({ period: FIVE_MIN, statistic: 'p95' });

  const alarms = [
    new cloudwatch.Alarm(stack, 'Api5xxAlarm', {
      alarmName: 'segue-api-5xx',
      alarmDescription: 'API Gateway returned a 5xx in the last 5 minutes.',
      metric: api5xx,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }),
    new cloudwatch.Alarm(stack, 'LambdaErrorsAlarm', {
      alarmName: 'segue-api-lambda-errors',
      alarmDescription: 'The segue-api Lambda reported errors in the last 5 minutes.',
      metric: lambdaErrors,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }),
    new cloudwatch.Alarm(stack, 'P95DurationAlarm', {
      alarmName: 'segue-api-p95-slow',
      alarmDescription: `Lambda p95 duration above ${props.p95ThresholdMs / 1000} s over 5 minutes. Uncached map lookups can trip this on a cold morning.`,
      metric: p95,
      threshold: props.p95ThresholdMs,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }),
  ];
  for (const a of alarms) {
    a.addAlarmAction(notify);
    a.addOkAction(notify);
  }

  // From the API's JSON log lines (EMF), namespace Segue.
  const hits = new cloudwatch.Metric({ namespace: 'Segue', metricName: 'CacheHit', statistic: 'Sum', period: FIVE_MIN });
  const misses = new cloudwatch.Metric({ namespace: 'Segue', metricName: 'CacheMiss', statistic: 'Sum', period: FIVE_MIN });
  const hitRate = new cloudwatch.MathExpression({
    expression: 'IF(h + m > 0, 100 * h / (h + m), 0)',
    usingMetrics: { h: hits, m: misses },
    label: 'Cache hit rate (%)',
    period: FIVE_MIN,
  });
  const bySource = SOURCES.map(
    (s) => new cloudwatch.Metric({ namespace: 'Segue', metricName: 'PlacesLookups', dimensionsMap: { PlacesSource: s }, statistic: 'Sum', period: FIVE_MIN, label: s }),
  );

  const dashboard = new cloudwatch.Dashboard(stack, 'Dashboard', { dashboardName: 'Segue', defaultInterval: Duration.hours(3) });
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({ title: 'Requests', left: [stage.metricCount({ period: FIVE_MIN, statistic: 'Sum', label: 'API requests' })], width: 8 }),
    new cloudwatch.GraphWidget({
      title: 'p95 latency (ms)',
      left: [stage.metricLatency({ period: FIVE_MIN, statistic: 'p95', label: 'API Gateway' }), p95.with({ label: 'Lambda' })],
      leftAnnotations: [{ value: props.p95ThresholdMs, label: 'alarm' }],
      width: 8,
    }),
    new cloudwatch.GraphWidget({
      title: 'Errors',
      left: [api5xx.with({ label: 'API 5xx' }), stage.metricClientError({ period: FIVE_MIN, statistic: 'Sum', label: 'API 4xx' }), lambdaErrors.with({ label: 'Lambda errors' })],
      width: 8,
    }),
  );
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({ title: 'Cache hit rate (%)', left: [hitRate], leftYAxis: { min: 0, max: 100 }, width: 8 }),
    new cloudwatch.GraphWidget({ title: 'Places answered by', left: bySource, stacked: true, width: 8 }),
    new cloudwatch.AlarmStatusWidget({ title: 'Alarms', alarms, width: 8 }),
  );
  dashboard.addWidgets(
    new cloudwatch.LogQueryWidget({
      title: 'Recent requests (route, status, ms, source, cache; no coordinates)',
      logGroupNames: [props.functionLogs.logGroupName],
      queryLines: ['fields @timestamp, route, status, ms, provider, cache', 'filter msg = "request"', 'sort @timestamp desc', 'limit 20'],
      width: 24,
      height: 6,
    }),
  );

  return { topic, alarms, dashboard };
}
