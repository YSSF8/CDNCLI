"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProgressBar = void 0;
exports.logError = logError;
exports.logSuccess = logSuccess;
exports.logInfo = logInfo;
exports.logWarning = logWarning;
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
function isTTY(stream) {
    return Boolean(stream && typeof stream === 'object' && stream.isTTY);
}
/**
 * Clears the current line in the terminal, if the stream is a TTY.
 */
function clearLine(stream = process.stdout) {
    if (isTTY(stream)) {
        stream.write('\r\x1b[K');
    }
}
/**
 * Logs an error message in red.
 * @param message - The error message to log.
 */
function logError(message) {
    console.error(`${Colors.FgRed}✖ Error: ${message}${Colors.Reset}`);
}
/**
 * Logs a success message in green.
 * @param message - The success message to log.
 */
function logSuccess(message) {
    console.log(`${Colors.FgGreen}✔ Success: ${message}${Colors.Reset}`);
}
/**
 * Logs an informational message in blue.
 * @param message - The informational message to log.
 */
function logInfo(message) {
    console.log(`${Colors.FgBlue}ℹ Info: ${message}${Colors.Reset}`);
}
/**
 * Logs a warning message in yellow.
 * @param message - The warning message to log.
 */
function logWarning(message) {
    console.warn(`${Colors.FgYellow}⚠ Warning: ${message}${Colors.Reset}`);
}
/**
 * Progress Bar Class
 *
 * A simple progress bar implementation for tracking progress.
 */
class ProgressBar {
    constructor(total, barLength = 50, stream = process.stdout) {
        this.total = total;
        this.current = 0;
        this.barLength = barLength;
        this.isComplete = false;
        this.stream = stream;
        this.streamIsTTY = isTTY(this.stream);
    }
    /**
     * Updates the progress bar.
     * @param value - The current progress value.
     */
    update(value) {
        if (this.isComplete)
            return;
        this.current = Math.min(value, this.total);
        this.draw();
        if (this.current >= this.total) {
            this.complete();
        }
    }
    /**
     * Draws the progress bar to the console.
     */
    draw() {
        if (!this.streamIsTTY)
            return;
        const progress = Math.min(this.current / this.total, 1);
        const filledBarLength = Math.round(progress * this.barLength);
        const emptyBarLength = this.barLength - filledBarLength;
        const filledBar = "█".repeat(filledBarLength);
        const emptyBar = "░".repeat(emptyBarLength);
        const output = `${Colors.FgCyan}[${filledBar}${emptyBar}] ${Math.round(progress * 100)}%${Colors.Reset}`;
        clearLine(this.stream);
        this.stream.write(output + '\r');
    }
    /**
     * Completes the progress bar.
     */
    complete() {
        if (this.isComplete || !this.streamIsTTY)
            return;
        this.current = this.total;
        this.draw();
        this.stream.write('\n');
        this.isComplete = true;
    }
    /**
     * Clears the progress bar line, useful before printing other output.
     */
    clear() {
        if (this.streamIsTTY) {
            clearLine(this.stream);
        }
    }
}
exports.ProgressBar = ProgressBar;
