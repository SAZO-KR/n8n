import { Container } from '@n8n/di';
import { mock } from 'jest-mock-extended';
import { DirectedGraph, WorkflowExecute } from 'n8n-core';
import * as core from 'n8n-core';
import type {
	IExecuteData,
	INode,
	IRun,
	ITaskData,
	IWaitingForExecution,
	IWaitingForExecutionSource,
	IWorkflowBase,
	IWorkflowExecutionDataProcess,
	StartNodeData,
} from 'n8n-workflow';
import { createDeferredPromise, Workflow, type ExecutionError } from 'n8n-workflow';
import PCancelable from 'p-cancelable';

import { ActiveExecutions } from '@/active-executions';
import { ConcurrencyControlService } from '@/concurrency/concurrency-control.service';
import config from '@/config';
import type { ExecutionEntity } from '@/databases/entities/execution-entity';
import type { User } from '@/databases/entities/user';
import { ExecutionRepository } from '@/databases/repositories/execution.repository';
import { ExecutionNotFoundError } from '@/errors/execution-not-found-error';
import * as lifecycleHooks from '@/execution-lifecycle/execution-lifecycle-hooks';
import { CredentialsPermissionChecker } from '@/executions/pre-execution-checks';
import { ManualExecutionService } from '@/manual-execution.service';
import { Telemetry } from '@/telemetry';
import * as additionalData from '@/workflow-execute-additional-data';
import { WorkflowRunner } from '@/workflow-runner';
import { WorkflowStaticDataService } from '@/workflows/workflow-static-data.service';
import { mockInstance } from '@test/mocking';
import { createExecution } from '@test-integration/db/executions';
import { createUser } from '@test-integration/db/users';
import { createWorkflow } from '@test-integration/db/workflows';
import * as testDb from '@test-integration/test-db';
import { setupTestServer } from '@test-integration/utils';

let owner: User;
let runner: WorkflowRunner;
setupTestServer({ endpointGroups: [] });

mockInstance(Telemetry);

beforeAll(async () => {
	owner = await createUser({ role: 'global:owner' });

	runner = Container.get(WorkflowRunner);
});

afterAll(() => {
	jest.restoreAllMocks();
});

beforeEach(async () => {
	await testDb.truncate(['Workflow', 'SharedWorkflow']);
	jest.clearAllMocks();
});

describe('processError', () => {
	let workflow: IWorkflowBase;
	let execution: ExecutionEntity;
	let hooks: core.ExecutionLifecycleHooks;

	const watcher = mock<{ workflowExecuteAfter: () => Promise<void> }>();

	beforeEach(async () => {
		jest.clearAllMocks();
		workflow = await createWorkflow({}, owner);
		execution = await createExecution({ status: 'success', finished: true }, workflow);
		hooks = new core.ExecutionLifecycleHooks('webhook', execution.id, workflow);
		hooks.addHandler('workflowExecuteAfter', watcher.workflowExecuteAfter);
	});

	test('processError should return early in Bull stalled edge case', async () => {
		const workflow = await createWorkflow({}, owner);
		const execution = await createExecution(
			{
				status: 'success',
				finished: true,
			},
			workflow,
		);
		config.set('executions.mode', 'queue');
		await runner.processError(
			new Error('test') as ExecutionError,
			new Date(),
			'webhook',
			execution.id,
			hooks,
		);
		expect(watcher.workflowExecuteAfter).toHaveBeenCalledTimes(0);
	});

	test('processError should return early if the error is `ExecutionNotFoundError`', async () => {
		const workflow = await createWorkflow({}, owner);
		const execution = await createExecution({ status: 'success', finished: true }, workflow);
		await runner.processError(
			new ExecutionNotFoundError(execution.id),
			new Date(),
			'webhook',
			execution.id,
			hooks,
		);
		expect(watcher.workflowExecuteAfter).toHaveBeenCalledTimes(0);
	});

	test('processError should process error', async () => {
		const workflow = await createWorkflow({}, owner);
		const execution = await createExecution(
			{
				status: 'success',
				finished: true,
			},
			workflow,
		);
		await Container.get(ActiveExecutions).add(
			{ executionMode: 'webhook', workflowData: workflow },
			execution.id,
		);
		config.set('executions.mode', 'regular');
		await runner.processError(
			new Error('test') as ExecutionError,
			new Date(),
			'webhook',
			execution.id,
			hooks,
		);
		expect(watcher.workflowExecuteAfter).toHaveBeenCalledTimes(1);
	});
});

