'use strict';

const Boom = require('@hapi/boom');
const Bounce = require('@hapi/bounce');
const Call = require('@hapi/call');
const Hoek = require('@hapi/hoek');
const Joi = require('@hapi/joi');
const Ws = require('ws');

const Socket = require('./socket');


const internals = {
    counter: {
        min: 10000,
        max: 99999
    }
};


exports = module.exports = internals.Listener = function (server, settings) {

    this._server = server;
    this._settings = settings;
    this._sockets = new internals.Sockets(this);
    this._router = new Call.Router();
    this._authRoute = this._settings.auth && this._server.lookup(this._settings.auth.id);
    this._socketCounter = internals.counter.min;
    this._heartbeat = null;
    this._beatTimeout = null;
    this._stopped = false;

    // WebSocket listener

    const options = { server: this._server.listener };
    if (settings.origin) {
        options.verifyClient = (info) => settings.origin.indexOf(info.origin) >= 0;
    }

    this._wss = new Ws.Server(options);

    this._wss.on('connection', (ws, req) => {

        ws.on('error', Hoek.ignore);

        if (this._stopped ||
            (this._settings.maxConnections && this._sockets.length() >= this._settings.maxConnections)) {

            return ws.close();
        }

        this._add(ws, req);
    });

    this._wss.on('error', Hoek.ignore);

    // Register with the server

    this._server.plugins.nes = { _listener: this };
};


internals.Listener.prototype._add = function (ws, req) {

    // Socket object

    const socket = new Socket(ws, req, this);

    // Subscriptions

    this._sockets.add(socket);

    ws.once('close', async (code, message) => {

        this._sockets.remove(socket);
        clearTimeout(socket.auth._initialAuthTimeout);
        socket.auth._initialAuthTimeout = null;

        const subs = Object.keys(socket._subscriptions);
        for (let i = 0; i < subs.length; ++i) {
            const sub = subs[i];
            const subscribers = socket._subscriptions[sub];
            await subscribers.remove(socket);
        }

        socket._subscriptions = {};

        if (this._settings.onDisconnection) {
            this._settings.onDisconnection(socket);
        }

        socket._removed.attend();
    });
};


internals.Listener.prototype._close = async function () {

    this._stopped = true;
    clearTimeout(this._heartbeat);
    clearTimeout(this._beatTimeout);

    await Promise.all(Object.keys(this._sockets._items).map((id) => this._sockets._items[id].disconnect()));

    this._wss.close();
};


internals.Listener.prototype._authRequired = function () {

    if (!this._authRoute) {
        return false;
    }

    const auth = this._server.auth.lookup(this._authRoute);
    if (!auth) {
        return false;
    }

    return auth.mode === 'required';
};


internals.Listener.prototype._beat = function () {

    if (!this._settings.heartbeat) {
        return;
    }

    if (this._heartbeat &&                              // Skip the first time
        this._sockets.length()) {

        // Send heartbeats

        const update = {
            type: 'ping'
        };

        this._sockets._forEach((socket) => socket._send(update).catch(Hoek.ignore));    // Ignore errors

        // Verify client responded

        this._beatTimeout = setTimeout(() => {

            this._sockets._forEach((socket) => {

                if (!socket._active()) {
                    socket.disconnect();
                }

                socket._pinged = false;
            });
        }, this._settings.heartbeat.timeout);
    }

    // Schedule next heartbeat

    this._heartbeat = setTimeout(() => {

        this._beat();
    }, this._settings.heartbeat.interval);
};


internals.Listener.broadcast = function (message, options) {

    options = options || {};

    const update = {
        type: 'update',
        message
    };

    return this.plugins.nes._listener._broadcast(update, options);
};


internals.Listener.prototype._broadcast = function (update, options) {

    Hoek.assert(!options.user || (this._settings.auth && this._settings.auth.index), 'Socket auth indexing is disabled');

    if (this._stopped) {
        return;
    }

    const each = (socket) => socket._send(update).catch(Hoek.ignore);       // Ignore errors

    if (options.user) {
        const sockets = this._sockets._byUser[options.user];
        if (!sockets) {
            return;
        }

        return sockets.forEach(each);
    }

    return this._sockets._forEach(each);
};


internals.subSchema = Joi.object({
    internal: Joi.boolean(),
    filter: Joi.func(),                                             // async function (path, update, options), where options: { credentials, params }, returns true, false, { override }, or throws an error
    onSubscribe: Joi.func(),                                        // async function (socket, path, params)
    onUnsubscribe: Joi.func(),                                      // async function (socket, path, params)
    auth: Joi.object({
        mode: Joi.string().valid('required', 'optional'),
        scope: Joi.array().items(Joi.string()).single().min(1),
        entity: Joi.valid('user', 'app', 'any'),
        index: Joi.boolean()
    })
        .allow(false)
});


