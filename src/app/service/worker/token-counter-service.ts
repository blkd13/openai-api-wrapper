import { ChildProcess, fork } from 'child_process';
import { EventEmitter } from 'events';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Task {
    id: number;
    text: string;
    model: string;
    resolve: (value: number) => void;
    reject: (reason: Error) => void;
    timeout?: NodeJS.Timeout;
    startTime: number;
}

interface ProcessWithState {
    process: ChildProcess;
    busy: boolean;
    currentTaskId?: number;
    tasksProcessed: number;
    createdAt: number;
}

export class TokenCounterProcessPool extends EventEmitter {
    private processes: ProcessWithState[] = [];
    private queue: Task[] = [];
    private taskIdCounter = 0;
    private isShuttingDown = false;
    private readonly defaultTimeout: number;
    private readonly maxTasksPerProcess: number;

    constructor(
        private poolSize: number = 4,
        private workerPath: string = join(__dirname, './token-counter-process.js'),
        options: {
            timeout?: number;
            maxTasksPerProcess?: number;
        } = {}
    ) {
        super();
        this.defaultTimeout = options.timeout || 30000;
        this.maxTasksPerProcess = options.maxTasksPerProcess || 1000;
        this.initializePool();
    }

    private initializePool(): void {
        console.log(`Initializing process pool with ${this.poolSize} processes`);
        for (let i = 0; i < this.poolSize; i++) {
            this.createProcess();
        }
    }

    private createProcess(): void {
        const childProcess = fork(this.workerPath, [], {
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            execArgv: process.execArgv.filter(arg => !arg.startsWith('--inspect')),
        });

        const processState: ProcessWithState = {
            process: childProcess,
            busy: false,
            tasksProcessed: 0,
            createdAt: Date.now(),
        };

        childProcess.on('message', (result: { id: number; count: number | null; error: string | null }) => {
            this.handleProcessMessage(processState, result);
        });

        childProcess.on('error', (error) => {
            console.error('Process error:', error);
            this.handleProcessError(processState, error);
        });

        childProcess.on('exit', (code, signal) => {
            if (!this.isShuttingDown) {
                console.error(`Process exited unexpectedly with code ${code}, signal ${signal}`);
                this.removeProcess(processState);
                this.createProcess();
            }
        });

        // プロセスの標準エラー出力をログに流す
        childProcess.stderr?.on('data', (data) => {
            console.error(`Process stderr: ${data}`);
        });

        this.processes.push(processState);
        this.emit('processCreated', processState);
    }

    private handleProcessMessage(
        processState: ProcessWithState,
        result: { id: number; count: number | null; error: string | null }
    ): void {
        processState.busy = false;
        processState.currentTaskId = undefined;
        processState.tasksProcessed++;

        const taskIndex = this.queue.findIndex(task => task.id === result.id);
        if (taskIndex !== -1) {
            const task = this.queue.splice(taskIndex, 1)[0];

            if (task.timeout) {
                clearTimeout(task.timeout);
            }

            const duration = Date.now() - task.startTime;
            this.emit('taskCompleted', { id: task.id, duration, success: !result.error });

            if (result.error) {
                task.reject(new Error(result.error));
            } else if (result.count !== null) {
                task.resolve(result.count);
            } else {
                task.reject(new Error('Invalid response from process'));
            }
        }

        // プロセスが多くのタスクを処理した場合、リサイクル
        if (processState.tasksProcessed >= this.maxTasksPerProcess) {
            console.log(`Recycling process after ${processState.tasksProcessed} tasks`);
            this.recycleProcess(processState);
        } else {
            this.processNextTask();
        }
    }

    private handleProcessError(processState: ProcessWithState, error: Error): void {
        if (processState.currentTaskId !== undefined) {
            const taskIndex = this.queue.findIndex(task => task.id === processState.currentTaskId);
            if (taskIndex !== -1) {
                const task = this.queue.splice(taskIndex, 1)[0];
                if (task.timeout) {
                    clearTimeout(task.timeout);
                }
                task.reject(error);
                this.emit('taskFailed', { id: task.id, error: error.message });
            }
        }

        processState.busy = false;
        processState.currentTaskId = undefined;
        this.recycleProcess(processState);
    }