describe('run', () => {
	it('uses recreateNodeExecutionStack to create a partial execution if a triggerToStartFrom with data is sent', async () => {
		// ARRANGE
		const activeExecutions = Container.get(ActiveExecutions);
		jest.spyOn(activeExecutions, 'add').mockResolvedValue('1');
		jest.spyOn(activeExecutions, 'attachWorkflowExecution').mockReturnValueOnce();
		const permissionChecker = Container.get(CredentialsPermissionChecker);
		jest.spyOn(permissionChecker, 'check').mockResolvedValueOnce();

		jest.spyOn(WorkflowExecute.prototype, 'processRunExecutionData').mockReturnValueOnce(
			new PCancelable(() => {
				return mock<IRun>();
			}),
		);

		jest.spyOn(Workflow.prototype, 'getNode').mockReturnValueOnce(mock<INode>());
		jest.spyOn(DirectedGraph, 'fromWorkflow').mockReturnValueOnce(new DirectedGraph());
		const recreateNodeExecutionStackSpy = jest
			.spyOn(core, 'recreateNodeExecutionStack')
			.mockReturnValueOnce({
				nodeExecutionStack: mock<IExecuteData[]>(),
				waitingExecution: mock<IWaitingForExecution>(),
				waitingExecutionSource: mock<IWaitingForExecutionSource>(),
			});

		const data = mock<IWorkflowExecutionDataProcess>({
			triggerToStartFrom: { name: 'trigger', data: mock<ITaskData>() },

			workflowData: { nodes: [] },
			executionData: undefined,
			startNodes: [mock<StartNodeData>()],
			destinationNode: undefined,
		});

		// ACT
		await runner.run(data);

		// ASSERT
		expect(recreateNodeExecutionStackSpy).toHaveBeenCalled();
	});

	it('does not use recreateNodeExecutionStack to create a partial execution if a triggerToStartFrom without data is sent', async () => {
		// ARRANGE
		const activeExecutions = Container.get(ActiveExecutions);
		jest.spyOn(activeExecutions, 'add').mockResolvedValue('1');
		jest.spyOn(activeExecutions, 'attachWorkflowExecution').mockReturnValueOnce();
		const permissionChecker = Container.get(CredentialsPermissionChecker);
		jest.spyOn(permissionChecker, 'check').mockResolvedValueOnce();

		jest.spyOn(WorkflowExecute.prototype, 'processRunExecutionData').mockReturnValueOnce(
			new PCancelable(() => {
				return mock<IRun>();
			}),
		);

		const recreateNodeExecutionStackSpy = jest.spyOn(core, 'recreateNodeExecutionStack');

		const data = mock<IWorkflowExecutionDataProcess>({
			triggerToStartFrom: { name: 'trigger', data: undefined },

			workflowData: { nodes: [] },
			executionData: undefined,
			startNodes: [mock<StartNodeData>()],
			destinationNode: undefined,
		});

		// ACT
		await runner.run(data);

		// ASSERT
		expect(recreateNodeExecutionStackSpy).not.toHaveBeenCalled();
	});
});