internals.Listener.subscription = function (path, options) {

    Hoek.assert(path, 'Subscription missing path');
    Joi.assert(options, internals.subSchema, 'Invalid subscription options: ' + path);

    const settings = Hoek.clone(options || {});

    // Auth configuration

    const auth = settings.auth;
    if (auth) {
        if (auth.scope) {
            if (typeof auth.scope === 'string') {
                auth.scope = [auth.scope];
            }

            for (let i = 0; i < auth.scope.length; ++i) {
                if (/{([^}]+)}/.test(auth.scope[i])) {
                    auth.hasScopeParameters = true;
                    break;
                }
            }
        }

        auth.mode = auth.mode || 'required';
    }

    // Path configuration

    const route = {
        method: 'sub',
        path
    };

    const config = {
        subscribers: new internals.Subscribers(this.plugins.nes._listener._server, settings),
        filter: settings.filter,
        onSubscribe: settings.onSubscribe,
        internal: settings.internal,
        auth
    };

    this.plugins.nes._listener._router.add(route, config);
};


internals.Listener.publish = function (path, update, options) {

    Hoek.assert(path && path[0] === '/', 'Missing or invalid subscription path:', path || 'empty');

    options = options || {};

    const message = {
        type: 'pub',
        path,
        message: update
    };

    return this.plugins.nes._listener._publish(path, message, options);
};


internals.Listener.prototype._publish = function (path, _update, options) {

    if (this._stopped) {
        return;
    }

    const match = this._router.route('sub', path);
    if (match.isBoom) {
        return;
    }

    const each = async (socket, actualPath) => {       // Filter on path if has parameters

        let update = _update;

        if (route.filter) {
            try {
                var isMatch = await route.filter(path, update.message, { socket, credentials: socket.auth.credentials, params: match.params, internal: options.internal });
            }
            catch (err) {
                Bounce.rethrow(err, 'system');
            }

            if (!isMatch) {
                return;
            }

            if (isMatch.override) {
                update = Object.assign({}, update);                                 // Shallow cloned
                update.message = isMatch.override;
            }
        }

        if (actualPath && update.path !== actualPath) {
            update = Object.assign({}, update);                                 // Shallow cloned
            update.path = actualPath;
        }

        return socket._send(update).catch(Hoek.ignore);                             // Ignore errors
    };

    const route = match.route;
    return route.subscribers._forEachSubscriber(match.paramsArray.length ? path : null, options, each);
};


internals.Listener.prototype._subscribe = async function (path, socket) {

    // Errors include subscription context in messages in case returned as connection errors

    if (path.indexOf('?') !== -1) {
        throw Boom.badRequest('Subscription path cannot contain query');
    }

    if (socket._subscriptions[path]) {
        return;
    }

    let match = this._router.route('sub', path);
    if (match.isBoom || match.route.internal) {
        throw Boom.notFound('Subscription not found');
    }

    const auth = this._server.auth.lookup({ settings: { auth: match.route.auth } });         // Create a synthetic route
    if (auth) {
        const credentials = socket.auth.credentials;
        if (credentials) {

            // Check scope

            if (auth.scope) {
                let scopes = auth.scope;
                if (auth.hasScopeParameters) {
                    scopes = [];
                    const context = { params: match.params };
                    for (let i = 0; i < auth.scope.length; ++i) {
                        scopes[i] = Hoek.reachTemplate(context, auth.scope[i]);
                    }
                }

                if (!credentials.scope ||
                    (typeof credentials.scope === 'string' ? !scopes.includes(credentials.scope) : !Hoek.intersect(scopes, credentials.scope).length)) {

                    throw Boom.forbidden('Insufficient scope to subscribe, expected any of: ' + scopes);
                }
            }

            // Check entity

            const entity = auth.entity || 'any';
            if (entity === 'user' &&
                !credentials.user) {

                throw Boom.forbidden('Application credentials cannot be used on a user subscription');
            }

            if (entity === 'app' &&
                credentials.user) {

                throw Boom.forbidden('User credentials cannot be used on an application subscription');
            }
        }
        else if (auth.mode === 'required') {
            throw Boom.unauthorized('Authentication required to subscribe');
        }
    }

    let softPath = path;

    if (match.route.onSubscribe) {
        const result = await match.route.onSubscribe(socket, path, match.params);

        if (result && result.override) {
            match = this._router.route('sub', result.override);
            if (match.isBoom) {
                throw Boom.notFound('Subscription not found');
            }

           softPath = result.override;
        }
    }

    await match.route.subscribers.add(socket, path, softPath, match);
    socket._subscriptions[path] = match.route.subscribers;
};


internals.Listener.eachSocket = function (each, options) {

    options = options || {};

    return this.plugins.nes._listener._eachSocket(each, options);
};


internals.Listener.prototype._eachSocket = function (each, options) {

    if (this._stopped) {
        return;
    }

    if (!options.subscription) {
        Hoek.assert(!options.user, 'Cannot specify user filter without a subscription path');
        return this._sockets._forEach(each);
    }

    const sub = this._router.route('sub', options.subscription);
    if (sub.isBoom) {
        return;
    }

    const route = sub.route;
    return route.subscribers._forEachSubscriber(sub.paramsArray.length ? options.subscription : null, options, each);       // Filter on path if has parameters
};


