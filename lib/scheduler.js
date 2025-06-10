const EventEmitter = require('events');
const PQueue = require('p-queue');
const { Logger } = require('./utils/logger');
const cron = require('node-cron');

class TaskScheduler extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.logger = new Logger();
        this.queues = new Map();
        this.scheduledTasks = new Map();
        this.initialize();
    }

    initialize() {
        // Initialize priority queues
        this.config.priorities.forEach(priority => {
            this.queues.set(priority.name, new PQueue({
                concurrency: priority.max_concurrent,
                autoStart: true
            }));
        });

        this.logger.info('Task scheduler initialized');
    }

    async schedule(task) {
        const {
            category,
            config,
            handler,
            priority = 'medium',
            schedule,
            repeat
        } = task;

        // Validate task configuration
        this.validateTask(task);

        // Handle scheduled/repeating tasks
        if (schedule || repeat) {
            return this.scheduleRecurringTask(task);
        }

        // Handle immediate execution
        return this.executeTask(task);
    }

    validateTask(task) {
        if (!task.category) {
            throw new Error('Task category is required');
        }
        if (!task.handler) {
            throw new Error('Task handler is required');
        }
        if (task.priority && !this.queues.has(task.priority)) {
            throw new Error(`Invalid priority level: ${task.priority}`);
        }
    }

    async executeTask(task) {
        const queue = this.queues.get(task.priority || 'medium');
        const taskId = this.generateTaskId(task);

        const queuedTask = {
            ...task,
            id: taskId,
            attempts: 0,
            startTime: Date.now()
        };

        try {
            return await queue.add(
                () => this.runTask(queuedTask),
                { priority: this.getPriorityValue(task.priority) }
            );
        } catch (error) {
            this.logger.error(`Task execution failed: ${taskId}`, error);
            throw error;
        }
    }

    async runTask(task) {
        const { id, handler, config, category, attempts } = task;
        
        try {
            this.emit('taskStart', { id, category, attempts });
            
            const result = await handler.execute(config);
            
            this.emit('taskComplete', { id, category, result });
            return result;
        } catch (error) {
            if (attempts < this.config.retry.max_attempts) {
                return await this.retryTask(task, error);
            }
            
            this.emit('taskFailed', { id, category, error, attempts });
            throw error;
        }
    }

    async retryTask(task, error) {
        const retryDelay = this.calculateRetryDelay(task.attempts);
        this.logger.warn(`Retrying task ${task.id} after ${retryDelay}ms`);
        
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        
        return this.executeTask({
            ...task,
            attempts: task.attempts + 1
        });
    }

    calculateRetryDelay(attempts) {
        // Exponential backoff with jitter
        const baseDelay = this.config.retry.delay || 5000;
        const maxDelay = 300000; // 5 minutes
        const exponentialDelay = Math.min(
            baseDelay * Math.pow(2, attempts),
            maxDelay
        );
        // Add random jitter (±20%)
        const jitter = exponentialDelay * 0.2 * (Math.random() - 0.5);
        return Math.floor(exponentialDelay + jitter);
    }

    scheduleRecurringTask(task) {
        const taskId = this.generateTaskId(task);
        
        if (task.schedule) {
            // One-time scheduled task
            const scheduledTime = new Date(task.schedule).getTime();
            const delay = scheduledTime - Date.now();
            
            if (delay < 0) {
                throw new Error('Cannot schedule task in the past');
            }

            const timeout = setTimeout(() => {
                this.executeTask(task);
                this.scheduledTasks.delete(taskId);
            }, delay);

            this.scheduledTasks.set(taskId, { timeout, task });
        } else if (task.repeat) {
            // Recurring task using cron
            if (!cron.validate(task.repeat)) {
                throw new Error('Invalid cron expression');
            }

            const cronJob = cron.schedule(task.repeat, () => {
                this.executeTask(task);
            });

            this.scheduledTasks.set(taskId, { cronJob, task });
        }

        return taskId;
    }

    cancelScheduledTask(taskId) {
        const scheduled = this.scheduledTasks.get(taskId);
        if (!scheduled) {
            return false;
        }

        if (scheduled.timeout) {
            clearTimeout(scheduled.timeout);
        } else if (scheduled.cronJob) {
            scheduled.cronJob.stop();
        }

        this.scheduledTasks.delete(taskId);
        return true;
    }

    generateTaskId(task) {
        return `${task.category}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    getPriorityValue(priority) {
        const priorities = {
            high: 1,
            medium: 2,
            low: 3
        };
        return priorities[priority] || priorities.medium;
    }

    getQueueStats() {
        const stats = {};
        for (const [priority, queue] of this.queues) {
            stats[priority] = {
                pending: queue.size,
                active: queue.pending,
                completed: queue.sizeCompleted
            };
        }
        return stats;
    }

    getScheduledTasksStats() {
        return {
            total: this.scheduledTasks.size,
            tasks: Array.from(this.scheduledTasks.entries()).map(([id, { task }]) => ({
                id,
                category: task.category,
                schedule: task.schedule,
                repeat: task.repeat
            }))
        };
    }

    async stop() {
        // Stop all queues
        for (const queue of this.queues.values()) {
            await queue.onIdle();
            queue.pause();
        }

        // Cancel all scheduled tasks
        for (const taskId of this.scheduledTasks.keys()) {
            this.cancelScheduledTask(taskId);
        }

        this.logger.info('Task scheduler stopped');
    }

    async pause() {
        for (const queue of this.queues.values()) {
            queue.pause();
        }
    }

    async resume() {
        for (const queue of this.queues.values()) {
            queue.start();
        }
    }
}

module.exports = { TaskScheduler };
