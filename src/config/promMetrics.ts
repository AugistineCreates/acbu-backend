/**
 * #388: Prometheus-compatible metrics for Prisma connection pool.
 * #436: Heap usage ratio gauge and heap dump counter for memory leak detection.
 * W10-I-013: Reserve ratio, queue depth, and RPC health metrics for observability.
 *
 * Instruments Prisma middleware to track:
 *  - prisma_pool_wait_seconds   – time spent waiting to acquire a connection (histogram)
 *  - prisma_pool_acquire_seconds – total time from request to first query byte (histogram)
 *  - prisma_pool_exhausted_total – P2024 (pool timeout) error counter
 *
 * Memory metrics:
 *  - nodejs_heap_used_ratio     – heapUsed / heap_size_limit (0–1 gauge)
 *  - nodejs_heap_dump_total     – number of heap snapshots written to disk
 *
 * Reserve metrics (W10-I-013):
 *  - reserve_ratio              – current reserve ratio by currency and segment (gauge)
 *  - reserve_ratio_breach_total – count of reserve ratio threshold breaches (counter)
 *
 * Queue metrics (W10-I-013):
 *  - rabbitmq_queue_depth       – current message count per queue (gauge)
 *  - rabbitmq_queue_publish_total – messages published per queue (counter)
 *  - rabbitmq_queue_consume_total – messages consumed per queue (counter)
 *  - rabbitmq_queue_error_total  – processing errors per queue (counter)
 *
 * RPC health metrics (W10-I-013):
 *  - stellar_rpc_request_duration – RPC request latency by operation (histogram)
 *  - stellar_rpc_error_total     – RPC error count by operation and error type (counter)
 *  - stellar_circuit_breaker_state – circuit breaker state per service (gauge)
 *
 * Also collects default Node.js process metrics (event loop, memory, CPU).
 */
import { Registry, Histogram, Counter, Gauge, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const poolWaitHistogram = new Histogram({
  name: "prisma_pool_wait_seconds",
  help: "Time in seconds a query spent waiting for a connection from the pool",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const poolAcquireHistogram = new Histogram({
  name: "prisma_pool_acquire_seconds",
  help: "Total time in seconds from query start to first result (includes pool wait + query)",
  labelNames: ["model", "action"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const poolExhaustedCounter = new Counter({
  name: "prisma_pool_exhausted_total",
  help: "Total number of P2024 connection pool timeout errors",
  registers: [registry],
});

// #436: heap usage ratio — heapUsed divided by the effective V8 heap size limit.
// Values approaching 1.0 indicate a potential memory leak.
export const heapUsedRatioGauge = new Gauge({
  name: "nodejs_heap_used_ratio",
  help: "Ratio of V8 heapUsed to heap_size_limit (0–1). Values near 1 indicate potential memory leak.",
  registers: [registry],
});

export const heapDumpCounter = new Counter({
  name: "nodejs_heap_dump_total",
  help: "Total number of heap snapshots written to disk by the leak detector.",
  registers: [registry],
});

// W10-I-013: Reserve ratio metrics
export const reserveRatioGauge = new Gauge({
  name: "reserve_ratio",
  help: "Current reserve ratio by currency and segment. Values below 1.0 indicate undercollateralization.",
  labelNames: ["currency", "segment"] as const,
  registers: [registry],
});

export const reserveRatioBreachCounter = new Counter({
  name: "reserve_ratio_breach_total",
  help: "Total count of reserve ratio threshold breaches (ratio fell below min_threshold)",
  labelNames: ["currency", "segment", "threshold"] as const,
  registers: [registry],
});

// W10-I-013: RabbitMQ queue metrics
export const rabbitmqQueueDepthGauge = new Gauge({
  name: "rabbitmq_queue_depth",
  help: "Current message count in each RabbitMQ queue",
  labelNames: ["queue_name"] as const,
  registers: [registry],
});

export const rabbitmqQueuePublishCounter = new Counter({
  name: "rabbitmq_queue_publish_total",
  help: "Total messages published to each RabbitMQ queue",
  labelNames: ["queue_name"] as const,
  registers: [registry],
});

export const rabbitmqQueueConsumeCounter = new Counter({
  name: "rabbitmq_queue_consume_total",
  help: "Total messages consumed from each RabbitMQ queue",
  labelNames: ["queue_name"] as const,
  registers: [registry],
});

export const rabbitmqQueueErrorCounter = new Counter({
  name: "rabbitmq_queue_error_total",
  help: "Total processing errors for each RabbitMQ queue",
  labelNames: ["queue_name", "error_type"] as const,
  registers: [registry],
});

// W10-I-013: Stellar RPC health metrics
export const stellarRpcDurationHistogram = new Histogram({
  name: "stellar_rpc_request_duration_seconds",
  help: "Stellar RPC request latency by operation type",
  labelNames: ["operation", "network"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const stellarRpcErrorCounter = new Counter({
  name: "stellar_rpc_error_total",
  help: "Total Stellar RPC errors by operation and error type",
  labelNames: ["operation", "network", "error_type"] as const,
  registers: [registry],
});

export const stellarCircuitBreakerStateGauge = new Gauge({
  name: "stellar_circuit_breaker_state",
  help: "Circuit breaker state (0=closed, 1=open, 2=half-open) per service",
  labelNames: ["service", "network"] as const,
  registers: [registry],
});