internals.Listener.prototype._generateId = function () {

    const id = Date.now() + ':' + this._server.info.id + ':' + this._socketCounter++;
    if (this._socketCounter > internals.counter.max) {
        this._socketCounter = internals.counter.min;
    }

    return id;
};


// Sockets manager

internals.Sockets = function (listener) {

    this._listener = listener;
    this._items = {};
    this._byUser = {};                  // user -> [sockets]
};


internals.Sockets.prototype.add = function (socket) {

    this._items[socket.id] = socket;
};


internals.Sockets.prototype.auth = function (socket) {

    if (!this._listener._settings.auth.index) {
        return;
    }

    if (!socket.auth.credentials.user) {
        return;
    }

    const user = socket.auth.credentials.user;
    if (this._listener._settings.auth.maxConnectionsPerUser &&
        this._byUser[user] &&
        this._byUser[user].length >= this._listener._settings.auth.maxConnectionsPerUser) {

        throw Boom.serverUnavailable('Too many connections for the authenticated user');
    }

    this._byUser[user] = this._byUser[user] || [];
    this._byUser[user].push(socket);
};


internals.Sockets.prototype.remove = function (socket) {

    delete this._items[socket.id];

    if (socket.auth.credentials &&
        socket.auth.credentials.user) {

        const user = socket.auth.credentials.user;
        if (this._byUser[user]) {
            this._byUser[user] = this._byUser[user].filter((item) => item !== socket);
            if (!this._byUser[user].length) {
                delete this._byUser[user];
            }
        }
    }
};


internals.Sockets.prototype._forEach = async function (each) {

    for (const item in this._items) {
        await each(this._items[item]);
    }
};


internals.Sockets.prototype.length = function () {

    return Object.keys(this._items).length;
};


// Subscribers manager

internals.Subscribers = function (server, options) {

    this._server = server;
    this._settings = options;
    this._items = {};
    this._byUser = {};          // user -> [item]
};


internals.Subscribers.prototype.add = async function (socket, path, softPath, match) {

    const item = this._items[socket.id];
    if (item) {
        item.paths[path] = {
            path,
            softPath,
            params: match.params
        };
        item.paths[softPath] = {
            path,
            softPath,
            params: match.params
        };
    }
    else {
        this._items[socket.id] = {
            socket,
            paths: {
                [path]: {
                    path: softPath,
                    softPath,
                    params: match.params
                },
                [softPath]: {
                    path,
                    softPath,
                    params: match.params
                }
            }
        };

        if (this._settings.auth &&
            this._settings.auth.index &&
            socket.auth.credentials &&
            socket.auth.credentials.user) {

            const user = socket.auth.credentials.user;
            this._byUser[user] = this._byUser[user] || [];
            this._byUser[user].push(this._items[socket.id]);
        }
    }
};


internals.Subscribers.prototype.remove = async function (socket, path) {

    const item = this._items[socket.id];
    if (!item) {
        return;
    }

    if (!path) {
        this._cleanup(socket, item);

        if (this._settings.onUnsubscribe) {
            for (const itemPath of Object.keys(item.paths)) {
                const itemPathValue = item.paths[itemPath];
                await this._remove(socket, itemPath, itemPathValue.params);
            }
        }

        return;
    }

    if (Object.keys(item.paths).length === 1) {
        this._cleanup(socket, item);
    }
    else {
        const {
            path: p,
            softPath: sp
        } = item.paths[path];
        delete item.paths[p];
        delete item.paths[sp];
    }

    if (this._settings.onUnsubscribe) {
        return this._remove(socket, path, params);
    }
};


internals.Subscribers.prototype._remove = async function (socket, path, params) {

    try {
        await this._settings.onUnsubscribe(socket, path, params);
    }
    catch (err) {
        this._server.log(['nes', 'onUnsubscribe', 'error'], err);
    }
};


internals.Subscribers.prototype._cleanup = function (socket, item) {

    delete this._items[socket.id];

    if (socket.auth.credentials &&
        socket.auth.credentials.user &&
        this._byUser[socket.auth.credentials.user]) {

        const user = socket.auth.credentials.user;
        this._byUser[user] = this._byUser[user].filter((record) => record !== item);
        if (!this._byUser[user].length) {
            delete this._byUser[user];
        }
    }
};


internals.Subscribers.prototype._forEachSubscriber = async function (path, options, each) {

    const itemize = async (item) => {

        if (item &&         // check item not removed
            (!path ||
            item.paths[path])) {

            await each(item.socket, item.paths[path].path);
        }
    };

    if (options.user) {
        Hoek.assert(this._settings.auth && this._settings.auth.index, 'Subscription auth indexing is disabled');

        const items = this._byUser[options.user];
        if (items) {
            for (let i = 0; i < items.length; ++i) {
                const item = items[i];
                await itemize(item);
            }
        }
    }
    else {
        const items = Object.keys(this._items);
        for (let i = 0; i < items.length; ++i) {
            const item = this._items[items[i]];
            await itemize(item);
        }
    }
};
