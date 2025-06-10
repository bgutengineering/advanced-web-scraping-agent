const winston = require('winston');
const path = require('path');
const fs = require('fs');

class Logger {
    constructor(options = {}) {
        this.options = {
            level: options.level || 'info',
            filename: options.filename || 'scraper.log',
            maxSize: options.maxSize || '100m',
            maxFiles: options.maxFiles || 5,
            ...options
        };

        this.initialize();
    }

    initialize() {
        // Ensure logs directory exists
        const logDir = 'logs';
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir);
        }

        const logFormat = winston.format.combine(
            winston.format.timestamp({
                format: 'YYYY-MM-DD HH:mm:ss'
            }),
            winston.format.errors({ stack: true }),
            winston.format.splat(),
            winston.format.json()
        );

        const consoleFormat = winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp({
                format: 'YYYY-MM-DD HH:mm:ss'
            }),
            winston.format.printf(
                info => `${info.timestamp} ${info.level}: ${info.message}`
            )
        );

        this.logger = winston.createLogger({
            level: this.options.level,
            format: logFormat,
            transports: [
                // Console output
                new winston.transports.Console({
                    format: consoleFormat
                }),
                // Rotating file transport
                new winston.transports.File({
                    filename: path.join(logDir, 'error.log'),
                    level: 'error',
                    maxsize: this.parseSize(this.options.maxSize),
                    maxFiles: this.options.maxFiles,
                    tailable: true
                }),
                new winston.transports.File({
                    filename: path.join(logDir, this.options.filename),
                    maxsize: this.parseSize(this.options.maxSize),
                    maxFiles: this.options.maxFiles,
                    tailable: true
                })
            ]
        });

        // Handle uncaught exceptions and unhandled rejections
        this.logger.exceptions.handle(
            new winston.transports.File({
                filename: path.join(logDir, 'exceptions.log')
            })
        );

        process.on('unhandledRejection', (error) => {
            this.error('Unhandled Rejection', error);
        });
    }

    parseSize(size) {
        const units = {
            'b': 1,
            'k': 1024,
            'm': 1024 * 1024,
            'g': 1024 * 1024 * 1024
        };

        const match = size.toString().toLowerCase().match(/^(\d+)([bkmg])$/);
        if (!match) return 10 * 1024 * 1024; // Default 10MB

        const [, number, unit] = match;
        return parseInt(number) * (units[unit] || 1);
    }

    formatMessage(message, meta = {}) {
        if (typeof message === 'object') {
            return JSON.stringify(message);
        }
        
        let formattedMessage = message;
        if (Object.keys(meta).length > 0) {
            formattedMessage += ` ${JSON.stringify(meta)}`;
        }
        
        return formattedMessage;
    }

    log(level, message, meta = {}) {
        this.logger.log(level, this.formatMessage(message, meta));
    }

    error(message, error = null, meta = {}) {
        const errorMeta = { ...meta };
        if (error) {
            errorMeta.error = {
                message: error.message,
                stack: error.stack,
                ...error
            };
        }
        this.logger.error(this.formatMessage(message, errorMeta));
    }

    warn(message, meta = {}) {
        this.logger.warn(this.formatMessage(message, meta));
    }

    info(message, meta = {}) {
        this.logger.info(this.formatMessage(message, meta));
    }

    debug(message, meta = {}) {
        this.logger.debug(this.formatMessage(message, meta));
    }

    // Specialized logging methods for scraping operations
    logScrapingStart(category, config) {
        this.info('Starting scraping operation', {
            category,
            config: this.sanitizeConfig(config)
        });
    }

    logScrapingComplete(category, stats) {
        this.info('Scraping operation complete', {
            category,
            stats
        });
    }

    logScrapingError(category, error, meta = {}) {
        this.error(`Scraping operation failed for ${category}`, error, meta);
    }

    logProxySwitch(oldProxy, newProxy, reason) {
        this.debug('Switching proxy', {
            from: this.sanitizeProxy(oldProxy),
            to: this.sanitizeProxy(newProxy),
            reason
        });
    }

    logApiKeyRotation(provider, reason) {
        this.debug('Rotating API key', {
            provider,
            reason
        });
    }

    // Utility methods
    sanitizeConfig(config) {
        // Remove sensitive information from config before logging
        const sanitized = { ...config };
        delete sanitized.apiKey;
        delete sanitized.credentials;
        delete sanitized.password;
        return sanitized;
    }

    sanitizeProxy(proxy) {
        if (!proxy) return null;
        // Mask proxy credentials in logs
        return proxy.replace(/\/\/.*@/, '//***:***@');
    }

    // Query logs
    async queryLogs(options = {}) {
        const {
            level = 'info',
            startTime,
            endTime,
            limit = 100,
            category
        } = options;

        // Implementation would depend on your storage backend
        // This is a placeholder for log querying functionality
        return {
            message: 'Log querying not implemented',
            options
        };
    }

    // Cleanup old logs
    async cleanup(maxAge = '7d') {
        const logDir = 'logs';
        const now = Date.now();
        const maxAgeMs = this.parseAge(maxAge);

        try {
            const files = fs.readdirSync(logDir);
            for (const file of files) {
                const filePath = path.join(logDir, file);
                const stats = fs.statSync(filePath);
                if (now - stats.mtime.getTime() > maxAgeMs) {
                    fs.unlinkSync(filePath);
                    this.debug(`Deleted old log file: ${file}`);
                }
            }
        } catch (error) {
            this.error('Error cleaning up old logs', error);
        }
    }

    parseAge(age) {
        const units = {
            'd': 24 * 60 * 60 * 1000,
            'h': 60 * 60 * 1000,
            'm': 60 * 1000,
            's': 1000
        };

        const match = age.toString().toLowerCase().match(/^(\d+)([dhms])$/);
        if (!match) return 7 * 24 * 60 * 60 * 1000; // Default 7 days

        const [, number, unit] = match;
        return parseInt(number) * (units[unit] || units.d);
    }
}

module.exports = { Logger };