describe('startup failures', () => {
	const startupError = new Error('timeout exceeded when trying to connect');
	let workflow: IWorkflowBase;
	let activeExecutions: ActiveExecutions;
	let executionRepository: ExecutionRepository;

	beforeEach(async () => {
		jest.restoreAllMocks();
		config.set('executions.mode', 'regular');
		runner.setExecutionMode('regular');
		workflow = await createWorkflow(
			{ nodes: [], connections: {}, settings: { executionTimeout: 60 } },
			owner,
		);
		activeExecutions = Container.get(ActiveExecutions);
		executionRepository = Container.get(ExecutionRepository);
		jest.spyOn(Container.get(CredentialsPermissionChecker), 'check').mockResolvedValue();
	});

	afterEach(async () => {
		for (const execution of activeExecutions.getActiveExecutions()) {
			activeExecutions.stopExecution(execution.id);
		}
		await new Promise(setImmediate);
		jest.restoreAllMocks();
	});

	const executionData = (): IWorkflowExecutionDataProcess => ({
		executionMode: 'webhook',
		workflowData: workflow,
	});

	test.each(['static data', 'execution context', 'running state'] as const)(
		'cleans up and records a failure loading %s',
		async (phase) => {
			const add = jest.spyOn(activeExecutions, 'add');
			const release = jest.spyOn(Container.get(ConcurrencyControlService), 'release');
			const execute = jest.spyOn(Container.get(ManualExecutionService), 'runManually');
			const response = createDeferredPromise<never>();
			const responseResult = response.promise.catch((error) => error);

			if (phase === 'static data') {
				jest
					.spyOn(Container.get(WorkflowStaticDataService), 'getStaticDataById')
					.mockRejectedValueOnce(startupError);
			} else if (phase === 'execution context') {
				jest.spyOn(additionalData, 'getBase').mockRejectedValueOnce(startupError);
			} else {
				const setRunning = executionRepository.setRunning.bind(executionRepository);
				jest
					.spyOn(executionRepository, 'setRunning')
					.mockImplementationOnce(setRunning)
					.mockRejectedValueOnce(startupError);
			}

			await expect(runner.run(executionData(), true, false, undefined, response)).rejects.toBe(
				startupError,
			);
			const executionId = await add.mock.results[0].value;
			await new Promise(setImmediate);

			expect(activeExecutions.has(executionId)).toBe(false);
			expect(release).toHaveBeenCalledTimes(1);
			expect(execute).not.toHaveBeenCalled();
			await expect(responseResult).resolves.toBe(startupError);
			const saved = await executionRepository.findSingleExecution(executionId, {
				includeData: true,
				unflattenData: true,
			});
			expect(saved).toMatchObject({
				status: 'error',
				finished: false,
				stoppedAt: expect.any(Date),
				data: { resultData: { error: { message: startupError.message } } },
			});
		},
	);

	test('releases the execution and rejects the webhook if error persistence also fails', async () => {
		const persistenceError = new Error('database is still unavailable');
		const hooks = new core.ExecutionLifecycleHooks('webhook', 'unused', workflow);
		hooks.addHandler('workflowExecuteAfter', () => {
			throw persistenceError;
		});
		jest.spyOn(lifecycleHooks, 'getLifecycleHooksForRegularMain').mockReturnValueOnce(hooks);
		jest
			.spyOn(Container.get(WorkflowStaticDataService), 'getStaticDataById')
			.mockRejectedValueOnce(startupError);
		const add = jest.spyOn(activeExecutions, 'add');
		const response = createDeferredPromise<never>();
		const responseResult = response.promise.catch((error) => error);

		await expect(runner.run(executionData(), true, false, undefined, response)).rejects.toBe(
			persistenceError,
		);
		const executionId = await add.mock.results[0].value;
		await new Promise(setImmediate);

		expect(activeExecutions.has(executionId)).toBe(false);
		await expect(responseResult).resolves.toBe(persistenceError);
	});

	test.each([false, true])(
		'cleans up credential denial when error persistence fails: %s',
		async (persistenceFails) => {
			const denied = new Error('credential access denied');
			const persistenceError = new Error('could not save denied execution');
			jest
				.spyOn(Container.get(CredentialsPermissionChecker), 'check')
				.mockRejectedValueOnce(denied);
			if (persistenceFails) {
				const hooks = new core.ExecutionLifecycleHooks('webhook', 'unused', workflow);
				hooks.addHandler('workflowExecuteAfter', () => {
					throw persistenceError;
				});
				jest.spyOn(lifecycleHooks, 'getLifecycleHooksForRegularMain').mockReturnValueOnce(hooks);
			}
			const add = jest.spyOn(activeExecutions, 'add');
			const execute = jest.spyOn(Container.get(ManualExecutionService), 'runManually');
			const response = createDeferredPromise<never>();
			const responseResult = response.promise.catch((error) => error);

			const run = runner.run(executionData(), false, false, undefined, response);
			if (persistenceFails) {
				await expect(run).rejects.toBe(persistenceError);
			} else {
				await run;
			}
			const executionId = await add.mock.results[0].value;
			await new Promise(setImmediate);

			expect(activeExecutions.has(executionId)).toBe(false);
			expect(execute).not.toHaveBeenCalled();
			await expect(responseResult).resolves.toBe(denied);
		},
	);

	test('does not remove another execution when startup fails', async () => {
		const otherId = await activeExecutions.add(executionData());
		jest
			.spyOn(Container.get(WorkflowStaticDataService), 'getStaticDataById')
			.mockRejectedValueOnce(startupError);

		await expect(runner.run(executionData(), true)).rejects.toBe(startupError);
		await new Promise(setImmediate);

		expect(activeExecutions.getActiveExecutions()).toEqual([
			expect.objectContaining({ id: otherId, status: 'running' }),
		]);
	});
});
