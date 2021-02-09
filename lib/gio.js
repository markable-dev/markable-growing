const request = require('superagent');

const messageBatch = Symbol('messageBatch');
const timer = Symbol('timer');
const handling = Symbol('handling');
const events = Symbol('events');
const initialized = Symbol('initialized');

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
    [events] = new Map();
    [initialized] = false;

    [messageBatch] = [];
    [timer] = null;
    [handling] = null;

    get initialized () {
        return this[initialized];
    }

    constructor (conf) {
        this.config = Object.assign(
            {},
            defaultConfig,
            conf,
        );
        this[initialized] = false;
    }

    async init () {
        const events = await this.getEvents();
        events.forEach((event) => {
            this[events].set(event.key, event);
            this[events].set(event.id, event);
        });
        this[initialized] = true;
    }

    async getEvent (key) {
        if (!this[initialized]) {
            await this.init();
        }
        const event = this[events].get(key);
        if (!event) {
            throw new Error(`Event ${key} is not defined yet.`);
        }
    }

    _buildData (eventKey, eventType, uid, payload) {
        eventType = eventType || GIO.CSTM;
        const body = {
            cs1: uid,
            tm: Date.now(),
            n: eventKey,
            var: payload,
            t: eventType,
        };
        return body;
    }

    batchCstm (eventName, uid, payload) {
        this[messageBatch].push(this._buildData(eventName, GIO.CSTM, uid, payload));
        if (this[messageBatch].length >= this.config.batchSize) {
            this.sendBatch();
        }
    }

    timer () {
        this[timer] = this[timer] || setInterval(() => this.sendBatch(), this.config.interval);
    }

    stopTimer () {
        if (this[timer] !== null) {
            clearInterval(this[timer]);
            this[timer] = null;
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
            .then(ret => ret && this.flush());
    }

    static _wait (ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    async _sendBatch (slice, tryTimes = 1) {
        const p = this._send(slice);
        this[handling] = p.catch(err => {
            if (err.code === 'ECONNABORTED' && tryTimes <= this.config.retryCount) {
                return this._sendBatch(slice, ++tryTimes);
            }
            throw err;
        });
        return this[handling];
    }

    async sendBatch () {
        const slice = this[messageBatch].splice(0, this.config.batchSize);
        if (slice.length) {
            return this._sendBatch(slice);
        }
    }

    async request (method, endpoint, version, path, options = {}) {
        const { body: data, query, headers } = options;
        const url = `${endpoint}/${version}${path}`;
        const req = request[method](url)
            .set('Authorization', this.config.token)
            .set('accept', 'json');
        headers && Object.keys(headers).map(key => req.set(key, headers[key]));
        query && req.query(query);
        data && req.send(data);
        console.log(req)

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
        return this._post(this.config.cstm, path, { body: events, query: { stm: `${Date.now()}` } });
    }
}

module.exports = GIO;
