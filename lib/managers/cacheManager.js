const Redis = require('ioredis');
const SQLite = require('better-sqlite3');
const crypto = require('crypto');
const { Logger } = require('../utils/logger');

class CacheManager {
    constructor(config) {
        this.config = config;
        this.logger = new Logger();
        this.client = null;
        this.ready = false;

        if (this.config.enabled) {
            this.initialize();
        }
    }

    async initialize() {
        try {
            if (this.config.type === 'redis') {
                await this.initializeRedis();
            } else if (this.config.type === 'sqlite') {
                await this.initializeSQLite();
            } else {
                throw new Error(`Unsupported cache type: ${this.config.type}`);
            }
            this.ready = true;
            this.logger.info(`Cache manager initialized with ${this.config.type}`);
        } catch (error) {
            this.logger.error('Failed to initialize cache:', error);
            throw error;
        }
    }

    async initializeRedis() {
        this.client = new Redis({
            host: this.config.redis?.host || 'localhost',
            port: this.config.redis?.port || 6379,
            password: this.config.redis?.password,
            db: this.config.redis?.db || 0,
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => {
                const delay = Math.min(times * 50, 2000);
                return delay;
            }
        });

        // Handle Redis events
        this.client.on('error', (error) => {
            this.logger.error('Redis cache error:', error);
        });

        this.client.on('connect', () => {
            this.logger.info('Connected to Redis cache');
        });

        // Wait for connection
        await new Promise((resolve, reject) => {
            this.client.once('ready', resolve);
            this.client.once('error', reject);
        });
    }

    async initializeSQLite() {
        try {
            this.client = new SQLite('cache.db');
            
            // Create cache table if it doesn't exist
            this.client.exec(`
                CREATE TABLE IF NOT EXISTS cache (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    category TEXT,
                    expires_at INTEGER,
                    created_at INTEGER
                )
            `);

            // Create index on expires_at for cleanup
            this.client.exec(`
                CREATE INDEX IF NOT EXISTS idx_expires_at ON cache(expires_at)
            `);

            // Prepare statements
            this.statements = {
                get: this.client.prepare('SELECT value, expires_at FROM cache WHERE key = ?'),
                set: this.client.prepare(
                    'INSERT OR REPLACE INTO cache (key, value, category, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
                ),
                delete: this.client.prepare('DELETE FROM cache WHERE key = ?'),
                cleanup: this.client.prepare('DELETE FROM cache WHERE expires_at < ?'),
                clear: this.client.prepare('DELETE FROM cache WHERE category = ?')
            };

            // Start cleanup interval
            setInterval(() => this.cleanup(), 300000); // Every 5 minutes
        } catch (error) {
            this.logger.error('Failed to initialize SQLite cache:', error);
            throw error;
        }
    }

    generateKey(category, data) {
        const input = typeof data === 'string' ? data : JSON.stringify(data);
        return `${category}:${crypto.createHash('sha256').update(input).digest('hex')}`;
    }

    getTTL(category) {
        return this.config.categories?.[category]?.ttl || this.config.ttl || 3600;
    }

    async get(category, key) {
        if (!this.ready || !this.config.enabled) return null;

        const cacheKey = this.generateKey(category, key);

        try {
            if (this.config.type === 'redis') {
                const value = await this.client.get(cacheKey);
                return value ? JSON.parse(value) : null;
            } else {
                const row = this.statements.get.get(cacheKey);
                if (!row || row.expires_at < Date.now()) {
                    return null;
                }
                return JSON.parse(row.value);
            }
        } catch (error) {
            this.logger.error(`Cache get error for ${category}:`, error);
            return null;
        }
    }

    async set(category, key, value, customTTL = null) {
        if (!this.ready || !this.config.enabled) return false;

        const cacheKey = this.generateKey(category, key);
        const ttl = customTTL || this.getTTL(category);
        const expiresAt = Date.now() + (ttl * 1000);

        try {
            if (this.config.type === 'redis') {
                await this.client.set(
                    cacheKey,
                    JSON.stringify(value),
                    'EX',
                    ttl
                );
            } else {
                this.statements.set.run(
                    cacheKey,
                    JSON.stringify(value),
                    category,
                    expiresAt,
                    Date.now()
                );
            }
            return true;
        } catch (error) {
            this.logger.error(`Cache set error for ${category}:`, error);
            return false;
        }
    }

    async delete(category, key) {
        if (!this.ready || !this.config.enabled) return false;

        const cacheKey = this.generateKey(category, key);

        try {
            if (this.config.type === 'redis') {
                await this.client.del(cacheKey);
            } else {
                this.statements.delete.run(cacheKey);
            }
            return true;
        } catch (error) {
            this.logger.error(`Cache delete error for ${category}:`, error);
            return false;
        }
    }

    async clear(category) {
        if (!this.ready || !this.config.enabled) return false;

        try {
            if (this.config.type === 'redis') {
                const keys = await this.client.keys(`${category}:*`);
                if (keys.length > 0) {
                    await this.client.del(...keys);
                }
            } else {
                this.statements.clear.run(category);
            }
            return true;
        } catch (error) {
            this.logger.error(`Cache clear error for ${category}:`, error);
            return false;
        }
    }

    async cleanup() {
        if (!this.ready || !this.config.enabled) return;

        try {
            if (this.config.type === 'sqlite') {
                this.statements.cleanup.run(Date.now());
            }
            // Redis handles expiration automatically
        } catch (error) {
            this.logger.error('Cache cleanup error:', error);
        }
    }

    async close() {
        if (!this.ready) return;

        try {
            if (this.config.type === 'redis') {
                await this.client.quit();
            } else {
                await this.client.close();
            }
            this.ready = false;
            this.logger.info('Cache manager closed');
        } catch (error) {
            this.logger.error('Error closing cache manager:', error);
        }
    }

    // Get cache statistics
    async getStats() {
        if (!this.ready || !this.config.enabled) return null;

        try {
            if (this.config.type === 'redis') {
                const info = await this.client.info();
                return this.parseRedisStats(info);
            } else {
                return this.getSQLiteStats();
            }
        } catch (error) {
            this.logger.error('Error getting cache stats:', error);
            return null;
        }
    }

    parseRedisStats(info) {
        // Parse Redis INFO command output
        const stats = {};
        info.split('\n').forEach(line => {
            const [key, value] = line.split(':');
            if (key && value) {
                stats[key.trim()] = value.trim();
            }
        });
        return stats;
    }

    getSQLiteStats() {
        const stats = {
            total_keys: this.client.prepare('SELECT COUNT(*) as count FROM cache').get().count,
            active_keys: this.client.prepare('SELECT COUNT(*) as count FROM cache WHERE expires_at > ?')
                .get(Date.now()).count,
            categories: {}
        };

        // Get stats per category
        const categoryStats = this.client.prepare(
            'SELECT category, COUNT(*) as count FROM cache GROUP BY category'
        ).all();
        
        categoryStats.forEach(stat => {
            stats.categories[stat.category] = stat.count;
        });

        return stats;
    }
}

module.exports = { CacheManager };
