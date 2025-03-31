/**
 * A function that performs an asynchronous task and returns a Promise.
 */
type AsyncTask<T> = () => Promise<T>;

/**
 * A function returned by createLimiter that you call to enqueue and run tasks.
 */
export type LimiterFunction = <T>(taskFn: AsyncTask<T>) => Promise<T>;

/**
 * Creates a limiter function that ensures no more than `concurrency`
 * asynchronous tasks run simultaneously.
 *
 * @param concurrency The maximum number of tasks to run at the same time.
 * @returns A function that accepts task functions and returns a Promise resolving/rejecting with the task's result.
 */
export function createLimiter(concurrency: number): LimiterFunction {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new TypeError('Concurrency must be a positive integer.');
    }

    let activeCount = 0;
    const queue: (() => void)[] = [];

    const runNext = () => {
        if (queue.length > 0 && activeCount < concurrency) {
            const taskToStart = queue.shift();
            if (taskToStart) {
                taskToStart();
            }
        }
    };

    const limit = <T>(taskFn: AsyncTask<T>): Promise<T> => {
        return new Promise<T>((resolve, reject) => {
            const taskWrapper = async () => {
                activeCount++;
                try {
                    const result = await taskFn();
                    resolve(result);
                } catch (error) {
                    reject(error);
                } finally {
                    activeCount--;
                    runNext();
                }
            };

            if (activeCount < concurrency) {
                taskWrapper();
            } else {
                queue.push(taskWrapper);
            }
        });
    };

    return limit;
}