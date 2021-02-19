const request = require('superagent');
const GIOEvent = require('./event');

const messageBatchSym = Symbol('messageBatch');
const timerSym = Symbol('timer');
const handlingSym = Symbol('handling');
const eventsSym = Symbol('events');
const initializedSym = Symbol('initialized');
const initPromiseSym = Symbol('initPromise');
const eventPostersSym = Symbol('eventPoster');
const onErrorSym = Symbol('onError');
const onSuccessSym = Symbol('onSuccess');

const defaultConfig = {
    cstm: {
        endpoint: 'https://api.growingio.com',
        version: 'v3',
    },
    management: {
        endpoint: 'https://www.growingio.com',
        version: 'v1',
    },
    projId: '',
    token: '',
    projUid: '',
    projPubKey: '',
    projPrivateKey: '',
    batchSize: 500,
    sendMsgInterval: 100,
    verbose: false,
    timeout: 30000,
};

class GIO {
    static CSTM = 'cstm';
    [eventsSym] = new Map();
    [initializedSym] = false;
    [onErrorSym] = [];
    [onSuccessSym] = [];

    [messageBatchSym] = [];
    [timerSym] = null;
    [handlingSym] = null;
    [eventPostersSym] = new Map();

    get initialized () {
        return this[initializedSym];
    }

    constructor (conf) {
        this.config = Object.assign(
            {},
            defaultConfig,
            conf,
        );
    }

    async init () {
        if (this[initializedSym]) {
            return this;
        }

        if (!this[initPromiseSym]) {
            this[initPromiseSym] = this.getEvents()
                .catch(err => {
                    console.error(`Load GrowingIO event definitions failed with error: ${err}`);
                    this[initPromiseSym] = null;
                });
        }
        const eventList = await this[initPromiseSym];
        if (!eventList) {
            return this;
        }
        this[initializedSym] = true;
        eventList.forEach((event) => {
            this[eventsSym].set(event.key, event);
            this[eventsSym].set(event.id, event);
        });
        return this;
    }

    async getEvent (key) {
        await this.init();
        if (!this[initializedSym]) { // Load events from remote failed.
            return;
        }

        const evtDef = this[eventsSym].get(key);
        return evtDef;
    }

    _buildData (eventKey, eventType, uid, payload, tm) {
        eventType = eventType || GIO.CSTM;
        const body = {
            cs1: uid,
            tm,
            n: eventKey,
            var: payload,
            t: eventType,
        };
        return body;
    }

    batchCstm (eventKey, uid, payload, time = Date.now()) {
        this[messageBatchSym].push(this._buildData(eventKey, GIO.CSTM, uid, payload, time));
        if (this[messageBatchSym].length >= this.config.batchSize) {
            this.sendBatch();
        }
    }

    timer () {
        this[timerSym] = this[timerSym] || setInterval(() => this.sendBatch(), this.config.sendMsgInterval);
    }

    stopTimer () {
        if (this[timerSym] !== null) {
            clearInterval(this[timerSym]);
            this[timerSym] = null;
        }
    }

    async stop (flush) {
        this.stopTimer();
        if (flush) {
            await this.flush();
        }
    }

    async flush () {
        return this.sendBatch()
            .then(() => this[messageBatchSym].length && this.flush());
    }

    static _wait (ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    async _sendBatch (slice) {
        const p = this._send(slice);
        this[handlingSym] = p;
        return this[handlingSym];
    }

    onSuccess (cb) {
        this[onSuccessSym].push(cb);
    }

    onError (cb) {
        this[onErrorSym].push(cb);
    }

    execCallbacks (callbacks, eventKeys, dataMap, err) {
        callbacks.forEach(cb => {
            eventKeys.forEach(eventKey => {
                cb(eventKey, dataMap[eventKey], err);
            });
        });
    }

    async sendBatch () {
        const slice = this[messageBatchSym].splice(0, this.config.batchSize);
        if (slice.length) {
            const map = {};
            slice.forEach(data => {
                map[data.n] = map[data.n] || [];
                map[data.n].push(data['var']);
            });
            const eventKeys = Object.keys(map);
            return this._sendBatch(slice)
                .then(() => {
                    this.execCallbacks(this[onSuccessSym], eventKeys, map)
                    return slice;
                })
                .catch(err =>
                    this.execCallbacks(this[onErrorSym], eventKeys, map, err)
                );
        }
    }

    async request (method, endpoint, version, path, options = {}) {
        const { body: data, query, headers, retry } = options;
        const url = `${endpoint}/${version}${path}`;
        const req = request[method](url)
            .set('Authorization', this.config.token)
            .set('accept', 'json');
        headers && Object.keys(headers).map(key => req.set(key, headers[key]));
        query && req.query(query);
        data && req.send(data);
        retry && req.retry(retry);

        return req
            .then(resp => {
                if (resp.statusCode > 299) {
                    throw new Error(resp.body);
                }
                return resp.body;
            })
            .catch(err => {
                const status = err.response ? err.response.statusCode : '';
                const statusPattern = status ? `[${status}] ` : '';
                throw new Error(`Error occurred when ${method.toUpperCase()} ${url}, ${statusPattern}${err.message}`);
            });
    }

    async _post ({ endpoint, version }, path, options) {
        return this.request('post', endpoint, version, path, options);
    }

    async _requestManagement (method, path, options) {
        const { endpoint, version } = this.config.management;
        return this.request(method, endpoint, version, path, options);
    }

    async _postManagement (path, options) {
        return this._requestManagement('post', path, options);
    }

    async _getManagement (path, options) {
        return this._requestManagement('get', path, options);
    }

    _getProjPath () {
        return `/api/projects/${this.config.projUid}`;
    }

    _getEventsPath () {
        return `${this._getProjPath()}/dim/events`;
    }

    _getEventVarsPath () {
        return `${this._getProjPath()}/vars/events`;
    }

    async createEvents (...events) {
        return this._postManagement(this._getEventsPath(), { body: events });
    }

    async createEventVar (varData) {
        return this._postManagement(this._getEventVarsPath(), { body: varData });
    }

    async getEventVars () {
        return this._getManagement(this._getEventVarsPath());
    }

    async getEvents () {
        return this._getManagement(this._getEventsPath());
    }

    async _send (events) {
        const path = `/${this.config.projId}/s2s/${GIO.CSTM}`;
        return this._post(this.config.cstm, path, {
            body: events,
            query: { stm: `${Date.now()}` },
            retry: this.config.retryCount,
        });
    }

    getEvtPoster (eventKey, options) {
        if (!this[eventPostersSym].has(eventKey)) {
            const evtPoster = new GIOEvent(this, eventKey, options);
            this[eventPostersSym].set(eventKey, evtPoster);
        }
        return this[eventPostersSym].get(eventKey);
    }
}

GIO.GIOEvent = GIOEvent;

module.exports = GIO;
