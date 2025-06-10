const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const { Logger } = require('./utils/logger');

class ConfigLoader {
    constructor() {
        this.logger = new Logger();
        this.configPath = process.env.CONFIG_PATH || 'config.yaml';
        this.envFile = process.env.ENV_FILE || '.env';
    }

    async loadConfig() {
        try {
            // Load environment variables
            await this.loadEnv();

            // Load and parse config file
            const configContent = await fs.promises.readFile(this.configPath, 'utf8');
            const config = this.parseConfig(configContent);

            // Validate and process configuration
            const validatedConfig = this.validateConfig(config);

            // Interpolate environment variables
            const processedConfig = this.processConfig(validatedConfig);

            return processedConfig;
        } catch (error) {
            this.logger.error('Failed to load configuration:', error);
            throw error;
        }
    }

    async loadEnv() {
        try {
            if (fs.existsSync(this.envFile)) {
                const envContent = await fs.promises.readFile(this.envFile, 'utf8');
                const envVars = this.parseEnvFile(envContent);
                Object.assign(process.env, envVars);
            }
        } catch (error) {
            this.logger.warn('Failed to load .env file:', error);
        }
    }

    parseEnvFile(content) {
        const env = {};
        content.split('\n').forEach(line => {
            line = line.trim();
            if (line && !line.startsWith('#')) {
                const [key, ...valueParts] = line.split('=');
                const value = valueParts.join('=');
                if (key && value) {
                    env[key.trim()] = value.trim().replace(/^["']|["']$/g, '');
                }
            }
        });
        return env;
    }

    parseConfig(content) {
        try {
            // Try parsing as YAML first
            return yaml.load(content);
        } catch (error) {
            try {
                // Fall back to JSON if YAML parsing fails
                return JSON.parse(content);
            } catch (jsonError) {
                throw new Error('Failed to parse configuration file as YAML or JSON');
            }
        }
    }

    validateConfig(config) {
        // Required top-level sections
        const requiredSections = [
            'system',
            'api_keys',
            'categories'
        ];

        for (const section of requiredSections) {
            if (!config[section]) {
                throw new Error(`Missing required configuration section: ${section}`);
            }
        }

        // Validate API keys configuration
        this.validateApiKeys(config.api_keys);

        // Validate categories configuration
        this.validateCategories(config.categories);

        // Validate proxy configuration if enabled
        if (config.proxies?.enabled) {
            this.validateProxies(config.proxies);
        }

        // Validate cache configuration if enabled
        if (config.cache?.enabled) {
            this.validateCache(config.cache);
        }

        return config;
    }

    validateApiKeys(apiKeys) {
        const requiredProviders = ['gemini'];
        for (const provider of requiredProviders) {
            if (!apiKeys[provider]) {
                throw new Error(`Missing required API key configuration for: ${provider}`);
            }
        }
    }

    validateCategories(categories) {
        const requiredCategories = [
            'job_market',
            'ecommerce',
            'real_estate',
            'content_aggregation',
            'research_docs',
            'financial',
            'travel',
            'lead_generation',
            'regulatory',
            'market_research'
        ];

        for (const category of requiredCategories) {
            if (!categories[category]) {
                throw new Error(`Missing required category configuration: ${category}`);
            }

            // Validate category configuration
            this.validateCategoryConfig(category, categories[category]);
        }
    }

    validateCategoryConfig(name, config) {
        // Required fields for each category
        const required = ['tools', 'features', 'settings'];
        for (const field of required) {
            if (!config[field]) {
                throw new Error(`Missing required field '${field}' in category: ${name}`);
            }
        }

        // Validate tools configuration
        if (!config.tools.primary) {
            throw new Error(`Missing primary tool configuration for category: ${name}`);
        }
    }

    validateProxies(proxies) {
        if (!Array.isArray(proxies.providers)) {
            throw new Error('Proxy providers must be an array');
        }

        for (const provider of proxies.providers) {
            if (!provider.type || !Array.isArray(provider.list)) {
                throw new Error('Invalid proxy provider configuration');
            }
        }
    }

    validateCache(cache) {
        if (!['redis', 'sqlite'].includes(cache.type)) {
            throw new Error('Invalid cache type. Must be either "redis" or "sqlite"');
        }

        if (typeof cache.ttl !== 'number') {
            throw new Error('Cache TTL must be a number');
        }
    }

    processConfig(config) {
        return this.interpolateEnvVars(config);
    }

    interpolateEnvVars(obj) {
        if (typeof obj !== 'object' || obj === null) {
            return obj;
        }

        if (Array.isArray(obj)) {
            return obj.map(item => this.interpolateEnvVars(item));
        }

        const result = {};
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'string') {
                result[key] = this.replaceEnvVars(value);
            } else if (typeof value === 'object') {
                result[key] = this.interpolateEnvVars(value);
            } else {
                result[key] = value;
            }
        }

        return result;
    }

    replaceEnvVars(str) {
        return str.replace(/\${([^}]+)}/g, (match, envVar) => {
            const [name, defaultValue] = envVar.split(':-');
            return process.env[name] || defaultValue || match;
        });
    }

    // Get effective configuration value
    static getEffectiveValue(value, defaultValue) {
        return value !== undefined ? value : defaultValue;
    }
}

// Export a singleton instance
const configLoader = new ConfigLoader();

module.exports = {
    loadConfig: () => configLoader.loadConfig(),
    ConfigLoader
};
