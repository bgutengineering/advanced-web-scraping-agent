const EventEmitter = require('events');
const { Logger } = require('../utils/logger');

class ApiKeyManager extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.logger = new Logger();
        this.keyStates = new Map();
        this.initializeKeyStates();
    }

    initializeKeyStates() {
        // Initialize state tracking for each provider
        for (const [provider, keys] of Object.entries(this.config)) {
            this.keyStates.set(provider, {
                currentKeyIndex: 0,
                keys: [keys.primary, ...(keys.fallback || [])].filter(Boolean),
                rateLimits: new Map(), // Track rate limits per key
                errors: new Map(),     // Track errors per key
                lastRotation: new Map() // Track last rotation time per key
            });
        }
    }

    async getKey(provider) {
        const state = this.keyStates.get(provider);
        if (!state || !state.keys.length) {
            throw new Error(`No API keys configured for provider: ${provider}`);
        }

        const currentKey = state.keys[state.currentKeyIndex];
        
        // Check if key is rate limited or has errors
        if (this.isKeyLimited(provider, currentKey)) {
            return await this.rotateKey(provider);
        }

        return currentKey;
    }

    async rotateKey(provider) {
        const state = this.keyStates.get(provider);
        if (!state) {
            throw new Error(`Unknown provider: ${provider}`);
        }

        // Try to find the next available key
        const startIndex = state.currentKeyIndex;
        let attempts = 0;

        while (attempts < state.keys.length) {
            state.currentKeyIndex = (state.currentKeyIndex + 1) % state.keys.length;
            const nextKey = state.keys[state.currentKeyIndex];

            // If key is not rate limited or errored, use it
            if (!this.isKeyLimited(provider, nextKey)) {
                this.logger.info(`Rotated to new API key for ${provider}`);
                state.lastRotation.set(nextKey, Date.now());
                return nextKey;
            }

            attempts++;
        }

        // If we've tried all keys and none are available
        throw new Error(`All API keys for ${provider} are currently unavailable`);
    }

    isKeyLimited(provider, key) {
        const state = this.keyStates.get(provider);
        if (!state) return true;

        const rateLimitInfo = state.rateLimits.get(key);
        const errorInfo = state.errors.get(key);
        const lastRotation = state.lastRotation.get(key);

        // Check rate limits
        if (rateLimitInfo && Date.now() < rateLimitInfo.resetTime) {
            return true;
        }

        // Check error backoff
        if (errorInfo && Date.now() < errorInfo.backoffUntil) {
            return true;
        }

        // Check minimum rotation interval
        const minRotationInterval = this.config[provider].retry_delay || 1000;
        if (lastRotation && Date.now() - lastRotation < minRotationInterval) {
            return true;
        }

        return false;
    }

    markKeyLimited(provider, key, resetTime) {
        const state = this.keyStates.get(provider);
        if (!state) return;

        state.rateLimits.set(key, {
            limitedAt: Date.now(),
            resetTime: resetTime || (Date.now() + 60000) // Default 1 minute
        });

        this.emit('keyLimited', { provider, key });
    }

    markKeyError(provider, key, error) {
        const state = this.keyStates.get(provider);
        if (!state) return;

        const currentErrors = state.errors.get(key) || { count: 0 };
        currentErrors.count++;
        currentErrors.lastError = error;
        currentErrors.backoffUntil = Date.now() + Math.min(
            currentErrors.count * 5000, // Exponential backoff, starting at 5 seconds
            300000 // Max 5 minutes
        );

        state.errors.set(key, currentErrors);
        this.emit('keyError', { provider, key, error });
    }

    resetKeyState(provider, key) {
        const state = this.keyStates.get(provider);
        if (!state) return;

        state.rateLimits.delete(key);
        state.errors.delete(key);
        this.emit('keyReset', { provider, key });
    }

    // Get status of all keys for a provider
    getProviderStatus(provider) {
        const state = this.keyStates.get(provider);
        if (!state) return null;

        return {
            totalKeys: state.keys.length,
            availableKeys: state.keys.filter(key => !this.isKeyLimited(provider, key)).length,
            currentKeyIndex: state.currentKeyIndex,
            rateLimits: Object.fromEntries(state.rateLimits),
            errors: Object.fromEntries(state.errors)
        };
    }

    // Get all providers status
    getAllProvidersStatus() {
        const status = {};
        for (const provider of this.keyStates.keys()) {
            status[provider] = this.getProviderStatus(provider);
        }
        return status;
    }
}

module.exports = { ApiKeyManager };
