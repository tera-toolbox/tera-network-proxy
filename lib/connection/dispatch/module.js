const mui = require('tera-toolbox-mui').DefaultInstance;
const fs = require('fs');
const path = require('path');

class Module {
    constructor(manager, moduleInfo) {
        this.manager = manager;
        this.info = moduleInfo;
        this.dispatch = manager.dispatch;
        this.options = moduleInfo.options;
        this.name = moduleInfo.name;
        this.niceName = this.options.niceName || moduleInfo.rawName;
        this.rootFolder = moduleInfo.path;

        // Module settings
        this.settingsVersion = this.options.settingsVersion || null;
        this.settingsFile = (this.settingsVersion === null) ? '' : path.join(this.rootFolder, this.options.settingsFile || 'module_settings.json');
        this.settingsMigrator = (this.settingsVersion === null) ? '' : path.join(this.rootFolder, this.options.settingsMigrator || 'module_settings_migrator.js');
        this.settingsAutosaveOnClose = (this.options.settingsAutosaveOnClose === undefined) ? true : this.options.settingsAutosaveOnClose;

        // Default modules
        this._command = null;
        this._game = null;

        // Initialize require proxy
        this.require = new Proxy(Object.create(null), {
            get: (obj, key) => {
                switch (key) {
                    case 'command':
                        if (this._command)
                            return this._command;

                        const _command = this.manager.load(key, false);
                        if (!_command)
                            throw new Error(`Required mod not found: ${key}`);
                        return this._command = _command.instance.createInstance(this);
                    case 'tera-game-state':
                        if (this._game)
                            return this._game;

                        const _game = this.manager.load(key, false);
                        if (!_game)
                            throw new Error(`Required mod not found: ${key}`);
                        return this._game = _game.instance;
                    default:
                        let mod = this.clientInterface ? this.clientInterface.moduleManager.get(key) : null;
                        if (!mod)
                            mod = this.manager.load(key, false);
                        if (!mod)
                            throw new Error(`Required mod not found: ${key}`);
                        return mod.instance;
                }
            },
            set() {
                throw new TypeError('Cannot set property of require');
            }
        });

        // Timers
        this._timeouts = new Set();
        this._intervals = new Set();

        // Use tera-game-state callbacks to clear timers when entering/leaving the game
        if (this.name !== 'tera-game-state') {
            try {
                this.game.on('leave_game', () => { this.clearAllTimeouts(); this.clearAllIntervals(); });
            } catch (_) {
                this.warn(mui.get('tera-network-proxy/connection/dispatch/module/tera-game-state-not-loaded'));
            }
        }

        // Load settings
        this.loadSettings();

        // Implementation will be set later when loaded by manager
        this.instance = null;
    }

    destructor() {
        // Destroy mod instance
        try {
            if (typeof this.instance.destructor === 'function')
                this.instance.destructor();

            if (this.settingsAutosaveOnClose)
                this.saveSettings();
        } finally {
            this.instance = null;
        }

        // Destroy core mod instances
        try {
            if (this._command && typeof this._command.destructor === 'function')
                this._command.destructor();
        } finally {
            this._command = null;
            this._game = null;
        }
    }

    loadState(state) {
        return (typeof this.instance.loadState === 'function') ? this.instance.loadState(state) : null;
    }

    saveState() {
        return (typeof this.instance.saveState === 'function') ? this.instance.saveState() : null;
    }

    hook(...args) {
        const hook = this.dispatch.hook(this.name, ...args);
        return hook;
    }

    tryHook(...args) {
        try {
            return this.hook(...args);
        } catch (_) {
            return null;
        }
    }

    hookOnce(...args) {
        const cb = args.pop();
        if (typeof cb !== 'function')
            throw new Error('last argument not a function');

        const dispatch = this.dispatch;
        let hook = dispatch.hook(this.name, ...args, function () {
            dispatch.unhook(hook);
            return cb.apply(this, arguments);
        });

        hook.moduleName = this.name;
        return hook;
    }

    tryHookOnce(...args) {
        const cb = args.pop();
        if (typeof cb !== 'function')
            throw new Error('last argument not a function');

        try {
            const dispatch = this.dispatch;
            let hook = dispatch.hook(this.name, ...args, function () {
                dispatch.unhook(hook);
                return cb.apply(this, arguments);
            });

            hook.moduleName = this.name;
            return hook;
        } catch (_) {
            return null;
        }
    }

    unhook(...args) {
        return this.dispatch.unhook(...args);
    }

    toClient(...args) {
        return this.dispatch.write(false, ...args);
    }

    toServer(...args) {
        return this.dispatch.write(true, ...args);
    }

    send(name, version, data) {
        if (typeof name !== 'string')
            throw Error('Raw send() is not supported');

        switch (name[0]) {
            case 'S':
            case 'I':
                return this.dispatch.write(false, name, version, data);
            case 'C':
                return this.dispatch.write(true, name, version, data);
            default:
                throw new Error(`Unknown packet direction: ${name}`);
        }
    }

