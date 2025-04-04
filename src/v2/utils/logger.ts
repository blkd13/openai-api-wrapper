// src/utils/logger.ts
import * as fs from 'fs';
import * as path from 'path';

/**
 * Log levels
 */
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
    level: LogLevel;
    logToConsole: boolean;
    logToFile: boolean;
    logDir: string;
    timestampFormat: string;
}

/**
 * Default logger configuration
 */
const DEFAULT_CONFIG: LoggerConfig = {
    level: LogLevel.INFO,
    logToConsole: true,
    logToFile: true,
    logDir: './logs',
    timestampFormat: 'yyyy-MM-dd HH:mm:ss.SSS'
};

/**
 * Centralized logging utility
 */
export class Logger {
    private static config: LoggerConfig = { ...DEFAULT_CONFIG };
    private context: string;

    /**
     * Create a new logger
     * @param context Context name for this logger instance
     */
    constructor(context: string) {
        this.context = context;

        // Ensure log directory exists
        if (Logger.config.logToFile && !fs.existsSync(Logger.config.logDir)) {
            fs.mkdirSync(Logger.config.logDir, { recursive: true });
        }
    }

    /**
     * Configure the logger
     * @param config Configuration options
     */
    static configure(config: Partial<LoggerConfig>): void {
        Logger.config = { ...Logger.config, ...config };

        // Ensure log directory exists
        if (Logger.config.logToFile && !fs.existsSync(Logger.config.logDir)) {
            fs.mkdirSync(Logger.config.logDir, { recursive: true });
        }
    }

    /**
     * Format the current timestamp
     * @returns Formatted timestamp string
     */
    private formatTimestamp(): string {
        const now = new Date();
        return now.toISOString().replace('T', ' ').substr(0, 23);
    }

    /**
     * Format an error object for logging
     * @param error Error to format
     * @returns Formatted error string
     */
    private formatError(error: any): string {
        if (error instanceof Error) {
            return `${error.message}\n${error.stack}`;
        } else if (typeof error === 'object') {
            try {
                return JSON.stringify(error, null, 2);
            } catch {
                return String(error);
            }
        }
        return String(error);
    }

    /**
     * Format a message for logging
     * @param level Log level
     * @param message Message to log
     * @param meta Additional metadata
     * @returns Formatted log message
     */
    private formatMessage(
        level: string,
        message: string,
        meta: any[] = []
    ): string {
        const timestamp = this.formatTimestamp();
        const metaStr = meta.length > 0
            ? meta.map(m => {
                if (m instanceof Error) return this.formatError(m);
                if (typeof m === 'object') return JSON.stringify(m, null, 2);
                return String(m);
            }).join(' ')
            : '';

        return `[${timestamp}] [${level}] [${this.context}] ${message} ${metaStr}`.trim();
    }

    /**
     * Write a log message to file
     * @param message Formatted log message
     */
    private writeToFile(message: string): void {
        if (!Logger.config.logToFile) return;

        const date = new Date().toISOString().split('T')[0];
        const logFile = path.join(Logger.config.logDir, `${date}.log`);

        fs.appendFileSync(logFile, message + '\n', { encoding: 'utf8' });
    }

    /**
     * Log a debug message
     * @param message Message to log
     * @param meta Additional metadata
     */
    debug(message: string, ...meta: any[]): void {
        if (Logger.config.level <= LogLevel.DEBUG) {
            const formattedMessage = this.formatMessage('DEBUG', message, meta);
            if (Logger.config.logToConsole) console.debug(formattedMessage);
            this.writeToFile(formattedMessage);
        }
    }

    /**
     * Log an info message
     * @param message Message to log
     * @param meta Additional metadata
     */
    info(message: string, ...meta: any[]): void {
        if (Logger.config.level <= LogLevel.INFO) {
            const formattedMessage = this.formatMessage('INFO', message, meta);
            if (Logger.config.logToConsole) console.info(formattedMessage);
            this.writeToFile(formattedMessage);
        }
    }

    /**
     * Log a warning message
     * @param message Message to log
     * @param meta Additional metadata
     */
    warn(message: string, ...meta: any[]): void {
        if (Logger.config.level <= LogLevel.WARN) {
            const formattedMessage = this.formatMessage('WARN', message, meta);
            if (Logger.config.logToConsole) console.warn(formattedMessage);
            this.writeToFile(formattedMessage);
        }
    }

    /**
     * Log an error message
     * @param message Message to log
     * @param meta Additional metadata
     */
    error(message: string, ...meta: any[]): void {
        if (Logger.config.level <= LogLevel.ERROR) {
            const formattedMessage = this.formatMessage('ERROR', message, meta);
            if (Logger.config.logToConsole) console.error(formattedMessage);
            this.writeToFile(formattedMessage);
        }
    }
}