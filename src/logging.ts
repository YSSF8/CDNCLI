import { Writable } from 'stream';

const Colors = {
    Reset: "\x1b[0m",
    Bright: "\x1b[1m",
    Dim: "\x1b[2m",
    Underscore: "\x1b[4m",
    Blink: "\x1b[5m",
    Reverse: "\x1b[7m",
    Hidden: "\x1b[8m",
    FgBlack: "\x1b[30m",
    FgRed: "\x1b[31m",
    FgGreen: "\x1b[32m",
    FgYellow: "\x1b[33m",
    FgBlue: "\x1b[34m",
    FgMagenta: "\x1b[35m",
    FgCyan: "\x1b[36m",
    FgWhite: "\x1b[37m",
    BgBlack: "\x1b[40m",
    BgRed: "\x1b[41m",
    BgGreen: "\x1b[42m",
    BgYellow: "\x1b[43m",
    BgBlue: "\x1b[44m",
    BgMagenta: "\x1b[45m",
    BgCyan: "\x1b[46m",
    BgWhite: "\x1b[47m",
};

/**
 * Checks if a stream is a TTY (terminal) stream.
 * We need this because 'isTTY' isn't on the base Writable type.
 * @param stream The stream to check.
 * @returns True if the stream has an 'isTTY' property set to true, false otherwise.
 */
function isTTY(stream: Writable): boolean {
    return Boolean(stream && typeof stream === 'object' && (stream as any).isTTY);
}

/**
 * Formats seconds into a more readable string.
 * @param totalSeconds The total number of seconds.
 * @returns A formatted duration string.
 */
function formatDuration(totalSeconds: number): string {
    if (totalSeconds < 0 || !isFinite(totalSeconds) || isNaN(totalSeconds)) {
        return '--s';
    }
    const seconds = Math.floor(totalSeconds % 60);
    const minutes = Math.floor(totalSeconds / 60);

    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    } else {
        return `${totalSeconds.toFixed(1)}s`;
    }
}

/**
 * Clears the current line in the terminal, if the stream is a TTY.
 */
function clearLine(stream: Writable = process.stdout): void {
    if (isTTY(stream)) {
        stream.write('\r\x1b[K');
    }
}

/**
 * Logs an error message in red.
 * @param message - The error message to log.
 */
export function logError(message: string): void {
    console.error(`${Colors.FgRed}✖ Error: ${message}${Colors.Reset}`);
}

/**
 * Logs a success message in green.
 * @param message - The success message to log.
 */
export function logSuccess(message: string): void {
    console.log(`${Colors.FgGreen}✔ Success: ${message}${Colors.Reset}`);
}

/**
 * Logs an informational message in blue.
 * @param message - The informational message to log.
 */
export function logInfo(message: string): void {
    console.log(`${Colors.FgBlue}ℹ Info: ${message}${Colors.Reset}`);
}

/**
 * Logs a warning message in yellow.
 * @param message - The warning message to log.
 */
export function logWarning(message: string): void {
    console.warn(`${Colors.FgYellow}⚠ Warning: ${message}${Colors.Reset}`);
}

/**
 * Progress Bar Class
 *
 * A simple progress bar implementation for tracking progress.
 */
export class ProgressBar {
    private total: number;
    private current: number;
    private totalBytesDownloaded: number;
    private barLength: number;
    private isComplete: boolean;
    private stream: Writable;
    private readonly streamIsTTY: boolean;
    private startTime: number;

    constructor(total: number, barLength: number = 40, stream: Writable = process.stdout) {
        this.total = total;
        this.current = 0;
        this.totalBytesDownloaded = 0;
        this.barLength = barLength;
        this.isComplete = false;
        this.stream = stream;
        this.streamIsTTY = isTTY(this.stream);
        this.startTime = Date.now();
    }

    /**
     * Updates the progress bar.
     * @param value - The current progress value (number of items completed).
     * @param totalBytesDownloaded - The cumulative total bytes downloaded so far.
     */
    update(value: number, totalBytesDownloaded?: number): void {
        if (this.isComplete) return;

        this.current = Math.min(Math.max(0, value), this.total);
        if (totalBytesDownloaded !== undefined) {
            this.totalBytesDownloaded = totalBytesDownloaded;
        }

        this.draw();

        if (this.current >= this.total) {
            // Don't call complete automatically here, let the caller decide
            // when the overall process is done. Draw the 100% state though.
        }
    }

    /**
     * Draws the progress bar to the console.
     */
    private draw(): void {
        if (!this.streamIsTTY || this.total <= 0) return;

        const progress = this.total === 0 ? 1 : Math.min(this.current / this.total, 1);
        const filledBarLength = Math.round(progress * this.barLength);
        const emptyBarLength = this.barLength - filledBarLength;

        const filledBar = "█".repeat(filledBarLength);
        const emptyBar = "░".repeat(emptyBarLength);
        const percentage = Math.round(progress * 100);

        const elapsedMs = Date.now() - this.startTime;
        const elapsedSeconds = elapsedMs / 1000;

        let etaString = 'ETA: --s';
        if (this.current > 0 && elapsedSeconds > 0.5 && this.current < this.total) {
            const secondsPerItem = elapsedSeconds / this.current;
            const remainingItems = this.total - this.current;
            const etaSeconds = secondsPerItem * remainingItems;
            etaString = `ETA: ${formatDuration(etaSeconds)}`;
        } else if (this.current === 0 && elapsedSeconds > 0.5) {
            etaString = 'ETA: ...';
        } else if (this.current >= this.total) {
            etaString = `Done ${formatDuration(elapsedSeconds)}`;
        }

        let speedString = '-- KB/s';
        if (elapsedSeconds > 0.1 && this.totalBytesDownloaded > 0) {
            const bytesPerSecond = this.totalBytesDownloaded / elapsedSeconds;
            const kbPerSecond = bytesPerSecond / 1024;
            speedString = `${kbPerSecond.toFixed(1)} KB/s`;
        } else if (this.current >= this.total && this.totalBytesDownloaded > 0) {
            const bytesPerSecond = this.totalBytesDownloaded / elapsedSeconds;
            const kbPerSecond = bytesPerSecond / 1024;
            speedString = `Avg: ${kbPerSecond.toFixed(1)} KB/s`;
        }

        const output = `${Colors.FgCyan}[${filledBar}${emptyBar}] ${percentage}% (${this.current}/${this.total}) ${speedString} ${etaString}${Colors.Reset}`;

        clearLine(this.stream);
        this.stream.write(output + '\r');
    }

    /**
     * Marks the progress bar as complete and clears the line for final output.
     * Often called after the loop finishes.
     */
    complete(): void {
        if (this.isComplete || !this.streamIsTTY) return;

        this.current = this.total;
        this.draw();

        this.stream.write('\n');
        this.isComplete = true;
    }

    /**
     * Clears the progress bar line, useful before printing other output during progress.
     */
    clear(): void {
        if (this.streamIsTTY && !this.isComplete) {
            clearLine(this.stream);
        }
    }
}