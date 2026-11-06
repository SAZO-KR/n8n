import { GlobalConfig } from '@n8n/config';
import { Container } from '@n8n/di';
import type { QueryRunner } from '@n8n/typeorm';
import type { INode, IWorkflowExecutionDataProcess } from 'n8n-workflow';
import { createDeferredPromise, NodeConnectionTypes } from 'n8n-workflow';
import { setTimeout as sleep } from 'node:timers/promises';

import { ActiveExecutions } from '@/active-executions';
import type { WorkflowEntity } from '@/databases/entities/workflow-entity';
import { ExecutionRepository } from '@/databases/repositories/execution.repository';
import * as Db from '@/db';
import { WorkflowRunner } from '@/workflow-runner';
import { WorkflowStaticDataService } from '@/workflows/workflow-static-data.service';
import { createUser } from '@test-integration/db/users';
import { createWorkflow } from '@test-integration/db/workflows';
import { initBinaryDataService, initNodeTypes, setupTestServer } from '@test-integration/utils';

// Opt in with --testRegex=postgres-startup.integration.ts$ against an isolated local DB.
const database = Container.get(GlobalConfig).database;
if (
	database.type !== 'postgresdb' ||
	!['127.0.0.1', 'localhost'].includes(database.postgresdb.host) ||
	database.postgresdb.poolSize !== 2
) {
	throw new Error('This load test requires an isolated local PostgreSQL server and a pool of two');
}

setupTestServer({ endpointGroups: [] });

let workflow: WorkflowEntity;
let runner: WorkflowRunner;
let active: ActiveExecutions;
const start: INode = {
	id: 'start',
	name: 'Start',
	type: 'n8n-nodes-base.start',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

beforeAll(async () => {
	await initNodeTypes();
	await initBinaryDataService();
	const owner = await createUser({ role: 'global:owner' });
	workflow = await createWorkflow(
		{
			nodes: [
				start,
				...Array.from(
					{ length: 104 },
					(_, i): INode => ({
						id: `set-${i}`,
						name: `Set ${i}`,
						type: 'n8n-nodes-base.set',
						typeVersion: 1,
						position: [200, i * 100],
						parameters: { values: { string: [{ name: 'marker', value: 'x'.repeat(700) }] } },
					}),
				),
			],
			connections: {
				Start: { main: [[{ node: 'Set 0', type: NodeConnectionTypes.Main, index: 0 }]] },
			},
			settings: { executionTimeout: 60, saveDataSuccessExecution: 'all' },
		},
		owner,
	);
	runner = Container.get(WorkflowRunner);
	active = Container.get(ActiveExecutions);
});

afterEach(async () => {
	jest.restoreAllMocks();
	for (const execution of active.getActiveExecutions()) active.stopExecution(execution.id);
	await new Promise(setImmediate);
});

function input(sequence: number): IWorkflowExecutionDataProcess {
	return {
		executionMode: 'webhook',
		workflowData: structuredClone(workflow),
		executionData: {
			startData: {},
			resultData: { runData: {} },
			executionData: {
				contextData: {},
				metadata: {},
				waitingExecution: {},
				waitingExecutionSource: {},
				nodeExecutionStack: [
					{
						node: start,
						source: null,
						data: {
							main: [[{ json: { sequence, padding: 'x'.repeat(2048) } }]],
						},
					},
				],
			},
		},
	};
}

test('completes 295 starts at five every two seconds with no retained execution', async () => {
	const execute = async (sequence: number): Promise<string> => {
		const id = await runner.run(input(sequence), true);
		const result = await active.getPostExecutePromise(id);
		expect(result?.finished).toBe(true);
		expect(result?.data.resultData.error).toBeUndefined();
		expect(result?.data.resultData.runData['Set 0'][0].data?.main?.[0]?.[0]?.json.sequence).toBe(
			sequence,
		);
		const saved = await Container.get(ExecutionRepository).findSingleExecution(id, {
			includeData: false,
		});
		return saved?.status ?? 'missing';
	};
	expect(await execute(-1)).toBe('success');
	global.gc?.();
	const heapBefore = process.memoryUsage().heapUsed;
	const started = Date.now();
	const pending: Array<Promise<{ status: string; elapsedMs: number }>> = [];
	for (let batch = 0; batch < 59; batch++) {
		await sleep(Math.max(0, started + batch * 2000 - Date.now()));
		for (let offset = 0; offset < 5; offset++) {
			const requested = Date.now();
			pending.push(
				execute(batch * 5 + offset).then(
					(status) => ({ status, elapsedMs: Date.now() - requested }),
					(error) => ({ status: String(error), elapsedMs: Date.now() - requested }),
				),
			);
		}
	}
	const results = await Promise.all(pending);
	await new Promise(setImmediate);
	global.gc?.();
	const latencies = results.map((result) => result.elapsedMs).sort((a, b) => a - b);
	console.log(
		JSON.stringify({
			scenario: '295 starts, five per two seconds',
			successes: results.filter((result) => result.status === 'success').length,
			elapsedMs: Date.now() - started,
			p95Ms: latencies[Math.floor(latencies.length * 0.95)],
			maxMs: latencies.at(-1),
			activeAfter: active.getActiveExecutions().length,
			heapBefore,
			heapAfter: process.memoryUsage().heapUsed,
			gcEnabled: typeof global.gc === 'function',
		}),
	);
	expect(results).toHaveLength(295);
	expect(results.every((result) => result.status === 'success')).toBe(true);
	expect(active.getActiveExecutions()).toHaveLength(0);
}, 180_000);

test.each([true, false])(
	'releases startup data after real pool exhaustion; DB recovers: %s',
	async (recover) => {
		const clients: QueryRunner[] = [
			Db.getConnection().createQueryRunner(),
			Db.getConnection().createQueryRunner(),
		];
		const service = Container.get(WorkflowStaticDataService);
		const getStaticData: WorkflowStaticDataService['getStaticDataById'] =
			service.getStaticDataById.bind(service);
		jest.spyOn(service, 'getStaticDataById').mockImplementationOnce(async (id) => {
			await Promise.all(clients.map(async (client) => await client.connect()));
			try {
				return await getStaticData(id);
			} finally {
				if (recover) await Promise.all(clients.map(async (client) => await client.release()));
			}
		});
		const add = jest.spyOn(active, 'add');
		const response = createDeferredPromise<never>();
		const responseResult = response.promise.catch((error) => error as Error);
		const started = Date.now();
		try {
			await expect(runner.run(input(0), true, false, undefined, response)).rejects.toThrow(
				'timeout exceeded when trying to connect',
			);
			await new Promise(setImmediate);
			expect(active.getActiveExecutions()).toHaveLength(0);
			await expect(responseResult).resolves.toBeInstanceOf(Error);
		} finally {
			await Promise.all(clients.map(async (client) => await client.release()));
		}
		const executionId = await add.mock.results[0].value;
		const saved = await Container.get(ExecutionRepository).findSingleExecution(executionId, {
			includeData: true,
			unflattenData: true,
		});
		if (recover)
			expect(saved).toMatchObject({
				status: 'error',
				data: { resultData: { error: { message: 'timeout exceeded when trying to connect' } } },
			});
		console.log(
			JSON.stringify({
				scenario: 'real pool exhaustion',
				recover,
				elapsedMs: Date.now() - started,
				activeAfter: active.getActiveExecutions().length,
				persistedStatus: saved?.status,
			}),
		);
	},
	65_000,
);