    private recycleProcess(processState: ProcessWithState): void {
        this.removeProcess(processState);
        processState.process.kill();
        this.createProcess();
        this.processNextTask();
    }

    private removeProcess(processState: ProcessWithState): void {
        const index = this.processes.indexOf(processState);
        if (index !== -1) {
            this.processes.splice(index, 1);
        }
    }

    private getAvailableProcess(): ProcessWithState | null {
        return this.processes.find(p => !p.busy) || null;
    }

    private processNextTask(): void {
        if (this.isShuttingDown) {
            return;
        }

        const process = this.getAvailableProcess();
        if (!process || this.queue.length === 0) {
            return;
        }

        // キューから未処理のタスクを取得
        const pendingTasks = this.queue.filter(t => !t.timeout);
        if (pendingTasks.length === 0) {
            return;
        }

        const task = pendingTasks[0];

        process.busy = true;
        process.currentTaskId = task.id;

        task.timeout = setTimeout(() => {
            const idx = this.queue.findIndex(t => t.id === task.id);
            if (idx !== -1) {
                this.queue.splice(idx, 1);
                task.reject(new Error('Token counting timeout'));

                this.emit('taskTimeout', { id: task.id });

                // タイムアウトしたプロセスは信頼できないので再起動
                this.recycleProcess(process);
            }
        }, this.defaultTimeout);

        this.emit('taskStarted', { id: task.id, textLength: task.text.length });

        try {
            process.process.send({
                id: task.id,
                text: task.text,
                model: task.model,
            });
        } catch (error) {
            console.error('Error sending message to process:', error);
            this.handleProcessError(process, error as Error);
        }
    }

    async countTokens(text: string, model: string = 'gpt-4'): Promise<number> {
        if (this.isShuttingDown) {
            throw new Error('TokenCounterProcessPool is shutting down');
        }

        if (!text || typeof text !== 'string') {
            throw new Error('Invalid text input');
        }

        const id = this.taskIdCounter++;

        return new Promise<number>((resolve, reject) => {
            const task: Task = {
                id,
                text,
                model,
                resolve,
                reject,
                startTime: Date.now(),
            };

            this.queue.push(task);
            this.emit('taskQueued', { id, textLength: text.length, queueLength: this.queue.length });
            this.processNextTask();
        });
    }

    getStats() {
        const now = Date.now();
        return {
            poolSize: this.poolSize,
            busyProcesses: this.processes.filter(p => p.busy).length,
            availableProcesses: this.processes.filter(p => !p.busy).length,
            queueLength: this.queue.length,
            totalTasksProcessed: this.processes.reduce((sum, p) => sum + p.tasksProcessed, 0),
            processes: this.processes.map(p => ({
                busy: p.busy,
                tasksProcessed: p.tasksProcessed,
                uptimeMs: now - p.createdAt,
            })),
        };
    }

    async terminate(): Promise<void> {
        console.log('Terminating process pool...');
        this.isShuttingDown = true;

        // 全ての待機中タスクを拒否
        this.queue.forEach(task => {
            if (task.timeout) {
                clearTimeout(task.timeout);
            }
            task.reject(new Error('Pool is shutting down'));
        });
        this.queue = [];

        // 全プロセスを終了
        const killPromises = this.processes.map(({ process }) => {
            return new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    process.kill('SIGKILL');
                    resolve();
                }, 5000);

                process.once('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });

                process.kill('SIGTERM');
            });
        });

        await Promise.all(killPromises);
        this.processes = [];
        console.log('Process pool terminated');
    }
}

// シングルトンインスタンス
export const tokenCounterPool = new TokenCounterProcessPool(4, undefined, {
    timeout: 30000,
    maxTasksPerProcess: 1000,
});

// グレースフルシャットダウン
const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    await tokenCounterPool.terminate();
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));