    trySend(...args) {
        try {
            return this.send(...args);
        } catch (_) {
            return false;
        }
    }

    parseSystemMessage(...args) {
        return this.dispatch.parseSystemMessage(...args);
    }

    buildSystemMessage(...args) {
        return this.dispatch.buildSystemMessage(...args);
    }

    get proxyAuthor() { return this.dispatch.proxyAuthor; }
    get region() { return this.dispatch.region; }
    get environment() { return this.dispatch.environment; }
    get majorPatchVersion() { return this.dispatch.majorPatchVersion; }
    get minorPatchVersion() { return this.dispatch.minorPatchVersion; }
    get protocolVersion() { return this.dispatch.protocolVersion; }
    get isConsole() { return this.dispatch.isConsole; }
    get isClassic() { return this.dispatch.isClassic; }
    get platform() { return this.dispatch.platform; }
    get connection() { return this.dispatch.connection; }
    get serverId() { return this.dispatch.connection.metadata.serverId; }
    get serverList() { return this.dispatch.connection.metadata.serverList; }

    // Default modules
    get command() { return this.require['command']; }
    get game() { return this.require['tera-game-state']; }

    // Module settings
    loadSettings() {
        if (this.settingsVersion === null)
            return;

        this.settings = {};

        let data = null;
        try {
            data = fs.readFileSync(this.settingsFile);
        } catch (_) {
            this.settings = this.migrateSettings(null, this.settingsVersion);
            return;
        }

        try {
            data = JSON.parse(data);
        } catch (e) {
            if (e.toString().includes('at position 0')) {
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-load-error-corrupted-1'));
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-load-error-corrupted-2', { name: this.name }));
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-load-error-corrupted-3'));
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-load-error-corrupted-4'));
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-load-error-corrupted-5'));

                this.settings = this.migrateSettings(null, this.settingsVersion);
                this.saveSettings();
                return;
            } else {
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-load-error-invalid-format-1', { name: this.name }));
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-load-error-invalid-format-2'));
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-load-error-invalid-format-3'));
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-load-error-invalid-format-4'));
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-load-error-invalid-format-5'));
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-load-error-invalid-format-6'));
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-load-error-invalid-format-7', { settingsFile: this.settingsFile }));
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-load-error-invalid-format-8'));
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-load-error-invalid-format-9', { e }));
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-load-error-invalid-format-10'));
                throw e;
            }
        }

        if (this.settingsVersion !== data.version) {
            this.settings = this.migrateSettings(data.version, this.settingsVersion, (data.version !== undefined && data.data !== undefined) ? data.data : data);
            return;
        }

        this.settings = data.data;
    }

    saveSettings() {
        if (this.settingsVersion === null)
            return;

        let data = null;
        try {
            data = JSON.stringify({ 'version': this.settingsVersion, 'data': this.settings }, null, 4);

            try {
                fs.writeFileSync(this.settingsFile, data);
            } catch (e) {
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-save-error-write'));
                this.error(e);
            }
        } catch (e) {
            this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-save-error-stringify'));
            this.error(e);
        }
    }

    migrateSettings(from_ver, to_ver, settings) {
        try {
            let migrator = require(this.settingsMigrator);
            try {
                return migrator(from_ver, to_ver, settings);
            } catch (e) {
                this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-migrate-error-run-migrator'));
                this.error(e);
                throw e;
            }
        } catch (e) {
            this.error(mui.get('tera-network-proxy/connection/dispatch/module/settings-migrate-error-load-migrator'));
            this.error(e);
            throw e;
        }
    }

    // Timers
    setTimeout(callback, delay, ...args) {
        const id = setTimeout(() => {
            callback(...args);
            this._timeouts.delete(id);
        }, delay);

        this._timeouts.add(id);
        return id;
    }

    clearTimeout(id) {
        if (!this._timeouts.delete(id))
            return false;
        return clearTimeout(id);
    }

    clearAllTimeouts() {
        this._timeouts.forEach(clearTimeout);
        this._timeouts.clear();
    }

    get activeTimeouts() { return this._timeouts; }


    setInterval(callback, delay, ...args) {
        const id = setInterval(callback, delay, ...args);
        this._intervals.add(id);
        return id;
    }

    clearInterval(id) {
        if (!this._intervals.delete(id))
            return false;
        return clearInterval(id);
    }

    clearAllIntervals() {
        this._intervals.forEach(clearInterval);
        this._intervals.clear();
    }

    get activeIntervals() { return this._intervals; }

    // Logging
    log(...args) { console.log(mui.get('tera-network-proxy/connection/dispatch/module/prefix-log', { name: this.name }), ...args); }
    warn(...args) { console.warn(mui.get('tera-network-proxy/connection/dispatch/module/prefix-warn', { name: this.name }), ...args); }
    error(...args) { console.error(mui.get('tera-network-proxy/connection/dispatch/module/prefix-error', { name: this.name }), ...args); }

    // Client Interface
    get clientInterface() { return this.dispatch.connection.clientInterfaceConnection; }
    queryData(...args) { return this.clientInterface.queryData(...args); }
}

module.exports = Module;
